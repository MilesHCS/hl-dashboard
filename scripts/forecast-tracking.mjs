import { createHash } from 'node:crypto';

const DAY = 86400000;
const finitePositive = value => typeof value === 'number' && Number.isFinite(value) && value > 0;
const instant = value => typeof value === 'string' && /T.*(?:Z|[+-]\d{2}:\d{2})$/.test(value)
  && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;
const localDay = ms => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(ms);
const localTime = value => new Intl.DateTimeFormat('zh-TW', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', hour12: false,
}).format(new Date(value));
const round = (value, digits = 1) => value.toLocaleString('en-US', { maximumFractionDigits: digits });
const clone = value => JSON.parse(JSON.stringify(value));
const referenceInstrument = market => market === 'xyz:GOLD'
  ? 'Hyperliquid xyz:GOLD perpetual midpoint' : 'Hyperliquid BTC perpetual midpoint';

function quoteFor(feed, market, now) {
  const candidates = [];
  let ignoredCount = 0;
  for (const item of Object.values(feed && typeof feed === 'object' ? feed : {})) {
    const price = item?.levels?.[market]?.midUsd;
    const at = instant(item?.updatedAt);
    if (!finitePositive(price) || !Number.isFinite(at) || at > now) { ignoredCount++; continue; }
    candidates.push({ price, at, asOf: new Date(at).toISOString() });
  }
  if (!candidates.length) return { status: 'missing', price: null, asOf: null, ignoredCount };
  const firstPrice = candidates[0].price;
  if (candidates.some(q => Math.abs(q.price - firstPrice) > Math.max(1e-8, firstPrice * 1e-10))) {
    return { status: 'conflict', price: null, asOf: null, ignoredCount, candidateCount: candidates.length };
  }
  // The oldest supporting timestamp is conservative when multiple rows share one market quote.
  const earliest = candidates.reduce((a, b) => a.at <= b.at ? a : b);
  return { status: 'available', price: firstPrice, asOf: earliest.asOf,
    ignoredCount, candidateCount: candidates.length, ageHours: (now - earliest.at) / 3600000,
    olderCalendarDay: localDay(earliest.at) !== localDay(now) };
}

function definitionKey(node) {
  return createHash('sha256').update(JSON.stringify({ id: node.id, market: node.market, kind: node.kind,
    targetUsd: node.targetUsd ?? null, comparator: node.comparator ?? null,
    window: node.window ?? null, source: node.source ?? null, sourceInstrument: node.sourceInstrument ?? null })).digest('hex');
}

function validPriorObservation(value, node, now, start, end) {
  const at = instant(value?.quoteAsOf);
  return Number.isFinite(at) && at <= now && at >= start && (node.window?.openEnded === true || at < end)
    && finitePositive(value?.priceUsd) && value?.instrument === referenceInstrument(node.market);
}

