alter view public.platform_legacy_bot_mapping set (security_invoker = true);

comment on view public.platform_legacy_bot_mapping is
  'Read-only control-plane observation of legacy bot runtime using caller permissions and RLS. Platform fields remain authoritative only for future Platform Core control; legacy runtime fields are read live from bot_configs.';
