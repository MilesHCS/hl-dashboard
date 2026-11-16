const DAY = 86400000;
const TRADERS = [
  ['0xb83de012dba672c76a7dbbbf3e459cb59d7d6e36', 'BTC大佬'],
  ['0x5b5d51203a0f9079f8aeb098a6523a13f298c060', 'ETH大佬'],
  ['0x46921f6961bdb411b756c9712f6bdb58fbd9164f', '黃金大佬'],
];
const MARKETS = ['BTC', 'ETH', 'GOLD'];
const STATUS = { passed: '通過', not_passed: '未通過', insufficient: '資料不足' };
const finite = value => typeof value === 'number' && Number.isFinite(value);
const dateMs = value => typeof value === 'string' ? Date.parse(value) : NaN;
const dayString = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value)
  && Number.isFinite(dateMs(value.slice(0, 10))) ? value.slice(0, 10) : null;
const round = (value, digits = 0) => Math.abs(value) >= 1e12 ? value.toExponential(2)
  : value.toLocaleString('en-US', { maximumFractionDigits: digits });
const price = value => finite(value) && value > 0 ? round(value) + '美元' : '待補';
const percent = value => finite(value) ? (value > 0 ? '+' : '') + round(value, 1) + '%' : '待補';
const sourceFor = (context, name) => context?.sources?.[name] ?? {};

function usableSource(source, now, fallbackDate) {
  const asOf = dayString(source.asOf) ?? dayString(fallbackDate);
  if (!asOf || source.status !== 'updated' || source.stale === true) return false;
  const ageDays = (now - dateMs(asOf)) / DAY;
  return ageDays >= 0 && ageDays <= 7 && (!finite(source.ageDays) || source.ageDays <= 7);
}

function sourceLine(label, source, fallbackDate, now) {
  const asOf = dayString(source.asOf) ?? dayString(fallbackDate);
  const state = source.status === 'cached' ? '更新失敗，沿用上次有效資料'
    : source.status === 'updated' && usableSource(source, now, fallbackDate) ? '已更新'
    : source.status === 'updated' ? '資料過期或日期異常' : '查詢缺失';
  return label + ' ' + (asOf ?? '日期待補') + '（' + state + '）';
}

function money(value) {
  if (!finite(value)) return '資料不足';
  const abs = Math.abs(value);
  const amount = abs >= 1e8 ? round(abs / 1e8, 1) + '億美元'
    : abs >= 1e4 ? round(abs / 1e4, 0) + '萬美元' : round(abs, 0) + '美元';
  return value === 0 ? '淨額0' : '淨' + (value > 0 ? '流入' : '流出') + amount;
}

function pendingDates(etf) {
  return [...(Array.isArray(etf?.partialPendingDates) ? etf.partialPendingDates : []),
    ...(Array.isArray(etf?.pendingDates) ? etf.pendingDates : [])]
    .map(item => dayString(typeof item === 'string' ? item : item?.date)).filter(Boolean);
}

function pendingAfterLastComplete(etf, source = {}) {
  const asOf = dayString(etf?.asOf);
  return [...new Set([...pendingDates(etf), ...pendingDates(source)])]
    .filter(date => !asOf || date >= asOf).toSorted();
}

function partialCoverage(etf, source = {}) {
  return etf?.fundCoverageIncomplete === true || source.fundCoverageIncomplete === true;
}

function missingWindow(etf, source = {}) {
  return [etf, source].some(item => item && (
    (Array.isArray(item.missingDates) && item.missingDates.length > 0)
    || (Array.isArray(item.fiveSessionMissingDates) && item.fiveSessionMissingDates.length > 0)
    || (Array.isArray(item.twentySessionMissingDates) && item.twentySessionMissingDates.length > 0)
    || item.windowIncomplete === true || item.hasGaps === true || item.incomplete === true));
}

function completedWeeks(btc, now) {
  const byDate = new Map();
  for (const row of Array.isArray(btc?.weekly) ? btc.weekly : []) {
    const date = dayString(row?.date);
    if (!date || new Date(date + 'T00:00:00Z').getUTCDay() !== 0
      || dateMs(date) + DAY > now || !finite(row.price) || row.price <= 0) continue;
    byDate.set(date, { ...row, date });
  }
  return [...byDate.values()].toSorted((a, b) => a.date.localeCompare(b.date));
}

function rule(id, label, status, asOf, reason) {
  return { id, label, status, asOf: asOf ?? null, reason };
}