function evaluateNode(input, quote, previous, now) {
  const node = clone(input);
  const key = definitionKey(node);
  const start = instant(node.window?.start), end = instant(node.window?.end);
  const validWindow = Number.isFinite(start) && Number.isFinite(end) && start < end;
  const hasTarget = finitePositive(node.targetUsd) && node.comparator === 'lte';
  const quoteAt = instant(quote.asOf);
  const quoteEligible = validWindow && quote.status === 'available' && quoteAt >= start
    && (node.window?.openEnded === true || quoteAt < end);
  const prior = previous?.definitionKey === key ? previous : null;
  const priorLast = prior && validPriorObservation(prior.lastObservation, node, now, start, end)
    ? clone(prior.lastObservation) : null;
  const priorTouch = hasTarget && prior && validPriorObservation(prior.firstReferenceTouch, node, now, start, end)
    && prior.firstReferenceTouch.priceUsd <= node.targetUsd ? clone(prior.firstReferenceTouch) : null;
  const newObservation = quoteEligible && (!priorLast || quoteAt > instant(priorLast.quoteAsOf));
  const observation = newObservation ? {
    quoteAsOf: quote.asOf, priceUsd: quote.price, instrument: referenceInstrument(node.market),
  } : priorLast;
  const currentTouches = hasTarget && newObservation && quote.price <= node.targetUsd;
  const firstReferenceTouch = priorTouch || (currentTouches ? clone(observation) : null);
  const priorCount = prior && Number.isSafeInteger(prior.referenceObservationCount)
    && prior.referenceObservationCount >= 0 ? prior.referenceObservationCount : 0;

  let temporalStatus = !validWindow ? 'unknown'
    : now < start ? 'before_window' : now >= end
      ? node.window?.openEnded === true ? 'after_coarse_window_open_end' : 'window_ended'
      : 'in_window';
  let status = !validWindow ? '資料不足' : temporalStatus === 'before_window' ? '尚未到期'
    : temporalStatus === 'in_window' ? '窗口進行中'
      : temporalStatus === 'after_coarse_window_open_end' ? '無硬性截止，待核對'
        : '窗口結束，待同口徑核對';
  let reason = !validWindow ? '時間窗口缺失或無法核對。'
    : temporalStatus === 'window_ended'
      ? '窗口結束，原市場是否觸價或完成轉折待核對；每日參考快照不是完整日內資料。'
      : temporalStatus === 'after_coarse_window_open_end'
        ? '已超出這一段追蹤窗口，但原話容許更晚，沒有硬性截止。'
        : node.window?.precision === 'coarse_window'
          ? '僅為追蹤用粗窗口，不是講者給出的精確轉折日。' : '明確期限尚未結束，不能提前判定結果。';
  if (quote.status !== 'available') {
    status = '資料不足';
    reason += quote.status === 'conflict' ? '各快照參考價不一致，未任選其中一筆。'
      : '沒有有效、含明確時間且不在未來的參考價；不能推論無變化或未達。';
  }
  const conditionStatus = node.dependsOn ? 'unverified' : 'not_applicable';
  if (node.dependsOn) {
    status = '條件未核對';
    reason = '前一節點在原市場是否未觸價尚未核對；本替代情境不自動啟動，也不延長原期限。'
      + (node.window?.openEnded ? '原話另容許更晚，沒有硬性截止。' : '');
  }
  const requiredMovePct = hasTarget && quote.status === 'available'
    ? (node.targetUsd / quote.price - 1) * 100 : null;
  const gapUsd = hasTarget && quote.status === 'available' ? quote.price - node.targetUsd : null;
  // The full original wording stays in forecast-nodes.json, not copied into every daily archive.
  const source = { recordedDate: node.source?.recordedDate ?? null, videoTitle: node.source?.videoTitle ?? null,
    timestamp: node.source?.timestamp ?? null, claimIds: clone(node.source?.claimIds ?? []) };
  const window = { start: node.window?.start ?? null, end: node.window?.end ?? null,
    timeZone: node.window?.timeZone ?? null, label: node.window?.label ?? null,
    precision: node.window?.precision ?? null, endExclusive: true,
    ...(node.window?.openEnded ? { openEnded: true } : {}) };
  return { id: node.id, asset: node.asset, market: node.market, kind: node.kind, label: node.label,
    confidence: node.confidence ?? null, source, window,
    sourceInstrument: node.sourceInstrument ?? null, dailyPriority: node.dailyPriority ?? 100,
    direction: node.direction ?? null,
    ...(hasTarget ? { targetUsd: node.targetUsd, comparator: node.comparator } : {}),
    ...(node.dependsOn ? { dependsOn: clone(node.dependsOn) } : {}),
    definitionKey: key, temporalStatus, status, reason, conditionStatus,
    preciseOutcome: 'unverified', sourceMarketComparable: false,
    referenceInstrument: referenceInstrument(node.market), referenceStatus: quote.status,
    referencePriceUsd: quote.price, quoteAsOf: quote.asOf,
    quoteOlderCalendarDay: quote.olderCalendarDay ?? null, quoteAgeHours: quote.ageHours ?? null,
    gapUsd, requiredMovePct, referenceWithinThreshold: requiredMovePct === null ? null : quote.price <= node.targetUsd,
    referenceTouchObserved: Boolean(firstReferenceTouch), firstReferenceTouch,
    referenceObservationCount: priorCount + (newObservation ? 1 : 0), lastObservation: observation,
    observationUpdate: newObservation ? 'new_snapshot' : quoteEligible && priorLast
      ? quoteAt === instant(priorLast.quoteAsOf) ? 'same_snapshot' : 'older_snapshot_ignored'
      : quote.status !== 'available' ? 'missing_reference' : 'outside_window',
  };
}

