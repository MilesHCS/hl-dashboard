const DAY = 86400000;
const ADDRESSES = [
  '0xb83de012dba672c76a7dbbbf3e459cb59d7d6e36',
  '0x5b5d51203a0f9079f8aeb098a6523a13f298c060',
  '0x46921f6961bdb411b756c9712f6bdb58fbd9164f',
];
const LABELS = ['BTC', 'ETH', '黃金'];
const MARKETS = ['BTC-PERP', 'ETH-PERP', 'xyz:GOLD-PERP'];

function timestamp(value) {
  if (typeof value === 'number') return value;
  if (!value) return NaN;
  const text = String(value).replace(' ', 'T');
  return Date.parse(/(?:Z|[+-]\d\d:\d\d)$/.test(text) ? text : text + 'Z');
}

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function number(value, digits = 0) {
  return value.toLocaleString('en-US', { maximumFractionDigits: digits });
}

function localTime(value) {
  return new Date(value).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
}

function averages(candles, time) {
  const closed = (candles ?? []).filter(candle => Number(candle.T) < time && Number(candle.c) > 0)
    .toSorted((a, b) => Number(a.t) - Number(b.t));
  if (closed.length < 60) return null;
  const mean = count => closed.slice(-count).reduce((sum, candle) => sum + Number(candle.c), 0) / count;
  return { fast: mean(20), slow: mean(60) };
}

function change(before, after) {
  if (!finite(before) || !finite(after)) return '比較基準待補齊';
  if (before === after) return after ? '持倉數量持平' : '維持無倉';
  if (!after) return '已平掉原有部位';
  if (!before) return '新建立' + (after > 0 ? '多單' : '空單');
  if (before * after < 0) return after > 0 ? '從空單翻為多單' : '從多單翻為空單';
  const ratio = Math.abs(after / before) - 1;
  const magnitude = Math.abs(ratio) < 0.01 ? '，幅度不到 1%' : '約 ' + number(Math.abs(ratio) * 100, 1) + '%';
  return (ratio > 0 ? '增加' : '減少') + (after > 0 ? '多單' : '空單') + magnitude;
}

function tradeStats(rows, fourHourCandles) {
  let opens = 0;
  let closes = 0;
  let openHours = 0;
  let closeHours = 0;
  let mixedHours = 0;
  let openDistance = 0;
  let closeDistance = 0;
  let openWeight = 0;
  let closeWeight = 0;
  for (const row of rows) {
    const open = Number(row.open_short_usd) || 0;
    const close = Number(row.close_short_usd) || 0;
    opens += open;
    closes += close;
    if (open > 0) openHours++;
    if (close > 0) closeHours++;
    if (open > 0 && close > 0) mixedHours++;
    const ma = averages(fourHourCandles, timestamp(row.hour));
    if (!ma) continue;
    if (open > 0 && Number(row.open_short_vwap) > 0) {
      openDistance += open * (Number(row.open_short_vwap) / ma.fast - 1);
      openWeight += open;
    }
    if (close > 0 && Number(row.close_short_vwap) > 0) {
      closeDistance += close * (Number(row.close_short_vwap) / ma.fast - 1);
      closeWeight += close;
    }
  }
  return {
    opens, closes, openHours, closeHours, mixedShare: rows.length ? mixedHours / rows.length : 0,
    openGap: openWeight ? openDistance / openWeight : null,
    closeGap: closeWeight ? closeDistance / closeWeight : null,
  };
}

function persistenceText(rows, fourHourCandles, from, until) {
  const midpoint = from + (until - from) / 2;
  const early = tradeStats(rows.filter(row => timestamp(row.hour) < midpoint), fourHourCandles);
  const late = tradeStats(rows.filter(row => timestamp(row.hour) >= midpoint), fourHourCandles);
  const enough = [early, late].every(part => part.openHours >= 3 && part.closeHours >= 3
    && part.openGap !== null && part.closeGap !== null);
  if (!enough) return '前後半段的加空與回補時段尚未都達到可比樣本，對持續進場規則的判斷仍需累積。';
  const bothSeparate = [early, late].every(part => part.openGap - part.closeGap > 0.01);
  if (bothSeparate) return '把可見窗口分成前後兩段後，兩段都出現加空靠近短均線、回補離均線更遠的差異。這讓候選習慣的依據比單次操作完整，但仍需上漲與盤整環境驗證。';
  const bothSimilar = [early, late].every(part => Math.abs(part.openGap - part.closeGap) < 0.005);
  if (bothSimilar) return '前後兩段中，加空與回補相對 MA20 的位置都接近，對固定均線門檻的支持持續較弱。持續的核心庫存增減，比單次觸及均線更能反映目前立場。';
  return '前後半段的均線關係尚未呈現同樣差異，可能受到不同波動環境或部位管理階段影響。後續若持續重複相同做法，才會提高對固定操作習慣的把握。';
}

