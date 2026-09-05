do $$
begin
  if exists (select 1 from cron.job where jobname = 'futures_demo_engine_15m') then
    perform cron.alter_job(
      (select jobid from cron.job where jobname = 'futures_demo_engine_15m'),
      active := true
    );
  end if;
end
$$;
