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

  -- A client-supplied reason is insufficient proof of non-dispatch.
  -- Refuse to free budget once ledger state indicates dispatch ambiguity.
  if p_reason is distinct from 'proven_non_dispatch' then
    raise exception 'reservation release requires proven_non_dispatch reason';
  end if;
  perform 1 from public.execution_ledger e
    where e.id=v_reservation.execution_id and e.status='CREATED'
      and e.reconciliation_status='PENDING' and e.exchange_order_id is null;
  if not found then
    raise exception 'reservation release forbidden after dispatch or ambiguous execution';
  end if;
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


-- Task 4: ledger mutations only through fenced PostgreSQL transactions.
-- Bybit facts are inputs to reconciliation and MUST be validated externally.
create or replace function public.algobot_create_execution(
  p_order_link_id text, p_symbol text, p_side text,
  p_requested_qty numeric, p_requested_notional_usdt numeric,
  p_fence_token bigint
) returns setof public.execution_ledger as $$
declare
  v_meta public.bot_state_meta%rowtype;
  v_existing public.execution_ledger%rowtype;
begin
  select * into v_meta from public.bot_state_meta
    where singleton_key='ALGOBOT' for update;
  if not found then raise exception 'bot_state_meta singleton missing'; end if;
  if p_fence_token is distinct from v_meta.executor_fence_token or
     v_meta.executor_owner_id is null or v_meta.lease_expires_at is null or
     v_meta.lease_expires_at <= clock_timestamp() then
    raise exception 'stale executor fence or expired lease';
  end if;
  if p_order_link_id is null or btrim(p_order_link_id)='' then
    raise exception 'order link id required';
  end if;
  if p_symbol is distinct from 'BTCUSDT' or p_side not in ('BUY','SELL') or p_side is null then
    raise exception 'only BTCUSDT Spot BUY/SELL execution intent supported';
  end if;
  if p_requested_qty is null or p_requested_qty < 0 or
     p_requested_notional_usdt is null or p_requested_notional_usdt <= 0 or
     p_requested_notional_usdt > v_meta.max_order_notional_usdt then
    raise exception 'invalid execution quantity or order budget';
  end if;
  select * into v_existing from public.execution_ledger
    where order_link_id=p_order_link_id for update;
  if found then
    if v_existing.symbol is distinct from p_symbol or v_existing.side is distinct from p_side
      or v_existing.requested_qty is distinct from p_requested_qty or
         v_existing.requested_notional_usdt is distinct from p_requested_notional_usdt then
      raise exception 'conflicting duplicate execution request %', p_order_link_id;
    end if;
    return next v_existing;
    return;
  end if;
  insert into public.execution_ledger(
    order_link_id,symbol,side,requested_qty,requested_notional_usdt,
    status,reconciliation_status,executor_fence_token
  ) values (
    p_order_link_id,p_symbol,p_side,p_requested_qty,p_requested_notional_usdt,
    'CREATED','PENDING',p_fence_token
  ) returning * into v_existing;
  return next v_existing;
end;
$$ language plpgsql;

create or replace function public.algobot_mark_execution_in_flight(
  p_order_link_id text, p_fence_token bigint
) returns setof public.execution_ledger as $$
declare
  v_meta public.bot_state_meta%rowtype;
  v_execution public.execution_ledger%rowtype;
begin
  select * into v_meta from public.bot_state_meta where singleton_key='ALGOBOT' for update;
  if not found then raise exception 'bot_state_meta singleton missing'; end if;
  if p_fence_token is distinct from v_meta.executor_fence_token or
     v_meta.executor_owner_id is null or v_meta.lease_expires_at is null or
     v_meta.lease_expires_at <= clock_timestamp() then
    raise exception 'stale executor fence or expired lease';
  end if;
  if v_meta.trading_state <> 'TRADING_ENABLED' then
    raise exception 'execution forbidden: recovery gate not TRADING_ENABLED';
  end if;
  select * into v_execution from public.execution_ledger
    where order_link_id=p_order_link_id for update;
  if not found then raise exception 'execution not found %', p_order_link_id; end if;
  if v_execution.status <> 'CREATED' then
    raise exception 'illegal execution transition from % to IN_FLIGHT',v_execution.status;
  end if;
  if not exists (
    select 1 from public.canary_reservations
    where execution_id=v_execution.id and order_link_id=p_order_link_id
      and status='RESERVED' and executor_fence_token=p_fence_token
      and reserved_notional_usdt >= v_execution.requested_notional_usdt
  ) then
    raise exception 'no matching durable CANARY reservation for execution %',p_order_link_id;
  end if;
  update public.execution_ledger set status='IN_FLIGHT',
    reconciliation_status='PENDING',executor_fence_token=p_fence_token,
    updated_at=clock_timestamp()
    where id=v_execution.id returning * into v_execution;
  return next v_execution;
