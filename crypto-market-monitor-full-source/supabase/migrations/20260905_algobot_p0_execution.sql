-- Serialize the whole migration behind an advisory lock inside a single
-- transaction. Postgres DDL guarded by IF NOT EXISTS is not safe against true
-- concurrent execution (two sessions can both pass the existence check before
-- either commits), so without this lock concurrently applying this migration
-- from multiple processes/tests can raise spurious duplicate-key errors on
-- catalog objects even though the migration is otherwise idempotent.
begin;
select pg_advisory_xact_lock(hashtext('algobot_p0_execution_migration'));

create extension if not exists pgcrypto;

create table if not exists public.execution_ledger (
  id uuid primary key default gen_random_uuid(),
  order_link_id text not null unique,
  symbol text not null,
  side text not null check (side in ('BUY', 'SELL')),
  requested_qty numeric(30, 12) not null check (requested_qty >= 0),
  requested_notional_usdt numeric(30, 12) not null check (requested_notional_usdt >= 0),
  status text not null check (status in (
    'CREATED', 'IN_FLIGHT', 'ACKNOWLEDGED', 'PARTIALLY_FILLED',
    'FILLED', 'REJECTED', 'CANCELLED', 'FAILED', 'UNKNOWN'
  )),
  reconciliation_status text not null default 'PENDING'
    check (reconciliation_status in ('PENDING', 'VERIFIED', 'MISMATCH')),
  exchange_order_id text,
  filled_qty numeric(30, 12) not null default 0 check (filled_qty >= 0),
  filled_notional_usdt numeric(30, 12) not null default 0 check (filled_notional_usdt >= 0),
  avg_fill_price numeric(30, 12) check (avg_fill_price is null or avg_fill_price >= 0),
  fees_usdt numeric(30, 12) not null default 0 check (fees_usdt >= 0),
  executor_fence_token bigint not null check (executor_fence_token > 0),
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.position_lifecycle (
  id uuid primary key default gen_random_uuid(),
  symbol text not null,
  side text not null check (side in ('BUY', 'SELL')),
  status text not null check (status in ('OPENING', 'OPEN', 'EXIT_PENDING', 'CLOSING', 'CLOSED')),
  quantity numeric(30, 12) not null default 0 check (quantity >= 0),
  average_entry_price numeric(30, 12) check (average_entry_price is null or average_entry_price >= 0),
  fees_usdt numeric(30, 12) not null default 0 check (fees_usdt >= 0),
  realized_pnl_usdt numeric(30, 12) not null default 0,
  executor_fence_token bigint not null check (executor_fence_token > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.bot_state_meta (
  singleton_key text primary key check (singleton_key = 'ALGOBOT'),
  trading_state text not null default 'RECOVERY_REQUIRED'
    check (trading_state in ('RECOVERY_REQUIRED', 'TRADING_ENABLED', 'TRADING_LOCKED')),
  max_order_notional_usdt numeric not null default 10
    check (max_order_notional_usdt > 0),
  max_cumulative_notional_usdt numeric not null default 100
    check (max_cumulative_notional_usdt > 0),
  executor_owner_id text,
  executor_fence_token bigint not null default 0 check (executor_fence_token >= 0),
  lease_expires_at timestamptz,
  updated_at timestamptz not null default now()
);

create table if not exists public.canary_reservations (
  id uuid primary key default gen_random_uuid(),
  execution_id uuid not null references public.execution_ledger(id),
  order_link_id text not null unique,
  reserved_notional_usdt numeric(30, 12) not null check (reserved_notional_usdt > 0),
  status text not null check (status in ('RESERVED', 'COMMITTED', 'RELEASED')),
  executor_fence_token bigint not null check (executor_fence_token > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

insert into public.bot_state_meta (singleton_key)
values ('ALGOBOT')
on conflict (singleton_key) do nothing;

create index if not exists execution_ledger_status_idx
  on public.execution_ledger (status, reconciliation_status);
create index if not exists position_lifecycle_status_idx
  on public.position_lifecycle (status);
create index if not exists canary_reservations_status_idx
  on public.canary_reservations (status);

-- Atomically reserves CANARY budget for a single order_link_id. Locks the
-- singleton bot_state_meta row so per-order and cumulative caps can never be
-- oversubscribed by concurrent workers, and validates the caller's executor
-- fencing token in the same transaction.
create or replace function public.algobot_reserve_canary(
  p_order_link_id text,
  p_requested_notional_usdt numeric,
  p_executor_fence_token bigint
) returns table (
  reservation_id uuid,
  reserved_notional_usdt numeric,
  total_authorized_usdt numeric
) as $$
declare
  v_meta public.bot_state_meta%rowtype;
  v_execution_id uuid;
  v_committed_total numeric;
  v_reservation_id uuid;
begin
  select * into v_meta from public.bot_state_meta where singleton_key = 'ALGOBOT' for update;
  if not found then
    raise exception 'bot_state_meta singleton row missing';
  end if;

  if p_executor_fence_token <> v_meta.executor_fence_token then
    raise exception 'stale executor fence token: expected %, got %', v_meta.executor_fence_token, p_executor_fence_token;
  end if;

  if p_requested_notional_usdt > v_meta.max_order_notional_usdt then
    raise exception 'reservation of % USDT exceeds max order notional limit of % USDT', p_requested_notional_usdt, v_meta.max_order_notional_usdt;
  end if;

  select id into v_execution_id
    from public.execution_ledger
    where order_link_id = p_order_link_id;
  if v_execution_id is null then
    raise exception 'no execution_ledger row found for order_link_id %', p_order_link_id;
  end if;

  if exists (select 1 from public.canary_reservations where order_link_id = p_order_link_id) then
    -- canary_reservations.order_link_id already has a unique constraint, so
    -- this check is intentionally redundant with it: it turns what would
    -- otherwise be an opaque unique-violation error into a clear message.
    raise exception 'a CANARY reservation already exists for order_link_id %', p_order_link_id;
  end if;

  -- All CANARY budget accounting reads/writes below happen while this
  -- function still holds the bot_state_meta row lock acquired above, which
  -- is what makes the aggregate sum-then-insert sequence race-free. Any
  -- other code path that writes to canary_reservations must take the same
  -- bot_state_meta lock first to preserve this invariant.
  select coalesce(sum(canary_reservations.reserved_notional_usdt), 0) into v_committed_total
    from public.canary_reservations
    where status in ('RESERVED', 'COMMITTED');

  if v_committed_total + p_requested_notional_usdt > v_meta.max_cumulative_notional_usdt then
    raise exception 'reservation of % USDT would exceed max cumulative notional limit of % USDT', p_requested_notional_usdt, v_meta.max_cumulative_notional_usdt;
  end if;

  insert into public.canary_reservations(
    execution_id, order_link_id, reserved_notional_usdt, status, executor_fence_token
  ) values (
    v_execution_id, p_order_link_id, p_requested_notional_usdt, 'RESERVED', p_executor_fence_token
  ) returning id into v_reservation_id;

  return query select v_reservation_id, p_requested_notional_usdt, v_committed_total + p_requested_notional_usdt;
end;
$$ language plpgsql;

-- Idempotently commits a RESERVED reservation to its verified filled notional.
-- A reservation already COMMITTED or RELEASED is left untouched so replayed
-- exchange evidence never double-counts CANARY budget.
create or replace function public.algobot_commit_canary_reservation(
  p_reservation_id uuid,
  p_filled_notional_usdt numeric,
  p_executor_fence_token bigint
) returns void as $$
declare
  v_meta public.bot_state_meta%rowtype;
begin
  select * into v_meta from public.bot_state_meta where singleton_key = 'ALGOBOT' for update;
  if not found then
    raise exception 'bot_state_meta singleton row missing';
  end if;

  if p_executor_fence_token <> v_meta.executor_fence_token then
    raise exception 'stale executor fence token: expected %, got %', v_meta.executor_fence_token, p_executor_fence_token;
  end if;

  update public.canary_reservations
    set reserved_notional_usdt = p_filled_notional_usdt,
        status = 'COMMITTED',
        updated_at = now()
    where id = p_reservation_id
      and status = 'RESERVED';
end;
$$ language plpgsql;

-- Releases a RESERVED reservation (e.g. after proven non-dispatch) so its
-- notional no longer counts against the CANARY budget. Idempotent: a
-- reservation already COMMITTED or RELEASED is left untouched.
create or replace function public.algobot_release_canary_reservation(
  p_reservation_id uuid,
  p_reason text,
  p_executor_fence_token bigint
) returns void as $$
declare
  v_meta public.bot_state_meta%rowtype;
begin
  select * into v_meta from public.bot_state_meta where singleton_key = 'ALGOBOT' for update;
  if not found then
    raise exception 'bot_state_meta singleton row missing';
  end if;

  if p_executor_fence_token <> v_meta.executor_fence_token then
    raise exception 'stale executor fence token: expected %, got %', v_meta.executor_fence_token, p_executor_fence_token;
  end if;

  update public.canary_reservations
    set status = 'RELEASED',
        updated_at = now()
    where id = p_reservation_id
      and status = 'RESERVED';
end;
$$ language plpgsql;

commit;
