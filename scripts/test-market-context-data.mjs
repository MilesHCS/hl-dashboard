import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBtcContext, buildEtfContext, isEtfTradingDay, parseFarside, parseTheBlock, refreshMarketContext } from './market-context-data.mjs';

const DAY = 86400000;
const NOW = Date.parse('2026-11-17T01:00:00Z');
const day = time => new Date(time).toISOString().slice(0, 10);
const at = date => Date.parse(date + 'T00:00:00Z');
const dateLabel = date => new Date(at(date)).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const response = (value, status = 200) => new Response(typeof value === 'string' ? value : JSON.stringify(value), { status });
function tradingDates(count, until = '2026-11-13') {
  const dates = [];
  for (let t = at(until); dates.length < count; t -= DAY) if (isEtfTradingDay(day(t))) dates.push(day(t));
  return dates.reverse();
}
function html(rows, funds = ['IBIT', 'FBTC']) {
  return '<table><tr><th>Date</th>' + funds.map(fund => `<th>${fund}</th>`).join('') + '<th>Total</th></tr>'
    + rows.map(row => '<tr><td>' + dateLabel(row.date) + '</td>' + row.values.map(value => `<td>${value}</td>`).join('') + `<td>${row.total}</td></tr>`).join('') + '</table>';
}
const priceRows = (count, until = '2026-11-15') => Array.from({ length: count }, (_, index) => ({ date: day(at(until) - (count - 1 - index) * DAY), price: 1000 + index }));
const apiPrices = rows => ({ data: rows.map(({ date, price }) => ({ asset: 'btc', time: date + 'T00:00:00Z', PriceUSD: String(price) })) });
function blockFixture(dates = tradingDates(25), missing = null) {
  return {
    Frequency: 'Daily', Series: Object.fromEntries(['IBIT', 'FBTC'].map((fund, i) => [fund, {
      YAxis: 'USD', Data: dates.filter(date => missing !== `${fund}:${date}`)
        .map(date => ({ Timestamp: at(date) / 1000 + 12 * 3600, Result: i ? -2e6 : 5e6 })),
    }])),
  };
}

test('all-dash latest row is pending; an actual numeric zero session remains valid', () => {
  const parsed = parseFarside(html([
    { date: '2026-11-12', values: ['1.0', '(1.0)'], total: '0.0' },
    { date: '2026-11-13', values: ['0.0', '0.0'], total: '0.0' },
    { date: '2026-11-16', values: ['-', '-'], total: '0.0' },
  ]), NOW);
  assert.equal(parsed.rows.at(-1).date, '2026-11-13');
  assert.equal(parsed.rows.at(-1).totalUsd, 0);
  assert.deepEqual(parsed.pendingDates, ['2026-11-16']);
});

test('a fund missing after inception blocks that date; pre-inception dash does not', () => {
  const parsed = parseFarside(html([
    { date: '2026-11-10', values: ['1.0', '-'], total: '1.0' },
    { date: '2026-11-11', values: ['1.0', '0.0'], total: '1.0' },
    { date: '2026-11-12', values: ['1.0', '-'], total: '1.0' },
    { date: '2026-11-13', values: ['1.0', '(0.5)'], total: '0.5' },
  ]), NOW);
  assert.deepEqual(parsed.rows.map(row => row.date), ['2026-11-10', '2026-11-11', '2026-11-13']);
  assert.deepEqual(parsed.pendingDates, ['2026-11-12']);
});

