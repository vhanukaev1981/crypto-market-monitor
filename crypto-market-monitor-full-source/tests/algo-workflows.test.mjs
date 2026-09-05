import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root=new URL('../../',import.meta.url);
const spotResearchWorkflow=readFileSync(new URL('.github/workflows/algo-v2-bybit-spot-research.yml',root),'utf8');
const oosWorkflow=readFileSync(new URL('.github/workflows/algo-v2-bybit-spot-blind-oos.yml',root),'utf8');
const oosVerifyWorkflow=readFileSync(new URL('.github/workflows/algo-v2-bybit-spot-blind-oos-verify.yml',root),'utf8');

test('spot research workflow tracks freeze-governance files so regression cannot silently skip them', () => {
  for(const requiredPath of [
    'crypto-market-monitor-full-source/algo/algo-v2-candidate-freeze.mjs',
    'crypto-market-monitor-full-source/validation/algo-v2-candidate-freeze.json',
  ]) assert.match(spotResearchWorkflow,new RegExp(requiredPath.replaceAll(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});

test('blind OOS opening workflow is dispatch-only and uploads isolated one-time evidence artifact', () => {
  assert.doesNotMatch(oosWorkflow,/\n\s+push:/);
  for(const requiredText of [
    'name: ALGO V2 Bybit Spot Blind OOS',
    'workflow_dispatch:',
    'working-directory: crypto-market-monitor-full-source',
    'node scripts/run-bybit-spot-blind-oos.mjs',
    'algo-v2-btc-bybit-spot-blind-oos',
    '--out validation-results/BTCUSDT-SPOT-BLIND-OOS.json',
    '--digest-out validation-results/BTCUSDT-SPOT-BLIND-OOS.sha256',
    'if-no-files-found: error',
  ]) assert.match(oosWorkflow,new RegExp(requiredText.replaceAll(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});

test('verification-only blind OOS workflow validates committed evidence without reopening market data', () => {
  assert.match(oosVerifyWorkflow,/name: ALGO V2 Bybit Spot Blind OOS Verify/);
  assert.match(oosVerifyWorkflow,/\n\s+push:/);
  assert.match(oosVerifyWorkflow,/workflow_dispatch:/);
  assert.match(oosVerifyWorkflow,/crypto-market-monitor-full-source\/scripts\/verify-bybit-spot-blind-oos\.mjs/);
  assert.match(oosVerifyWorkflow,/crypto-market-monitor-full-source\/validation\/algo-v2-btcusdt-blind-oos\.json/);
  assert.match(oosVerifyWorkflow,/crypto-market-monitor-full-source\/validation\/algo-v2-btcusdt-blind-oos\.sha256/);
  assert.doesNotMatch(oosVerifyWorkflow,/run-bybit-spot-blind-oos\.mjs/);
  assert.doesNotMatch(oosVerifyWorkflow,/public\.bybit\.com\/spot/);
});
