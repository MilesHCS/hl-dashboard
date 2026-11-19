import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWhaleAlignment, describeMarketContext } from './market-context-report.mjs';
import { TRADERS, MARKETS } from './traders.mjs';

const NOW = Date.parse('2026-11-17T02:00:00Z');
const ADDRESSES = TRADERS.map(trader => trader.user);

function fixture() {
  const weekly = [
    { date: '2026-11-08', price: 80000, ma50: 74000, ma200: 67000 },
    { date: '2026-11-15', price: 81000, ma50: 75000, ma200: 68000 },
  ];
  const etf = { asOf: '2026-11-13', dayNetUsd: 1e8, fiveSessionNetUsd: 2e8,
    twentySessionNetUsd: 3e8, sessionCount: 20, last20: [], partialPendingDates: [],
    topBuyers5: [{fund:'IBIT',netUsd:5e8}], topSellers5: [{fund:'GBTC',netUsd:-3e8}] };
  const context = {
    generatedAt: new Date(NOW).toISOString(),
    sources: {
      prices: { status: 'updated', asOf: '2026-11-15', ageDays: 2 },
      btcEtf: { status: 'updated', asOf: '2026-11-13', ageDays: 4 },
      ethEtf: { status: 'updated', asOf: '2026-11-13', ageDays: 4 },
    },
    btc: { asOf: '2026-11-15', priceUsd: 81000, yearReturnPct: -7.5,
      peak: {date:'2025-10-06',price:124824},low:{date:'2026-06-30',price:58525},
      drawdownPct: -35, maxDrawdownPct:-53.1, daysSincePeak:405, weeklyAsOf:'2026-11-15',
      ma50WeekUsd:75000, ma200WeekUsd:68000, ma50WeekPreviousUsd:74000, weekly,
      cycleHistory:[{daysToLow:406},{daysToLow:364},{daysToLow:366}] },
    etf: {BTC:structuredClone(etf),ETH:structuredClone(etf)},
  };
  const feed = Object.fromEntries(ADDRESSES.map((address,index) => [address, {
    updatedAt:new Date(NOW-index*1000).toISOString(), from:'2026-11-16T01:00:00Z',
    quantities:[-50,-200,-300],previousQuantities:[-100,-400,-600],
    levels:{BTC:{midUsd:81000},ETH:{midUsd:2000},'xyz:GOLD':{midUsd:4000}},
  }]));
  return {context,feed,now:NOW};
}

const byId = (result,id) => result.bottomConfirmation.rules.find(row=>row.id===id);

test('all candidate rules can pass without asserting a confirmed bottom or probability',()=>{
  const input=fixture();
  const before=JSON.stringify(input);
  const result=describeMarketContext(input);
  assert.equal(result.bottomConfirmation.rules.every(row=>row.status==='passed'),true);
  assert.match(result.bottomConfirmation.phase,/仍需延續/);
  assert.match(result.report,/不保證見底/);
  assert.match(result.report,/回補不等於翻多/);
  assert.match(result.report,/6地址不代表全市場/);
  assert.match(result.report,/50／200週線約75,000美元／68,000美元/);
  assert.ok(result.report.length<=1800,result.report.length);
  assert.equal(JSON.stringify(input),before);
});

test('each weekly close is compared against that week own MA, not the latest one',()=>{
  const input=fixture();
  input.context.btc.weekly[0]={date:'2026-11-08',price:71000,ma50:70000,ma200:72000};
  input.context.btc.weekly[1]={date:'2026-11-15',price:74000,ma50:71000,ma200:70000};
  assert.equal(byId(describeMarketContext(input),'ma200').status,'not_passed');
});

test('a falling 50-week MA fails the sustained repair rule even after price reclaims it',()=>{
  const input=fixture();
  input.context.btc.weekly[1].ma50=73000;
  assert.equal(byId(describeMarketContext(input),'ma50').status,'not_passed');
});

test('an unfinished Sunday cannot provide the second confirming weekly close',()=>{
  const input=fixture();
  input.context.btc.weekly=[input.context.btc.weekly[1],{
    date:'2026-11-22',price:90000,ma50:76000,ma200:69000,
  }];
  assert.equal(byId(describeMarketContext(input),'ma200').status,'insufficient');
});

