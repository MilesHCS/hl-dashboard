import { TRADERS, MARKETS, LABELS } from './traders.mjs';

const DAY = 86400000;
const HOUR = 3600000;
const CACHE_MARKETS = MARKETS.map(market => market + '-PERP');

function timestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
  if (typeof value !== 'string' || !value) return NaN;
  const text = value.replace(' ', 'T');
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(text) ? text : text + 'Z');
}

const finite = value => typeof value === 'number' && Number.isFinite(value);
const amount = value => finite(value) && value >= 0 ? value : 0;
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;
const addressOf = value => typeof value === 'string' ? value.toLowerCase() : '';
function number(value, digits = 0) {
  if (!finite(value)) return '待補';
  return Math.abs(value) >= 1e12 ? value.toExponential(2)
    : value.toLocaleString('en-US', { maximumFractionDigits: digits });
}
const localTime = value => new Date(value).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });

function averageLookup(candles) {
  const unique = new Map();
  for (const candle of Array.isArray(candles) ? candles : []) {
    const start = Number(candle?.t), end = Number(candle?.T), close = Number(candle?.c);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start || !(close > 0) || !Number.isFinite(close)) continue;
    unique.set(start, { start, end, close });
  }
  const ordered = [...unique.values()].sort((a, b) => a.end - b.end || a.start - b.start);
  const prefix = [0];
  for (const candle of ordered) prefix.push(prefix.at(-1) + candle.close);
  return time => {
    if (!Number.isFinite(time)) return null;
    let low = 0, high = ordered.length;
    while (low < high) { const mid = Math.floor((low + high) / 2); if (ordered[mid].end < time) low = mid + 1; else high = mid; }
    if (low < 60) return null;
    return { fast: (prefix[low] - prefix[low - 20]) / 20, slow: (prefix[low] - prefix[low - 60]) / 60 };
  };
}

function change(before, after, compact = false) {
  if (!finite(after)) return compact ? '持倉待補' : '目前持倉資料待補，暫不判變化';
  if (!finite(before)) return (after > 0 ? '目前多頭' : after < 0 ? '目前空頭' : '目前無倉')
    + (compact ? '（基準待補）' : '；首期比較基準待建立，不計增減百分比');
  if (before === after) return !after ? '維持無倉' : after > 0 ? '多單數量持平' : '空單數量持平';
  if (after === 0) return (before > 0 ? '多單' : '空單') + '平倉' + (compact ? '' : '，目前無倉');
  if (before === 0) return '由無倉新開' + (after > 0 ? '多單' : '空單');
  if (before * after < 0) return after > 0 ? '空轉多' : '多轉空';
  const ratio = Math.abs(after / before) - 1;
  if (!finite(ratio)) return (after > 0 ? '多單' : '空單') + '變動幅度待核對';
  const magnitude = Math.abs(ratio) < 0.01 ? '不到1%' : number(Math.abs(ratio) * 100, 1) + '%';
  return (ratio > 0 ? '增加' : '減少') + (after > 0 ? '多單' : '空單') + magnitude;
}

function coverageFor(user, cache, time) {
  const address = addressOf(user);
  const map = cache?.coverageByAddress;
  const source = map && typeof map === 'object'
    ? Object.entries(map).find(([key]) => addressOf(key) === address)?.[1] : null;
  const storedFrom = timestamp(source?.fromISO), storedTo = timestamp(source?.toISO);
  const from = Math.max(storedFrom, time - 30 * DAY);
  const until = Math.min(storedTo, time);
  const valid = Number.isFinite(from) && Number.isFinite(until) && from < until
    && ['bootstrapping', 'ready'].includes(source?.state);
  // Free history starts at the first complete UTC day, so a ready interval can
  // cover 29-30 days. Do not require a full rolling 30*24 hours when the query
  // deliberately excludes that first partial UTC day. Earlier valid targets
  // within the same free window also remain compatible with saved coverage.
  const freeStart = time - 30 * DAY;
  const firstCompleteUtcDay = Math.ceil(freeStart / DAY) * DAY;
  const requestedFrom = source?.requestedFromISO == null
    ? firstCompleteUtcDay : timestamp(source.requestedFromISO);
  const reasonableTarget = Number.isFinite(requestedFrom)
    && requestedFrom >= freeStart && requestedFrom <= firstCompleteUtcDay;
  const full = valid && source.state === 'ready' && reasonableTarget
    && from <= requestedFrom && until >= time - HOUR;
  return { address, source, valid, full, from, until,
    rows: valid ? (Array.isArray(cache?.trades) ? cache.trades : []).filter(row =>
      addressOf(row.address) === address && timestamp(row.hour) >= from
      && timestamp(row.hour) + HOUR <= until) : [] };
}