function bottomRules(context, now) {
  const btc = context?.btc;
  const weeks = completedWeeks(btc, now);
  const lastTwo = weeks.slice(-2);
  const priceDate = dayString(btc?.asOf);
  const priceFresh = usableSource(sourceFor(context, 'prices'), now, priceDate);
  const consecutive = lastTwo.length === 2 && dateMs(lastTwo[1].date) - dateMs(lastTwo[0].date) === 7 * DAY;
  const latestWeek = weeks.at(-1);
  // A stale terminal weekly row must not certify a current bottom, even when daily prices refreshed.
  const weeklyFresh = latestWeek && now - (dateMs(latestWeek.date) + DAY) <= 7 * DAY;
  const weeklyAsOf = latestWeek?.date ?? null;
  const maRule = (id, field, label, slope) => {
    if (!priceFresh || !consecutive || !weeklyFresh
      || !lastTwo.every(row => finite(row[field]) && row[field] > 0)) {
      return rule(id, label, 'insufficient', weeklyAsOf, '需最新兩個連續完整週與各週自己的均線。');
    }
    const held = lastTwo.every(row => row.price > row[field]);
    const improving = !slope || lastTwo[1][field] >= lastTwo[0][field];
    return rule(id, label, held && improving ? 'passed' : 'not_passed', weeklyAsOf,
      !held ? '最近兩週尚未都收在各自均線上方。' : !improving ? '價格收復，但50週線仍下降。' : '最近兩個完整週均符合。');
  };
  const rules = [
    maRule('ma200', 'ma200', '連續兩週站穩200週線', false),
    maRule('ma50', 'ma50', '連續兩週站穩50週線且均線不再下降', true),
  ];
  const etf = context?.etf?.BTC;
  const etfSource = sourceFor(context, 'btcEtf');
  const etfDate = dayString(etf?.asOf);
  const pending = pendingAfterLastComplete(etf, etfSource);
  const incompleteCoverage = partialCoverage(etf, etfSource);
  const missing = missingWindow(etf, etfSource);
  const etfFresh = usableSource(etfSource, now, etfDate);
  if (!etfFresh || pending.length || incompleteCoverage || missing || !finite(etf?.fiveSessionNetUsd) || !finite(etf?.twentySessionNetUsd)
    || !finite(etf?.sessionCount) || etf.sessionCount < 20) {
    rules.push(rule('btcEtf', 'BTC ETF近5與20個完整交易日均淨流入', 'insufficient', etfDate,
      pending.length || missing ? '交易日窗口仍有缺報，暫不確認。' : incompleteCoverage ? '基金覆蓋不全，暫不確認。' : '來源更新或完整交易日樣本不足。'));
  } else {
    const passed = etf.fiveSessionNetUsd > 0 && etf.twentySessionNetUsd > 0;
    rules.push(rule('btcEtf', 'BTC ETF近5與20個完整交易日均淨流入', passed ? 'passed' : 'not_passed', etfDate,
      passed ? '兩個完整窗口均為正值。' : '至少一個窗口尚非淨流入。'));
  }
  const passedCount = rules.filter(item => item.status === 'passed').length;
  const sufficient = rules.every(item => item.status !== 'insufficient');
  const phase = !sufficient ? '確認資料未齊'
    : passedCount === rules.length ? '多項修復條件成立，仍需延續'
    : passedCount ? '部分修復，底部仍待確認' : '反轉條件尚未成立';
  const lowDate = dayString(btc?.low?.date);
  const lowUsd = finite(btc?.low?.price) && btc.low.price > 0 ? btc.low.price : null;
  return {
    phase, asOf: priceDate, weeklyAsOf, rules,
    methodology: '候選確認條件，未經機率校準或完整樣本外回測；即使全部通過，也不保證已見底。',
    invalidation: {
      referenceLowDate: lowDate, referenceLowUsd: lowUsd,
      conditions: ['後續日收盤跌破暫定低點', '收復均線後再次失守', 'ETF資金再次持續淨流出'],
    },
  };
}