end;
$$ language plpgsql;

create or replace function public.algobot_mark_execution_unknown(
  p_order_link_id text, p_reason text, p_fence_token bigint
) returns setof public.execution_ledger as $$
declare
  v_meta public.bot_state_meta%rowtype;
  v_execution public.execution_ledger%rowtype;
begin
  select * into v_meta from public.bot_state_meta where singleton_key='ALGOBOT' for update;
  if not found then raise exception 'bot_state_meta singleton missing'; end if;
  if p_fence_token is distinct from v_meta.executor_fence_token or
     v_meta.executor_owner_id is null or v_meta.lease_expires_at is null or
     v_meta.lease_expires_at <= clock_timestamp() then
    raise exception 'stale executor fence or expired lease';
  end if;
  if p_reason is null or btrim(p_reason)='' then raise exception 'UNKNOWN requires a reason'; end if;
  select * into v_execution from public.execution_ledger
    where order_link_id=p_order_link_id for update;
  if not found then raise exception 'execution not found %',p_order_link_id; end if;
  if v_execution.status not in ('CREATED','IN_FLIGHT','ACKNOWLEDGED','PARTIALLY_FILLED','UNKNOWN') then
    raise exception 'cannot transition terminal execution % to UNKNOWN',p_order_link_id;
  end if;
  update public.execution_ledger set status='UNKNOWN',reconciliation_status='PENDING',
    error_message=p_reason,executor_fence_token=p_fence_token,
    updated_at=clock_timestamp()
    where id=v_execution.id returning * into v_execution;
  -- UNKNOWN means Bybit dispatch/outcome is ambiguous: lock new trading
  -- in the same transaction as the durable UNKNOWN ledger transition.
  update public.bot_state_meta set trading_state='TRADING_LOCKED',
    updated_at=clock_timestamp() where singleton_key='ALGOBOT';
  return next v_execution;
end;
$ language plpgsql;

create or replace function public.algobot_apply_execution_evidence(
  p_order_link_id text, p_status text, p_exchange_order_id text,
  p_filled_qty numeric, p_filled_notional_usdt numeric,
  p_avg_fill_price numeric, p_fees_usdt numeric, p_fence_token bigint
) returns setof public.execution_ledger as $$
declare
  v_meta public.bot_state_meta%rowtype;
  v_execution public.execution_ledger%rowtype;