function statsFor(rows, averageAt, side) {
  let opens = 0, closes = 0, openHours = 0, closeHours = 0, mixedHours = 0, activeHours = 0;
  let openDistance = 0, closeDistance = 0, openWeight = 0, closeWeight = 0;
  for (const row of rows) {
    const open = amount(row['open_' + side + '_usd']);
    const close = amount(row['close_' + side + '_usd']);
    opens += open; closes += close;
    if (open > 0) openHours++;
    if (close > 0) closeHours++;
    if (open > 0 || close > 0) activeHours++;
    if (open > 0 && close > 0) mixedHours++;
    const ma = averageAt(timestamp(row.hour));
    if (!ma) continue;
    const openVwap = row['open_' + side + '_vwap'];
    const closeVwap = row['close_' + side + '_vwap'];
    if (open > 0 && positive(openVwap)) {
      openDistance += open * (Number(openVwap) / ma.fast - 1); openWeight += open;
    }
    if (close > 0 && positive(closeVwap)) {
      closeDistance += close * (Number(closeVwap) / ma.fast - 1); closeWeight += close;
    }
  }
  return { opens, closes, openHours, closeHours, activeHours,
    mixedShare: activeHours ? mixedHours / activeHours : 0,
    openGap: openWeight ? openDistance / openWeight : null,
    closeGap: closeWeight ? closeDistance / closeWeight : null };
}

function gapPattern(stats, side) {
  if (stats.openGap === null || stats.closeGap === null) return 'insufficient';
  if (Math.abs(stats.openGap - stats.closeGap) < 0.005) return 'similar';
  const nearer = Math.abs(stats.openGap) + 0.01 < Math.abs(stats.closeGap);
  if (nearer && (side === 'short' ? stats.closeGap < stats.openGap : stats.closeGap > stats.openGap)) return 'separated';
  return 'other';
}

function sideProfile(stats, side) {
  const open = side === 'long' ? '加多' : '加空';
  const close = side === 'long' ? '減多／平多' : '回補';
  const label = side === 'long' ? '多頭' : '空頭';
  if (!stats.activeHours) return '';
  let text = stats.mixedShare >= 0.6 ? label + '多個活躍小時同時有進出，較像庫存調整候選。'
    : stats.closes > stats.opens * 2 && stats.closes > 0 ? close + '成交較多。'
      : stats.opens > stats.closes * 1.2 && stats.opens > 0 ? open + '成交較多。'
        : open + '與' + close + '並存，須看連續淨持倉。';
  const pattern = gapPattern(stats, side);
  if (pattern === 'separated') text += open + '較靠近MA20，' + close
    + (side === 'long' ? '位置較高；僅為候選習慣。' : '位置較低；僅為候選習慣。');
  else if (pattern === 'similar') text += label + '進出位置相近，固定MA門檻支持弱。';
  else if (pattern === 'insufficient') text += label + 'VWAP或均線對照不足，不判固定均線規則。';
  else text += label + '均線位置有差異，尚未辨識固定門檻。';
  return text;
}

function persistenceText(rows, averageAt, research, activeSides) {
  if (!research.full) return '前後段：近30天覆蓋待補，暫不判固定習慣。';
  const midpoint = research.from + (research.until - research.from) / 2;
  const parts = [];
  for (const side of activeSides) {
    const early = statsFor(rows.filter(row => timestamp(row.hour) < midpoint), averageAt, side);
    const late = statsFor(rows.filter(row => timestamp(row.hour) >= midpoint), averageAt, side);
    const label = side === 'long' ? '多頭' : '空頭';
    const enough = [early, late].every(s => s.openHours >= 3 && s.closeHours >= 3
      && s.openGap !== null && s.closeGap !== null);
    if (!enough) { parts.push(label + '前後段進出／VWAP樣本不足'); continue; }
    const patterns = [gapPattern(early, side), gapPattern(late, side)];
    if (patterns.every(p => p === 'separated')) parts.push(label + '前後段均見近MA20加倉、較遠處退出的差異，仍待其他行情驗證');
    else if (patterns.every(p => p === 'similar')) parts.push(label + '前後段進出位置均接近，固定門檻支持弱');
    else parts.push(label + '前後半段差異未一致');
  }
  return '前後段：' + (parts.length ? parts.join('；') : '可比進出樣本不足') + '。';
}

