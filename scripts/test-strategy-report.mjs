import test from 'node:test';
import assert from 'node:assert/strict';
import { describeStrategy, describeTrader, summarizeTraders } from './strategy-report.mjs';
import { TRADERS, MARKETS, LABELS } from './traders.mjs';

const DAY = 86400000, HOUR = 3600000;
const now = Date.parse('2026-11-20T01:00:00Z');
const user = TRADERS[1].user;
const iso = time => new Date(time).toISOString();
const candles = Array.from({ length: 720 }, (_, i) => {
  const t = now - 120 * DAY + i * 4 * HOUR;
  return { t, T: t + 4 * HOUR - 1, c: 100 };
});
const contexts = MARKETS.map(() => ({ price: 90, month: '相較約30天前下跌約10%。', candles: [], fourHourCandles: candles }));

function row(day, market, extra = {}, address = user) {
  return { address, market: market + '-PERP', hour: iso(now - day * DAY - 2 * HOUR),
    open_short_usd: 100, close_short_usd: 100, open_short_vwap: 99, close_short_vwap: 95,
    open_long_usd: 0, close_long_usd: 0, ...extra };
}
function fullCache(address = user) {
  return { fromISO: iso(now - 120 * DAY), toISO: iso(now), fundingDays: [],
    coverageByAddress: { [address]: { state: 'ready', fromISO: iso(now - 30 * DAY), toISO: iso(now), requestedFromISO: iso(now - 30 * DAY) } },
    trades: MARKETS.flatMap(market => [26, 25, 24, 5, 4, 3].map(day => row(day, market, {}, address))) };
}
const run = options => describeTrader({ user, quantities: [12, -3, 0], previous: { quantities: [-2, -4, 0] }, contexts,
  cache: fullCache(), hedge: { spotHype: 10, perpHype: -20, at: iso(now) }, now, ...options });

test('one address report covers all three markets rather than mapping identity to focus index', () => {
  const result = run();
  for (const label of LABELS) assert.match(result, new RegExp(label + '｜'));
  assert.match(result, /空轉多/);
  assert.match(result, /減少空單25%/);
  assert.match(result, /維持無倉/);
  assert.match(result, /4h MA20、MA60/);
  assert.match(result, /空頭前後段均見/);
  assert.equal((result.match(/HYPE對沖：/g) || []).length, 1);
  assert.equal((result.match(/資料充分性：/g) || []).length, 1);
  assert.equal((result.match(/下一期驗證：/g) || []).length, 1);
  assert.ok(result.length <= 3000, result.length);
});

test('new baseline is unknown comparison, not zero change or a percentage increase', () => {
  const result = run({ quantities: [3, -9, 0], previous: null });
  assert.equal((result.match(/首期比較基準待建立/g) || []).length, 3);
  assert.doesNotMatch(result, /持倉數量持平|多單數量持平|空單數量持平|增加多單|增加空單/);
  assert.doesNotMatch(result, /起點已有核心空單/);
});

test('new address pending coverage cannot borrow another address or the global cache window', () => {
  const cache = fullCache(TRADERS[0].user);
  cache.coverageByAddress[user] = { state: 'pending', fromISO: null, toISO: null, requestedFromISO: iso(now - 30 * DAY) };
  cache.trades.push(row(3, 'BTC'));
  const result = run({ cache });
  assert.match(result, /此地址成交覆蓋待補/);
  assert.match(result, /無紀錄不等於無交易/);
  assert.match(result, /沒有借用其他地址或全域研究時間/);
  assert.doesNotMatch(result, /近30天覆蓋已齊|空頭前後段均見/);
});

test('missing per-address coverage stays insufficient even if legacy global dates span months', () => {
  const cache = fullCache();
  delete cache.coverageByAddress;
  const result = run({ cache });
  assert.match(result, /近30天成交覆蓋待補/);
  assert.doesNotMatch(result, /近30天覆蓋已齊/);
});

test('bootstrapping may describe the visible interval but cannot claim a complete 30-day rule', () => {
  const cache = fullCache();
  cache.coverageByAddress[user] = { state: 'bootstrapping', fromISO: iso(now - 7 * DAY), toISO: iso(now), requestedFromISO: iso(now - 30 * DAY) };
  const result = run({ cache });
  assert.match(result, /可見區間：/);
  assert.match(result, /近30天尚未補齊/);
  assert.match(result, /前後段：近30天覆蓋待補/);
  assert.doesNotMatch(result, /近30天覆蓋已齊/);
});

