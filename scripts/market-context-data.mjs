const DAY = 86400000;
const START = '2010-07-18';
const PRICE_URL = 'https://community-api.coinmetrics.io/v4/timeseries/asset-metrics';
const ETF_URLS = {
  BTC: 'https://farside.co.uk/bitcoin-etf-flow-all-data/',
  ETH: 'https://farside.co.uk/ethereum-etf-flow-all-data/',
};
const BLOCK_URLS = {
  BTC: 'https://data.tbstat.com/dashboard/markets_structuredproducts_btcspotetfflows_daily_other.json',
  ETH: 'https://data.tbstat.com/dashboard/markets_structuredproducts_ethspotetfflows_daily_other.json',
};
const KNOWN_ETF_FUNDS = {
  BTC: ['IBIT', 'FBTC', 'BITB', 'ARKB', 'BTCO', 'EZBC', 'BRRR', 'HODL', 'BTCW', 'MSBT', 'GBTC', 'BTC'],
  ETH: ['ETHA', 'ETHB', 'FETH', 'ETHW', 'TETH', 'ETHV', 'QETH', 'EZET', 'MSSE', 'ETHE', 'ETH'],
};
const isoDay = time => new Date(time).toISOString().slice(0, 10);
const timeOf = date => Date.parse(date + 'T00:00:00Z');
const daysBetween = (a, b) => Math.round((timeOf(b) - timeOf(a)) / DAY);
const mean = values => values.reduce((sum, value) => sum + value, 0) / values.length;
const validDate = date => /^\d{4}-\d{2}-\d{2}$/.test(date) && Number.isFinite(timeOf(date)) && isoDay(timeOf(date)) === date;
const positive = value => Number.isFinite(value) && value > 0;

