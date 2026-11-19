import fs from 'node:fs/promises';
import { review } from './swing-context.mjs';
import { refreshStrategyCache } from './strategy-data.mjs';
import { describeTrader, summarizeTraders } from './strategy-report.mjs';
import { refreshMarketContext } from './market-context-data.mjs';
import { describeMarketContext } from './market-context-report.mjs';
import { describeForecastTracking } from './forecast-tracking.mjs';
import { TRADERS } from './traders.mjs';
import { fetchTrackedSnapshot } from './position-snapshot.mjs';

const DAY = 86400000;
const now = Date.now();
const today = Math.floor(now / DAY) * DAY;
const taipeiDate = time => new Date(time + 8 * 3600000).toISOString().slice(0, 10);
const reportDate = taipeiDate(now);
const coins = ['BTC', 'ETH', 'xyz:GOLD'];
const traders = TRADERS;
const historyPath = 'analysis/observations.json';
const cachePath = 'analysis/strategy-cache.json';
const marketCachePath = 'analysis/market-context-cache.json';
const archiveDirectory = 'analysis/daily';
const history = JSON.parse(await fs.readFile(historyPath, 'utf8'));
const storedCache = JSON.parse(await fs.readFile(cachePath, 'utf8'));
await fs.mkdir(archiveDirectory, { recursive: true });
const previousFiles = (await fs.readdir(archiveDirectory))
  .filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name) && name.slice(0, 10) < reportDate).sort();
const previousArchive = previousFiles.length
  ? JSON.parse(await fs.readFile(archiveDirectory + '/' + previousFiles.at(-1), 'utf8')) : {};
let previousForecast = null;
try {
  previousForecast = JSON.parse(await fs.readFile('analysis/summary.json', 'utf8')).forecastTracking ?? null;
} catch (error) {
  console.warn('Previous forecast reference unavailable:', error.code ?? 'invalid JSON');
}

function baseline(user) {
  const archived = previousArchive[user];
  const archivedTime = Date.parse(archived?.updatedAt);
  if (Array.isArray(archived?.quantities) && archived.quantities.length === 3
      && archived.quantities.every(Number.isFinite) && Number.isFinite(archivedTime)
      && taipeiDate(archivedTime) < reportDate) return archived;
  const older = (history.snapshots[user] ?? [])
    .filter(row => Number.isFinite(row.t) && taipeiDate(row.t) < reportDate
      && Array.isArray(row.q) && row.q.length === 3 && row.q.every(Number.isFinite)).sort((a, b) => b.t - a.t)[0];
  return older ? { updatedAt: new Date(older.t).toISOString(), quantities: older.q } : null;
}

async function info(body) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const response = await fetch('https://api.hyperliquid.xyz/info', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
    });
    if (response.status === 429 && attempt < 3) {
      const seconds = Math.max(Number(response.headers.get('Retry-After')) || 0, 8 * 2 ** attempt);
      await new Promise(resolve => setTimeout(resolve, seconds * 1000));
      continue;
    }
    if (!response.ok) throw Error('Hyperliquid HTTP ' + response.status);
    return response.json();
  }
}

