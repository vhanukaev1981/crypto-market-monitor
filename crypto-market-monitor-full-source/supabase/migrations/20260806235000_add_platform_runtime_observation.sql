create or replace view public.platform_runtime_observation
with (security_invoker = true) as
select
  m.organization_id,
  m.platform_bot_id,
  m.bot_key,
  m.display_name,
  m.legacy_bot_id,
  m.execution_environment as platform_environment,
  m.platform_runtime_status,
  m.platform_enabled,
  m.platform_kill_switch,
  m.live_gate_status,
  m.legacy_environment,
  m.legacy_category,
  m.legacy_runtime_status,
  m.legacy_enabled,
  m.legacy_kill_switch,
  m.sync_status,
  m.platform_core_controls_execution,
  m.last_run_at,
  latest_run.status as latest_run_status,
  latest_run.reason as latest_run_reason,
  latest_run.started_at as latest_run_started_at,
  latest_run.ended_at as latest_run_ended_at,
  coalesce(run_stats.completed_24h, 0)::integer as completed_runs_24h,
  coalesce(run_stats.failed_24h, 0)::integer as failed_runs_24h,
  coalesce(spot_stats.open_positions, 0)::integer + coalesce(futures_stats.open_positions, 0)::integer as open_positions,
  coalesce(spot_stats.unprotected_positions, 0)::integer + coalesce(futures_stats.unprotected_positions, 0)::integer as unprotected_positions,
  coalesce(spot_stats.open_positions, 0)::integer as spot_open_positions,
  coalesce(futures_stats.open_positions, 0)::integer as futures_open_positions,
  spot_stats.last_position_update_at as spot_last_position_update_at,
  futures_stats.last_position_update_at as futures_last_position_update_at,
  spot_stats.last_smart_exit_update_at,
  case
    when m.legacy_category = 'linear' then 'native_futures_protection'
    when coalesce(spot_stats.open_positions, 0) = 0 then 'idle'
    when coalesce(spot_stats.unprotected_positions, 0) > 0 then 'protection_warning'
    when spot_stats.last_smart_exit_update_at is not null
      and now() - spot_stats.last_smart_exit_update_at <= interval '5 minutes' then 'active_observed'
    else 'protected_observed'
  end as smart_exit_status,
  private_stream.connected as private_stream_connected,
  private_stream.auth_ok as private_stream_auth_ok,
  private_stream.subscribed as private_stream_subscribed,
  private_stream.last_error as private_stream_error,
  private_stream.last_message_at as private_stream_last_message_at,
  private_stream.updated_at as private_stream_updated_at,
  case
    when m.legacy_category <> 'spot' then 'not_applicable'
    when private_stream.last_error is not null then 'error'
    when private_stream.connected
      and private_stream.auth_ok
      and private_stream.subscribed
      and now() - private_stream.updated_at <= interval '3 minutes' then 'healthy'
    when private_stream.updated_at is null then 'missing'
    else 'stale_or_disconnected'
  end as private_stream_status,
  shadow_stream.connected as shadow_stream_connected,
  shadow_stream.last_error as shadow_stream_error,
  shadow_stream.last_tick_at as shadow_stream_last_tick_at,
  shadow_stream.updated_at as shadow_stream_updated_at,
  orderbook_stream.connected as orderbook_stream_connected,
  orderbook_stream.last_error as orderbook_stream_error,
  orderbook_stream.last_sample_at as orderbook_stream_last_sample_at,
  orderbook_stream.updated_at as orderbook_stream_updated_at,
  snapshot.checked_at as snapshot_checked_at,
  snapshot.last_error as snapshot_error,
  case
    when m.legacy_environment not in ('demo','demo_futures') then 'not_applicable'
    when snapshot.last_error is not null then 'error'
    when snapshot.checked_at is null then 'missing'
    when now() - snapshot.checked_at > interval '2 minutes' then 'stale'
    else 'healthy'
  end as snapshot_status,
  case when m.legacy_category = 'linear' then coalesce(snapshot.linear_open_orders, 0)
       when m.legacy_category = 'spot' then coalesce(snapshot.spot_open_orders, 0)
       else 0 end::integer as exchange_open_orders,
  coalesce(order_stats.orders_24h, 0)::integer as orders_24h,
  order_stats.last_order_at,
  latest_risk.severity as latest_risk_severity,
  latest_risk.code as latest_risk_code,
  latest_risk.message as latest_risk_message,
  latest_risk.created_at as latest_risk_at,
  extract(epoch from (now() - coalesce(m.last_run_at, latest_run.started_at)))::integer as last_run_age_seconds,
  case
    when m.sync_status = 'live_locked' then 'live_locked'
    when not m.legacy_enabled or m.legacy_kill_switch or m.legacy_runtime_status <> 'running' then 'stopped'
    when latest_run.status = 'failed' then 'error'
    when coalesce(m.last_run_at, latest_run.started_at) is null then 'never_run'
    when now() - coalesce(m.last_run_at, latest_run.started_at) > interval '30 minutes' then 'stale'
    when m.legacy_environment in ('demo','demo_futures')
      and (snapshot.checked_at is null or snapshot.last_error is not null or now() - snapshot.checked_at > interval '2 minutes') then 'data_delayed'
    when m.legacy_category = 'spot'
      and not (coalesce(private_stream.connected,false)
        and coalesce(private_stream.auth_ok,false)
        and coalesce(private_stream.subscribed,false)
        and private_stream.last_error is null
        and now() - private_stream.updated_at <= interval '3 minutes') then 'stream_warning'
    when coalesce(spot_stats.unprotected_positions, 0) + coalesce(futures_stats.unprotected_positions, 0) > 0 then 'protection_warning'
    else 'healthy'
  end as runtime_health_status,
  now() as observed_at