function positionMeaning(before, after, focus) {
  if (!finite(before) || !finite(after)) return '前後倉位基準待補齊，本期先依可核對的行情與歷史操作判讀。';
  if (before < 0 && after < 0 && Math.abs(after) <= Math.abs(before) * 0.75) {
    return '本期回補比例較大，這個地址願意承擔的空頭風險已明顯下降。若其他商品也同步縮減，會更支持整體降曝險；若資金轉到其他部位，則需要從配置調整理解這次退出。';
  }
  if (before * after < 0) {
    return '部位已跨越零，後續應把新方向當成新的操作週期追蹤，並比較它占全帳戶的規模。小額新倉與大額核心倉，對整體立場的影響不同。';
  }
  if (after < 0 && Math.abs(after) > Math.abs(before) && before < 0) {
    return '新增空單提高了這個商品的下跌曝險。接下來要看新增數量能否持續保留，以及反彈時是否再次增加，才更能區分核心配置擴大與短線庫存調整。';
  }
  if (focus === 2 && after < 0) {
    return '黃金仍保留空頭核心。日內加減倉可能相互抵銷，連續幾期的核心數量與其他商品配置，更適合觀察它是否真正改變風險承擔。';
  }
  if (after < 0) return '目前仍保留空頭部位，價格弱勢與逐步回補可以同時發生。後續應觀察部位是否連續收縮，以及反彈時有沒有把已減掉的空單重新建立。';
  if (after > 0) return '目前保留多頭曝險，後續看回落時是否持有、上漲後是否加碼，才能逐步判斷這是短線試單還是較持續的新方向。';
  return '目前這項商品無倉，後續重新建立部位的方向與規模，會比空倉期間的單次行情更能說明下一輪策略。';
}

function priceContext(context, now) {
  if (!(Number(context?.price) > 0)) return '本期市價資訊待更新。';
  const price = Number(context.price);
  const ma = averages(context.fourHourCandles, now);
  let sentence = '合約中間價約 ' + number(price) + ' 美元。';
  if (context.month) sentence += context.month;
  if (!ma) return sentence + '4 小時均線暖機資料不足。';
  if (price < Math.min(ma.fast, ma.slow)) sentence += '價格仍低於 4 小時 MA20、MA60。';
  else if (price > Math.max(ma.fast, ma.slow)) sentence += '價格已高於 4 小時 MA20、MA60。';
  else sentence += '價格位於 4 小時 MA20 與 MA60 之間。';
  sentence += ma.fast < ma.slow ? 'MA20 仍低於 MA60。' : 'MA20 已高於或等於 MA60。';
  return sentence;
}

function profileText(stats, focus) {
  const lines = [];
  if (focus === 2 && stats.mixedShare >= 0.6) {
    lines.push('近月多數活躍小時同時有加空與回補，較符合保留核心部位後頻繁調整庫存的候選習慣。後續應優先看淨持倉是否連續改變。');
  } else if (stats.closes > stats.opens * 2 && stats.closes > 0) {
    lines.push('近月回補空單的成交明顯多於新增空單，這段操作主軸偏向退出既有空倉。價格趨勢與交易者願意留下的風險，可能以不同速度改變。');
  } else if (stats.opens > stats.closes * 1.2 && stats.opens > 0) {
    lines.push('近月加空成交多於回補，後續要看新增空頭是否保留到下一次快照，或只是短線來回調整。');
  } else if (stats.opens + stats.closes > 0) {
    lines.push('近月同時有加空與回補，應以連續幾期的核心部位變化判斷立場。');
  } else {
    lines.push('近月尚無足夠的加空、回補紀錄可辨識操作習慣。');
  }
  if (stats.openGap !== null && stats.closeGap !== null) {
    if (stats.openGap - stats.closeGap > 0.01) {
      lines.push('加空成交相對較靠近 MA20，回補則出現在更低的位置。這支持反彈增加空頭、跌離短均線後收縮部位的候選做法，實際觸發條件仍待更多行情驗證。');
    } else if (Math.abs(stats.openGap - stats.closeGap) < 0.005) {
      lines.push('加空與回補相對 MA20 的位置接近，這段紀錄對固定均線門檻的支持較弱。');
    } else {
      lines.push('加空與回補的均線位置呈現差異，仍需分開看反彈、下跌和部位重置，才能判斷是否為持續規則。');
    }
  }
  return lines.join('');
}