test('ETF rolling windows require contiguous trading sessions and retain missing dates', () => {
  const dates = tradingDates(25);
  const missing = dates.at(-3);
  const data = buildEtfContext({
    rows: dates.filter(date => date !== missing).map(date => ({ date, totalUsd: 10, funds: { A: 10 } })), pendingDates: [missing],
  });
  assert.equal(data.fiveSessionNetUsd, null);
  assert.equal(data.twentySessionNetUsd, null);
  assert.deepEqual(data.fiveSessionMissingDates, [missing]);
  assert.deepEqual(data.topBuyers5, []);
  const complete = buildEtfContext({ rows: dates.map(date => ({ date, totalUsd: 10, funds: { A: 12, B: -2 } })), pendingDates: [] });
  assert.equal(complete.fiveSessionNetUsd, 50);
  assert.equal(complete.twentySessionNetUsd, 200);
  assert.deepEqual(complete.topBuyers5, [{ fund: 'A', netUsd: 60 }]);
});

test('NYSE dates exclude weekends and actual exchange holidays, not Veterans Day', () => {
  assert.equal(isEtfTradingDay('2026-11-14'), false);
  assert.equal(isEtfTradingDay('2026-04-03'), false); // Good Friday
  assert.equal(isEtfTradingDay('2026-06-19'), false);
  assert.equal(isEtfTradingDay('2026-11-26'), false);
  assert.equal(isEtfTradingDay('2025-01-09'), false);
  assert.equal(isEtfTradingDay('2026-11-11'), true);
  assert.equal(isEtfTradingDay('2027-12-31'), true); // NYSE New Year Saturday exception
});

test('weekly close uses only completed UTC days and each MA uses its own historical window', () => {
  const rows = priceRows(1500);
  const sundayNow = buildBtcContext(rows, at('2026-11-15') + 12 * 3600000);
  assert.equal(sundayNow.weeklyAsOf, '2026-11-08');
  const mondayNow = buildBtcContext(rows, at('2026-11-16') + 3600000);
  assert.equal(mondayNow.weeklyAsOf, '2026-11-15');
  const completed = rows.filter(row => new Date(at(row.date)).getUTCDay() === 0);
  const expected50 = completed.slice(-50).reduce((sum, row) => sum + row.price, 0) / 50;
  assert.equal(mondayNow.ma50WeekUsd, expected50);
  assert.equal(mondayNow.ma50WeekUsd - mondayNow.ma50WeekPreviousUsd, 7);
  const missingSunday = rows.filter(row => row.date !== completed.at(-20).date);
  assert.equal(buildBtcContext(missingSunday, NOW).ma50WeekUsd, null);
});

test('a short or gapped price sample cannot invent a current-cycle peak', () => {
  const short = buildBtcContext(priceRows(30), NOW);
  assert.equal(short.cycleCoverageComplete, false);
  assert.equal(short.peak, null);
  assert.equal(short.maxDrawdownPct, null);
  const long = priceRows(1500);
  const gap = long.filter(row => row.date !== '2025-01-03');
  assert.equal(buildBtcContext(gap, NOW).peak, null);
  assert.equal(buildBtcContext(long, NOW).cycleCoverageComplete, true);
});

test('The Block null or missing fund entries are pending and universe omissions are explicit', () => {
  const dates = tradingDates(25);
  const body = blockFixture(dates, 'FBTC:' + dates.at(-1));
  body.Series.IBIT.Data.at(-2).Result = null;
  const parsed = parseTheBlock(body, 'BTC', NOW);
  assert.equal(parsed.rows.at(-1).date, dates.at(-3));
  assert.deepEqual(parsed.pendingDates, dates.slice(-2));
  assert.equal(parsed.fundCoverageIncomplete, true);
  assert.ok(parsed.missingFunds.includes('GBTC'));
});

test('independent source fallback uses The Block on Farside 403 and preserves its actual asOf', async () => {
  const prices = priceRows(1500);
  const urls = [];
  const fetchImpl = async url => {
    urls.push(url);
    if (url.includes('coinmetrics')) return response(apiPrices(prices));
    if (url.includes('farside')) return response('blocked', 403);
    return response(blockFixture());
  };
  const result = await refreshMarketContext({ now: NOW, fetchImpl });
  assert.equal(result.context.sources.prices.status, 'updated');
  assert.equal(result.context.sources.btcEtf.provider, 'The Block');
  assert.equal(result.context.etf.BTC.asOf, '2026-11-13');
  assert.equal(result.context.etf.BTC.fiveSessionNetUsd, 15e6);
  assert.equal(result.context.etf.BTC.latestPending, true);
  assert.ok(result.context.etf.BTC.pendingDates.includes('2026-11-16'));
  assert.equal(result.context.sources.btcEtf.primaryError, 'HTTP 403');
  assert.equal(urls.length, 5);
});

