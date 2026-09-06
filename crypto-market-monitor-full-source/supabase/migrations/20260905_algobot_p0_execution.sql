create extension if not exists pgcrypto;

create table if not exists public.execution_ledger (
  id uuid primary key default gen_random_uuid(),
  order_link_id text not null unique,
  symbol text not null,
  side text not null check (side in ('BUY', 'SELL')),
  requested_qty numeric(30, 12) not null check (requested_qty >= 0),
  requested_notional_usdt numeric(30, 8) not null check (requested_notional_usdt >= 0),
  status text not null default 'CREATED' check (status in (
    'CREATED', 'IN_FLIGHT', 'ACKNOWLEDGED', 'PARTIALLY_FILLED',
    'FILLED', 'REJECTED', 'CANCELLED', 'FAILED', 'UNKNOWN'
  )),
  reconciliation_status text not null default 'PENDING' check (
    reconciliation_status in ('PENDING', 'VERIFIED', 'MISMATCH')
  ),
  exchange_order_id text,
  filled_qty numeric(30, 12) not null default 0 check (filled_qty >= 0),
  filled_notional_usdt numeric(30, 8) not null default 0 check (filled_notional_usdt >= 0),
  avg_fill_price numeric(30, 12) check (avg_fill_price is null or avg_fill_price >= 0),
  fees_usdt numeric(30, 8) not null default 0 check (fees_usdt >= 0),
  executor_fence_token bigint not null check (executor_fence_token >= 0),
  error_code text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists execution_ledger_status_idx
  on public.execution_ledger (status);

create table if not exists public.position_lifecycle (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  side text not null default 'LONG' check (side = 'LONG'),
  status text not null default 'OPENING' check (status in (
    'OPENING', 'OPEN', 'EXIT_PENDING', 'CLOSING', 'CLOSED'
  )),
  quantity numeric(30, 12) not null default 0 check (quantity >= 0),
  average_entry_price numeric(30, 12) check (
    average_entry_price is null or average_entry_price >= 0
  ),
  fees_usdt numeric(30, 8) not null default 0 check (fees_usdt >= 0),
  realized_pnl_usdt numeric(30, 8) not null default 0,
  opening_execution_id uuid references public.execution_ledger(id),
  closing_execution_id uuid references public.execution_ledger(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz
);

create index if not exists position_lifecycle_status_idx
  on public.position_lifecycle (status);

create table if not exists public.bot_state_meta (
  singleton_key text primary key check (singleton_key = 'ALGOBOT'),
  trading_state text not null default 'RECOVERY_REQUIRED' check (
    trading_state in ('RECOVERY_REQUIRED', 'TRADING_ENABLED', 'TRADING_LOCKED')
  ),
  max_order_notional_usdt numeric(30, 8) not null default 10
    check (max_order_notional_usdt > 0),
  max_cumulative_notional_usdt numeric(30, 8) not null default 100
    check (max_cumulative_notional_usdt > 0),
  reserved_notional_usdt numeric(30, 8) not null default 0
    check (reserved_notional_usdt >= 0),
  committed_notional_usdt numeric(30, 8) not null default 0
    check (committed_notional_usdt >= 0),
  executor_owner_id text,
  executor_fence_token bigint not null default 0 check (executor_fence_token >= 0),
  lease_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

insert into public.bot_state_meta (singleton_key)
values ('ALGOBOT')
on conflict (singleton_key) do nothing;

create table if not exists public.canary_reservations (
  id uuid primary key default gen_random_uuid(),
  execution_id uuid not null references public.execution_ledger(id),
  order_link_id text not null unique,
  reserved_notional_usdt numeric(30, 8) not null check (reserved_notional_usdt > 0),
  status text not null default 'RESERVED' check (status in (
    'RESERVED', 'TRANSMITTED', 'COMMITTED', 'RELEASED', 'UNKNOWN'
  )),
  executor_fence_token bigint not null check (executor_fence_token >= 0),
  released_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists canary_reservations_status_idx
  on public.canary_reservations (status);

create or replace function public.algobot_assert_fence(expected_token bigint)
returns void
language plpgsql
as $$
begin
  if not exists (
    select 1
    from public.bot_state_meta
    where singleton_key = 'ALGOBOT'
      and executor_fence_token = expected_token
      and trading_state <> 'TRADING_LOCKED'
  ) then
    raise exception 'stale or inactive executor fence token: %', expected_token
      using errcode = '42501';
  end if;
end;
$$;

create or replace function public.algobot_acquire_executor(
  requested_owner_id text,
  lease_duration interval default interval '60 seconds'
)
returns bigint
language plpgsql
as $$
declare
  next_token bigint;
begin
  select executor_fence_token + 1
    into next_token
    from public.bot_state_meta
   where singleton_key = 'ALGOBOT'
   for update;

  update public.bot_state_meta
     set executor_owner_id = requested_owner_id,
         executor_fence_token = next_token,
         lease_expires_at = now() + lease_duration,
         trading_state = 'RECOVERY_REQUIRED',
         updated_at = now()
   where singleton_key = 'ALGOBOT';

  return next_token;
end;
$$;

create or replace function public.algobot_reserve_canary(
  requested_order_link_id text,
  requested_notional_usdt numeric,
  requested_execution_id uuid,
  requested_fence_token bigint
)
returns uuid
language plpgsql
as $$
declare
  reservation_id uuid;
  state_row public.bot_state_meta%rowtype;
begin
  select * into state_row
    from public.bot_state_meta
   where singleton_key = 'ALGOBOT'
   for update;

  if state_row.executor_fence_token <> requested_fence_token
     or state_row.trading_state = 'TRADING_LOCKED' then
    raise exception 'executor fence is not active' using errcode = '42501';
  end if;
  if requested_notional_usdt <= 0
     or requested_notional_usdt > state_row.max_order_notional_usdt then
    raise exception 'CANARY order notional exceeds per-order limit';
  end if;
  if state_row.committed_notional_usdt + state_row.reserved_notional_usdt
       + requested_notional_usdt > state_row.max_cumulative_notional_usdt then
    raise exception 'CANARY cumulative notional exceeds limit';
  end if;

  insert into public.canary_reservations (
    execution_id, order_link_id, reserved_notional_usdt, executor_fence_token
  ) values (
    requested_execution_id, requested_order_link_id,
    requested_notional_usdt, requested_fence_token
  )
  returning id into reservation_id;

  update public.bot_state_meta
     set reserved_notional_usdt = reserved_notional_usdt + requested_notional_usdt,
         updated_at = now()
   where singleton_key = 'ALGOBOT';

  return reservation_id;
end;
$$;

create or replace function public.algobot_release_canary_reservation(
  reservation_id uuid,
  release_reason text,
  requested_fence_token bigint
)
returns void
language plpgsql
as $$
declare
  reservation public.canary_reservations%rowtype;
begin
  select * into reservation
    from public.canary_reservations
   where id = reservation_id
   for update;

  if reservation.status <> 'RESERVED' then
    return;
  end if;
  perform public.algobot_assert_fence(requested_fence_token);
  update public.canary_reservations
     set status = 'RELEASED', released_reason = release_reason, updated_at = now()
   where id = reservation_id;
  update public.bot_state_meta
     set reserved_notional_usdt =
       greatest(0, reserved_notional_usdt - reservation.reserved_notional_usdt),
         updated_at = now()
   where singleton_key = 'ALGOBOT';
end;
$$;
