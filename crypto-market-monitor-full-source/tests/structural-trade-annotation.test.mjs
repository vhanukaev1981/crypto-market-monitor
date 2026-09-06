import test from 'node:test';
import assert from 'node:assert/strict';
import { annotateTradesWithStructuralPersistence } from '../algo/structural-trade-annotation.mjs';

function makeHourly(n,{start='2020-01-01T00:00:00Z',slope=0.05}={}) {
  const t0=Date.parse(start);
  return Array.from({length:n},(_,i)=>{
    const close=100+slope*i;
    return {time:new Date(t0+i*3600000).toISOString(),open:close-0.02,high:close+0.1,low:close-0.1,close,volume:100};
  });
}

test('annotates a trade using only completed 4H and 1D structure available at entry',()=>{
  const candles=makeHourly(6500);
  const trade={entryTime:candles[6000].time,pnl:100};
  const [a]=annotateTradesWithStructuralPersistence({candles,trades:[trade]});
  assert.ok(Number.isInteger(a.entry4hTrendAgeBars));
  assert.ok(a.entry4hTrendAgeBars>0);
  assert.equal(a.entry4hTransitionCount12,0);
  assert.ok(a.entry4hEmaSpreadPct>0);
  assert.ok(a.entry1dDistanceAboveEma200Pct>0);
});

test('future candles cannot change structural features assigned to an earlier entry',()=>{
  const base=makeHourly(6500);
  const entryTime=base[6000].time;
  const altered=base.map((c,i)=>i<=6000?c:{...c,close:c.close*0.2,open:c.open*0.2,high:c.high*0.2,low:c.low*0.2});
  const left=annotateTradesWithStructuralPersistence({candles:base,trades:[{entryTime,pnl:1}]})[0];
  const right=annotateTradesWithStructuralPersistence({candles:altered,trades:[{entryTime,pnl:1}]})[0];
  for (const key of ['entry4hTrendAgeBars','entry4hTransitionCount12','entry4hEmaSpreadPct','entry1dDistanceAboveEma200Pct']) {
    assert.equal(left[key],right[key]);
  }
});

test('fails closed when a trade has no valid entry timestamp',()=>{
  assert.throws(()=>annotateTradesWithStructuralPersistence({candles:makeHourly(6500),trades:[{entryTime:'bad',pnl:1}]}),/INVALID_TRADE_ENTRY_TIME/);
});
