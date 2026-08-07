alter table public.exchange_connections
  add constraint exchange_connections_withdrawals_hard_locked
  check (withdrawals_enabled = false);

alter table public.trading_accounts
  add constraint trading_accounts_withdrawals_hard_locked
  check (withdrawals_enabled = false);

alter table public.risk_profiles
  add constraint risk_profiles_withdrawals_hard_locked
  check (allow_withdrawals = false);