function priceContext(context, now, averageAt) {
  if (!positive(context?.price)) return '本期市價待補，暫不比較價格與4h均線。';
  const price = Number(context.price), ma = averageAt(now);
  let text = '參考價約' + number(price) + '美元。';
  if (typeof context.month === 'string' && context.month.length <= 120) text += context.month;
  if (!ma) return text + '4h MA20／MA60暖機資料不足。';
  if (price < Math.min(ma.fast, ma.slow)) text += '價格低於4h MA20、MA60；';
  else if (price > Math.max(ma.fast, ma.slow)) text += '價格高於4h MA20、MA60；';
  else text += '價格在4h MA20與MA60之間；';
  return text + (ma.fast < ma.slow ? 'MA20低於MA60。' : 'MA20高於或等於MA60。');
}

function marketDescription(index, quantities, previous, context, research, now) {
  const current = quantities?.[index], before = previous?.quantities?.[index];
  const rows = research.rows.filter(row => row.market === CACHE_MARKETS[index]);
  const averageAt = averageLookup(context?.fourHourCandles);
  const short = statsFor(rows, averageAt, 'short');
  const long = statsFor(rows, averageAt, 'long');
  const sides = [];
  if (short.activeHours) sides.push('short');
  if (long.activeHours) sides.push('long');
  let profile = !research.valid ? '此地址成交覆蓋待補；無紀錄不等於無交易。'
    : !sides.length ? '可見區間未收錄足夠可分類成交；無紀錄不等於無交易。'
      : (research.full ? '近30天：' : '可見區間：') + sideProfile(short, 'short') + sideProfile(long, 'long');
  if (research.valid && current > 0 && !long.activeHours && short.activeHours) {
    profile += '目前多單缺進出樣本，不把空頭規則套用多單。';
  }
  return LABELS[index] + '｜' + priceContext(context, now, averageAt) + '\n本期：' + change(before, current) + '。'
    + profile + persistenceText(rows, averageAt, research, sides);
}

function hedgeText(user, cache, hedge, now) {
  const spot = hedge?.spotHype, perp = hedge?.perpHype;
  let text = 'HYPE對沖：';
  if (finite(spot) && spot >= 0 && finite(perp)) {
    if (spot > 0 && perp < 0) {
      const cover = spot / Math.abs(perp);
      text += cover < 0.01 ? '現貨僅覆蓋永續空單不到1%，主要仍偏淨空；少量現貨不證明刻意配對。'
        : '可見現貨多／永續空，現貨數量約覆蓋空單' + number(cover * 100) + '%；'
          + (cover < 0.99 ? '仍偏淨空。' : cover > 1.01 ? '仍偏淨多。' : '兩腿數量接近。');
    } else text += '可見數量未形成現貨多／永續空配對。';
  } else text += '現貨或永續快照待補，不能當作沒有避險。';
  const hedgeTime = timestamp(hedge?.at);
  if (Number.isFinite(hedgeTime)) text += '快照' + localTime(hedgeTime) + '。';
  const funding = (Array.isArray(cache?.fundingDays) ? cache.fundingDays : []).filter(row =>
    addressOf(row.address) === addressOf(user) && row.market === 'HYPE-PERP'
    && timestamp(row.day) >= now - 30 * DAY && timestamp(row.day) <= now && finite(row.funding_usdc));
  if (funding.length) {
    const net = funding.reduce((sum, row) => sum + row.funding_usdc, 0);
    const dates = funding.map(row => String(row.day).slice(0, 10)).sort();
    text += '已保存資金費（UTC ' + dates[0] + '至' + dates.at(-1) + '）'
      + (net === 0 ? '淨額為零。' : net > 0 ? '為淨收入。' : '為淨支出。');
  }
  return text + '這只涉及HYPE；歷史資金費或跨資產多空，不足證明目前完整避險或獲利。';
}

function researchText(research) {
  let text = '資料充分性：';
  if (!research.valid) text += '此地址近30天成交覆蓋待補，沒有借用其他地址或全域研究時間。';
  else text += '此地址可見窗口為' + localTime(research.from) + '至' + localTime(research.until)
    + '（台灣時間）；' + (research.full ? '近30天覆蓋已齊。' : '近30天尚未補齊。');
  return text + '均線只用當時已收盤4h K線；可見紀錄不能直接證明原始建倉動機。';
}

