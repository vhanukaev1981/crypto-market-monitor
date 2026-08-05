create table if not exists public.bybit_demo_live_snapshot (
  user_id uuid primary key references auth.users(id) on delete cascade,
  environment text not null default 'demo' check (environment = 'demo'),
  account jsonb not null default '{}'::jsonb,
  assets jsonb not null default '[]'::jsonb,
  linear_positions jsonb not null default '[]'::jsonb,
  prices jsonb not null default '{}'::jsonb,
  spot_open_orders integer not null default 0 check (spot_open_orders >= 0),
  linear_open_orders integer not null default 0 check (linear_open_orders >= 0),
  checked_at timestamptz,
  source text not null default 'bybit_demo_api',
  last_error text,
  updated_at timestamptz not null default now()
);

alter table public.bybit_demo_live_snapshot enable row level security;
revoke all on table public.bybit_demo_live_snapshot from anon, authenticated;
grant select on table public.bybit_demo_live_snapshot to authenticated;
grant all on table public.bybit_demo_live_snapshot to service_role;
drop policy if exists "Users can read own Bybit Demo snapshot" on public.bybit_demo_live_snapshot;
create policy "Users can read own Bybit Demo snapshot" on public.bybit_demo_live_snapshot for select to authenticated using ((select auth.uid()) = user_id);

create or replace view public.trading_dashboard_summary with (security_invoker = true) as
with users as (
  select distinct user_id from public.bot_configs
), latest_futures_run as (
  select distinct on (r.user_id) r.user_id,
    nullif(r.metadata #>> '{account,totalEquity}', '')::numeric as account_equity_usdt,
    nullif(r.metadata #>> '{account,availableBalance}', '')::numeric as available_balance_usdt,
    r.ended_at as account_updated_at
  from public.bot_runs r join public.bot_configs c on c.id = r.bot_id
  where c.category = 'linear' and r.status = 'completed'
  order by r.user_id, r.ended_at desc nulls last
), positions as (
  select user_id, count(*)::integer as open_positions,
    count(*) filter (where market='spot')::integer as spot_positions,
    count(*) filter (where market='futures')::integer as futures_positions,
    count(*) filter (where direction='long')::integer as long_positions,
    count(*) filter (where direction='short')::integer as short_positions,
    coalesce(sum(notional_usdt),0) as open_exposure_usdt,
    coalesce(sum(unrealized_pnl),0) as unrealized_pnl,
    count(*) filter (where protection_status='native_verified')::integer as protected_positions
  from public.open_positions_unified group by user_id
), spot_today as (
  select user_id, coalesce(sum(net_pnl),0) as pnl from public.bot_positions
  where status='closed' and closed_at >= (date_trunc('day', now() at time zone 'Asia/Jerusalem') at time zone 'Asia/Jerusalem') group by user_id
), futures_today as (
  select user_id, coalesce(sum(net_pnl),0) as pnl from public.futures_positions
  where status='closed' and closed_at >= (date_trunc('day', now() at time zone 'Asia/Jerusalem') at time zone 'Asia/Jerusalem') group by user_id
), configs as (
  select user_id, max(nullif(risk->>'reference_capital_usdt','')::numeric) as reference_capital_usdt,
    bool_and(enabled and not kill_switch and status='running') filter (where environment in ('demo','demo_futures')) as all_demo_engines_running,
    max(last_run_at) filter (where environment='demo' and category='spot') as spot_last_run_at,
    max(last_run_at) filter (where environment='demo_futures' and category='linear') as futures_last_run_at
  from public.bot_configs group by user_id
)
select u.user_id,
  coalesce(nullif(s.account->>'total_equity','')::numeric, f.account_equity_usdt) as account_equity_usdt,
  coalesce(nullif(s.account->>'total_available_balance','')::numeric, f.available_balance_usdt) as available_balance_usdt,
  coalesce(s.checked_at, f.account_updated_at) as account_updated_at,
  c.reference_capital_usdt, coalesce(p.open_positions,0) as open_positions, coalesce(p.spot_positions,0) as spot_positions,
  coalesce(p.futures_positions,0) as futures_positions, coalesce(p.long_positions,0) as long_positions, coalesce(p.short_positions,0) as short_positions,
  coalesce(p.open_exposure_usdt,0) as open_exposure_usdt, coalesce(p.unrealized_pnl,0) as unrealized_pnl, coalesce(p.protected_positions,0) as protected_positions,
  coalesce(st.pnl,0) as spot_realized_today, coalesce(ft.pnl,0) as futures_realized_today, coalesce(st.pnl,0)+coalesce(ft.pnl,0) as realized_today,
  coalesce(c.all_demo_engines_running,false) as all_demo_engines_running, c.spot_last_run_at, c.futures_last_run_at,
  case when s.checked_at is not null then 'bybit_demo_snapshot' else 'bot_run_fallback' end as account_source,
  (s.checked_at is null or s.last_error is not null) as account_stale
from users u left join public.bybit_demo_live_snapshot s using(user_id) left join latest_futures_run f using(user_id)
left join positions p using(user_id) left join spot_today st using(user_id) left join futures_today ft using(user_id) left join configs c using(user_id);

alter view public.strategy_lab_performance_v2 set (security_invoker = true);

create or replace function private.invoke_bybit_demo_live_snapshot()
returns bigint language plpgsql security definer set search_path = public, private, net as $$
declare request_id bigint; cron_token text;
begin
  select secret_value into cron_token from private.bot_runtime_secrets where secret_name='bot_cron';
  if cron_token is null then raise exception 'Snapshot cron credential is unavailable'; end if;
  select net.http_post(
    url := 'https://xabffbjifmnoogzcttyd.supabase.co/functions/v1/bybit-demo-live-snapshot-cron',
    headers := jsonb_build_object('Content-Type','application/json','x-bot-cron-token',cron_token), body := '{}'::jsonb, timeout_milliseconds := 60000
  ) into request_id;
  return request_id;
end; $$;
revoke all on function private.invoke_bybit_demo_live_snapshot() from public, anon, authenticated;
grant execute on function private.invoke_bybit_demo_live_snapshot() to service_role, postgres;

do $$ begin
  if exists(select 1 from cron.job where jobname='bybit_demo_live_snapshot_1m') then perform cron.unschedule('bybit_demo_live_snapshot_1m'); end if;
end $$;
select cron.schedule('bybit_demo_live_snapshot_1m','* * * * *','select private.invoke_bybit_demo_live_snapshot();');