function hedgeText(user, cache, hedge, now) {
  if (user === ADDRESSES[2]) return '對沖觀察：黃金以外的股票、指數和商品部位也會影響整體風險。跨資產多空部位需要另驗證風險敏感度與聯動，才足以判定具體避險配對。';
  const spot = hedge?.spotHype;
  const perp = hedge?.perpHype;
  let text = '對沖觀察：';
  if (finite(spot) && finite(perp) && spot > 0 && perp < 0) {
    const cover = spot / Math.abs(perp);
    text += '目前可見 HYPE 現貨多頭與永續空頭，現貨數量約為空單的 ' + number(cover * 100) + '%。';
    text += cover < 0.99 ? 'HYPE 仍有剩餘淨空頭。' : cover > 1.01 ? 'HYPE 仍有剩餘淨多頭。' : '兩腿數量接近配平。';
  } else if (finite(spot) && finite(perp)) {
    text += '本期未見同時成立的 HYPE 現貨多頭與永續空頭配對。';
  } else {
    text += '本期 HYPE 現貨或永續資料待補齊。';
  }
  const funding = (cache?.fundingDays ?? []).filter(row => row.address === user && row.market === 'HYPE-PERP'
    && timestamp(row.day) >= now - 30 * DAY && timestamp(row.day) <= now);
  if (funding.length) {
    const net = funding.reduce((sum, row) => sum + Number(row.funding_usdc || 0), 0);
    const dates = funding.map(row => String(row.day).slice(0, 10)).toSorted();
    text += '已保存區間（UTC ' + dates[0] + ' 至 ' + dates.at(-1) + '）的 HYPE 資金費合計為淨'
      + (net >= 0 ? '收入' : '支出') + '。';
  }
  return text + '這項配對主要影響 HYPE，其他商品的方向曝險與組合費用仍需另看。如果現貨先退出、空單沒有同步回補，剩餘淨空頭就會擴大；兩腿同時縮減則較符合退出配對部位。';
}

export function describeStrategy({ user, focus, quantities, previous, context, cache, hedge, now = Date.now() }) {
  const time = timestamp(now);
  const address = user.toLowerCase();
  const before = previous?.quantities?.[focus];
  const current = quantities?.[focus];
  const from = Math.max(timestamp(cache?.fromISO) || 0, time - 30 * DAY);
  const until = Math.min(timestamp(cache?.toISO) || time, time);
  const rows = (cache?.trades ?? []).filter(row => row.address === address && row.market === MARKETS[focus]
    && timestamp(row.hour) >= from && timestamp(row.hour) < until);
  const stats = tradeStats(rows, context?.fourHourCandles);
  const paragraphs = [
    priceContext(context, time),
    '本期' + LABELS[focus] + ' ' + change(before, current) + '。' + profileText(stats, focus),
    positionMeaning(before, current, focus),
    persistenceText(rows, context?.fourHourCandles, from, until),
    hedgeText(address, cache, hedge, time),
  ];
  if (current < 0) {
    paragraphs.push('接下來觀察：如果反彈接近短均線時重新加空，會支持空頭操作延續；若反彈期間仍持續回補，則代表它繼續收縮空頭風險。鎖定收益、資金調度與降低槓桿等動機，需要資金流與其他部位再核對。');
  } else if (current > 0) {
    paragraphs.push('接下來觀察：看價格回落時是否保留多單，以及重新站穩均線後是否增加核心部位。持續減倉則顯示它在收縮這個方向的風險。');
  } else {
    paragraphs.push('接下來觀察：重新開倉的方向、成交位置與後續能否保留，比空倉期間的單次價格變動更能呈現下一輪策略。');
  }
  const dataTime = Number.isFinite(timestamp(cache?.toISO)) ? localTime(timestamp(cache.toISO)) : '尚無';
  const coverage = rows.length ? '歷史計算截至 ' + dataTime + '（台灣時間）。' : '本期缺少可用的近月成交資料，策略段僅供累積觀察。';
  paragraphs.push('資料充分性：' + coverage + '均線比較只使用當時已收盤的 K 線。先前研究窗口起點已有核心空單，原始建倉理由仍需更早資料。');
  return paragraphs.join('\n\n').slice(0, 3000);
}