function relevant(node, now) {
  const start = instant(node.window?.start), end = instant(node.window?.end);
  return Number.isFinite(start) && Number.isFinite(end)
    && (node.window?.openEnded === true && start <= now
      || start <= now && now < end || start > now && start - now <= 100 * DAY
      || end <= now && now - end <= 14 * DAY);
}

function priceSentence(node) {
  const label = node.asset === 'GOLD' ? '黃金' : node.asset;
  const confidence = String(node.confidence || '信心未量化').replace(/[。\s]+$/g, '');
  const deadlineLabel = node.id === 'gold-3500-before-thanksgiving'
    ? '感恩節前（紐約11/26開始前）' : node.window?.label ?? '原窗口';
  const prefix = `${label}${round(node.targetUsd, 0)}：${deadlineLabel}，原說法屬「${confidence}」。`;
  if (node.dependsOn) return prefix + '前一條件未核對，不能自動啟用替代期限。';
  if (node.referenceStatus !== 'available') return prefix + '參考價資料不足或互相不一致，不能推論未達或無變化。';
  let priceText = `參考價約${round(node.referencePriceUsd, 2)}美元，`;
  if (node.referencePriceUsd > node.targetUsd) priceText += `尚需下跌約${round(Math.abs(node.requiredMovePct))}%。`;
  else priceText += '目前位於參考門檻內，但不等於原市場目標已命中。';
  if (node.referenceTouchObserved) priceText += '日報曾記錄窗口內參考觸價；';
  if (node.temporalStatus === 'window_ended') return prefix + priceText + '窗口結束，原市場是否觸價待核對。';
  if (node.temporalStatus === 'after_coarse_window_open_end') return prefix + priceText + '原話容許更晚，沒有硬性截止。';
  return prefix + priceText + (node.temporalStatus === 'before_window' ? '窗口尚未開始。' : '期限尚未到。');
}