test('ready first-complete-UTC-day coverage is complete at a non-midnight run', () => {
  const lateNow = Date.parse('2026-11-20T17:00:00Z');
  const target = Math.ceil((lateNow - 30 * DAY) / DAY) * DAY;
  assert.equal(lateNow - target, 29 * DAY + 17 * HOUR);
  const cache = fullCache();
  cache.coverageByAddress[user] = { state: 'ready', fromISO: iso(target), toISO: iso(lateNow), requestedFromISO: iso(target) };
  const result = run({ now: lateNow, cache });
  assert.match(result, /近30天覆蓋已齊/);
  assert.match(result, /空頭前後段均見/);
  assert.ok(result.includes(new Date(target).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })));
  assert.ok(result.includes(new Date(lateNow).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false })));
  assert.doesNotMatch(result, /近30天尚未補齊/);
});

test('bootstrapping remains incomplete even when its displayed endpoints span the requested window', () => {
  const lateNow = Date.parse('2026-11-20T17:00:00Z');
  const target = Math.ceil((lateNow - 30 * DAY) / DAY) * DAY;
  const cache = fullCache();
  cache.coverageByAddress[user] = { state: 'bootstrapping', fromISO: iso(target), toISO: iso(lateNow), requestedFromISO: iso(target) };
  const result = run({ now: lateNow, cache });
  assert.match(result, /近30天尚未補齊/);
  assert.doesNotMatch(result, /近30天覆蓋已齊|空頭前後段均見/);
});

test('a missing requested start uses the complete UTC day but a shortened or invalid target cannot claim completeness', () => {
  const lateNow = Date.parse('2026-11-20T17:00:00Z');
  const target = Math.ceil((lateNow - 30 * DAY) / DAY) * DAY;
  const cache = fullCache();
  cache.coverageByAddress[user] = { state: 'ready', fromISO: iso(target), toISO: iso(lateNow) };
  assert.match(run({ now: lateNow, cache }), /近30天覆蓋已齊/);
  for (const requested of [iso(lateNow - DAY), iso(lateNow - 29 * DAY), 'invalid']) {
    cache.coverageByAddress[user].requestedFromISO = requested;
    const result = run({ now: lateNow, cache });
    assert.match(result, /近30天尚未補齊/);
    assert.doesNotMatch(result, /近30天覆蓋已齊/);
  }
});

test('zero recorded activity is not stated as proof there were no actual trades', () => {
  const cache = fullCache(); cache.trades = [];
  const result = run({ cache });
  assert.match(result, /無紀錄不等於無交易/);
  assert.doesNotMatch(result, /完全沒有交易|確認無交易/);
});

test('long and short flows are described separately and missing long VWAP is not replaced with short VWAP', () => {
  const cache = fullCache();
  cache.trades = cache.trades.map(r => ({ ...r, open_long_usd: 300, close_long_usd: 100 }));
  const result = run({ cache, quantities: [4, 5, 6] });
  assert.match(result, /加空較靠近MA20/);
  assert.match(result, /多頭VWAP或均線對照不足/);
  assert.match(result, /多頭前後段進出／VWAP樣本不足/);
  assert.doesNotMatch(result, /加多較靠近MA20/);
});

test('available long VWAP supports its own buy-near-MA and sell-higher candidate, not the short pattern', () => {
  const cache = fullCache();
  cache.trades = cache.trades.map(r => ({ ...r, open_long_usd: 100, close_long_usd: 100, open_long_vwap: 101, close_long_vwap: 105 }));
  const result = run({ cache, quantities: [4, 5, 6] });
  assert.match(result, /加多較靠近MA20，減多／平多位置較高/);
  assert.match(result, /多頭前後段均見/);
  assert.match(result, /空頭前後段均見/);
});

test('open prices farther from MA are not incorrectly labelled near-MA entries', () => {
  const cache = fullCache();
  cache.trades = cache.trades.map(r => ({ ...r, open_short_vwap: 105, close_short_vwap: 102 }));
  const result = run({ cache });
  assert.doesNotMatch(result, /加空較靠近MA20/);
  assert.match(result, /尚未辨識固定門檻/);
});

test('unknown quantity and unknown perpetual hedge are not converted to zero positions', () => {
  const result = run({ quantities: [null, -3, 0], hedge: { spotHype: 0, perpHype: null, at: iso(now) } });
  const btc = result.split('\n\n')[0];
  assert.match(btc, /目前持倉資料待補/);
  assert.doesNotMatch(btc, /平倉|目前無倉|維持無倉/);
  assert.match(result, /不能當作沒有避險/);
  assert.match(result, /BTC：先補持倉快照/);
});

test('the golden address is no longer a hard-coded hedge exception', () => {
  const goldUser = TRADERS[0].user;
  const result = run({ user: goldUser, cache: fullCache(goldUser) });
  assert.match(result, /現貨數量約覆蓋空單50%/);
  assert.match(result, /仍偏淨空/);
});

