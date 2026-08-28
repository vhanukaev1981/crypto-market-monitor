import test from 'node:test';
import assert from 'node:assert/strict';
import { FROZEN_ALGO_V2_CANDIDATE_FREEZE_RECORD } from '../algo/algo-v2-candidate-freeze.mjs';
import {
  latestFullyClosedMonthUtc,
  assertBlindOosCanOpen,
  assertFrozenBlindOosRecord,
  sha256Hex,
} from '../algo/algo-v2-blind-oos.mjs';

test('latest fully closed UTC month excludes the current open month', () => {
  assert.equal(latestFullyClosedMonthUtc(new Date('2026-08-28T16:23:48.902Z')),'2026-07');
  assert.equal(latestFullyClosedMonthUtc(new Date('2026-01-01T00:00:00.000Z')),'2025-12');
});

test('blind OOS opening fails closed if already opened or freeze state drifted', () => {
  assert.throws(
    ()=>assertBlindOosCanOpen({
      freezeRecord:FROZEN_ALGO_V2_CANDIDATE_FREEZE_RECORD,
      blindOosEvidenceExists:true,
    }),
    /BLIND_OOS_ALREADY_EXECUTED/,
  );
  assert.throws(
    ()=>assertBlindOosCanOpen({
      freezeRecord:{
        ...FROZEN_ALGO_V2_CANDIDATE_FREEZE_RECORD,
        freeze:{...FROZEN_ALGO_V2_CANDIDATE_FREEZE_RECORD.freeze,blindOosOpened:true},
      },
    }),
    /BLIND_OOS_ALREADY_OPENED/,
  );
});

test('blind OOS verifier rejects digest drift and second selection use', () => {
  const record={
    schemaVersion:1,
    freezeEvidence:{
      head:'03211a2a7d1bb55b20fc9d9b91b39cfd1c1ac3f9',
      candidateThresholdPct:25,
    },
    oos:{
      state:'OPENED_ONCE',
      startMonth:'2025-01',
      endMonth:'2026-07',
      openCount:1,
      blindOosOpened:true,
      tuningAfterFreeze:false,
      selectionReuseAllowed:false,
      promotionState:'FAIL_CLOSED_OOS',
    },
    provenance:{
      market:'BYBIT_SPOT',
      source:'BYBIT_PUBLIC_SPOT_TRADE_ARCHIVES',
      syntheticRepair:false,
      gapCount:2,
      syntheticCandles:1,
    },
    parameters:FROZEN_ALGO_V2_CANDIDATE_FREEZE_RECORD.parameters,
    metrics:{
      netReturnPct:-1,
      maxDrawdownPct:1,
      profitFactor:0.9,
      expectancy:-10,
      completedTrades:3,
      maxObservedExposurePct:20,
      maxPostControlExposurePct:20,
    },
    passCriteria:FROZEN_ALGO_V2_CANDIDATE_FREEZE_RECORD.blindOosPassCriteria,
    evaluation:{
      passed:false,
      checks:{
        netReturnPct:false,
        profitFactor:false,
        expectancy:false,
        maxDrawdownPct:true,
        maxExposurePct:true,
        syntheticRepair:true,
        dataQualityViolations:false,
        tuningAfterFreeze:true,
      },
    },
  };
  const digest=sha256Hex(JSON.stringify(record,null,2)+'\n');
  assert.equal(assertFrozenBlindOosRecord(record,{digest}),record);
  assert.throws(()=>assertFrozenBlindOosRecord(record,{digest:`sha256:${'0'.repeat(64)}`}),/BLIND_OOS_DIGEST_MISMATCH/);
  assert.throws(
    ()=>assertFrozenBlindOosRecord({
      ...record,
      oos:{...record.oos,selectionReuseAllowed:true},
    },{digest}),
    /BLIND_OOS_SELECTION_REUSE_FORBIDDEN/,
  );
});
