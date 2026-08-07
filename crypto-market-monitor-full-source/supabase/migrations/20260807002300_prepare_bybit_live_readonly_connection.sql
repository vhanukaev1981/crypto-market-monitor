update public.exchange_connections
set status = 'disconnected',
    credential_ref = 'BYBIT_LIVE_API_KEY/BYBIT_LIVE_API_SECRET',
    connector_version = 'bybit-live-readonly-probe-v1',
    is_read_only = true,
    trading_enabled = false,
    withdrawals_enabled = false,
    permissions = jsonb_build_object('read', true, 'trade', false, 'withdraw', false, 'readOnly', true),
    metadata = coalesce(metadata, '{}'::jsonb) || jsonb_build_object(
      'connection_stage', 'pending_live_read_only_credentials',
      'platform_core_controls_execution', false,
      'requires_static_egress_before_trade_key', true
    ),
    last_error = null,
    updated_at = now()
where exchange = 'bybit'
  and environment::text = 'mainnet';

update public.trading_accounts ta
set status = 'connecting',
    trading_enabled = false,
    withdrawals_enabled = false,
    last_error = null,
    metadata = coalesce(ta.metadata, '{}'::jsonb) || jsonb_build_object(
      'connection_stage', 'pending_live_read_only_credentials',
      'platform_core_execution_locked', true,
      'requires_static_egress_before_trade_key', true
    ),
    updated_at = now()
from public.exchange_connections ec
where ta.connection_id = ec.id
  and ec.exchange = 'bybit'
  and ec.environment::text = 'mainnet'
  and ta.environment = 'live';

update public.bot_instances
set enabled = false,
    kill_switch = true,
    runtime_status = 'stopped',
    live_gate_status = 'locked',
    last_error = null,
    updated_at = now()
where execution_environment = 'live';

update public.risk_profiles
set status = 'locked',
    allow_withdrawals = false,
    updated_at = now()
where environment = 'live';
