import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeSignalFunnel } from '../algo/signal-funnel.mjs';

const events=[
  {time:'2021-01-01T00:00:00.000Z',action:'NO_TRADE',reason:'TREND_CONFIRMATION_FAILED',regime:'TREND_UP',regimeConfidence:100,structural1d:'TREND_DOWN',confirmation4h:'TREND_UP'},
  {time:'2021-01-01T01:00:00.000Z',action:'NO_TRADE',reason:'PULLBACK_QUALITY_FAILED',regime:'TREND_UP',regimeConfidence:100,structural1d:'TREND_UP',confirmation4h:'TREND_UP'},
  {time:'2021-01-01T02:00:00.000Z',action:'BUY_CANDIDATE',reason:'SETUP_VALID',regime:'TREND_UP',regimeConfidence:100,structural1d:'TREND_UP',confirmation4h:'TREND_UP',score:80},
  {time:'2022-02-01T00:00:00.000Z',action:'NO_TRADE',reason:'REGIME_NOT_ALLOWED',regime:'TREND_DOWN',regimeConfidence:85,structural1d:'TREND_DOWN',confirmation4h:'TREND_DOWN'},
];

test('summarizes flat-bar signal evaluation funnel by year and reason',()=>{
  const r=summarizeSignalFunnel(events);
  assert.equal(r.total.evaluatedBars,4);
  assert.equal(r.total.buyCandidates,1);
  assert.equal(r.total.blockedBars,3);
  assert.equal(r.byYear['2021'].evaluatedBars,3);
  assert.equal(r.byYear['2021'].buyCandidates,1);
  assert.equal(r.byYear['2021'].reasons.TREND_CONFIRMATION_FAILED,1);
  assert.equal(r.byYear['2021'].reasons.PULLBACK_QUALITY_FAILED,1);
  assert.equal(r.byYear['2022'].reasons.REGIME_NOT_ALLOWED,1);
  assert.equal(r.byYear['2022'].regimes.TREND_DOWN,1);
  assert.equal(r.byYear['2021'].structural1d.TREND_UP,2);
  assert.equal(r.byYear['2021'].confirmation4h.TREND_UP,3);
});

test('rejects malformed funnel events',()=>{
  assert.throws(()=>summarizeSignalFunnel([{time:'bad',action:'NO_TRADE',reason:'X'}]),/INVALID_SIGNAL_FUNNEL_EVENT/);
  assert.throws(()=>summarizeSignalFunnel([{time:'2021-01-01T00:00:00Z',action:'NO_TRADE'}]),/INVALID_SIGNAL_FUNNEL_EVENT/);
});
