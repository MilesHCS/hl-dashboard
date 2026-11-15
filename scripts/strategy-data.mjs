const DAY = 86400000;
const HOUR = 3600000;
const ADDRESSES = [
  '0xb83de012dba672c76a7dbbbf3e459cb59d7d6e36',
  '0x5b5d51203a0f9079f8aeb098a6523a13f298c060',
  '0x46921f6961bdb411b756c9712f6bdb58fbd9164f',
];
const MARKETS = ['BTC-PERP', 'ETH-PERP', 'xyz:GOLD-PERP', 'HYPE-PERP', 'HYPE/USDC'];
const TRADE_NUMBERS = [
  'fills', 'buys', 'sells', 'open_short_usd', 'close_short_usd',
  'open_long_usd', 'close_long_usd', 'low', 'high',
];

function timestamp(value) {
  if (typeof value !== 'string') throw Error('Missing timestamp');
  const normalized = value.includes('T') ? value : value.replace(' ', 'T');
  const time = Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(normalized) ? normalized : normalized + 'Z');
  if (!Number.isFinite(time)) throw Error('Invalid timestamp');
  return time;
}

const sqlTime = time => new Date(time).toISOString().slice(0, 19).replace('T', ' ');
const sqlList = values => values.map(value => `'${value}'`).join(',');

function readRows(body) {
  if (!body || body.truncated !== false || !Number.isFinite(body.limits?.history_days) || body.limits.history_days < 30) {
    throw Error('Incomplete query response');
  }
  if (!Array.isArray(body.columns) || !Array.isArray(body.rows)) throw Error('Missing query rows');
  const columns = body.columns.map(column => column.name);
  if (columns.some(name => typeof name !== 'string') || new Set(columns).size !== columns.length) {
    throw Error('Invalid query columns');
  }
  return body.rows.map(row => {
    if (!Array.isArray(row) || row.length !== columns.length) throw Error('Invalid query row');
    return Object.fromEntries(columns.map((name, index) => [name, row[index]]));
  });
}

function checkIdentity(row, funding) {
  if (!ADDRESSES.includes(row.address) || !MARKETS.includes(row.market)) throw Error('Unknown market or address');
  if (funding && row.market === 'HYPE/USDC') throw Error('Unexpected spot funding');
}

function validateTrades(rows, start, end) {
  for (const row of rows) {
    checkIdentity(row, false);
    const time = timestamp(row.hour);
    if (time % HOUR || time < start || time >= end) throw Error('Trade outside requested window');
    for (const field of TRADE_NUMBERS) {
      if (typeof row[field] !== 'number' || !Number.isFinite(row[field]) || row[field] < 0) {
        throw Error('Invalid trade amount');
      }
    }
    if (!Number.isInteger(row.fills) || row.high < row.low) throw Error('Invalid trade range');
    for (const field of ['open_short_vwap', 'close_short_vwap']) {
      if (row[field] !== null && (typeof row[field] !== 'number' || !Number.isFinite(row[field]) || row[field] <= 0)) {
        throw Error('Invalid trade price');
      }
    }
  }
  return rows;
}

function validateFunding(rows, start, end) {
  for (const row of rows) {
    checkIdentity(row, true);
    if (typeof row.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.day)) throw Error('Invalid funding date');
    const time = timestamp(row.day);
    if (time < start || time >= end) throw Error('Funding outside requested window');
    if (typeof row.funding_usdc !== 'number' || !Number.isFinite(row.funding_usdc)) throw Error('Invalid funding');
  }
  return rows;
}

function replaceRange(previous, fresh, field, start, end) {
  const retained = previous.filter(row => {
    const time = timestamp(row[field]);
    return time < start || time >= end;
  });
  const byKey = new Map([...retained, ...fresh].map(row => [
    [row.address, row.market, row[field]].join('/'), row,
  ]));
  return [...byKey.values()].sort((a, b) => timestamp(a[field]) - timestamp(b[field]));
}

function hedgeFlows(trades, end) {
  const groups = new Map();
  for (const row of trades) {
    if (!['HYPE-PERP', 'HYPE/USDC'].includes(row.market)) continue;
    const time = Math.floor(timestamp(row.hour) / (4 * HOUR)) * 4 * HOUR;
    const key = [row.address, row.market, time].join('/');
    const group = groups.get(key) ?? {
      address: row.address, market: row.market, hour: sqlTime(time), net_qty: 0,
      complete: time + 4 * HOUR <= end,
    };
    group.net_qty += row.buys - row.sells;
    groups.set(key, group);
  }
  return [...groups.values()];
}

