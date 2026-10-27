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

  if p_executor_fence_token is distinct from v_meta.executor_fence_token then
    raise exception 'stale executor fence token: expected %, got %', v_meta.executor_fence_token, p_executor_fence_token;
  end if;
  if v_meta.executor_owner_id is null or v_meta.lease_expires_at is null
     or v_meta.lease_expires_at <= clock_timestamp() then
    raise exception 'executor lease expired or missing';
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

-- Commits a RESERVED reservation to its verified filled notional.
--
-- Safety invariants (ChatGPT independent review of PR #18):
--   1. A commit can never authorize more CANARY budget than was reserved for
--      this order: p_filled_notional_usdt must be > 0 and <= the amount that
--      was originally reserved.
--   2. Fail closed, never silent no-op: a reservation id that does not exist,
--      or a reservation that is RELEASED, raises. An already-COMMITTED
--      reservation is idempotent ONLY when replayed with the identical filled
--      notional; a conflicting amount raises.
create or replace function public.algobot_commit_canary_reservation(
  p_reservation_id uuid,
  p_filled_notional_usdt numeric,
  p_executor_fence_token bigint
) returns void as $$
declare
  v_meta public.bot_state_meta%rowtype;
  v_reservation public.canary_reservations%rowtype;
begin
  select * into v_meta from public.bot_state_meta where singleton_key = 'ALGOBOT' for update;
  if not found then
    raise exception 'bot_state_meta singleton row missing';
  end if;

  if p_executor_fence_token is distinct from v_meta.executor_fence_token then
    raise exception 'stale executor fence token: expected %, got %', v_meta.executor_fence_token, p_executor_fence_token;
  end if;
  if v_meta.executor_owner_id is null or v_meta.lease_expires_at is null
     or v_meta.lease_expires_at <= clock_timestamp() then
    raise exception 'executor lease expired or missing';
  end if;

  -- Lock the reservation row (also under the bot_state_meta lock held above)
  -- and fail closed if it is not there at all.
  select * into v_reservation from public.canary_reservations
    where id = p_reservation_id
    for update;
  if not found then
    raise exception 'no CANARY reservation found for id %', p_reservation_id;
  end if;

  if p_filled_notional_usdt is null or p_filled_notional_usdt <= 0 then
    raise exception 'commit filled notional must be positive, got % for reservation %', p_filled_notional_usdt, p_reservation_id;
  end if;

  if v_reservation.status = 'RELEASED' then
    raise exception 'cannot commit reservation % because it is RELEASED', p_reservation_id;
  end if;

  if v_reservation.status = 'COMMITTED' then
    -- Replayed exchange evidence: a no-op only when it agrees with what was
    -- already committed. A different amount is a real accounting conflict.
    if p_filled_notional_usdt <> v_reservation.reserved_notional_usdt then
      raise exception 'reservation % already COMMITTED at % USDT; refusing conflicting commit of % USDT',
        p_reservation_id, v_reservation.reserved_notional_usdt, p_filled_notional_usdt;
    end if;
    return;
  end if;

  -- v_reservation.status = 'RESERVED'
  if p_filled_notional_usdt > v_reservation.reserved_notional_usdt then
    raise exception 'commit of % USDT exceeds the reserved amount of % USDT for reservation %',
      p_filled_notional_usdt, v_reservation.reserved_notional_usdt, p_reservation_id;
  end if;

  update public.canary_reservations
    set reserved_notional_usdt = p_filled_notional_usdt,
        status = 'COMMITTED',
        updated_at = now()
    where id = p_reservation_id;
end;
$$ language plpgsql;

-- Releases a RESERVED reservation (e.g. after proven non-dispatch) so its
-- notional no longer counts against the CANARY budget.
--
-- Safety invariant (ChatGPT independent review of PR #18): fail closed, never
-- silent no-op. A reservation id that does not exist, or a reservation that is
-- COMMITTED, raises. Re-releasing an already-RELEASED reservation is the one
-- idempotent case.
create or replace function public.algobot_release_canary_reservation(
  p_reservation_id uuid,
  p_reason text,
  p_executor_fence_token bigint
) returns void as $$
declare
  v_meta public.bot_state_meta%rowtype;
  v_reservation public.canary_reservations%rowtype;
begin
  select * into v_meta from public.bot_state_meta where singleton_key = 'ALGOBOT' for update;
  if not found then
    raise exception 'bot_state_meta singleton row missing';
  end if;

  if p_executor_fence_token is distinct from v_meta.executor_fence_token then
    raise exception 'stale executor fence token: expected %, got %', v_meta.executor_fence_token, p_executor_fence_token;
  end if;
  if v_meta.executor_owner_id is null or v_meta.lease_expires_at is null
     or v_meta.lease_expires_at <= clock_timestamp() then
    raise exception 'executor lease expired or missing';
  end if;

  select * into v_reservation from public.canary_reservations
    where id = p_reservation_id
    for update;
  if not found then
    raise exception 'no CANARY reservation found for id %', p_reservation_id;
  end if;

  if v_reservation.status = 'RELEASED' then
    return;
  end if;

  if v_reservation.status = 'COMMITTED' then
    raise exception 'cannot release reservation % because it is COMMITTED', p_reservation_id;
  end if;

  -- v_reservation.status = 'RESERVED'
  update public.canary_reservations
    set status = 'RELEASED',
        updated_at = now()
    where id = p_reservation_id;
end;
$$ language plpgsql;

-- Task 3: all executor acquisition and fencing authorization is serialized
-- on the same bot_state_meta singleton row as CANARY budget changes.
-- A newly acquired executor starts in RECOVERY_REQUIRED, NEVER TRADING_ENABLED.
create or replace function public.algobot_acquire_executor(
  p_owner_id text, p_lease_ms bigint
) returns table(owner_id text, fence_token bigint, lease_expires_at timestamptz) as $$
declare
  v_meta public.bot_state_meta%rowtype;
  v_expires_at timestamptz;
begin
  if p_owner_id is null or btrim(p_owner_id) = '' then
    raise exception 'executor owner id required';
  end if;
  if p_lease_ms is null or p_lease_ms < 1 or p_lease_ms > 300000 then
    raise exception 'invalid executor lease duration';
  end if;
  select * into v_meta from public.bot_state_meta where singleton_key = 'ALGOBOT' for update;
  if not found then raise exception 'bot_state_meta singleton row missing'; end if;
  if v_meta.executor_owner_id is null and v_meta.lease_expires_at is not null then
    raise exception 'inconsistent executor ownership/lease state';
  end if;
  if v_meta.executor_owner_id is not null and
     (v_meta.lease_expires_at is null or v_meta.lease_expires_at > clock_timestamp()) then
    raise exception 'active executor lease already held by %', v_meta.executor_owner_id;
  end if;
  v_expires_at := clock_timestamp() + p_lease_ms * interval '1 millisecond';
  update public.bot_state_meta
  set executor_owner_id=p_owner_id, executor_fence_token=v_meta.executor_fence_token+1,
      lease_expires_at=v_expires_at, trading_state='RECOVERY_REQUIRED', updated_at=clock_timestamp()
  where singleton_key='ALGOBOT';
  return query select p_owner_id, v_meta.executor_fence_token+1, v_expires_at;
end;
$$ language plpgsql;

create or replace function public.algobot_renew_executor_lease(
  p_executor_fence_token bigint, p_lease_ms bigint
) returns table(lease_expires_at timestamptz) as $$
declare
  v_meta public.bot_state_meta%rowtype;
  v_expires_at timestamptz;
begin
  if p_lease_ms is null or p_lease_ms < 1 or p_lease_ms > 300000 then
    raise exception 'invalid executor lease duration';
  end if;
  select * into v_meta from public.bot_state_meta where singleton_key='ALGOBOT' for update;
  if not found then raise exception 'bot_state_meta singleton row missing'; end if;
  if p_executor_fence_token is distinct from v_meta.executor_fence_token or
     v_meta.executor_owner_id is null or v_meta.lease_expires_at is null or
     v_meta.lease_expires_at <= clock_timestamp() then
    raise exception 'stale executor fence token or expired lease';
  end if;
  v_expires_at := clock_timestamp() + p_lease_ms * interval '1 millisecond';
  update public.bot_state_meta set lease_expires_at=v_expires_at, updated_at=clock_timestamp()
  where singleton_key='ALGOBOT';
  return query select v_expires_at;
end;
$$ language plpgsql;

create or replace function public.algobot_assert_executor_fence(
  p_executor_fence_token bigint
) returns void as $$
declare
  v_meta public.bot_state_meta%rowtype;
begin
  select * into v_meta from public.bot_state_meta where singleton_key='ALGOBOT' for share;
  if not found then raise exception 'bot_state_meta singleton row missing'; end if;
  if p_executor_fence_token is distinct from v_meta.executor_fence_token or
     v_meta.executor_owner_id is null or v_meta.lease_expires_at is null or
     v_meta.lease_expires_at <= clock_timestamp() then
    raise exception 'stale executor fence token or expired lease';
  end if;
end;
$$ language plpgsql;

create or replace function public.algobot_release_executor(
  p_executor_fence_token bigint
) returns void as $$
declare
  v_meta public.bot_state_meta%rowtype;
begin
  select * into v_meta from public.bot_state_meta where singleton_key='ALGOBOT' for update;
  if not found then raise exception 'bot_state_meta singleton row missing'; end if;
  if p_executor_fence_token is distinct from v_meta.executor_fence_token or
     v_meta.executor_owner_id is null or v_meta.lease_expires_at is null or
     v_meta.lease_expires_at <= clock_timestamp() then
    raise exception 'stale executor fence token or expired lease';
  end if;
  update public.bot_state_meta
  set executor_owner_id=null, lease_expires_at=null, trading_state='RECOVERY_REQUIRED',
      updated_at=clock_timestamp()
  where singleton_key='ALGOBOT';
end;
$$ language plpgsql;

commit;
