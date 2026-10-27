import test from 'node:test';
import assert from 'node:assert/strict';
import { createExecutorFence } from '../algo/executor-fence.mjs';

test('executor fence enforces strict constructor bounds without SQL calls',()=> {
  const pool={query:async()=>{throw new Error('should not query');}};
  assert.throws(()=>createExecutorFence({pool,ownerId:' '}),/ownerId/);
  assert.throws(()=>createExecutorFence({pool:{},ownerId:'a'}),/pool/);
  assert.throws(()=>createExecutorFence({pool,ownerId:'a',leaseMs:0}),/leaseMs/);
  assert.throws(()=>createExecutorFence({pool,ownerId:'a',leaseMs:300001}),/leaseMs/);
});

test('acquire returns only validated PostgreSQL ownership evidence',async()=> {
  const calls=[];
  const pool={query:async(sql,args)=>{calls.push({sql,args});return {rows:[{owner_id:'executor-a',fence_token:'42',lease_expires_at:'2030-01-01T00:00:00Z'}]};}};
  const fence=createExecutorFence({pool,ownerId:'executor-a'});
  assert.deepEqual(await fence.acquire(),{ownerId:'executor-a',fenceToken:42,leaseExpiresAt:'2030-01-01T00:00:00Z'});
  assert.deepEqual(calls[0].args,['executor-a',30000]);
  assert.match(calls[0].sql,/public\.algobot_acquire_executor/);
});

test('rejects missing or malformed acquisition evidence',async()=> {
  const noRows=createExecutorFence({ownerId:'a',pool:{query:async()=>({rows:[]})}});
  await assert.rejects(noRows.acquire(),/no row/);
  const badToken=createExecutorFence({ownerId:'a',pool:{query:async()=>({rows:[{owner_id:'a',fence_token:'9007199254740993',lease_expires_at:'tomorrow'}]})}});
  await assert.rejects(badToken.acquire(),/safe integer/);
  const wrongOwner=createExecutorFence({ownerId:'a',pool:{query:async()=>({rows:[{owner_id:'b',fence_token:'1',lease_expires_at:'tomorrow'}]})}});
  await assert.rejects(wrongOwner.acquire(),/inconsistent/);
});

test('renew/assert/release reject missing invalid tokens before SQL',async()=> {
  let calls=0;
  const f=createExecutorFence({ownerId:'a',pool:{query:async()=>{calls++;return {rows:[{lease_expires_at:'tomorrow'}]};}}});
  await assert.rejects(f.renew(),/fenceToken/);
  await assert.rejects(f.assertCurrent({fenceToken:0}),/fenceToken/);
  await assert.rejects(f.release({fenceToken:-1}),/fenceToken/);
  assert.equal(calls,0);
});

test('each operation queries PostgreSQL and fails closed on DB errors',async()=> {
  let calls=0;
  const f=createExecutorFence({ownerId:'a',pool:{query:async()=>{calls++;throw new Error('database unavailable');}}});
  await assert.rejects(f.acquire(),/database unavailable/);
  await assert.rejects(f.renew({fenceToken:1}),/database unavailable/);
  await assert.rejects(f.assertCurrent({fenceToken:1}),/database unavailable/);
  await assert.rejects(f.release({fenceToken:1}),/database unavailable/);
  assert.equal(calls,4);
});

test('no-row acknowledgements are not treated as success',async()=> {
  const f=createExecutorFence({ownerId:'a',pool:{query:async()=>({rows:[]})}});
  await assert.rejects(f.renew({fenceToken:1}),/no row/);
  await assert.rejects(f.assertCurrent({fenceToken:1}),/no row/);
  await assert.rejects(f.release({fenceToken:1}),/no row/);
});