from public.platform_legacy_bot_mapping m
join public.bot_configs bc on bc.id = m.legacy_bot_id
left join lateral (
  select r.status, r.reason, r.started_at, r.ended_at
  from public.bot_runs r
  where r.user_id = bc.user_id and r.bot_id = bc.id
  order by r.started_at desc
  limit 1
) latest_run on true
left join lateral (
  select
    count(*) filter (where r.status = 'completed') as completed_24h,
    count(*) filter (where r.status = 'failed') as failed_24h
  from public.bot_runs r
  where r.user_id = bc.user_id
    and r.bot_id = bc.id
    and r.started_at >= now() - interval '24 hours'
) run_stats on true
left join lateral (
  select
    count(*) filter (where p.status in ('open','closing')) as open_positions,
    count(*) filter (
      where p.status in ('open','closing')
        and coalesce(p.protection_status,'missing') not in ('native_verified','software_only')
    ) as unprotected_positions,
    max(p.updated_at) filter (where p.status in ('open','closing')) as last_position_update_at,
    max(coalesce(p.last_stop_update_at, p.last_shadow_tick_at, p.updated_at))
      filter (where p.status in ('open','closing')) as last_smart_exit_update_at
  from public.bot_positions p
  where p.user_id = bc.user_id and p.bot_id = bc.id
) spot_stats on true
left join lateral (
  select
    count(*) filter (where p.status in ('open','closing')) as open_positions,
    count(*) filter (
      where p.status in ('open','closing')
        and coalesce(p.protection_status,'missing') <> 'native_verified'
    ) as unprotected_positions,
    max(p.updated_at) filter (where p.status in ('open','closing')) as last_position_update_at
  from public.futures_positions p
  where p.user_id = bc.user_id and p.bot_id = bc.id
) futures_stats on true
left join lateral (
  select count(*) as orders_24h, max(o.created_at) as last_order_at
  from public.orders o
  where o.user_id = bc.user_id
    and o.bot_id = bc.id
    and o.created_at >= now() - interval '24 hours'
) order_stats on true
left join lateral (
  select e.severity, e.code, e.message, e.created_at
  from public.risk_events e
  where e.user_id = bc.user_id and e.bot_id = bc.id
  order by e.created_at desc
  limit 1
) latest_risk on true
left join public.bot_stream_state private_stream
  on private_stream.user_id = bc.user_id and private_stream.bot_id = bc.id
left join public.bot_shadow_stream_state shadow_stream
  on shadow_stream.user_id = bc.user_id and shadow_stream.bot_id = bc.id
left join public.bot_orderbook_stream_state orderbook_stream
  on orderbook_stream.user_id = bc.user_id and orderbook_stream.bot_id = bc.id
left join lateral (
  select s.checked_at, s.last_error, s.spot_open_orders, s.linear_open_orders
  from public.bybit_demo_live_snapshot s
  where s.user_id = bc.user_id
  order by s.checked_at desc
  limit 1
) snapshot on true;

comment on view public.platform_runtime_observation is
  'Read-only Runtime observation for Platform V2. Aggregates current legacy bot runs, streams, positions, exchange snapshot, orders and risk events without execution control.';

revoke all on public.platform_runtime_observation from anon;
grant select on public.platform_runtime_observation to authenticated;