function quantityChange(before, after) {
  if (!finite(after)) return { action: 'unknown', direction: 'unknown', delta: null, text: '資料不足' };
  const direction = after > 0 ? 'long' : after < 0 ? 'short' : 'flat';
  const side = after > 0 ? '多' : after < 0 ? '空' : '無倉';
  if (!finite(before)) return { action: 'unknown', direction, delta: null, text: side + '，比較待補' };
  const delta = after - before;
  if (before === after) return { action: 'unchanged', direction, delta, text: side + '持平' };
  if (after === 0) return { action: before > 0 ? 'close_long' : 'close_short', direction, delta, text: before > 0 ? '多單平倉' : '空單平倉' };
  if (before === 0) return { action: after > 0 ? 'open_long' : 'open_short', direction, delta, text: '新開' + side };
  if (before * after < 0) return { action: after > 0 ? 'reverse_long' : 'reverse_short', direction, delta, text: after > 0 ? '空轉多' : '多轉空' };
  const increased = Math.abs(after) > Math.abs(before);
  const remainingFraction = Math.abs(after) / Math.abs(before);
  const magnitude = Math.abs((remainingFraction - 1) * 100);
  // A nonzero residual must not be rounded into an assertion of complete closure.
  const ratio = !increased && magnitude >= 99.95 ? '接近100%'
    : magnitude < 0.1 ? '<0.1%' : round(magnitude, 1) + '%';
  const action = after > 0 ? increased ? 'add_long' : 'reduce_long' : increased ? 'add_short' : 'cover_short';
  const text = after > 0 ? '多單' + (increased ? '加倉' : '減倉') + ratio : '空單' + (increased ? '加倉' : '回補') + ratio;
  return { action, direction, delta, remainingFraction, text };
}

function whales(feed) {
  const rows = TRADERS.map(([address, name]) => {
    const entry = feed?.[address];
    return {
      address, name, asOf: entry?.updatedAt ?? null, from: entry?.from ?? null,
      markets: Object.fromEntries(MARKETS.map((market, index) => [market,
        quantityChange(entry?.previousQuantities?.[index], entry?.quantities?.[index])])),
    };
  });
  const pair = rows.slice(0, 2).map(row => row.markets.BTC);
  const nearlyFlatShorts = pair.every(item => item.action === 'cover_short'
    && finite(item.remainingFraction) && item.remainingFraction < 0.01);
  let btcAlignment = '兩位加密大佬的BTC方向或比較基準未齊。';
  if (pair.every(item => finite(item.delta))) {
    if (pair.every(item => item.delta > 0)) {
      btcAlignment = nearlyFlatShorts
        ? '兩位加密大佬均大幅回補BTC空單，剩餘均不到前期1%；尚未翻多，也不代表維持原有看空強度。'
        : pair.every(item => item.direction === 'short')
        ? '兩位加密大佬都往回補BTC空單方向移動，仍為空頭。'
        : '兩位加密大佬的BTC數量都向多方移動，現有方向另看個別部位。';
    } else if (pair.every(item => item.delta < 0)) {
      btcAlignment = pair.every(item => item.direction === 'short')
        ? '兩位加密大佬都擴大BTC空頭方向。' : '兩位加密大佬的BTC數量都向空方移動。';
    } else if (pair.every(item => item.delta === 0)) btcAlignment = '兩位加密大佬的BTC數量均持平。';
    else btcAlignment = '兩位加密大佬的BTC調倉節奏有差異。';
  }
  const goldPair = [rows[0].markets.GOLD, rows[2].markets.GOLD];
  const goldDirectionSplit = goldPair.every(item => item.direction !== 'unknown')
    ? goldPair[0].direction !== goldPair[1].direction : null;
  const goldAdjustmentSplit = goldPair.every(item => finite(item.delta))
    ? goldPair[0].delta * goldPair[1].delta < 0 : null;
  return { rows, btcAlignment, nearlyFlatShorts, goldDirectionSplit, goldAdjustmentSplit,
    scope: '僅三個可見地址及本期數量比較，不代表全市場或完整資產組合。' };
}

function etfText(label, etf, source) {
  const pending = pendingAfterLastComplete(etf, source);
  const coverage = partialCoverage(etf, source);
  const fundCount = etf?.fundCount ?? source?.fundCount;
  const provider = String(etf?.provider ?? source?.provider ?? '此來源').replace(/[\r\n<>]/g, '').slice(0, 20);
  const scope = coverage ? '（' + provider + '已涵蓋' + (finite(fundCount) ? fundCount : '部分') + '檔，非全體）' : '';
  let line = label + ' ETF' + scope + '：近5／20完整交易日' + money(etf?.fiveSessionNetUsd) + '／' + money(etf?.twentySessionNetUsd) + '。';
  if (pending.length) line += '較新日期未報齊，未當成零流量。';
  if (missingWindow(etf, source)) line += '窗口仍有缺日，暫不確認。';
  return line;
}