test('funding zero is zero, and funding history does not establish a current hedge', () => {
  const cache = fullCache();
  cache.fundingDays = [{ address: user, market: 'HYPE-PERP', day: '2026-11-19', funding_usdc: 0 }];
  const result = run({ cache, hedge: null });
  assert.match(result, /淨額為零/);
  assert.match(result, /現貨或永續快照待補/);
  assert.match(result, /不足證明目前完整避險或獲利/);
});

test('only completed four-hour candles and completed trade hours are used', () => {
  const incomplete = { t: now - HOUR, T: now + 3 * HOUR, c: 100000 };
  const changedContexts = contexts.map(context => ({ ...context, fourHourCandles: [...candles, incomplete] }));
  const cache = fullCache();
  cache.trades.push({ ...row(1, 'BTC'), hour: iso(now - HOUR / 2), open_short_usd: 1e10, close_short_usd: 0 });
  assert.equal(run({ cache, contexts: changedContexts }), run({ cache: fullCache() }));
});

test('describeStrategy remains compatible without an unconditional existing-core-short assertion', () => {
  const result = describeStrategy({ user, focus: 1, quantities: [0, 4, 0], previous: null, context: contexts[1], cache: fullCache(), hedge: null, now });
  assert.match(result, /^ETH｜/);
  assert.doesNotMatch(result, /^BTC｜|起點已有核心空單/);
  assert.match(result, /首期比較基準待建立/);
  assert.ok(result.length <= 3000);
});

test('summary iterates six roster addresses across all markets, ignoring retired identities', () => {
  const current = [[-1, 2, -3], [4, 0, 5], [null, -5, 0], [0, 0, 0], [-2, -3, 8]];
  const before = [[-1, 2, -2], null, [0, -2, 0], [-1, 1, -1], [3, -4, -8]];
  const feed = Object.fromEntries(TRADERS.slice(0, 5).map((trader, index) => [trader.user, {
    name: trader.name, quantities: current[index], previousQuantities: before[index], updatedAt: iso(now), from: iso(now - DAY),
  }]));
  feed['0xb83de012dba672c76a7dbbbf3e459cb59d7d6e36'] = { name: 'BTC大佬', quantities: [1000, 1000, 1000], previousQuantities: [0, 0, 0] };
  feed[TRADERS[2].user].levels = { BTC: { quantity: 0 } }; // explicit quantities:null still means unknown
  const result = summarizeTraders(feed, now);
  assert.match(result.name, /6/);
  for (const trader of TRADERS) assert.ok(result.report.includes(trader.name), trader.name);
  assert.doesNotMatch(result.report, /BTC大佬|ETH大佬|兩位加密/);
  assert.match(result.report, /BTC多1／空2／無倉1／待補2/);
  const firstNew = result.report.split('\n\n').find(line => line.startsWith(TRADERS[1].name + '：'));
  assert.match(firstNew, /BTC目前多頭（基準待補）/);
  assert.match(firstNew, /ETH目前無倉（基準待補）/);
  assert.doesNotMatch(firstNew, /%|增加|持平/);
  assert.match(result.report, /多轉空/);
  assert.match(result.report, /空轉多/);
  assert.ok(result.report.length <= 1100, result.report.length);
});

test('missing feeds and extreme but finite positions remain bounded, not assumed flat', () => {
  const missing = summarizeTraders({}, now);
  assert.match(missing.report, /三市場快照待補/);
  assert.match(missing.report, /BTC多0／空0／無倉0／待補6/);
  const feed = Object.fromEntries(TRADERS.map(t => [t.user, {
    quantities: [1e150, -1e150, 0], previousQuantities: [1e-150, -1e-150, 0], updatedAt: iso(now), from: iso(now - DAY),
  }]));
  assert.ok(summarizeTraders(feed, now).report.length <= 1100);
});

test('full mixed-side reports stay within the per-address budget and do not mutate inputs', () => {
  const cache = fullCache();
  cache.trades = cache.trades.map(r => ({ ...r, open_long_usd: 100, close_long_usd: 100, open_long_vwap: 101, close_long_vwap: 105 }));
  const rich = contexts.map(c => ({ ...c, month: '近月行情仍須分開觀察。'.repeat(9) }));
  const input = { user, quantities: [4, -5, 6], previous: { quantities: [0, -4, -2] }, cache, contexts: rich, hedge: { spotHype: 100, perpHype: -100, at: iso(now) }, now };
  const before = structuredClone(input);
  const report = describeTrader(input);
  assert.ok(report.length <= 3000, report.length);
  assert.deepEqual(input, before);
});