function queries(start, end) {
  const filter = `address IN (${sqlList(ADDRESSES)})
    AND ts >= toDateTime('${sqlTime(start)}','UTC')
    AND ts < toDateTime('${sqlTime(end)}','UTC')`;
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
      FROM hl.wallet_fills WHERE ${filter} AND market IN (${sqlList(MARKETS)})
      GROUP BY address, market, hour ORDER BY hour, address, market LIMIT 1000`,
    `SELECT address, market, toDate(ts) AS day, sum(payment) AS funding_usdc
      FROM hl.funding_payments WHERE ${filter}
      AND market IN (${sqlList(MARKETS.filter(market => market !== 'HYPE/USDC'))})
      GROUP BY address, market, day ORDER BY day, address, market LIMIT 1000`,
  ];
}

/** Refresh atomically using two queries per normal run. request(sql) returns the raw SQL response. */
export async function refreshStrategyCache({ cache, key, now = Date.now(), request }) {
  let calls = 0;
  if (!key) return { cache, calls, status: '未設定 Ironflow Key，沿用已保存研究；策略資料時間以標示為準。' };
  const end = typeof now === 'number' ? now : Date.parse(now);
  if (!Number.isFinite(end) || typeof request !== 'function' || cache?.version !== 1 ||
      !Array.isArray(cache.trades) || !Array.isArray(cache.hedgeFlows) || !Array.isArray(cache.fundingDays)) {
    return { cache, calls, status: '策略快取格式或查詢設定有誤，保留上次資料。' };
  }
  try {
    const through = timestamp(cache.toISO);
    const originalFrom = timestamp(cache.fromISO);
    if (through > end) throw Error('Cache timestamp is in the future');
    const yesterday = Math.floor(end / DAY) * DAY - DAY;
    const oldestFullDay = Math.ceil((end - 30 * DAY) / DAY) * DAY;
    const lostHistory = through < oldestFullDay;
    let cursor = Math.max(oldestFullDay, Math.min(Math.floor(through / DAY) * DAY, yesterday));
    const next = structuredClone(cache);
    let chunks = 0;
    while (cursor < end && chunks < 3) {
      const chunkEnd = Math.min(cursor + 2 * DAY, end);
      const [tradeSql, fundingSql] = queries(cursor, chunkEnd);
      calls++;
      const trades = validateTrades(readRows(await request(tradeSql)), cursor, chunkEnd);
      calls++;
      const funding = validateFunding(readRows(await request(fundingSql)), cursor, chunkEnd);
      next.trades = replaceRange(next.trades, trades, 'hour', cursor, chunkEnd);
      next.fundingDays = replaceRange(next.fundingDays, funding, 'day', cursor, chunkEnd);
      next.hedgeFlows = replaceRange(next.hedgeFlows, hedgeFlows(trades, chunkEnd), 'hour', cursor, chunkEnd);
      next.toISO = new Date(chunkEnd).toISOString();
      cursor = chunkEnd;
      chunks++;
    }
    const minimum = end - 30 * DAY;
    next.trades = next.trades.filter(row => timestamp(row.hour) >= minimum);
    next.hedgeFlows = next.hedgeFlows.filter(row => timestamp(row.hour) >= minimum);
    next.fundingDays = next.fundingDays.filter(row => timestamp(row.day) >= Math.ceil(minimum / DAY) * DAY);
    next.fromISO = new Date(Math.max(originalFrom, minimum, lostHistory ? oldestFullDay : originalFrom)).toISOString();
    const progress = cursor < end
      ? '策略歷史補至 ' + next.toISO + '，仍有待補區間；本期已限制查詢次數。'
      : '策略資料已增量更新。';
    const status = (lostHistory ? '先前缺口已超過免費回查範圍，資料起點已調整。' : '') + progress;
    return { cache: next, calls, status };
  } catch {
    return { cache, calls, status: '策略歷史更新未完成，沿用上次成功資料；本期未推進資料時間。' };
  }
}