function normalizePrices(rows) {
  const byDate = new Map();
  for (const row of rows ?? []) {
    const date = row.date ?? row.time?.slice(0, 10);
    const price = Number(row.price ?? row.PriceUSD);
    if (validDate(date ?? '') && positive(price)) byDate.set(date, { date, price });
  }
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function rangeHasEveryDay(rows, from, to) {
  const selected = rows.filter(row => row.date >= from && row.date <= to);
  return selected.length === daysBetween(from, to) + 1
    && selected.every((row, index) => index === 0 || daysBetween(selected[index - 1].date, row.date) === 1);
}

export function buildBtcContext(input, now = Date.now()) {
  // PriceUSD timestamps label the UTC day whose closing price is reported.
  // Exclude the current UTC day even if a provider publishes a partial value.
  const rows = normalizePrices(input).filter(row => row.date < isoDay(now));
  if (!rows.length) return null;
  const latest = rows.at(-1);
  const cycleRows = rows.filter(row => row.date >= '2024-04-20');
  const cycleCoverageComplete = latest.date >= '2024-04-20'
    && rangeHasEveryDay(rows, '2024-04-20', latest.date);
  const peak = cycleRows.length && cycleCoverageComplete ? cycleRows.reduce((a, b) => a.price >= b.price ? a : b) : null;
  const low = peak ? rows.filter(row => row.date >= peak.date).reduce((a, b) => a.price <= b.price ? a : b) : null;
  const sundays = rows.filter(row => new Date(timeOf(row.date)).getUTCDay() === 0);
  const weekly = sundays.map((row, index) => {
    const average = count => {
      if (index + 1 < count) return null;
      const window = sundays.slice(index - count + 1, index + 1);
      if (window.some((value, i) => i > 0 && daysBetween(window[i - 1].date, value.date) !== 7)) return null;
      return mean(window.map(value => value.price));
    };
    return { ...row, ma50: average(50), ma200: average(200) };
  });
  const yearStart = `${Number(latest.date.slice(0, 4)) - 1}-12-31`;
  const yearBaseline = rows.find(row => row.date === yearStart);
  const historyWindows = [
    ['2013–2015', '2013-07-01', '2014-01-01', '2016-07-09', '2012-11-28'],
    ['2017–2018', '2017-01-01', '2018-01-01', '2020-05-11', '2016-07-09'],
    ['2021–2022', '2021-07-01', '2022-01-01', '2024-04-20', '2020-05-11'],
  ];
  const cycleHistory = historyWindows.map(([cycle, peakStart, peakEnd, lowEnd, halvingDate]) => {
    if (!rangeHasEveryDay(rows, peakStart, lowEnd)) return null;
    const highs = rows.filter(row => row.date >= peakStart && row.date < peakEnd);
    const historicalPeak = highs.reduce((a, b) => a.price >= b.price ? a : b);
    const historicalLow = rows.filter(row => row.date >= historicalPeak.date && row.date < lowEnd)
      .reduce((a, b) => a.price <= b.price ? a : b);
    return {
      cycle, peakDate: historicalPeak.date, peakUsd: historicalPeak.price,
      lowDate: historicalLow.date, lowUsd: historicalLow.price,
      drawdownPct: (historicalLow.price / historicalPeak.price - 1) * 100,
      daysToLow: daysBetween(historicalPeak.date, historicalLow.date),
      halvingDate, daysFromHalvingToPeak: daysBetween(halvingDate, historicalPeak.date),
    };
  }).filter(Boolean);
  const lastWeek = weekly.at(-1);
  return {
    asOf: latest.date, priceUsd: latest.price,
    yearReturnPct: yearBaseline ? (latest.price / yearBaseline.price - 1) * 100 : null,
    peak, low,
    drawdownPct: peak ? (latest.price / peak.price - 1) * 100 : null,
    maxDrawdownPct: peak && low ? (low.price / peak.price - 1) * 100 : null,
    daysSincePeak: peak ? daysBetween(peak.date, latest.date) : null,
    calendarDaysSincePeak: peak ? daysBetween(peak.date, isoDay(now)) : null,
    daysToLow: peak && low ? daysBetween(peak.date, low.date) : null,
    weeklyAsOf: lastWeek?.date ?? null,
    ma50WeekUsd: lastWeek?.ma50 ?? null,
    ma200WeekUsd: lastWeek?.ma200 ?? null,
    ma50WeekPreviousUsd: weekly.at(-2)?.ma50 ?? null,
    weekly: weekly.slice(-24), cycleHistory,
    methodology: 'Coin Metrics PriceUSD UTC daily close; weekly closes sampled on Sunday, completed days only; current low is provisional',
    cycleCoverageComplete,
    contiguousRecentDays: rows.length >= 1460 && rangeHasEveryDay(rows, isoDay(timeOf(latest.date) - 1459 * DAY), latest.date),
  };
}

const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
function parseDate(text) {
  const match = text.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})$/);
  if (!match) return null;
  const month = MONTHS.indexOf(match[2].toLowerCase());
  if (month < 0) return null;
  const date = `${match[3]}-${String(month + 1).padStart(2, '0')}-${match[1].padStart(2, '0')}`;
  return validDate(date) ? date : null;
}
function cleanCell(html) {
  return html.replace(/<[^>]*>/g, ' ').replace(/&nbsp;|&#160;|\u00a0/g, ' ')
    .replace(/&amp;/g, '&').replace(/&#8211;|&ndash;/g, '–')
    .replace(/&#8212;|&mdash;/g, '—').replace(/\s+/g, ' ').trim();
}
function flowNumber(text) {
  const value = text.replace(/,/g, '').trim();
  if (/^\(\d+(?:\.\d+)?\)$/.test(value)) return -Number(value.slice(1, -1)) * 1e6;
  return /^[+-]?\d+(?:\.\d+)?$/.test(value) ? Number(value) * 1e6 : null;
}

function nthWeekday(year, month, weekday, n) {
  const first = new Date(Date.UTC(year, month, 1)).getUTCDay();
  return isoDay(Date.UTC(year, month, 1 + (weekday - first + 7) % 7 + (n - 1) * 7));
}
function lastWeekday(year, month, weekday) {
  const end = new Date(Date.UTC(year, month + 1, 0));
  return isoDay(end.getTime() - (end.getUTCDay() - weekday + 7) % 7 * DAY);
}
function observed(year, month, day) {
  const time = Date.UTC(year, month, day);
  const weekday = new Date(time).getUTCDay();
  return isoDay(time + (weekday === 6 ? -1 : weekday === 0 ? 1 : 0) * DAY);
}
function goodFriday(year) {
  const a = year % 19, b = Math.floor(year / 100), c = year % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = (h + l - 7 * m + 114) % 31 + 1;
  return isoDay(Date.UTC(year, month - 1, day) - 2 * DAY);
}
export function isEtfTradingDay(date) {
  const t = timeOf(date);
  if (!validDate(date) || [0, 6].includes(new Date(t).getUTCDay())) return false;
  const year = Number(date.slice(0, 4));
  const newYear = Date.UTC(year, 0, 1);
  // NYSE does not observe a Saturday New Year's Day on the prior Friday.
  const newYearHoliday = isoDay(newYear + (new Date(newYear).getUTCDay() === 0 ? DAY : 0));
  const holidays = new Set([
    newYearHoliday,
    nthWeekday(year, 0, 1, 3), nthWeekday(year, 1, 1, 3), goodFriday(year),
    lastWeekday(year, 4, 1), observed(year, 6, 4), nthWeekday(year, 8, 1, 1),
    nthWeekday(year, 10, 4, 4), observed(year, 11, 25),
  ]);
  if (year >= 2022) holidays.add(observed(year, 5, 19));
  // NYSE closed for the national day of mourning for President Carter.
  if (date === '2025-01-09') return false;
  return !holidays.has(date);
}

export function parseFarside(html, now = Date.now()) {
  const candidates = [];
  for (const table of html.matchAll(/<table\b[^>]*>([\s\S]*?)<\/table>/gi)) {
    const tableRows = [...table[1].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)]
      .map(row => [...row[1].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(cell => cleanCell(cell[1])));
    for (const header of tableRows) {
      const totalIndex = header.findIndex(cell => /^total$/i.test(cell));
      if (totalIndex < 2) continue;
      const funds = header.slice(1, totalIndex);
      if (!funds.every(fund => /^[A-Z][A-Z0-9.-]{1,8}$/.test(fund))) continue;
      const raw = tableRows.map(cells => {
        const date = parseDate(cells[0] ?? '');
        if (!date || date > isoDay(now) || cells.length <= totalIndex) return null;
        return { date, values: funds.map((_, i) => flowNumber(cells[i + 1])), totalUsd: flowNumber(cells[totalIndex]) };
      }).filter(Boolean).sort((a, b) => a.date.localeCompare(b.date));
      if (!raw.length) continue;
      const firstNumeric = funds.map((_, index) => raw.find(row => row.values[index] !== null)?.date ?? null);
      const rows = [], pendingDates = [];
      for (const row of raw) {
        if (!isEtfTradingDay(row.date)) continue;
        const active = row.values.filter((_, index) => firstNumeric[index] && firstNumeric[index] <= row.date);
        const present = active.filter(value => value !== null);
        if (!active.length || present.length !== active.length || row.totalUsd === null) {
          pendingDates.push(row.date);
          continue;
        }
        const sum = present.reduce((a, b) => a + b, 0);
        // Fund and total columns are independently rounded to US$0.1m.
        if (Math.abs(sum - row.totalUsd) > (active.length + 1) * 50001) {
          pendingDates.push(row.date);
          continue;
        }
        rows.push({ date: row.date, totalUsd: row.totalUsd, funds: Object.fromEntries(funds.map((fund, index) => [fund, row.values[index]]).filter(([, value]) => value !== null)) });
      }
      if (rows.length) candidates.push({ rows, pendingDates, funds, unknownFunds: funds.filter((_, index) => !firstNumeric[index]) });
    }
  }
  if (!candidates.length) throw Error('Farside returned no valid ETF flow table');
  return candidates.sort((a, b) => b.rows.length - a.rows.length)[0];
}

export function parseTheBlock(body, symbol, now = Date.now()) {
  if (body.Frequency !== 'Daily' || !body.Series || typeof body.Series !== 'object') throw Error('Unexpected The Block ETF schema');
  const entries = Object.entries(body.Series).filter(([fund]) => !/^(total|all|net flows?)$/i.test(fund));
  if (!entries.length) throw Error('The Block returned no ETF fund series');
  const funds = entries.map(([fund]) => fund);
  const maps = entries.map(([fund, series]) => {
    if (!Array.isArray(series.Data) || (series.YAxis && series.YAxis !== 'USD')) throw Error('Invalid The Block fund series');
    const dates = new Map();
    for (const row of series.Data) {
      if (typeof row.Timestamp !== 'number' || !Number.isFinite(row.Timestamp)) continue;
      const date = isoDay(row.Timestamp * 1000);
      if (date > isoDay(now)) continue;
      // JSON null, strings and absent entries are missing data, never zero.
      dates.set(date, typeof row.Result === 'number' && Number.isFinite(row.Result) ? row.Result : null);
    }
    return { fund, dates };
  });
  const dates = [...new Set(maps.flatMap(map => [...map.dates.keys()]))].sort();
  const rows = [], pendingDates = [];
  for (const date of dates) {
    if (!isEtfTradingDay(date)) continue;
    if (maps.some(map => !map.dates.has(date) || map.dates.get(date) === null)) {
      pendingDates.push(date);
      continue;
    }
    const fundValues = Object.fromEntries(maps.map(map => [map.fund, map.dates.get(date)]));
    rows.push({ date, totalUsd: Object.values(fundValues).reduce((sum, value) => sum + value, 0), funds: fundValues });
  }
  if (!rows.length) throw Error('No fully reported The Block ETF dates');
  const missingFunds = (KNOWN_ETF_FUNDS[symbol] ?? []).filter(fund => !funds.includes(fund));
  return { rows, pendingDates, funds, missingFunds, fundCoverageIncomplete: missingFunds.length > 0 };
}

function expectedSessionDates(asOf, count) {
  const dates = [];
  for (let t = timeOf(asOf); dates.length < count; t -= DAY) {
    const date = isoDay(t);
    if (isEtfTradingDay(date)) dates.push(date);
  }
  return dates.reverse();
}
function mergeEtf(previous, incoming) {
  // Do not splice different provider/fund universes into one 5/20-session sum.
  const sameUniverse = previous?.provider === incoming.provider
    && JSON.stringify([...(previous?.funds ?? [])].sort()) === JSON.stringify([...(incoming.funds ?? [])].sort());
  const byDate = new Map((sameUniverse ? previous?.rows ?? [] : []).map(row => [row.date, row]));
  for (const row of incoming.rows) byDate.set(row.date, row);
  const rows = [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-160);
  const complete = new Set(rows.map(row => row.date));
  const pendingDates = [...new Set([...(sameUniverse ? previous?.pendingDates ?? [] : []), ...incoming.pendingDates])]
    .filter(date => !complete.has(date) && (!rows.length || date >= rows[0].date)).sort();
  return {
    rows, pendingDates, funds: incoming.funds, provider: incoming.provider,
    missingFunds: incoming.missingFunds ?? [], fundCoverageIncomplete: Boolean(incoming.fundCoverageIncomplete),
    unknownFunds: incoming.unknownFunds ?? [],
    expectedAsOf: incoming.expectedAsOf ?? null,
  };
}
export function buildEtfContext(cache) {
  const rows = (cache?.rows ?? []).filter(row => validDate(row.date ?? '') && Number.isFinite(row.totalUsd)
    && isEtfTradingDay(row.date)).sort((a, b) => a.date.localeCompare(b.date));
  if (!rows.length) return null;
  const last = rows.at(-1);
  const byDate = new Map(rows.map(row => [row.date, row]));
  const pending = new Set(cache.pendingDates ?? []);
  const window = count => {
    const dates = expectedSessionDates(last.date, count);
    const missingDates = dates.filter(date => !byDate.has(date) || pending.has(date));
    return { dates, missingDates, sum: missingDates.length ? null : dates.reduce((sum, date) => sum + byDate.get(date).totalUsd, 0) };
  };
  const five = window(5), twenty = window(20);
  const fundTotals = new Map();
  if (!five.missingDates.length) for (const date of five.dates) {
    for (const [fund, netUsd] of Object.entries(byDate.get(date).funds ?? {})) fundTotals.set(fund, (fundTotals.get(fund) ?? 0) + netUsd);
  }
  const fundRows = [...fundTotals].map(([fund, netUsd]) => ({ fund, netUsd }));
  const pendingDates = [...pending].filter(isEtfTradingDay).sort();
  return {
    asOf: last.date, dayNetUsd: last.totalUsd,
    fiveSessionNetUsd: five.sum, twentySessionNetUsd: twenty.sum,
    fiveSessionMissingDates: five.missingDates, twentySessionMissingDates: twenty.missingDates,
    fiveSessionFrom: five.dates[0], twentySessionFrom: twenty.dates[0],
    sessionCount: rows.length, last20: rows.filter(row => row.date >= twenty.dates[0]).map(({ date, totalUsd }) => ({ date, totalUsd })),
    pendingDates, latestPending: pendingDates.some(date => date > last.date),
    provider: cache.provider ?? null, url: cache.url ?? null,
    fundCount: cache.funds?.length ?? null, missingFunds: cache.missingFunds ?? [],
    unknownFunds: cache.unknownFunds ?? [],
    fundCoverageIncomplete: Boolean(cache.fundCoverageIncomplete), expectedAsOf: cache.expectedAsOf ?? null,
    topBuyers5: fundRows.filter(row => row.netUsd > 0).sort((a, b) => b.netUsd - a.netUsd).slice(0, 3),
    topSellers5: fundRows.filter(row => row.netUsd < 0).sort((a, b) => a.netUsd - b.netUsd).slice(0, 3),
    scope: 'Published provider fund universe, US-listed spot ETF net creations/redemptions; not all institutional trading and not fund-manager own-account bets',
  };
}

function sourceStatus({ ok, data, url, now, error, fetchedAt, maxAgeDays, provider, primaryError }) {
  const asOf = data?.asOf ?? null;
  const ageDays = asOf ? Math.max(0, daysBetween(asOf, isoDay(now))) : null;
  return {
    status: ok ? 'updated' : asOf ? 'cached' : 'unavailable', asOf, ageDays,
    stale: ageDays === null || ageDays > maxAgeDays,
    fetchedAt: fetchedAt ?? null, checkedAt: new Date(now).toISOString(), url,
    ...(provider ? { provider } : {}),
    ...(primaryError ? { primaryError: String(primaryError.message ?? primaryError).slice(0, 180) } : {}),
    ...(error ? { error: String(error.message ?? error).slice(0, 180) } : {}),
  };
}

function expectedLastReportedSession(now) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now)).map(part => [part.type, part.value]));
  let t = timeOf(`${parts.year}-${parts.month}-${parts.day}`);
  // ETF flows normally report after the close. This is a pending-data check,
  // not a claim that the provider guarantees publication by this hour.
  if (Number(parts.hour) < 18) t -= DAY;
  while (!isEtfTradingDay(isoDay(t))) t -= DAY;
  return isoDay(t);
}
async function checkedFetch(fetchImpl, url) {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw Error('HTTP ' + response.status);
  return response;
}