test('a missing week or stale terminal weekly sample cannot certify a current bottom',()=>{
  const gap=fixture();
  gap.context.btc.weekly[0].date='2026-11-01';
  assert.equal(byId(describeMarketContext(gap),'ma200').status,'insufficient');
  const stale=fixture();
  stale.context.btc.weekly[0].date='2026-10-25';
  stale.context.btc.weekly[1].date='2026-11-01';
  assert.equal(byId(describeMarketContext(stale),'ma200').status,'insufficient');
});

test('pending ETF reports do not become a zero-flow or a passing confirmation',()=>{
  const input=fixture();
  input.context.etf.BTC.partialPendingDates=['2026-11-16'];
  const result=describeMarketContext(input);
  assert.equal(byId(result,'btcEtf').status,'insufficient');
  assert.match(result.report,/未報齊，未當成零流量/);
  assert.match(result.report,/2026-11-13/);
});

test('ETF pending dates attached to the source also prevent confirmation',()=>{
  const input=fixture();
  input.context.sources.btcEtf.pendingDates=['2026-11-16'];
  assert.equal(byId(describeMarketContext(input),'btcEtf').status,'insufficient');
});

test('a partial fund universe is labelled and cannot certify institutional confirmation',()=>{
  const input=fixture();
  input.context.etf.BTC.fundCoverageIncomplete=true;
  input.context.etf.ETH.fundCoverageIncomplete=true;
  input.context.etf.ETH.fundCount=8;
  input.context.sources.ethEtf.provider='TheBlock';
  const result=describeMarketContext(input);
  assert.equal(byId(result,'btcEtf').status,'insufficient');
  assert.match(result.report,/TheBlock已涵蓋8檔，非全體/);
});

test('missing internal ETF dates block the rule even if a provider erroneously left sums populated',()=>{
  const input=fixture();
  input.context.etf.BTC.missingDates=['2026-11-05'];
  const result=describeMarketContext(input);
  assert.equal(byId(result,'btcEtf').status,'insufficient');
  assert.match(result.report,/窗口仍有缺日/);
});

test('an unavailable five-session window suppresses misleading fund rankings',()=>{
  const input=fixture();
  input.context.etf.BTC.fiveSessionNetUsd=null;
  input.context.etf.ETH.fiveSessionNetUsd=null;
  const result=describeMarketContext(input);
  assert.doesNotMatch(result.report,/主要淨申購|主要淨贖回/);
});

test('fewer than 20 complete ETF sessions are insufficient, and zero is not net inflow',()=>{
  const input=fixture();
  input.context.etf.BTC.sessionCount=19;
  assert.equal(byId(describeMarketContext(input),'btcEtf').status,'insufficient');
  input.context.etf.BTC.sessionCount=20;
  input.context.etf.BTC.fiveSessionNetUsd=0;
  assert.equal(byId(describeMarketContext(input),'btcEtf').status,'not_passed');
});

test('failed-refresh cache and stale prices preserve dates but cannot pass current rules',()=>{
  const input=fixture();
  input.context.sources.prices.status='cached';
  input.context.sources.btcEtf.status='cached';
  const cached=describeMarketContext(input);
  assert.equal(cached.bottomConfirmation.rules.every(row=>row.status==='insufficient'),true);
  assert.match(cached.report,/沿用上次有效資料/);
  input.context.sources.prices.status='updated';
  input.context.sources.prices.ageDays=8;
  assert.equal(byId(describeMarketContext(input),'ma200').status,'insufficient');
});

test('empty and null inputs report missing data rather than an affirmative bottom',()=>{
  for(const input of [{now:NOW},{context:null,feed:null,now:NOW}]){
    const result=describeMarketContext(input);
    assert.equal(result.bottomConfirmation.rules.every(row=>row.status==='insufficient'),true);
    assert.match(result.report,/資料不足/);
    assert.ok(result.report.length<=1800);
  }
});