function buildReport(nodes, quotes, now, maxChars) {
  if (maxChars <= 0) return '';
  const sorted = nodes.toSorted((a, b) => (a.dailyPriority ?? 100) - (b.dailyPriority ?? 100));
  const goldPrice = sorted.find(n => n.asset === 'GOLD' && n.kind === 'price' && relevant(n, now));
  const goldPath = sorted.filter(n => n.asset === 'GOLD' && n.kind !== 'price' && relevant(n, now)).slice(0, 2);
  const btcPath = sorted.filter(n => n.asset === 'BTC' && relevant(n, now)).slice(0, 2);
  const quoteEntries = Object.entries(quotes).filter(([, q]) => q.status === 'available');
  const times = [...new Set(quoteEntries.map(([, q]) => q.asOf))];
  const old = quoteEntries.some(([, q]) => q.olderCalendarDay) ? '，舊快照' : '';
  const timeLine = times.length === 1 ? `參考價截至${localTime(times[0])}（台灣${old}）。`
    : quoteEntries.length ? '參考價時間（台灣）：' + quoteEntries.map(([a, q]) => `${a} ${localTime(q.asOf)}`).join('；') + `${old}。`
      : '參考價缺失，無法判斷價差或變化。';
  const pathSentence = (label, path) => path.length
    ? `${label}時間節點：` + path.map(n => `${n.label}（${n.status}）`).join('；') + '。粗窗口不作二元勝負判定。'
    : `${label}目前沒有可核對的近期時間節點。`;
  const warning = '價格是Hyperliquid永續中間價，黃金不是影片GC期貨口徑；缺少原市場完整日內高低，不能證明曾／未觸價。預測不是底部確認。';
  const full = ['影片預測節點參考。' + timeLine,
    goldPrice ? priceSentence(goldPrice) : '近期沒有可核對的黃金價位節點。',
    pathSentence('黃金', goldPath), pathSentence('BTC', btcPath),
    'ETH：影片沒有獨立預測節點。' + warning].join('\n\n');
  if (full.length <= maxChars) return full;
  const goldShort = goldPrice
    ? `黃金${round(goldPrice.targetUsd, 0)}是「${String(goldPrice.confidence || '信心未量化')}」情境；`
      + (goldPrice.referenceStatus === 'available' && goldPrice.referencePriceUsd > goldPrice.targetUsd
        ? `參考價尚需跌${round(Math.abs(goldPrice.requiredMovePct))}%；` : '參考價或觸價狀態待核對；')
      + (goldPrice.temporalStatus === 'window_ended' ? '窗口結束，原市場是否觸價待核對。' : `${goldPrice.status}。`)
    : '黃金近期節點資料待核對。';
  const compact = [timeLine, goldShort,
    btcPath.length ? 'BTC：' + btcPath.map(n => n.label).join('；') + '，粗窗口待驗證。' : 'BTC近期節點待核對。',
    'ETH無獨立節點。僅參考中間價，並非GC口徑或完整盤中紀錄，不判命中。'].join('\n');
  if (compact.length <= maxChars) return compact;
  // Choose complete, caution-preserving short forms instead of cutting a claim mid-sentence.
  const fallback = goldPrice ? [
    `黃金${round(goldPrice.targetUsd, 0)}為「${String(goldPrice.confidence || '信心未量化')}」情境；僅參考價，原市場觸價待核對。`,
    '影片節點屬低信心參考；篇幅不足，原市場觸價待核對。',
    '低信心節點待核對。',
  ] : ['影片節點資料或篇幅不足，不作命中判定。', '影片節點待核對。'];
  return fallback.find(line => line.length <= maxChars) ?? '';
}

export function describeForecastTracking({ registry = {}, feed = {}, previous = {}, now = Date.now(), maxReportChars = 700 } = {}) {
  const evaluatedNow = Number.isFinite(now) ? now : Date.now();
  const budget = Number.isFinite(maxReportChars) ? Math.max(0, Math.floor(maxReportChars)) : 700;
  const sourceNodes = Array.isArray(registry.nodes) ? registry.nodes.filter(n => n && typeof n === 'object' && typeof n.id === 'string') : [];
  const priorNodes = new Map((Array.isArray(previous?.nodes) ? previous.nodes : [])
    .filter(n => n && typeof n.id === 'string').map(n => [n.id, n]));
  const quotes = { BTC: quoteFor(feed, 'BTC', evaluatedNow), GOLD: quoteFor(feed, 'xyz:GOLD', evaluatedNow) };
  const nodes = sourceNodes.map(n => evaluateNode(n, quotes[n.asset] ?? { status: 'missing', price: null, asOf: null }, priorNodes.get(n.id), evaluatedNow));
  return {
    schemaVersion: 1, evaluatedAt: new Date(evaluatedNow).toISOString(), registryAsOf: registry.registryAsOf ?? null,
    priceAsOf: { BTC: quotes.BTC.asOf, GOLD: quotes.GOLD.asOf }, nodes,
    report: buildReport(nodes, quotes, evaluatedNow, budget),
    limitations: [
      '每日Hyperliquid參考快照不是影片原市場的完整盤中高低資料，沒有精確命中／失準判定。',
      '未記錄參考觸價不等於盤中未達；回補空單、ETF流量或底部規則不證明影片預測成立。',
      '粗窗口只是追蹤用途；條件式替代期限不覆蓋或延長原預測。',
      'ETH沒有獨立影片預測節點。',
    ],
  };
}