begin
  select * into v_meta from public.bot_state_meta where singleton_key='ALGOBOT' for update;
  if not found then raise exception 'bot_state_meta singleton missing'; end if;
  if p_fence_token is distinct from v_meta.executor_fence_token or
     v_meta.executor_owner_id is null or v_meta.lease_expires_at is null or
     v_meta.lease_expires_at <= clock_timestamp() then
    raise exception 'stale executor fence or expired lease';
  end if;
  if p_status is null or p_status not in
    ('ACKNOWLEDGED','PARTIALLY_FILLED','FILLED','REJECTED','CANCELLED','FAILED') then
    raise exception 'invalid exchange evidence status';
  end if;
  if p_exchange_order_id is null or btrim(p_exchange_order_id)='' then
    raise exception 'verified exchange evidence requires real order ID';
  end if;
  if p_filled_qty is null or p_filled_qty < 0 or
     p_filled_notional_usdt is null or p_filled_notional_usdt < 0 or
     p_fees_usdt is null or p_fees_usdt < 0 then
    raise exception 'invalid exchange evidence fill/fees';
  end if;
  if p_filled_qty > 0 and (p_filled_notional_usdt <= 0 or
      p_avg_fill_price is null or p_avg_fill_price <= 0) then
    raise exception 'verified fill requires positive average price and notional';
  end if;
  if p_filled_qty = 0 and
     (p_filled_notional_usdt <> 0 or p_fees_usdt <> 0 or p_avg_fill_price is not null) then
    raise exception 'unfilled execution cannot carry fill notional, fees or price';
  end if;
  if p_status in ('PARTIALLY_FILLED','FILLED') and p_filled_qty <= 0 then
    raise exception 'filled execution requires positive verified quantity';
  end if;
  select * into v_execution from public.execution_ledger
    where order_link_id=p_order_link_id for update;
  if not found then raise exception 'execution not found %',p_order_link_id; end if;
  if v_execution.exchange_order_id is not null and
     v_execution.exchange_order_id <> p_exchange_order_id then
    raise exception 'conflicting exchange order ID for %',p_order_link_id;
  end if;
  if p_filled_qty < v_execution.filled_qty or
     p_filled_notional_usdt < v_execution.filled_notional_usdt or
     p_fees_usdt < v_execution.fees_usdt then
    raise exception 'exchange evidence cannot reduce verified cumulative fills or fees';
  end if;
  if p_filled_notional_usdt > v_execution.requested_notional_usdt then
    raise exception 'exchange evidence notional exceeds authorized order amount';
  end if;
  if v_execution.status in ('FILLED','REJECTED','CANCELLED','FAILED') then
    if v_execution.status <> p_status or v_execution.exchange_order_id is distinct from p_exchange_order_id
      or v_execution.filled_qty <> p_filled_qty or
         v_execution.filled_notional_usdt <> p_filled_notional_usdt or
         v_execution.fees_usdt <> p_fees_usdt or
         v_execution.avg_fill_price is distinct from p_avg_fill_price then
      raise exception 'conflicting terminal exchange evidence for %',p_order_link_id;
    end if;
    return next v_execution;
    return;
  end if;
  if v_execution.status not in ('IN_FLIGHT','ACKNOWLEDGED','PARTIALLY_FILLED','UNKNOWN') then
    raise exception 'execution not dispatchable/reconcilable from status %',v_execution.status;
  end if;
  if v_execution.status='PARTIALLY_FILLED' and p_status='ACKNOWLEDGED' then
    raise exception 'cannot regress partial fill to acknowledged';
  end if;
  if v_execution.status='ACKNOWLEDGED' and p_status='ACKNOWLEDGED' and
     (v_execution.filled_qty <> p_filled_qty or
      v_execution.filled_notional_usdt <> p_filled_notional_usdt) then
    raise exception 'conflicting acknowledged evidence';
  end if;
  update public.execution_ledger set
    status=p_status,reconciliation_status='VERIFIED',
    exchange_order_id=p_exchange_order_id,filled_qty=p_filled_qty,
    filled_notional_usdt=p_filled_notional_usdt,
    avg_fill_price=p_avg_fill_price,fees_usdt=p_fees_usdt,
    executor_fence_token=p_fence_token,error_message=null,
    updated_at=clock_timestamp()
    where id=v_execution.id returning * into v_execution;
  return next v_execution;
end;
$$ language plpgsql;

create or replace function public.algobot_list_unresolved_executions()
returns setof public.execution_ledger as $$
begin
  return query select e.* from public.execution_ledger e
    where e.status not in ('FILLED','REJECTED','CANCELLED','FAILED')
       or e.reconciliation_status <> 'VERIFIED'
    order by e.created_at,e.id;
end;
$$ language plpgsql;

-- Restrict untrusted roles from bypassing fenced transaction functions.
-- Privileged service_role and DB owners still bypass these controls; separate
-- least-privilege production credentials are mandatory before LIVE trading.
alter table public.bot_state_meta enable row level security;
alter table public.execution_ledger enable row level security;
alter table public.canary_reservations enable row level security;
alter table public.position_lifecycle enable row level security;
revoke all on table public.bot_state_meta, public.execution_ledger,
  public.canary_reservations, public.position_lifecycle from public;

do $acl$
declare
  r record;
  role_name text;
begin
  foreach role_name in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=role_name) then
      execute format('revoke all on table public.bot_state_meta, public.execution_ledger, public.canary_reservations, public.position_lifecycle from %I',role_name);
    end if;
  end loop;
  for r in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and p.proname like 'algobot_%'
  loop
    execute format('revoke all on function %s from public',r.signature);
    foreach role_name in array array['anon','authenticated'] loop
      if exists(select 1 from pg_roles where rolname=role_name) then
        execute format('revoke all on function %s from %I',r.signature,role_name);
      end if;
    end loop;
  end loop;
end
$acl$;

commit;
