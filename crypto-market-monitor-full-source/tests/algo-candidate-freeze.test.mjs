import test from 'node:test';
import assert from 'node:assert/strict';
import { readFrozenAlgoV2CandidateFreezeRecord, assertFrozenAlgoV2CandidateFreezeRecord } from '../algo/algo-v2-candidate-freeze.mjs';

test('persists the immutable frozen 25% candidate record for the future blind OOS gate', async () => {
  const record=await readFrozenAlgoV2CandidateFreezeRecord();
  assert.equal(record.evidence.researchHead,'03211a2a7d1bb55b20fc9d9b91b39cfd1c1ac3f9');
  assert.equal(record.evidence.workflowRunId,33065509531);
  assert.equal(record.evidence.artifact.id,9643733715);
  assert.equal(record.evidence.artifact.digest,'sha256:757f23fe259f81bfa275a9a2ed2324274de13bcc00fe9b3bb900f98e181d0021');
  assert.equal(record.freeze.candidateName,'DAILY_EMA200_OVEREXTENSION');
  assert.equal(record.freeze.candidateState,'FROZEN_FOR_FUTURE_BLIND_OOS');
  assert.equal(record.freeze.thresholdPct,25);
  assert.deepEqual(record.freeze.sensitivityOnlyThresholdsPct,[20,30]);
  assert.equal(record.freeze.oosLocked,true);
  assert.equal(record.freeze.blindOosOpened,false);
  assert.equal(record.parameters.maxPositionPct,0.25);
  assert.equal(record.parameters.hardExposurePct,0.30);
  assert.deepEqual(record.metrics.research2023,{
    netReturnPct:5.802356,
    maxDrawdownPct:1.93061,
    profitFactor:4.525931,
    expectancy:362.647258,
    completedTrades:16,
  });
  assert.deepEqual(record.metrics.validation2024,{
    netReturnPct:0.484937,
    maxDrawdownPct:3.125476,
    profitFactor:1.07045,
    expectancy:12.123436,
    completedTrades:40,
  });
  assert.deepEqual(record.blindOosPassCriteria,{
    netReturnPct:'>0',
    profitFactor:'>1.0',
    expectancy:'>0',
    maxDrawdownPct:'<=5.0',
    maxExposurePct:'<=30.0',
    syntheticRepair:false,
    dataQualityViolations:0,
    tuningAfterFreeze:false,
  });
});

test('freeze verifier fails closed on threshold, parameter, provenance, and OOS state drift', async () => {
  const record=await readFrozenAlgoV2CandidateFreezeRecord();
  assert.throws(
    ()=>assertFrozenAlgoV2CandidateFreezeRecord({...record,freeze:{...record.freeze,thresholdPct:30}}),
    /FROZEN_CANDIDATE_THRESHOLD_DRIFT/,
  );
  assert.throws(
    ()=>assertFrozenAlgoV2CandidateFreezeRecord({...record,parameters:{...record.parameters,riskPct:0.004}}),
    /FROZEN_RISK_PARAMETER_DRIFT:riskPct/,
  );
  assert.throws(
    ()=>assertFrozenAlgoV2CandidateFreezeRecord({...record,parameters:{...record.parameters,slippageBps:3}}),
    /FROZEN_EXECUTION_PARAMETER_DRIFT:slippageBps/,
  );
  assert.throws(
    ()=>assertFrozenAlgoV2CandidateFreezeRecord({...record,provenance:{...record.provenance,source:'BYBIT_PUBLIC_MT4_KLINES'}}),
    /FROZEN_PROVENANCE_DRIFT:source/,
  );
  assert.throws(
    ()=>assertFrozenAlgoV2CandidateFreezeRecord({...record,freeze:{...record.freeze,blindOosOpened:true}}),
    /BLIND_OOS_ALREADY_OPENED/,
  );
  assert.throws(
    ()=>assertFrozenAlgoV2CandidateFreezeRecord({...record,freeze:{...record.freeze,oosLocked:false}}),
    /OOS_LOCK_STATE_DRIFT/,
  );
});