test('all failed requests retain valid cache and expose cached dates rather than today', async () => {
  const cache = {
    prices: { rows: priceRows(1500), fetchedAt: '2026-11-16T00:00:00Z' },
    etf: { BTC: { rows: tradingDates(25).map(date => ({ date, totalUsd: 1, funds: { IBIT: 1 } })), funds: ['IBIT'], provider: 'Farside', pendingDates: [] } },
  };
  const result = await refreshMarketContext({ cache, now: NOW, fetchImpl: async () => response('unavailable', 503) });
  assert.deepEqual(result.cache.prices, cache.prices);
  assert.deepEqual(result.cache.etf.BTC, cache.etf.BTC);
  assert.equal(result.context.sources.prices.status, 'cached');
  assert.equal(result.context.sources.prices.asOf, '2026-11-15');
  assert.equal(result.context.sources.btcEtf.status, 'cached');
  assert.equal(result.context.sources.ethEtf.status, 'unavailable');
  assert.equal(result.context.etf.ETH, null);
  assert.equal(cache.version, undefined); // input is not mutated
});

test('overlap refresh starts seven days before cache tail and rejects a new daily gap', async () => {
  const prices = priceRows(1500);
  const cache = { prices: { rows: prices, fetchedAt: '2026-11-16T00:00:00Z' } };
  let priceUrl;
  const fetchImpl = async url => {
    if (url.includes('coinmetrics')) {
      priceUrl = url;
      return response(apiPrices([{ date: '2026-11-17', price: 8000 }])); // only an unfinished day
    }
    return response('unavailable', 503);
  };
  const result = await refreshMarketContext({ cache, now: NOW, fetchImpl });
  assert.equal(new URL(priceUrl).searchParams.get('start_time'), '2026-11-08');
  assert.deepEqual(result.cache.prices, cache.prices);
  assert.equal(result.context.sources.prices.status, 'cached');
  assert.match(result.context.sources.prices.error, /No completed/);
});

test('an incoming range cannot skip the bridge day after the cached tail', async () => {
  const cache = { prices: { rows: priceRows(1500, '2026-11-14'), fetchedAt: '2026-11-15T00:00:00Z' } };
  const result = await refreshMarketContext({
    cache, now: Date.parse('2026-11-18T01:00:00Z'),
    fetchImpl: async url => url.includes('coinmetrics')
      ? response(apiPrices([{ date: '2026-11-16', price: 8000 }, { date: '2026-11-17', price: 8100 }]))
      : response('unavailable', 503),
  });
  assert.deepEqual(result.cache.prices, cache.prices);
  assert.equal(result.context.sources.prices.status, 'cached');
  assert.match(result.context.sources.prices.error, /daily gap/);
});

test('Farside missing fund headers and never-numeric fund columns disclose incomplete coverage', async () => {
  const table = html([{ date: '2026-11-13', values: ['1.0', '-'], total: '1.0' }]);
  const result = await refreshMarketContext({
    now: NOW, fetchImpl: async url => url.includes('coinmetrics') ? response(apiPrices(priceRows(1500))) : response(table),
  });
  assert.equal(result.context.etf.BTC.provider, 'Farside');
  assert.equal(result.context.etf.BTC.fundCoverageIncomplete, true);
  assert.ok(result.context.etf.BTC.missingFunds.includes('GBTC'));
  assert.deepEqual(result.context.etf.BTC.unknownFunds, ['FBTC']);
});