test('short covering, adding shorts, flat closure and reversals retain their actual directions',()=>{
  const input=fixture();
  input.feed[ADDRESSES[0]].previousQuantities=[-100,-200,100];
  input.feed[ADDRESSES[0]].quantities=[-50,-300,-100];
  input.feed[ADDRESSES[1]].previousQuantities=[-100,100,-100];
  input.feed[ADDRESSES[1]].quantities=[50,0,-50];
  const result=describeMarketContext(input);
  const first=result.whaleAlignment.rows[0].markets;
  const second=result.whaleAlignment.rows[1].markets;
  assert.equal(first.BTC.action,'cover_short');
  assert.equal(first.BTC.direction,'short');
  assert.equal(first.ETH.action,'add_short');
  assert.equal(first['xyz:GOLD'].action,'reverse_short');
  assert.equal(second.BTC.action,'reverse_long');
  assert.equal(second.ETH.action,'close_long');
  assert.match(result.report,/空轉多/);
});

test('price changes with identical quantities never manufacture a position change',()=>{
  const input=fixture();
  for(const entry of Object.values(input.feed)){
    entry.previousQuantities=[...entry.quantities];
    entry.levels.BTC.midUsd=120000;
  }
  const result=describeMarketContext(input);
  assert.equal(result.whaleAlignment.rows.every(row=>Object.values(row.markets).every(x=>x.action==='unchanged')),true);
  assert.match(result.report,/數量均持平/);
});

test('opposing gold adjustments and holding directions remain separate observations',()=>{
  const input=fixture();
  input.feed[ADDRESSES[0]].quantities[2]=-200;
  input.feed[ADDRESSES[2]].quantities[2]=-800;
  const result=describeMarketContext(input);
  assert.equal(result.whaleAlignment.goldDirectionSplit,false);
  assert.equal(result.whaleAlignment.goldAdjustmentSplit,true);
  assert.match(result.whaleAlignment.markets['xyz:GOLD'].text,/GOLD.*調倉方向分歧/);
});

test('oversized upstream labels cannot remove critical caveats or exceed Telegram budget',()=>{
  const input=fixture();
  input.context.etf.BTC.topBuyers5[0].fund='X'.repeat(100000);
  input.context.etf.ETH.topSellers5[0].fund='Y'.repeat(100000);
  const result=describeMarketContext(input);
  assert.ok(result.report.length<=1800);
  assert.match(result.report,/未涵蓋企業、黃金基金等全部機構/);
  assert.match(result.report,/暫定低點/);
});

test('covering shorts against reported ETF outflows is conditional divergence, not a bullish claim',()=>{
  const input=fixture();
  input.context.btc.weekly.forEach(row=>{ row.price=65000; });
  input.context.etf.BTC.fiveSessionNetUsd=-1e8;
  input.context.etf.BTC.twentySessionNetUsd=-5e8;
  input.context.etf.BTC.pendingDates=['2026-11-16'];
  const result=describeMarketContext(input);
  assert.match(result.report,/6地址回補BTC但仍空/);
  assert.match(result.report,/訊號分歧/);
  assert.match(result.report,/若後續.*可能偏向獲利了結或降風險/);
  assert.match(result.report,/不能判斷今日機構方向/);
  assert.match(result.report,/資料日期不同，不推因果/);
  assert.match(result.report,/快照截至/);
});

test('convergence of whales, ETF and trend supports repair without declaring the final bottom',()=>{
  const result=describeMarketContext(fixture());
  assert.match(result.report,/6地址同步回補BTC空單與ETF流入提供修復線索/);
  assert.match(result.report,/回補仍是降低空頭曝險，不代表新多頭或底部完成/);
  assert.ok(result.report.length<=1800);
});

test('nonzero residual positions display nearly 100% reduction without claiming complete closure',()=>{
  const input=fixture();
  input.feed[ADDRESSES[0]].previousQuantities=[-338.85639,1000,-6116.2027];
  input.feed[ADDRESSES[0]].quantities=[-0.00639,0.001,-0.0941];
  const result=describeMarketContext(input);
  const markets=result.whaleAlignment.rows[0].markets;
  assert.equal(markets.BTC.action,'cover_short');
  assert.equal(markets.BTC.direction,'short');
  assert.equal(markets.BTC.text,'空單回補接近100%');
  assert.equal(markets.ETH.action,'reduce_long');
  assert.equal(markets.ETH.text,'多單減倉接近100%');
  assert.equal(markets['xyz:GOLD'].text,'空單回補接近100%');
  assert.doesNotMatch(result.report,/回補100%/);
});

