do $$
declare
  v_jobid bigint;
begin
  select jobid into v_jobid
  from cron.job
  where jobname = 'futures_demo_engine_15m';

  if v_jobid is not null then
    perform cron.alter_job(job_id := v_jobid, active := false);
  end if;
end
$$;