const key = process.env.IRONFLOW_API_KEY;
console.log('Ironflow key configured:', Boolean(key));
const refreshed = await refreshStrategyCache({
  cache: storedCache, key, now,
  request: async sql => {
    const response = await fetch('https://api.ironflow.sh/v1/query', {
      method: 'POST', headers: { Authorization: 'Bearer ' + key, 'content-type': 'application/json' },
      body: JSON.stringify({ sql }), signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw Error('Ironflow HTTP ' + response.status);
    return response.json();
  },
});
const cache = refreshed.cache;
console.log('Strategy query calls:', refreshed.calls, refreshed.status);

let storedMarketCache = {};
try { storedMarketCache = JSON.parse(await fs.readFile(marketCachePath, 'utf8')); }
catch (error) { console.warn('Market background cache unavailable:', error.code ?? 'invalid JSON'); }
const marketRefreshed = await refreshMarketContext({ cache: storedMarketCache, now });
console.log('Market background sources:', JSON.stringify(marketRefreshed.context.sources));

const mids = [await info({ type: 'allMids' }), await info({ type: 'allMids', dex: 'xyz' })];
const contexts = [];
for (const [index, coin] of coins.entries()) {
  const price = Number(mids[index === 2 ? 1 : 0][coin]);
  if (!(price > 0)) throw Error('Missing market price');
  const candles = await info({ type: 'candleSnapshot', req: { coin, interval: '1d', startTime: today - 366 * DAY, endTime: now } });
  const fourHourCandles = await info({ type: 'candleSnapshot', req: { coin, interval: '4h', startTime: today - 120 * DAY, endTime: now } });
  if (!Array.isArray(candles) || !Array.isArray(fourHourCandles)) throw Error('Missing candles');
  const first = candles.find(candle => Number(candle.t) === today - 30 * DAY);
  let month = '近月起始價格待補。';
  if (Number(first?.o) > 0) {
    const change = (price / Number(first.o) - 1) * 100;
    month = '相較約 30 天前' + (change >= 0 ? '上漲' : '下跌') + '約 ' + Math.abs(change).toFixed(1) + '%。';
  }
  contexts.push({ price, month, candles, fourHourCandles });
}

const feed = {};
for (const { user, name } of traders) {
  const previous = baseline(user);
  const snapshot = await fetchTrackedSnapshot({ info, user, contexts });
  const { quantities, levels, hedge, marketStatus } = snapshot;
  const updatedAt = new Date().toISOString();
  const report = describeTrader({ user, quantities, previous, contexts, cache, hedge, now });
  const events = (history.events[user] ?? []).filter(event => event.t >= today - 365 * DAY);
  const forwardStudy = events.length
    ? '\n\n歷史事件追蹤：' + coins.map((coin, index) => coin + '：' + review(history.snapshots[user] ?? [], events, index, contexts[index].candles, now).split('\n').at(-1)).join('；') : '';
  const comparisonTime = previous
    ? '比較起點 ' + new Date(previous.updatedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) + '（台灣時間）。'
    : '本期建立持倉比較基準。';
  feed[user] = {
    name, levels, hedge, marketStatus, quantities, previousQuantities: previous?.quantities ?? null,
    baselineDate: previous ? taipeiDate(Date.parse(previous.updatedAt)) : null,
    from: previous?.updatedAt ?? updatedAt, updatedAt,
    goldChange: Number.isFinite(quantities[2]) && Number.isFinite(previous?.quantities?.[2]) ? quantities[2] - previous.quantities[2] : null,
    strategyAsOf: cache.coverageByAddress?.[user]?.toISO ?? null, strategyCoverage: cache.coverageByAddress?.[user] ?? null, strategyStatus: refreshed.status,
    report: comparisonTime + '\n\n' + report + '\n\n' + refreshed.status + forwardStudy,
  };
  const snapshots = history.snapshots[user] ?? [];
  if (snapshot.complete) snapshots.push({ t: now, q: quantities });
  history.snapshots[user] = snapshots.filter(snapshot => snapshot.t >= now - 366 * DAY);
  history.events[user] = events;
}
const summary = summarizeTraders(feed, now);
const marketReview = describeMarketContext({ context: marketRefreshed.context, feed, now });
summary.marketContext = marketRefreshed.context;
summary.bottomConfirmation = marketReview.bottomConfirmation;
summary.whaleAlignment = marketReview.whaleAlignment;
summary.report += '\n\n' + marketReview.report;
summary.strategyAsOf = cache.toISO;
summary.strategyStatus = refreshed.status;
summary.usage = { sqlCalls: refreshed.calls, estimatedCredits: refreshed.calls * 10 };
summary.report += '\n\n' + refreshed.status;
// Forecast nodes reuse the already-fetched reference quotes. No extra market,
// Ironflow, video-transcription, or language-model requests are made here.
try {
  const registry = JSON.parse(await fs.readFile('analysis/forecast-nodes.json', 'utf8'));
  summary.forecastTracking = describeForecastTracking({
    registry, feed, previous: previousForecast, now: Date.now(),
    maxReportChars: Math.min(900, Math.max(0, 3700 - summary.report.length - 2)),
  });
  if (summary.forecastTracking.report) summary.report += '\n\n' + summary.forecastTracking.report;
} catch (error) {
  console.warn('Forecast reference unavailable:', error.code ?? 'invalid registry or evaluation');
  summary.forecastTracking = {
    schemaVersion: 1, status: 'unavailable', evaluatedAt: new Date(now).toISOString(),
    report: '影片節點參考：資料或計算未完成，不據此推論預測成立。',
  };
  if (summary.report.length + summary.forecastTracking.report.length + 2 <= 3700) {
    summary.report += '\n\n' + summary.forecastTracking.report;
  }
}
for (const entry of [...Object.values(feed), summary]) {
  if (entry.report.length > 3700) throw Error('Telegram report too long');
}

await fs.writeFile(cachePath, JSON.stringify(cache) + '\n');
await fs.writeFile(marketCachePath, JSON.stringify(marketRefreshed.cache) + '\n');
await fs.writeFile(historyPath, JSON.stringify(history) + '\n');
await fs.writeFile('analysis/latest.json', JSON.stringify(feed, null, 2) + '\n');
await fs.writeFile('analysis/summary.json', JSON.stringify(summary, null, 2) + '\n');
for (const [path, content] of [
  [archiveDirectory + '/' + reportDate + '.json', feed],
  [archiveDirectory + '/summary-' + reportDate + '.json', summary],
]) {
  try { await fs.writeFile(path, JSON.stringify(content, null, 2) + '\n', { flag: 'wx' }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
}
console.log('Published reports:', Object.keys(feed).length + 1);