function fundText(label, etf) {
  if (!finite(etf?.fiveSessionNetUsd)) return '';
  const buyer = etf?.topBuyers5?.find(item => finite(item?.netUsd) && item.netUsd > 0);
  const seller = etf?.topSellers5?.find(item => finite(item?.netUsd) && item.netUsd < 0);
  const safeName = item => String(item.fund).replace(/[\r\n<>]/g, '').slice(0, 16);
  const parts = [];
  if (buyer) parts.push('主要淨申購' + safeName(buyer));
  if (seller) parts.push('主要淨贖回' + safeName(seller));
  return parts.length ? label + '近5完整交易日：' + parts.join('、') + '。' : '';
}

function crossRead(context, alignment, confirmation, now) {
  const etf = context?.etf?.BTC;
  const pair = alignment.rows.slice(0, 2).map(row => row.markets.BTC);
  if (!finite(etf?.fiveSessionNetUsd) || !finite(etf?.twentySessionNetUsd)
    || pair.some(item => !finite(item.delta))) return '交叉判讀：資金窗口或地址比較未齊，暫不判斷是否共同轉向。';
  const incoming = etf.fiveSessionNetUsd > 0 && etf.twentySessionNetUsd > 0;
  const outgoing = etf.fiveSessionNetUsd < 0 && etf.twentySessionNetUsd < 0;
  const towardLong = pair.every(item => item.delta > 0);
  const towardShort = pair.every(item => item.delta < 0);
  const shortCovering = towardLong && pair.every(item => item.direction === 'short');
  const maRules = confirmation.rules.filter(item => item.id === 'ma200' || item.id === 'ma50');
  const priceConfirmed = maRules.every(item => item.status === 'passed');
  const priceUnknown = maRules.some(item => item.status === 'insufficient');
  const priceText = priceConfirmed ? '長週線修復條件已過' : priceUnknown ? '長週線確認資料未齊' : '長週線修復條件未過';
  const observation = outgoing && alignment.nearlyFlatShorts
    ? '兩位已大幅退出BTC空頭，殘餘均不到前期1%；尚未翻多，也不代表維持原有看空強度。已報ETF5／20日流出，'
      + priceText + '。若後續維持小倉或無倉，較符合降風險或觀望的候選情境，仍缺資金與趨勢支持翻多。'
    : outgoing && shortCovering
    ? '兩位回補BTC但仍空，已報ETF5／20日流出，' + priceText + '，訊號分歧。若後續仍只回補而未開多，可能偏向獲利了結或降風險，動機仍待核對；資金與趨勢尚不足支持翻多。'
    : outgoing && towardLong ? '地址向多方調整與ETF流出並存，' + priceText + '，承接仍待確認。'
    : outgoing && towardShort ? '地址向空方調整與ETF流出同向，' + priceText + '，修復仍受壓。'
    : incoming && towardLong ? '地址調整與ETF流入出現修復線索，' + priceText + '；即使同向，也只支持風險修復，不證明底部完成。'
    : incoming && towardShort ? 'ETF流入與地址向空方調整分歧，需看買盤能否承接賣壓。'
    : '地址與ETF窗口尚未呈現一致轉向。';
  const source = sourceFor(context, 'btcEtf');
  const limited = !usableSource(source, now, etf.asOf) || pendingAfterLastComplete(etf, source).length
    || missingWindow(etf, source) || partialCoverage(etf, source);
  return '交叉判讀：' + observation + (limited ? '僅對照已報／舊窗口，不能判斷今日機構方向。' : '')
    + '資料日期不同，不推因果，仍需後續驗證。';
}

