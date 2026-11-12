import fs from 'node:fs/promises';

import {dailyTrades,review,goldComparison} from './swing-context.mjs';
const historyFile='analysis/observations.json';
const history=JSON.parse(await fs.readFile(historyFile,'utf8'));
const file = 'analysis/latest.json';
const feed = JSON.parse(await fs.readFile(file, 'utf8'));
const traders = [
  ['0xb83de012dba672c76a7dbbbf3e459cb59d7d6e36','BTC大佬',0],
  ['0x5b5d51203a0f9079f8aeb098a6523a13f298c060','ETH大佬',1],
  ['0x46921f6961bdb411b756c9712f6bdb58fbd9164f','黃金大佬',2],
];
const coins = ['BTC','ETH','xyz:GOLD'];
const labels = ['BTC','ETH','黃金'];
const day = 86400000;
const now = Date.now();
const today = Math.floor(now/day)*day;
async function info(body) {
  for(let attempt=0;attempt<4;attempt++) {
  const response = await fetch('https://api.hyperliquid.xyz/info', {
    method:'POST', headers:{'content-type':'application/json'},
    body:JSON.stringify(body), signal:AbortSignal.timeout(20000)
  });
  if (response.status===429 && attempt<3) { await new Promise(resolve=>setTimeout(resolve,Math.max(Number(response.headers.get('Retry-After'))||0,8*2**attempt)*1000)); continue; }
  if (!response.ok) throw Error('Hyperliquid HTTP '+response.status);
  return response.json();
  }
}
function describe(before, qty) {
  const side = qty > 0 ? '多單' : '空單';
  if (before == null) return qty ? '目前持有'+side : '目前無倉';
  if (qty === before) return qty ? side+'數量持平' : '維持無倉';
  if (!qty) return '已平掉原有'+(before>0?'多單':'空單');
  if (!before) return '新開'+side;
  if (Math.sign(qty)!==Math.sign(before)) return '已反手轉為'+side;
  const ratio = Math.abs(qty / before)-1;
  return (ratio>0?'增加':'減少')+side+(Math.abs(ratio)<0.01?'，幅度不到 1%':'約 '+Math.round(Math.abs(ratio)*100)+'%');
}
const contexts = [];
for (const [i,coin] of coins.entries()) {
  const dex = i===2 ? 'xyz' : '';
  const mids = await info({type:'allMids',dex});
  const price = Number(mids[coin]);
  if (!(price>0)) throw Error('Missing price for '+coin);
  const candles = await info({type:'candleSnapshot',req:{coin,interval:'1d',startTime:today-366*day,endTime:now}});
  const first = candles.find(c=>Number(c.t)===today-30*day);
  let month = '近一個月的起始價格資料不足。';
  if (Number(first?.o)>0) {
    const pct = (price/Number(first.o)-1)*100;
    month = '相較約 30 天前'+(pct>=0?'上漲':'下跌')+'約 '+Math.abs(pct).toFixed(1)+'%。';
  }
  contexts.push({price,month,candles});
}
for (const [user,name,focus] of traders) {
  const previous = feed[user];
  const positions = [];
  for (const dex of ['', 'xyz']) {
    const s = await info({type:'clearinghouseState',user,dex});
    if (!Array.isArray(s.assetPositions)) throw Error('Missing positions');
    positions.push(...s.assetPositions.map(x=>x.position));
  }
  const quantities = coins.map(coin=>{
    const p = positions.find(x=>x.coin===coin);
    const q = p ? Number(p.szi) : 0;
    if (!Number.isFinite(q)) throw Error('Invalid size');
    return q;
  });
  const q = quantities[focus], label = labels[focus];
  const {price,month} = contexts[focus];
  const side = q>0?'多單':'空單';
  const entry = Number(positions.find(x=>x.coin===coins[focus])?.entryPx);
  let interpretation = '';
  if (q && entry>0) {
    const favorable = q*(price-entry)>0;
    interpretation = price===entry?'現價在持倉均價附近。':'現價'+(price>entry?'高於':'低於')+'持倉均價，價格變動對這筆'+side+(favorable?'有利。':'不利。');
  }
  const changes = labels.map((asset,i)=>asset+' '+describe(previous?.quantities?.[i],quantities[i]));
  const watch = q ? '接下來觀察'+label+'：如果價格'+(q>0?'回落':'反彈')+'時繼續加'+(q>0?'多':'空')+'，代表它在逆向波動中增加曝險；如果連續減倉，則顯示它正在收縮這個方向的部位。' : '接下來觀察是否重新開倉，以及新倉選擇的方向。';
  const report = label+' 合約中間價約 '+Math.round(price).toLocaleString('en-US')+' 美元，'+month+'\n\n'+changes.join('；')+'。'+interpretation+'\n\n'+watch;
  const updatedAt = new Date().toISOString();
  const snapshots=history.snapshots[user]??[];
  snapshots.push({t:now,q:quantities});
  history.snapshots[user]=snapshots.filter(s=>s.t>=now-366*day);
  const retained=(history.events[user]??[]).filter(e=>e.t>=today-365*day);
  const events=new Map(retained.map(e=>[e.t+'/'+e.i,e]));
  let fresh=[], gap='';
  try {
    const since=retained.length?Math.max(today-30*day,Math.max(...retained.map(e=>e.t))-day):today-30*day;
    fresh=await dailyTrades(info,user,coins,now,since);
  } catch(error) {
    console.warn('Fill history unavailable',user,error.message);
    gap='\n本期成交查詢未完成，成交區間及樣本只列已保存紀錄。';
  }
  for(const e of fresh) if(e.t<today)events.set(e.t+'/'+e.i,e);
  history.events[user]=[...events.values()];
  const text=review(history.snapshots[user],history.events[user],focus,contexts[focus].candles,now);
  const goldChange=previous?.quantities ? quantities[2]-previous.quantities[2] : null;
  feed[user] = {goldChange,name,from:previous?.updatedAt??updatedAt,updatedAt,quantities,report:report+'\n\n'+text+gap};
}
const comparison=goldComparison(feed,traders[0][0],traders[2][0]);
for(const i of [0,2])feed[traders[i][0]].report+='\n\n'+comparison;
await fs.writeFile(historyFile,JSON.stringify(history)+'\n');
await fs.writeFile(file,JSON.stringify(feed,null,2)+'\n');
