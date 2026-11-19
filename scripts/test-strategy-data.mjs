import test from 'node:test';
import assert from 'node:assert/strict';
import { refreshStrategyCache } from './strategy-data.mjs';
import { TRADERS, RETIRED_ADDRESSES } from './traders.mjs';

const DAY = 86400000;
const HOUR = 3600000;
const NOW = Date.parse('2026-11-20T01:00:00Z');
const TARGET = '2026-10-22T00:00:00.000Z';
const GOLD = TRADERS[0].user;
const TRADE_COLUMNS = [
  'address', 'market', 'hour', 'fills', 'buys', 'sells', 'open_short_usd',
  'close_short_usd', 'open_long_usd', 'close_long_usd', 'low', 'high',
  'open_short_vwap', 'close_short_vwap',
];
const FUNDING_COLUMNS = ['address', 'market', 'day', 'funding_usdc'];

function response(sql, rows = []) {
  const names = sql.includes('FROM hl.funding_payments') ? FUNDING_COLUMNS : TRADE_COLUMNS;
  return {
    columns: names.map(name => ({ name })),
    rows: rows.map(row => names.map(name => row[name])),
    truncated: false,
    limits: { history_days: 30 },
  };
}

function legacyCache() {
  return {
    version: 1,
    fromISO: TARGET,
    toISO: '2026-11-19T01:00:00.000Z',
    trades: [{ address: RETIRED_ADDRESSES[0], market: 'BTC-PERP', hour: '2026-10-01 00:00:00', marker: 'keep' }],
    hedgeFlows: [],
    fundingDays: [],
  };
}

function readyCache() {
  const cache = legacyCache();
  cache.coverageByAddress = Object.fromEntries(TRADERS.map(({ user }) => [user, {
    fromISO: TARGET, toISO: cache.toISO, state: 'ready',
    ranges: [{ fromISO: TARGET, toISO: cache.toISO }],
  }]));
  return cache;
}

