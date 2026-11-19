import { TRADERS } from './traders.mjs';

const DAY = 86400000;
const HOUR = 3600000;
const BLOCK = 4 * HOUR;
const ADDRESSES = TRADERS.map(trader => trader.user.toLowerCase());
const GOLD_ADDRESS = '0x46921f6961bdb411b756c9712f6bdb58fbd9164f';
const MARKETS = ['BTC-PERP', 'ETH-PERP', 'xyz:GOLD-PERP', 'HYPE-PERP', 'HYPE/USDC'];
const MAX_CALLS = 6;
const ROW_LIMIT = 1000;
const TRADE_NUMBERS = [
  'fills', 'buys', 'sells', 'open_short_usd', 'close_short_usd',
  'open_long_usd', 'close_long_usd', 'low', 'high',
];
const TRADE_COLUMNS = ['address', 'market', 'hour', ...TRADE_NUMBERS, 'open_short_vwap', 'close_short_vwap'];
const FUNDING_COLUMNS = ['address', 'market', 'day', 'funding_usdc'];

function timestamp(value) {
  if (typeof value !== 'string') throw Error('Missing timestamp');
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const time = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(normalized) ? normalized : normalized + 'Z');
  if (!Number.isFinite(time)) throw Error('Invalid timestamp');
  return time;
}

const iso = time => new Date(time).toISOString();
const sqlTime = time => iso(time).slice(0, 19).replace('T', ' ');
const sqlList = values => values.map(value => `'${value}'`).join(',');
const rowKey = (row, field) => [row.address, row.market, timestamp(row[field])].join('/');

function readRows(body, required) {
  if (!body || body.truncated !== false || !Number.isFinite(body.limits?.history_days) || body.limits.history_days < 30) {
    throw Error('Incomplete query response');
  }
  if (!Array.isArray(body.columns) || !Array.isArray(body.rows)) throw Error('Missing query rows');
  // truncated:false does not prove completeness when the response reaches its row cap.
  if (body.rows.length >= ROW_LIMIT) throw Error('Query reached row limit');
  const columns = body.columns.map(column => column.name);
  if (columns.some(name => typeof name !== 'string') || new Set(columns).size !== columns.length ||
      required.some(name => !columns.includes(name))) throw Error('Invalid query columns');
  return body.rows.map(row => {
    if (!Array.isArray(row) || row.length !== columns.length) throw Error('Invalid query row');
    return Object.fromEntries(columns.map((name, index) => [name, row[index]]));
  });
}

function validateRows(rows, addresses, start, end, funding) {
  for (const row of rows) {
    if (!addresses.includes(row.address) || !MARKETS.includes(row.market) ||
        (funding && row.market === 'HYPE/USDC')) throw Error('Unexpected market or address');
    const time = timestamp(row[funding ? 'day' : 'hour']);
    if (time < start || time >= end || time % (funding ? DAY : HOUR)) throw Error('Row outside requested window');
    if (funding) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.day) || iso(time).slice(0, 10) !== row.day ||
          !Number.isFinite(row.funding_usdc)) throw Error('Invalid funding');
      continue;
    }
    if (TRADE_NUMBERS.some(field => typeof row[field] !== 'number' || !Number.isFinite(row[field]) || row[field] < 0) ||
        !Number.isInteger(row.fills) || row.high < row.low) throw Error('Invalid trade amount');
    for (const field of ['open_short_vwap', 'close_short_vwap']) {
      if (row[field] !== null && (typeof row[field] !== 'number' || !Number.isFinite(row[field]) || row[field] <= 0)) {
        throw Error('Invalid trade price');
      }
    }
  }
  return rows;
}

function replaceRange(previous, fresh, field, addresses, start, end) {
  const retained = previous.filter(row => !addresses.includes(row.address) ||
    timestamp(row[field]) < start || timestamp(row[field]) >= end);
  const byKey = new Map([...retained, ...fresh].map(row => [rowKey(row, field), row]));
  return [...byKey.values()].sort((a, b) => timestamp(a[field]) - timestamp(b[field]));
}