function getEntry(feed, address) {
  return feed?.[address] ?? null;
}

function comparable(entry, focus) {
  return finite(entry?.quantities?.[focus]) && finite(entry?.previousQuantities?.[focus]);
}

function reduction(entry, focus) {
  if (!comparable(entry, focus)) return null;
  const before = entry.previousQuantities[focus];
  const after = entry.quantities[focus];
  if (before >= 0 || after >= 0) return null;
  return 1 - Math.abs(after / before);
}

export function summarizeTraders(feed, now = Date.now()) {
  const entries = ADDRESSES.map(address => getEntry(feed, address));
  const time = timestamp(now);
  const updated = entries.map(entry => timestamp(entry?.updatedAt)).filter(Number.isFinite);
  const starts = entries.map(entry => timestamp(entry?.from)).filter(Number.isFinite);
  const btcReductions = [reduction(entries[0], 0), reduction(entries[1], 0)];
  const paragraphs = [];
  if (btcReductions.every(value => value !== null && value > 0)) {
    paragraphs.push('BTC大佬和 ETH大佬都減少 BTC 空單，加密空頭曝險正在收縮。' +
      (btcReductions[1] > btcReductions[0] ? 'ETH大佬的 BTC 回補比例較大。' : 'BTC大佬的 BTC 回補比例較大或相近。'));
  } else if (btcReductions.every(value => value !== null && value < 0)) {
    paragraphs.push('兩位加密交易者都增加 BTC 空單，這一期新增的空頭曝險方向一致。');
  } else if (btcReductions.every(value => value !== null)) {
    paragraphs.push('兩位加密交易者對 BTC 的調倉節奏有差異，應分開觀察保留的核心部位與新增風險。');
  } else {
    paragraphs.push('BTC 比較基準或部位方向尚未一致，以下分別觀察可核對的變化。');
  }
  const changes = [];
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (entry && comparable(entry, i)) changes.push(entry.name + '的' + LABELS[i] + change(entry.previousQuantities[i], entry.quantities[i]));
  }
  if (changes.length) paragraphs.push('本期差異：' + changes.join('；') + '。');
  const gold = entries.filter(entry => comparable(entry, 2));
  if (gold.length === 3) {
    const deltas = gold.map(entry => entry.quantities[2] - entry.previousQuantities[2]);
    const allShort = gold.every(entry => entry.quantities[2] < 0);
    const split = deltas.some(value => value > 0) && deltas.some(value => value < 0);
    paragraphs.push('黃金比較：' + (allShort ? '三個地址均保留黃金空頭。' : '三個地址的黃金持倉方向存在差異。') +
      (split ? '本期有人回補、有人加空，調倉方向出現分歧。' : deltas.every(value => value === 0) ? '本期黃金數量均持平。' : '各地址調倉幅度不同，持續幾期的核心數量更值得追蹤。'));
  } else {
    paragraphs.push('黃金比較：部分地址缺少有效前後快照，跨地址結論待資料補齊。');
  }
  paragraphs.push('下一期重點：觀察價格反彈接近 MA20 時，兩位加密交易者是否重新加空，或仍持續回補；再看黃金是否同步收縮。這能逐步區分階段性調整與更持續的方向改變。');
  paragraphs.push('風險與資料：HYPE 現貨／永續配對主要抵銷該資產的部分曝險。跨地址同向操作與近月均線關聯，仍需更長行情和整體部位核對。各地址的實際比較時段見個別日報。');
  return {
    name: '三個地址綜合結論',
    updatedAt: new Date(updated.length ? Math.min(...updated) : time).toISOString(),
    from: new Date(starts.length ? Math.min(...starts) : time).toISOString(),
    report: paragraphs.join('\n\n'),
  };
}