function queryWindow(sql) {
  return [...sql.matchAll(/toDateTime\('([^']+)'/g)].map(match => Date.parse(match[1].replace(' ', 'T') + 'Z'));
}

test('legacy metadata migrates only gold, while new addresses remain pending without a key', async () => {
  const original = legacyCache();
  const result = await refreshStrategyCache({ cache: original, now: NOW });
  assert.equal(result.calls, 0);
  assert.equal(result.cache.coverageByAddress[GOLD].fromISO, TARGET);
  assert.equal(result.cache.coverageByAddress[GOLD].toISO, original.toISO);
  for (const { user } of TRADERS.slice(1)) {
    assert.equal(result.cache.coverageByAddress[user].state, 'pending');
    assert.equal(result.cache.coverageByAddress[user].fromISO, null);
  }
  assert.equal(result.cache.toISO, null);
  assert.match(result.status, /未設定/);
  assert.deepEqual(result.cache.trades, original.trades);
  assert.equal(original.coverageByAddress, undefined);
});

test('bootstrap makes recent data current first, caps six calls and guards every trade window', async () => {
  const sqls = [];
  const original = legacyCache();
  const result = await refreshStrategyCache({
    cache: original, key: 'test', now: NOW,
    request: async sql => { sqls.push(sql); return response(sql); },
  });
  assert.equal(result.calls, 6);
  assert.equal(sqls.length, 6);
  assert.equal(result.cache.coverageByAddress[GOLD].state, 'ready');
  for (const { user } of TRADERS.slice(1)) {
    assert.equal(result.cache.coverageByAddress[user].state, 'bootstrapping');
    assert.equal(result.cache.coverageByAddress[user].toISO, new Date(NOW).toISOString());
    assert.ok(Date.parse(result.cache.coverageByAddress[user].fromISO) > Date.parse(TARGET));
  }
  for (const sql of sqls.filter(sql => sql.includes('FROM hl.wallet_fills'))) {
    const [start, end] = queryWindow(sql);
    const addresses = [...sql.matchAll(/0x[0-9a-f]{40}/g)].length;
    assert.ok(addresses * 5 * Math.ceil((end - start) / HOUR) < 1000);
    assert.match(sql, /LIMIT 1000/);
  }
  assert.deepEqual(result.cache.trades, original.trades);
});

test('fully bootstrapped roster uses only two daily queries', async () => {
  const original = readyCache();
  const result = await refreshStrategyCache({ cache: original, key: 'test', now: NOW, request: async sql => response(sql) });
  assert.equal(result.calls, 2);
  for (const { user } of TRADERS) assert.equal(result.cache.coverageByAddress[user].state, 'ready');
  assert.equal(result.cache.fromISO, TARGET);
  assert.equal(result.cache.toISO, new Date(NOW).toISOString());
  assert.deepEqual(result.cache.trades, original.trades);
});

test('a 1000-row response with truncated:false is rejected before advancing coverage', async () => {
  const original = legacyCache();
  const result = await refreshStrategyCache({ cache: original, key: 'test', now: NOW, request: async sql => ({
    ...response(sql), rows: Array.from({ length: 1000 }, () => []),
  }) });
  assert.equal(result.calls, 1);
  assert.equal(result.cache.coverageByAddress[GOLD].toISO, original.toISO);
  for (const { user } of TRADERS.slice(1)) assert.equal(result.cache.coverageByAddress[user].state, 'pending');
  assert.match(result.status, /行數上限/);
});

test('truncated response or failed funding query cannot commit its trade window', async () => {
  for (const mode of ['truncated', 'funding-error']) {
    let calls = 0;
    const original = legacyCache();
    const result = await refreshStrategyCache({ cache: original, key: 'test', now: NOW, request: async sql => {
      calls++;
      if (mode === 'truncated') return { ...response(sql), truncated: true };
      if (calls === 2) throw Error('Funding unavailable');
      return response(sql);
    } });
    assert.equal(result.cache.coverageByAddress[GOLD].toISO, original.toISO);
    for (const { user } of TRADERS.slice(1)) assert.equal(result.cache.coverageByAddress[user].state, 'pending');
    assert.deepEqual(result.cache.trades, original.trades);
  }
});

test('later backfill failure keeps successful current coverage and marks history incomplete', async () => {
  let calls = 0;
  const result = await refreshStrategyCache({ cache: legacyCache(), key: 'test', now: NOW, request: async sql => {
    calls++;
    if (calls === 4) throw Error('Backfill unavailable');
    return response(sql);
  } });
  assert.equal(result.calls, 4);
  for (const { user } of TRADERS) assert.equal(result.cache.coverageByAddress[user].toISO, new Date(NOW).toISOString());
  for (const { user } of TRADERS.slice(1)) assert.equal(result.cache.coverageByAddress[user].state, 'bootstrapping');
  assert.match(result.status, /部分查詢失敗/);
});

test('funding backfill queries whole UTC days, preventing partial-day replacement', async () => {
  const sqls = [];
  await refreshStrategyCache({ cache: legacyCache(), key: 'test', now: NOW, request: async sql => {
    sqls.push(sql);
    return response(sql);
  } });
  for (let i = 0; i < sqls.length; i += 2) {
    const [start, end] = queryWindow(sqls[i]);
    const [fundStart, fundEnd] = queryWindow(sqls[i + 1]);
    assert.equal(fundStart % DAY, 0);
    assert.ok(fundStart <= start);
    assert.ok(fundEnd >= end);
    assert.ok(fundEnd % DAY === 0 || fundEnd === NOW);
  }
});

test('backfill merges a real gap before declaring old and recent coverage continuous', async () => {
  const cache = readyCache();
  cache.coverageByAddress[TRADERS[1].user] = {
    fromISO: TARGET, toISO: '2026-11-16T00:00:00.000Z',
    ranges: [{ fromISO: TARGET, toISO: '2026-11-16T00:00:00.000Z' }],
  };
  const result = await refreshStrategyCache({ cache, key: 'test', now: NOW, request: async sql => response(sql) });
  const coverage = result.cache.coverageByAddress[TRADERS[1].user];
  assert.equal(result.calls, 4);
  assert.equal(coverage.state, 'ready');
  assert.equal(coverage.ranges.length, 1);
  assert.equal(coverage.fromISO, TARGET);
});

test('bootstrapping eventually completes all six histories within the bounded query budget', async () => {
  let cache = legacyCache();
  let runs = 0;
  for (; runs < 12; runs++) {
    const result = await refreshStrategyCache({ cache, key: 'test', now: NOW + runs * DAY, request: async sql => response(sql) });
    assert.ok(result.calls <= 6);
    cache = result.cache;
    if (TRADERS.every(({ user }) => cache.coverageByAddress[user].state === 'ready')) break;
  }
  assert.ok(runs < 12, 'new wallets must progress, not repeatedly fetch the latest day');
});