test('two residual shorts cannot stand in for the other four addresses',()=>{
  const input=fixture();
  input.feed[ADDRESSES[0]].previousQuantities[0]=-338.85639;
  input.feed[ADDRESSES[0]].quantities[0]=-0.00639;
  input.feed[ADDRESSES[1]].previousQuantities[0]=-872.5119;
  input.feed[ADDRESSES[1]].quantities[0]=-3.28011;
  input.context.etf.BTC.fiveSessionNetUsd=-1e8;
  input.context.etf.BTC.twentySessionNetUsd=-5e8;
  input.context.btc.weekly.forEach(row=>{row.price=65000;});
  const result=describeMarketContext(input);
  assert.equal(result.whaleAlignment.nearlyFlatShorts,false);
  assert.doesNotMatch(result.whaleAlignment.btcAlignment,/剩餘均不到前期1%/);
  assert.doesNotMatch(result.report,/兩位已大幅退出BTC空頭/);
  assert.match(result.report,/6地址回補BTC但仍空/);
  assert.equal(result.whaleAlignment.rows[1].markets.BTC.direction,'short');
  assert.ok(result.report.length<=1800);
});

test('alignment uses the complete active registry and keeps three canonical market keys',()=>{
  const input=fixture();
  // Previously tracked but now retired traders must not influence active consensus.
  input.feed['0xb83de012dba672c76a7dbbbf3e459cb59d7d6e36']={quantities:[1e9,1e9,1e9],previousQuantities:[0,0,0]};
  const result=buildWhaleAlignment(input.feed);
  assert.deepEqual(result.rows.map(row=>row.address),ADDRESSES);
  assert.deepEqual(Object.keys(result.markets),[...MARKETS]);
  assert.equal(result.rows.length,6);
  assert.equal(result.markets.BTC.counts.short,6);
  assert.doesNotMatch(describeMarketContext(input).report,/BTC大佬|ETH大佬|兩位|三地址/);
});

test('mixed long additions and short covering do not become a shared long position',()=>{
  const input=fixture();
  for(let index=0;index<ADDRESSES.length;index++){
    input.feed[ADDRESSES[index]].previousQuantities=[index<3?100:-100,0,0];
    input.feed[ADDRESSES[index]].quantities=[index<3?200:-50,0,0];
  }
  const result=describeMarketContext(input);
  const btc=result.whaleAlignment.markets.BTC;
  assert.deepEqual(btc.counts,{long:3,short:3,flat:0,unknown:0});
  assert.equal(btc.increasedCount,6);
  assert.equal(btc.actionCounts.add_long,3);
  assert.equal(btc.actionCounts.cover_short,3);
  assert.equal(btc.directionSplit,true);
  assert.equal(btc.adjustmentSplit,false);
  assert.match(result.report,/持倉多空並存/);
  assert.match(result.report,/多單加倉與空單回補需分開解讀/);
  assert.doesNotMatch(result.report,/6地址增加BTC多頭/);
});

test('flat, unknown and initial baseline are distinct and never manufacture openings',()=>{
  const input=fixture();
  input.feed[ADDRESSES[0]].quantities=[0,0,0];
  input.feed[ADDRESSES[0]].previousQuantities=[0,0,0];
  input.feed[ADDRESSES[1]].quantities=[null,null,null];
  input.feed[ADDRESSES[2]].quantities=[20,0,-10];
  input.feed[ADDRESSES[2]].previousQuantities=null;
  const result=describeMarketContext(input);
  const btc=result.whaleAlignment.markets.BTC;
  assert.deepEqual(btc.counts,{long:1,short:3,flat:1,unknown:1});
  assert.equal(btc.comparedCount,4);
  assert.equal(btc.baselineCount,1);
  assert.equal(result.whaleAlignment.rows[0].markets.BTC.action,'unchanged');
  assert.equal(result.whaleAlignment.rows[1].markets.BTC.action,'unknown');
  assert.equal(result.whaleAlignment.rows[1].markets.BTC.after,null);
  assert.equal(result.whaleAlignment.rows[2].markets.BTC.action,'baseline');
  assert.equal(result.whaleAlignment.rows[2].markets.BTC.delta,null);
  assert.equal(result.whaleAlignment.rows[2].markets.ETH.direction,'flat');
  assert.match(result.report,/BTC可比較4／6，新增基準1/);
  assert.match(result.report,/新增基準/);
  assert.doesNotMatch(result.report,/6地址同步回補|6地址增加BTC多頭/);
});