function hedgeFlows(trades, end) {
  const groups = new Map();
  for (const row of trades) {
    if (!['HYPE-PERP', 'HYPE/USDC'].includes(row.market)) continue;
    const time = Math.floor(timestamp(row.hour) / BLOCK) * BLOCK;
    const key = [row.address, row.market, time].join('/');
    const group = groups.get(key) ?? {
      address: row.address, market: row.market, hour: sqlTime(time), net_qty: 0,
      complete: time + BLOCK <= end,
    };
    group.net_qty += row.buys - row.sells;
    groups.set(key, group);
  }
  return [...groups.values()];
}

function mergeRanges(ranges) {
  const merged = [];
  for (const range of ranges.toSorted((a, b) => a[0] - b[0])) {
    const last = merged.at(-1);
    if (last && range[0] <= last[1]) last[1] = Math.max(last[1], range[1]);
    else merged.push([...range]);
  }
  return merged;
}

function readCoverage(record, target, end) {
  const ranges = record?.ranges ?? (record?.fromISO && record?.toISO
    ? [{ fromISO: record.fromISO, toISO: record.toISO }] : []);
  return mergeRanges(ranges.flatMap(range => {
    try {
      const from = timestamp(range.fromISO), to = timestamp(range.toISO);
      return from < to && to <= end && to > target ? [[Math.max(from, target), to]] : [];
    } catch { return []; }
  }));
}

function coverageRecord(ranges, target, end) {
  const latest = ranges.at(-1);
  return {
    fromISO: latest ? iso(latest[0]) : null,
    toISO: latest ? iso(latest[1]) : null,
    requestedFromISO: iso(target),
    state: !latest ? 'pending' : latest[0] <= target && latest[1] >= end ? 'ready' : 'bootstrapping',
    ranges: ranges.map(([from, to]) => ({ fromISO: iso(from), toISO: iso(to) })),
  };
}

function updateCoverage(cache, addresses, start, end, target, now) {
  for (const address of addresses) {
    const ranges = readCoverage(cache.coverageByAddress[address], target, now);
    cache.coverageByAddress[address] = coverageRecord(mergeRanges([...ranges, [start, end]]), target, now);
  }
}

function commonCoverage(cache) {
  const records = ADDRESSES.map(address => cache.coverageByAddress[address]);
  if (records.some(record => !record.fromISO || !record.toISO)) {
    cache.fromISO = null;
    cache.toISO = null;
    return;
  }
  const from = Math.max(...records.map(record => timestamp(record.fromISO)));
  const to = Math.min(...records.map(record => timestamp(record.toISO)));
  cache.fromISO = from < to ? iso(from) : null;
  cache.toISO = from < to ? iso(to) : null;
}

function queries(addresses, start, end, fundingStart, fundingEnd) {
  const filter = (from, to) => `address IN (${sqlList(addresses)})
    AND ts >= toDateTime('${sqlTime(from)}','UTC')
    AND ts < toDateTime('${sqlTime(to)}','UTC')`;
  return [
    `SELECT address, market, toStartOfHour(ts) AS hour, count() AS fills,
      sumIf(size,side='buy') AS buys, sumIf(size,side='sell') AS sells,
      sumIf(notional,direction='Open Short') AS open_short_usd,
      sumIf(notional,direction='Close Short') AS close_short_usd,
      sumIf(notional,direction='Open Long') AS open_long_usd,
      sumIf(notional,direction='Close Long') AS close_long_usd,
      sumIf(notional,direction='Open Short') / nullIf(sumIf(size,direction='Open Short'),0) AS open_short_vwap,
      sumIf(notional,direction='Close Short') / nullIf(sumIf(size,direction='Close Short'),0) AS close_short_vwap,
      min(price) AS low, max(price) AS high
      FROM hl.wallet_fills WHERE ${filter(start, end)} AND market IN (${sqlList(MARKETS)})
      GROUP BY address, market, hour ORDER BY hour, address, market LIMIT 1000`,
    `SELECT address, market, toDate(ts) AS day, sum(payment) AS funding_usdc
      FROM hl.funding_payments WHERE ${filter(fundingStart, fundingEnd)}
      AND market IN (${sqlList(MARKETS.filter(market => market !== 'HYPE/USDC'))})
      GROUP BY address, market, day ORDER BY day, address, market LIMIT 1000`,
  ];
}

