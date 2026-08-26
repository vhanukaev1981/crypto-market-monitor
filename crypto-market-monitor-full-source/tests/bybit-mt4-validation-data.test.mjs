import test from 'node:test';
import assert from 'node:assert/strict';
import { prepareBybitMt4Hourly } from '../algo/bybit-mt4-validation-data.mjs';

function hour(h, base=100) {
  return [0,15,30,45].map((m,i)=>{
    const dt=new Date(Date.UTC(2024,0,1,h,m));
    const stamp=`${dt.getUTCFullYear()}.${String(dt.getUTCMonth()+1).padStart(2,'0')}.${String(dt.getUTCDate()).padStart(2,'0')} ${String(dt.getUTCHours()).padStart(2,'0')}:${String(dt.getUTCMinutes()).padStart(2,'0')}`;
    const o=base+i, c=o+0.5;
    return `${stamp},${o},${o+1},${o-1},${c},10`;
  });
}

function hourlyRow(h, base=100) {
  const dt=new Date(Date.UTC(2024,0,1,h,0));
  const stamp=`${dt.getUTCFullYear()}.${String(dt.getUTCMonth()+1).padStart(2,'0')}.${String(dt.getUTCDate()).padStart(2,'0')} ${String(dt.getUTCHours()).padStart(2,'0')}:00`;
  return `${stamp},${base},${base+2},${base-1},${base+1},100`;
}

test('prepares 15m MT4 archive to contiguous 1H candles and reports a minor repaired gap', () => {
  const text=[...hour(0,100),...hour(2,110)].join('\n');
  const r=prepareBybitMt4Hourly(text,{sourceMinutes:15,maxGapHours:3});
  assert.equal(r.rawSourceCount,8);
  assert.equal(r.native1hCount,2);
  assert.equal(r.candles.length,3);
  assert.equal(r.gapsFilled,1);
  assert.equal(r.gapEvents.length,1);
  assert.equal(r.candles[1].synthetic,true);
  assert.equal(r.candles[1].volume,0);
});

test('uses official 60m MT4 rows directly without resampling', () => {
  const text=[hourlyRow(0,100),hourlyRow(1,110),hourlyRow(2,120)].join('\n');
  const r=prepareBybitMt4Hourly(text,{sourceMinutes:60,maxGapHours:3});
  assert.equal(r.rawSourceCount,3);
  assert.equal(r.native1hCount,3);
  assert.equal(r.candles.length,3);
  assert.equal(r.gapsFilled,0);
  assert.equal(r.candles[1].open,110);
  assert.equal(r.candles[1].close,111);
});

test('fails closed when MT4 archive contains a large hourly gap', () => {
  const text=[hourlyRow(0,100),hourlyRow(5,110)].join('\n');
  assert.throws(()=>prepareBybitMt4Hourly(text,{sourceMinutes:60,maxGapHours:3}),/HOURLY_GAP_TOO_LARGE/);
});
