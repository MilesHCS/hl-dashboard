import fs from 'node:fs/promises';
import { review } from './swing-context.mjs';
import { refreshStrategyCache } from './strategy-data.mjs';
import { describeStrategy, summarizeTraders } from './strategy-report.mjs';

const DAY = 86400000;
const now = Date.now();
const today = Math.floor(now / DAY) * DAY;
const taipeiDate = time => new Date(time + 8 * 3600000).toISOString().slice(0, 10);
const reportDate = taipeiDate(now);
const coins = ['BTC', 'ETH', 'xyz:GOLD'];
const traders = [
  ['0xb83de012dba672c76a7dbbbf3e459cb59d7d6e36', 'BTC大佬', 0],
  ['0x5b5d51203a0f9079f8aeb098a6523a13f298c060', 'ETH大佬', 1],
  ['0x46921f6961bdb411b756c9712f6bdb58fbd9164f', '黃金大佬', 2],
];
const historyPath = 'analysis/observations.json';
const cachePath = 'analysis/strategy-cache.json';
const archiveDirectory = 'analysis/daily';
const history = JSON.parse(await fs.readFile(historyPath, 'utf8'));
const storedCache = JSON.parse(await fs.readFile(cachePath, 'utf8'));
await fs.mkdir(archiveDirectory, { recursive: true });
const previousFiles = (await fs.readdir(archiveDirectory))
  .filter(name => /^\d{4}-\d{2}-\d{2}\.json$/.test(name) && name.slice(0, 10) < reportDate).sort();
const previousArchive = previousFiles.length
  ? JSON.parse(await fs.readFile(archiveDirectory + '/' + previousFiles.at(-1), 'utf8')) : {};

function baseline(user) {
  if (previousArchive[user]) return previousArchive[user];
  const older = (history.snapshots[user] ?? [])
    .filter(row => taipeiDate(row.t) < reportDate).sort((a, b) => b.t - a.t)[0];
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
for (const [user, name, focus] of traders) {
  const previous = baseline(user);
  const positions = [];
  for (const dex of ['', 'xyz']) {
    const state = await info({ type: 'clearinghouseState', user, dex });
    if (!Array.isArray(state.assetPositions)) throw Error('Incomplete position snapshot');
    positions.push(...state.assetPositions.map(row => row.position));
  }
  const quantities = coins.map(coin => Number(positions.find(p => p.coin === coin)?.szi ?? 0));
  if (quantities.some(q => !Number.isFinite(q))) throw Error('Invalid quantity');
  let hedge = null;
  if (focus !== 2) {
    try {
      const spot = await info({ type: 'spotClearinghouseState', user });
      if (!Array.isArray(spot.balances)) throw Error('Missing spot balances');
      const spotHype = Number(spot.balances.find(balance => balance.coin === 'HYPE')?.total ?? 0);
      const perpHype = Number(positions.find(p => p.coin === 'HYPE')?.szi ?? 0);
      if (!Number.isFinite(spotHype) || !Number.isFinite(perpHype)) throw Error('Invalid hedge size');
      hedge = { spotHype, perpHype, at: new Date().toISOString(), scope: 'Hyperliquid main and xyz perpetuals plus spot' };
    } catch { console.warn('Spot hedge snapshot unavailable for', name); }
  }
  const updatedAt = new Date().toISOString();
  const levels = Object.fromEntries(coins.map((coin, index) => {
    const position = positions.find(p => p.coin === coin);
    return [coin, {
      quantity: quantities[index], midUsd: contexts[index].price,
      entryUsd: position ? Number(position.entryPx) : null,
      notionalUsd: position ? Number(position.positionValue) : 0,
      unrealizedPnlUsd: position ? Number(position.unrealizedPnl) : 0,
    }];
  }));
  const report = describeStrategy({ user, focus, quantities, previous, context: contexts[focus], cache, hedge, now });
  const events = (history.events[user] ?? []).filter(event => event.t >= today - 365 * DAY);
  const forwardStudy = events.length
    ? '\n\n歷史事件追蹤：' + review(history.snapshots[user] ?? [], events, focus, contexts[focus].candles, now).split('\n').at(-1) : '';
  const comparisonTime = previous
    ? '比較起點 ' + new Date(previous.updatedAt).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false }) + '（台灣時間）。'
    : '本期建立持倉比較基準。';
  feed[user] = {
    name, levels, hedge, quantities, previousQuantities: previous?.quantities ?? null,
    baselineDate: previous ? taipeiDate(Date.parse(previous.updatedAt)) : null,
    from: previous?.updatedAt ?? updatedAt, updatedAt,
    goldChange: previous?.quantities ? quantities[2] - previous.quantities[2] : null,
    strategyAsOf: cache.toISO, strategyStatus: refreshed.status,
    report: comparisonTime + '\n\n' + report + '\n\n' + refreshed.status + forwardStudy,
  };
  const snapshots = history.snapshots[user] ?? [];
  snapshots.push({ t: now, q: quantities });
  history.snapshots[user] = snapshots.filter(snapshot => snapshot.t >= now - 366 * DAY);
  history.events[user] = events;
}
const summary = summarizeTraders(feed, now);
summary.strategyAsOf = cache.toISO;
summary.strategyStatus = refreshed.status;
summary.usage = { sqlCalls: refreshed.calls, estimatedCredits: refreshed.calls * 10 };
summary.report += '\n\n' + refreshed.status;
for (const entry of [...Object.values(feed), summary]) {
  if (entry.report.length > 3700) throw Error('Telegram report too long');
}

await fs.writeFile(cachePath, JSON.stringify(cache) + '\n');
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
