import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
const db=process.env.ALGOBOT_TEST_DATABASE_URL;
const path=resolve(dirname(fileURLToPath(import.meta.url)),'../supabase/migrations/20260905_algobot_p0_execution.sql');
function psql(sql) {
  assert.ok(db,'real PostgreSQL ALGOBOT_TEST_DATABASE_URL required');
  const r=spawnSync('psql',[db,'-v','ON_ERROR_STOP=1','-X','-q','-A','-t','-c',sql],{encoding:'utf8'});
  assert.equal(r.status,0,r.stderr||r.stdout);
  return r.stdout.trim();
}
test.before(()=>{
  assert.ok(db,'real PostgreSQL required');
  const r=spawnSync('psql',[db,'-v','ON_ERROR_STOP=1','-X','-q'],{
    input:readFileSync(path,'utf8'),encoding:'utf8'
  });
  assert.equal(r.status,0,r.stderr||r.stdout);
  psql("do $$ begin if not exists (select 1 from pg_roles where rolname='algobot_p0_acl_probe') then create role algobot_p0_acl_probe nologin; end if; end $$;");
});
test('all four P0 safety tables enforce row-level security',()=>{
  assert.equal(psql("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('bot_state_meta','canary_reservations','execution_ledger','position_lifecycle') and c.relrowsecurity;"),'4');
});
test('unprivileged PostgreSQL role cannot update authority or ledger tables',()=>{
  assert.equal(psql("select count(*) from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relname in ('bot_state_meta','canary_reservations','execution_ledger','position_lifecycle') and (has_table_privilege('algobot_p0_acl_probe',c.oid,'INSERT') or has_table_privilege('algobot_p0_acl_probe',c.oid,'UPDATE') or has_table_privilege('algobot_p0_acl_probe',c.oid,'DELETE'));"),'0');
});
test('unprivileged PostgreSQL role cannot call ALGOBOT mutation functions',()=>{
  assert.equal(psql("select count(*) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'algobot_%' and p.proname <> 'algobot_list_unresolved_executions' and has_function_privilege('algobot_p0_acl_probe',p.oid,'EXECUTE');"),'0');
});
