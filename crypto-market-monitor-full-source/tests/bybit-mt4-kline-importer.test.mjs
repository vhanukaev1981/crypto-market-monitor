import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBybitMt4Klines15m, aggregate15mTo1h } from '../algo/bybit-mt4-kline-importer.mjs';

const sample = [
  '2024.01.01 00:00,100,102,99,101,10',
  '2024.01.01 00:15,101,103,100,102,20',
  '2024.01.01 00:30,102,104,101,103,30',
  '2024.01.01 00:45,103,105,102,104,40',
  '2024.01.01 01:00,104,106,103,105,50',
].join('\n');

test('parses official Bybit MT4 15m CSV rows as UTC candles', () => {
  const rows = parseBybitMt4Klines15m(sample);
  assert.equal(rows.length, 5);
  assert.deepEqual(rows[0], {
    time: '2024-01-01T00:00:00.000Z',
    open: 100,
    high: 102,
    low: 99,
    close: 101,
    volume: 10,
  });
});

test('aggregates exactly four contiguous 15m candles into one 1H candle', () => {
  const rows = parseBybitMt4Klines15m(sample);
  const h1 = aggregate15mTo1h(rows);
  assert.equal(h1.length, 1);
  assert.deepEqual(h1[0], {
    time: '2024-01-01T00:00:00.000Z',
    open: 100,
    high: 105,
    low: 99,
    close: 104,
    volume: 100,
  });
});

test('drops incomplete hourly buckets', () => {
  const rows = parseBybitMt4Klines15m(sample);
  assert.equal(aggregate15mTo1h(rows).length, 1);
});

test('deduplicates an identical repeated timestamp at archive boundaries', () => {
  const duplicateBoundary = [
    '2024.01.31 23:45,100,102,99,101,10',
    '2024.02.01 00:00,101,103,100,102,20',
    '2024.02.01 00:00,101,103,100,102,20',
    '2024.02.01 00:15,102,104,101,103,30',
  ].join('\n');
  const rows = parseBybitMt4Klines15m(duplicateBoundary);
  assert.equal(rows.length, 3);
  assert.equal(rows[1].time, '2024-02-01T00:00:00.000Z');
});

test('fails closed when duplicate timestamp has conflicting OHLCV', () => {
  const conflicting = [
    '2024.02.01 00:00,101,103,100,102,20',
    '2024.02.01 00:00,101,104,100,102,20',
  ].join('\n');
  assert.throws(() => parseBybitMt4Klines15m(conflicting), /CONFLICTING_MT4_DUPLICATE/);
});

test('rejects backward timestamps', () => {
  const backward = [
    '2024.02.01 00:15,102,104,101,103,30',
    '2024.02.01 00:00,101,103,100,102,20',
  ].join('\n');
  assert.throws(() => parseBybitMt4Klines15m(backward), /NON_ASCENDING_MT4_TIMESTAMP/);
});