function nextText(quantities, indices = MARKETS.map((_, i) => i)) {
  const parts = indices.map(index => LABELS[index] + '：' + (!finite(quantities?.[index]) ? '先補持倉快照'
    : quantities[index] > 0 ? '看回落是否留多、轉強後是否加多'
      : quantities[index] < 0 ? '看反彈是否加空或持續回補'
        : '看重開方向及能否留倉'));
  return '下一期驗證：' + parts.join('；') + '。單次成交不等於持續規則，回補空單也不等於翻多。';
}

export function describeTrader({ user, quantities, previous, contexts, cache, hedge, now = Date.now() } = {}) {
  const time = Number.isFinite(timestamp(now)) ? timestamp(now) : Date.now();
  const research = coverageFor(user, cache, time);
  return [
    ...MARKETS.map((_, index) => marketDescription(index, quantities, previous, contexts?.[index], research, time)),
    hedgeText(user, cache, hedge, time),
    researchText(research),
    nextText(quantities),
  ].join('\n\n');
}

// Compatibility for callers that still request one market. It uses the same side-aware and
// per-address coverage rules, never the old address/focus identity assumptions.
export function describeStrategy({ user, focus, quantities, previous, context, cache, hedge, now = Date.now() } = {}) {
  if (!Number.isInteger(focus) || focus < 0 || focus >= MARKETS.length) return '商品選擇無效，未作單一市場策略判讀。';
  const time = Number.isFinite(timestamp(now)) ? timestamp(now) : Date.now();
  const research = coverageFor(user, cache, time);
  return [
    marketDescription(focus, quantities, previous, context, research, time),
    hedgeText(user, cache, hedge, time),
    researchText(research),
    nextText(quantities, [focus]),
  ].join('\n\n');
}

function getEntry(feed, address) {
  return feed?.[address] ?? Object.entries(feed ?? {}).find(([key]) => addressOf(key) === address)?.[1] ?? null;
}
function quantityOf(entry, index) {
  const value = entry?.quantities?.[index];
  if (Array.isArray(entry?.quantities) && index in entry.quantities) return finite(value) ? value : null;
  return finite(value) ? value : finite(entry?.levels?.[MARKETS[index]]?.quantity) ? entry.levels[MARKETS[index]].quantity : null;
}

export function summarizeTraders(feed = {}, now = Date.now()) {
  const time = Number.isFinite(timestamp(now)) ? timestamp(now) : Date.now();
  const entries = TRADERS.map(trader => ({ ...trader, entry: getEntry(feed, trader.user) }));
  const updated = entries.map(({ entry }) => timestamp(entry?.updatedAt)).filter(Number.isFinite);
  const starts = entries.map(({ entry }) => timestamp(entry?.from)).filter(Number.isFinite);
  const lines = entries.map(({ name, entry }) => name + '：' + (entry
    ? MARKETS.map((_, index) => LABELS[index] + change(entry.previousQuantities?.[index], quantityOf(entry, index), true)).join('；')
    : '三市場快照待補') + '。');
  const directions = MARKETS.map((_, index) => {
    const values = entries.map(({ entry }) => quantityOf(entry, index));
    return LABELS[index] + '多' + values.filter(q => finite(q) && q > 0).length
      + '／空' + values.filter(q => finite(q) && q < 0).length
      + '／無倉' + values.filter(q => q === 0).length
      + (values.some(q => !finite(q)) ? '／待補' + values.filter(q => !finite(q)).length : '');
  }).join('；') + '。';
  const intro = '本期' + TRADERS.length + '地址三市場比較；各址依自身有效基準，首期先建基準。';
  const next = '下一期重點：多頭看回落留倉，空頭看反彈加空或連續回補；無倉看重開方向。新增數量能否保留，比單次成交更重要。';
  const limits = '範圍：僅可見地址與市場；回補不等於翻多，缺資料不當零變化，HYPE配對不代表整體避險。比較時段見個別日報。';
  let paragraphs = [intro, ...lines, '目前方向分布：' + directions, next, limits];
  if (paragraphs.join('\n\n').length > 1100) paragraphs = [intro, ...lines, next, '回補不等於翻多；缺基準不計增減百分比。'];
  return {
    name: TRADERS.length + '個地址綜合結論',
    updatedAt: new Date(updated.length ? Math.min(...updated) : time).toISOString(),
    from: new Date(starts.length ? Math.min(...starts) : time).toISOString(),
    report: paragraphs.join('\n\n'),
  };
}
