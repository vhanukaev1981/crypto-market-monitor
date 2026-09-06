import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeRiskDecisions } from '../algo/risk-decision-attribution.mjs';

const events=[
  {time:'2021-01-01T00:00:00.000Z',decision:'APPROVED',approvedNotional:1000,reasonCode:'RISK_OK'},
  {time:'2021-01-02T00:00:00.000Z',decision:'HALT_SYSTEM',approvedNotional:0,reasonCode:'RISK_003_MAX_DRAWDOWN'},
  {time:'2022-01-01T00:00:00.000Z',decision:'HALT_SYSTEM',approvedNotional:0,reasonCode:'RISK_003_MAX_DRAWDOWN'},
  {time:'2022-01-02T00:00:00.000Z',decision:'REJECTED',approvedNotional:0,reasonCode:'RISK_002_DAILY_LOSS'},
];

test('summarizes risk decisions by year decision and reason',()=>{
  const r=summarizeRiskDecisions(events);
  assert.equal(r.total.evaluatedSignals,4);
  assert.equal(r.total.approvedSignals,1);
  assert.equal(r.total.blockedSignals,3);
  assert.equal(r.total.decisions.HALT_SYSTEM,2);
  assert.equal(r.total.reasons.RISK_003_MAX_DRAWDOWN,2);
  assert.equal(r.byYear['2021'].evaluatedSignals,2);
  assert.equal(r.byYear['2021'].approvedSignals,1);
  assert.equal(r.byYear['2022'].blockedSignals,2);
  assert.equal(r.byYear['2022'].reasons.RISK_003_MAX_DRAWDOWN,1);
  assert.equal(r.byYear['2022'].reasons.RISK_002_DAILY_LOSS,1);
});

test('rejects malformed risk events',()=>{
  assert.throws(()=>summarizeRiskDecisions([{time:'bad',decision:'APPROVED',reasonCode:'RISK_OK',approvedNotional:1}]),/INVALID_RISK_DECISION_EVENT/);
  assert.throws(()=>summarizeRiskDecisions([{time:'2021-01-01T00:00:00Z',decision:'APPROVED'}]),/INVALID_RISK_DECISION_EVENT/);
});
