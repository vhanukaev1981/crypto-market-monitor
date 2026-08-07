create or replace view public.platform_legacy_bot_mapping as
select
  bi.organization_id,
  bi.id as platform_bot_id,
  bi.bot_key,
  bi.display_name,
  (bi.parameters ->> 'legacy_bot_id')::uuid as legacy_bot_id,
  bi.execution_environment,
  bi.runtime_status as platform_runtime_status,
  bi.enabled as platform_enabled,
  bi.kill_switch as platform_kill_switch,
  bi.live_gate_status,
  coalesce(bc.status::text, bi.parameters ->> 'legacy_runtime_status', 'missing') as legacy_runtime_status,
  coalesce(bc.enabled, (bi.parameters ->> 'legacy_enabled')::boolean, false) as legacy_enabled,
  coalesce(bc.kill_switch, (bi.parameters ->> 'legacy_kill_switch')::boolean, true) as legacy_kill_switch,
  coalesce(bi.parameters ->> 'platform_core_controls_execution', 'false') as platform_core_controls_execution,
  coalesce(bc.last_run_at, bi.last_run_at) as last_run_at,
  bc.environment::text as legacy_environment,
  bc.category::text as legacy_category,
  bc.updated_at as legacy_updated_at,
  case
    when bc.id is null then 'missing_legacy_bot'
    when coalesce((bi.parameters ->> 'platform_core_controls_execution')::boolean, false) then 'platform_controls_execution'
    when bc.environment::text = 'mainnet' and bc.enabled = false and bc.kill_switch = true then 'live_locked'
    when bc.enabled = true and bc.kill_switch = false and bc.status::text = 'running' then 'legacy_active_observed'
    else 'legacy_inactive_observed'
  end as sync_status,
  now() as sync_checked_at
from public.bot_instances bi
left join public.bot_configs bc
  on bc.id = (bi.parameters ->> 'legacy_bot_id')::uuid
 and exists (
   select 1
   from public.platform_memberships m
   where m.organization_id = bi.organization_id
     and m.user_id = bc.user_id
     and m.status = 'active'
 )
where public.platform_is_org_member(bi.organization_id)
  and bi.parameters ? 'legacy_bot_id';

comment on view public.platform_legacy_bot_mapping is
  'Read-only control-plane observation of legacy bot runtime. Platform fields remain authoritative only for future Platform Core control; legacy runtime fields are read live from bot_configs.';

grant select on public.platform_legacy_bot_mapping to authenticated;
