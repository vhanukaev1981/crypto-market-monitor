import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const root=new URL('../../',import.meta.url);
const spotResearchWorkflow=readFileSync(new URL('.github/workflows/algo-v2-bybit-spot-research.yml',root),'utf8');
const oosWorkflow=readFileSync(new URL('.github/workflows/algo-v2-bybit-spot-blind-oos.yml',root),'utf8');

test('spot research workflow tracks freeze-governance files so regression cannot silently skip them', () => {
  for(const requiredPath of [
    'crypto-market-monitor-full-source/algo/algo-v2-candidate-freeze.mjs',
    'crypto-market-monitor-full-source/validation/algo-v2-candidate-freeze.json',
  ]) assert.match(spotResearchWorkflow,new RegExp(requiredPath.replaceAll(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});

test('dedicated blind OOS workflow exists and uploads immutable evidence artifact', () => {
  for(const requiredText of [
    'name: ALGO V2 Bybit Spot Blind OOS',
    'crypto-market-monitor-full-source/scripts/run-bybit-spot-blind-oos.mjs',
    'crypto-market-monitor-full-source/algo/algo-v2-blind-oos.mjs',
    'crypto-market-monitor-full-source/validation/bybit-spot-blind-oos-trigger.txt',
    'algo-v2-btc-bybit-spot-blind-oos',
    '--out validation-results/BTCUSDT-SPOT-BLIND-OOS.json',
    '--digest-out validation-results/BTCUSDT-SPOT-BLIND-OOS.sha256',
    'if-no-files-found: error',
  ]) assert.match(oosWorkflow,new RegExp(requiredText.replaceAll(/[.*+?^${}()|[\]\\]/g,'\\$&')));
});