/** Builds text and auditable candidate rules; it never emits a calibrated bottom probability. */
export function describeMarketContext({ context = {}, feed = {}, now = Date.now() } = {}) {
  context ??= {};
  feed ??= {};
  const time = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const btc = context?.btc;
  const bottomConfirmation = bottomRules(context, time);
  const whaleAlignment = whales(feed);
  const lines = [];
  if (finite(btc?.priceUsd) && btc.priceUsd > 0) {
    lines.push('週期位階：BTC日收盤約' + price(btc.priceUsd) + '，今年' + percent(btc.yearReturnPct)
      + '；距本輪最高收盤' + percent(btc.drawdownPct) + '，目前最深回撤' + percent(btc.maxDrawdownPct) + '。');
    const durations = (Array.isArray(btc.cycleHistory) ? btc.cycleHistory : [])
      .map(row => row?.daysToLow).filter(value => finite(value) && value > 0);
    const historical = durations.length >= 3 ? '，歷史三輪到低點約' + Math.min(...durations) + '–' + Math.max(...durations) + '天' : '';
    if (finite(btc.daysSincePeak)) lines.push('資料日距高點約' + Math.floor(btc.daysSincePeak) + '天' + historical
      + '。時間相似不等於已見底；本輪低點仍暫定，最終跌幅未定。');
  } else lines.push('週期位階：價格歷史資料不足，本期不判定位階。');
  const maReference = finite(btc?.ma50WeekUsd) && finite(btc?.ma200WeekUsd)
    ? '（50／200週線約' + price(btc.ma50WeekUsd) + '／' + price(btc.ma200WeekUsd) + '，隨週更新）' : '';
  lines.push('底部候選規則' + maReference + '：' + bottomConfirmation.rules.map(item => item.label + '【' + STATUS[item.status] + '】').join('；')
    + '。' + bottomConfirmation.phase + '。規則未經完整回測或機率校準，全部通過也不保證見底。');
  lines.push(etfText('BTC', context.etf?.BTC, sourceFor(context, 'btcEtf'))
    + etfText('ETH', context.etf?.ETH, sourceFor(context, 'ethEtf')));
  const optionalFundLine = [fundText('BTC', context.etf?.BTC), fundText('ETH', context.etf?.ETH)].filter(Boolean).join('');
  if (optionalFundLine) lines.push(optionalFundLine);
  const whaleDates = whaleAlignment.rows.map(row => dateMs(row.asOf)).filter(Number.isFinite);
  const whaleDate = whaleDates.length ? new Date(Math.max(...whaleDates)).toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  }) + '台灣時間' : '時間待補';
  lines.push('大戶本期方向（快照截至' + whaleDate + '）：\n' + whaleAlignment.rows.map(row => row.name + '：'
    + MARKETS.map(market => market + row.markets[market].text).join('；') + '。').join('\n'));
  lines.push(whaleAlignment.btcAlignment + (whaleAlignment.goldDirectionSplit === true ? 'BTC大佬與黃金大佬的黃金持倉方向分歧。'
    : whaleAlignment.goldAdjustmentSplit === true ? 'BTC大佬與黃金大佬的黃金加減倉方向分歧。' : ''));
  lines.push(crossRead(context, whaleAlignment, bottomConfirmation, time));
  lines.push('下一期驗證：看週收盤能否站穩均線、ETF能否持續轉流入，並觀察大戶是否保留新方向。若日收盤跌破暫定低點'
    + (bottomConfirmation.invalidation.referenceLowUsd ? '（' + bottomConfirmation.invalidation.referenceLowDate + '，' + price(bottomConfirmation.invalidation.referenceLowUsd) + '）' : '（待補）')
    + '、再失守均線或ETF持續流出，修復推論需下修。');
  lines.push('資料時間：' + sourceLine('BTC價格', sourceFor(context, 'prices'), btc?.asOf, time) + '；'
    + sourceLine('BTC ETF', sourceFor(context, 'btcEtf'), context.etf?.BTC?.asOf, time) + '；'
    + sourceLine('ETH ETF', sourceFor(context, 'ethEtf'), context.etf?.ETH?.asOf, time) + '。'
    + (bottomConfirmation.weeklyAsOf ? '週線截至' + bottomConfirmation.weeklyAsOf + '。' : '完整週線待補。'));
  lines.push('範圍：大戶只按數量變化判斷；回補不等於翻多，其他帳戶或現貨可能對沖。ETF淨申贖僅代表一項機構通道，含套利需求，亦未涵蓋企業、黃金基金等全部機構；三地址不代表全市場。');
  let report = lines.join('\n\n');
  if (report.length > 1800 && optionalFundLine) report = lines.filter(line => line !== optionalFundLine).join('\n\n');
  // Each non-optional line has bounded labels, dates and finite formatted numbers. Keep a hard safety
  // check instead of slicing off data-quality warnings or invalidation conditions for Telegram.
  if (report.length > 1800) throw new Error('Market-context report exceeds 1800 characters');
  return { report, bottomConfirmation, whaleAlignment };
}