test('missing gold cannot become flat or establish no directional disagreement',()=>{
  const input=fixture();
  input.feed[ADDRESSES[5]].quantities[2]=null;
  let result=buildWhaleAlignment(input.feed);
  assert.equal(result.markets['xyz:GOLD'].counts.unknown,1);
  assert.equal(result.goldDirectionSplit,null);
  assert.equal(result.goldAdjustmentSplit,null);
  input.feed[ADDRESSES[4]].quantities[2]=100;
  result=buildWhaleAlignment(input.feed);
  assert.equal(result.goldDirectionSplit,true);
  // Observed opposing directions remain real even with one unavailable market.
  assert.equal(result.markets['xyz:GOLD'].counts.long,1);
});

test('flat gold and a short position are not opposing holding directions',()=>{
  const input=fixture();
  for(const address of ADDRESSES){
    input.feed[address].previousQuantities[2]=0;
    input.feed[address].quantities[2]=0;
  }
  input.feed[ADDRESSES[5]].previousQuantities[2]=-100;
  input.feed[ADDRESSES[5]].quantities[2]=-50;
  const result=buildWhaleAlignment(input.feed);
  assert.equal(result.goldDirectionSplit,false);
  assert.deepEqual(result.markets['xyz:GOLD'].counts,{long:0,short:1,flat:5,unknown:0});
});

test('six large short exits preserve residual direction and Telegram budget',()=>{
  const input=fixture();
  for(const entry of Object.values(input.feed)){
    entry.previousQuantities=[-10000,-10000,-10000];
    entry.quantities=[-0.001,-0.001,-0.001];
  }
  input.context.etf.BTC.fiveSessionNetUsd=-1e8;
  input.context.etf.BTC.twentySessionNetUsd=-5e8;
  const result=describeMarketContext(input);
  assert.equal(result.whaleAlignment.nearlyFlatShorts,true);
  assert.match(result.whaleAlignment.btcAlignment,/6個原空頭.*剩餘均不到前期1%/);
  assert.match(result.report,/6個原BTC空頭大幅回補/);
  assert.equal(result.whaleAlignment.markets.BTC.counts.short,6);
  assert.ok(result.report.length<=1800,result.report.length);
});

test('a long holding can join the ETF repair signal only through actual long exposure changes',()=>{
  const input=fixture();
  for(const entry of Object.values(input.feed)){
    entry.previousQuantities=[100,0,0];
    entry.quantities=[150,0,0];
  }
  const result=describeMarketContext(input);
  assert.match(result.report,/6地址增加BTC多頭與ETF流入出現修復線索/);
  assert.match(result.report,/即使同向，也只支持風險修復，不證明底部完成/);
});

test('six-address divergence plus incomplete sources preserves all quality caveats within the budget',()=>{
  const input=fixture();
  const changes=[[100,200],[100,50],[-100,-200],[-100,-50],[0,100],[null,-100]];
  for(let index=0;index<ADDRESSES.length;index++){
    input.feed[ADDRESSES[index]].previousQuantities=MARKETS.map(()=>changes[index][0]);
    input.feed[ADDRESSES[index]].quantities=MARKETS.map(()=>changes[index][1]);
  }
  for(const label of ['BTC','ETH']){
    input.context.etf[label].provider='P'.repeat(20);
    input.context.etf[label].fundCount=8;
    input.context.etf[label].fundCoverageIncomplete=true;
    input.context.etf[label].partialPendingDates=['2026-11-16'];
    input.context.etf[label].missingDates=['2026-11-05'];
  }
  input.context.sources.prices.status='cached';
  input.context.sources.btcEtf.status='cached';
  input.context.sources.ethEtf.status='cached';
  const result=describeMarketContext(input);
  assert.ok(result.report.length<=1800,result.report.length);
  assert.match(result.report,/新增基準/);
  assert.match(result.report,/多空分歧/);
  assert.match(result.report,/未報齊，未當成零流量/);
  assert.match(result.report,/窗口仍有缺日/);
  assert.match(result.report,/沿用上次有效資料/);
  assert.match(result.report,/暫定低點/);
});