// Each hour can emit at most address-count * five-market rows. Stay below 1000.
const safeSpan = addresses => Math.floor((ROW_LIMIT - 1) / (addresses.length * MARKETS.length * 4)) * BLOCK;

function summary(cache, calls, error) {
  const pending = ADDRESSES.filter(address => cache.coverageByAddress[address].state !== 'ready');
  const progress = pending.length ? `尚有 ${pending.length} 個地址的近30天歷史待補；近日資料與歷史覆蓋分別標示。`
    : '六個地址策略資料已增量更新，近30天覆蓋完整。';
  return (error ? '部分查詢失敗或達到行數上限，該段未提交。' : '') + progress + ` 本次 ${calls} 次SQL。`;
}

/** Two queries normally, up to six while bootstrapping. Each query pair commits atomically. */
export async function refreshStrategyCache({ cache, key, now = Date.now(), request }) {
  let calls = 0;
  const parsed = typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(parsed) || cache?.version !== 1 || !Array.isArray(cache.trades) ||
      !Array.isArray(cache.hedgeFlows) || !Array.isArray(cache.fundingDays)) {
    return { cache, calls, status: '策略快取格式有誤，保留上次資料。' };
  }
  const end = Math.floor(parsed / 1000) * 1000;
  const target = Math.ceil((end - 30 * DAY) / DAY) * DAY;
  const next = structuredClone(cache);
  next.coverageByAddress ??= {};
  for (const address of ADDRESSES) {
    // Legacy v1 queried the old three-wallet roster. Only gold is still active.
    const legacy = address === GOLD_ADDRESS && !next.coverageByAddress[address]
      ? { fromISO: cache.fromISO, toISO: cache.toISO } : null;
    const ranges = readCoverage(next.coverageByAddress[address] ?? legacy, target, end);
    next.coverageByAddress[address] = coverageRecord(ranges, target, end);
  }
  commonCoverage(next);
  if (!key || typeof request !== 'function') {
    return { cache: next, calls, status: '未設定 Ironflow Key，新地址歷史待匯入；既有資料按地址與原時間保存。' };
  }
  async function fetchRange(addresses, start, finish) {
    // Fetch full UTC funding days so a partial backfill never overwrites a full day's total.
    const fundingStart = Math.floor(start / DAY) * DAY;
    const fundingEnd = Math.min(Math.ceil(finish / DAY) * DAY, end);
    const [tradeSql, fundingSql] = queries(addresses, start, finish, fundingStart, fundingEnd);
    calls++;
    const trades = validateRows(readRows(await request(tradeSql), TRADE_COLUMNS), addresses, start, finish, false);
    calls++;
    const funding = validateRows(readRows(await request(fundingSql), FUNDING_COLUMNS), addresses, fundingStart, fundingEnd, true);
    next.trades = replaceRange(next.trades, trades, 'hour', addresses, start, finish);
    next.fundingDays = replaceRange(next.fundingDays, funding, 'day', addresses, fundingStart, fundingEnd);
    next.hedgeFlows = replaceRange(next.hedgeFlows, hedgeFlows(trades, finish), 'hour', addresses, start, finish);
    updateCoverage(next, addresses, start, finish, target, end);
  }
  let error = false;
  try {
    const recentStart = Math.max(target, Math.ceil((end - safeSpan(ADDRESSES)) / BLOCK) * BLOCK);
    await fetchRange(ADDRESSES, recentStart, end);
    while (calls + 2 <= MAX_CALLS) {
      const pending = ADDRESSES.filter(address => next.coverageByAddress[address].state !== 'ready');
      if (!pending.length) break;
      const finish = Math.max(...pending.map(address => timestamp(next.coverageByAddress[address].fromISO)));
      const start = Math.max(target, finish - safeSpan(pending));
      if (start >= finish) break;
      await fetchRange(pending, start, finish);
    }
  } catch { error = true; }
  // Retired addresses remain archived. Only active addresses' rolling data is pruned.
  for (const [field, timeField] of [['trades', 'hour'], ['hedgeFlows', 'hour'], ['fundingDays', 'day']]) {
    next[field] = next[field].filter(row => !ADDRESSES.includes(row.address) || timestamp(row[timeField]) >= target);
  }
  commonCoverage(next);
  return { cache: next, calls, status: summary(next, calls, error) };
}
