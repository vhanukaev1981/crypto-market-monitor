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