export async function refreshMarketContext({ cache = {}, now = Date.now(), fetchImpl = fetch } = {}) {
  const next = structuredClone(cache);
  next.version = 1;
  next.etf ??= {};
  const sources = {};
  const generatedAt = new Date(now).toISOString();
  const tasks = [
    (async () => {
      const oldRows = normalizePrices(Array.isArray(cache.prices) ? cache.prices : cache.prices?.rows);
      const start = oldRows.length ? isoDay(Math.max(timeOf(START), timeOf(oldRows.at(-1).date) - 7 * DAY)) : START;
      const query = new URLSearchParams({ assets: 'btc', metrics: 'PriceUSD', frequency: '1d', start_time: start, end_time: isoDay(now), page_size: '10000' });
      const url = PRICE_URL + '?' + query;
      let ok = false, error;
      try {
        const response = await checkedFetch(fetchImpl, url);
        const body = await response.json();
        if (body.next_page_url || !Array.isArray(body.data)) throw Error('Incomplete Coin Metrics response');
        const incoming = normalizePrices(body.data).filter(row => row.date < isoDay(now));
        if (!incoming.length) throw Error('No completed Coin Metrics daily prices');
        const rows = normalizePrices([...oldRows, ...incoming]);
        const coverageFrom = oldRows.length && oldRows[0].date <= start ? start : incoming[0].date;
        const recent = rows.filter(row => row.date >= coverageFrom);
        // Include the cached tail, not just the first incoming date: otherwise
        // a response beginning after a missing bridge day silently skips it.
        if (!rangeHasEveryDay(recent, coverageFrom, recent.at(-1).date)) throw Error('Coin Metrics daily gap in refreshed range');
        next.prices = { rows, fetchedAt: generatedAt, url };
        ok = true;
      } catch (caught) { error = caught; }
      const btc = buildBtcContext(Array.isArray(next.prices) ? next.prices : next.prices?.rows, now);
      sources.prices = sourceStatus({ ok, data: btc, url, now, error, fetchedAt: next.prices?.fetchedAt, maxAgeDays: 3 });
    })(),
    ...Object.entries(ETF_URLS).map(async ([symbol, url]) => {
      let ok = false, error, primaryError, provider = 'Farside', activeUrl = url;
      try {
        let parsed;
        try {
          const response = await checkedFetch(fetchImpl, url);
          const farside = parseFarside(await response.text(), now);
          const missingFunds = (KNOWN_ETF_FUNDS[symbol] ?? []).filter(fund => !farside.funds.includes(fund));
          parsed = {
            ...farside, provider: 'Farside', missingFunds,
            fundCoverageIncomplete: missingFunds.length > 0 || farside.unknownFunds.length > 0,
          };
        } catch (caught) {
          primaryError = caught;
          provider = 'The Block';
          activeUrl = BLOCK_URLS[symbol];
          const response = await checkedFetch(fetchImpl, activeUrl);
          parsed = { ...parseTheBlock(await response.json(), symbol, now), provider };
        }
        const expectedAsOf = expectedLastReportedSession(now);
        const lastComplete = parsed.rows.at(-1).date;
        if (expectedAsOf > lastComplete) {
          for (let t = timeOf(lastComplete) + DAY; t <= timeOf(expectedAsOf); t += DAY) {
            if (isEtfTradingDay(isoDay(t))) parsed.pendingDates.push(isoDay(t));
          }
        }
        parsed.expectedAsOf = expectedAsOf;
        next.etf[symbol] = { ...mergeEtf(next.etf[symbol], parsed), fetchedAt: generatedAt, url: activeUrl };
        ok = true;
      } catch (caught) { error = caught; }
      const data = buildEtfContext(next.etf[symbol]);
      sources[symbol === 'BTC' ? 'btcEtf' : 'ethEtf'] = sourceStatus({
        ok, data, url: next.etf[symbol]?.url ?? activeUrl, now, error,
        provider: next.etf[symbol]?.provider ?? provider, primaryError,
        fetchedAt: next.etf[symbol]?.fetchedAt, maxAgeDays: 7,
      });
    }),
  ];
  await Promise.all(tasks);
  return {
    cache: next,
    context: {
      generatedAt, sources,
      btc: buildBtcContext(Array.isArray(next.prices) ? next.prices : next.prices?.rows, now),
      etf: { BTC: buildEtfContext(next.etf.BTC), ETH: buildEtfContext(next.etf.ETH) },
    },
  };
}
