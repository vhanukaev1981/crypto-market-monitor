revoke all on public.platform_legacy_bot_mapping from anon, authenticated;
grant select on public.platform_legacy_bot_mapping to authenticated;

revoke all on public.platform_runtime_observation from anon, authenticated;
grant select on public.platform_runtime_observation to authenticated;

comment on view public.platform_legacy_bot_mapping is
  'Read-only control-plane observation of legacy bot runtime using caller permissions and RLS. Authenticated callers have SELECT only.';

comment on view public.platform_runtime_observation is
  'Read-only Runtime observation for Platform V2 using caller permissions and RLS. Authenticated callers have SELECT only; no execution control.';
