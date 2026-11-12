const DAY = 86400000;
const date = t => new Date(t).toISOString().slice(5,10);
const pct = n => (100*n).toFixed(1)+'%';
const median = xs => { const a=xs.toSorted((x,y)=>x-y), i=Math.floor(a.length/2); return a.length%2?a[i]:(a[i-1]+a[i])/2; };
const action = (a,b) => b===0?'平倉':a===0?(b>0?'開多':'開空'):a*b<0?(b>0?'翻多':'翻空'):(Math.abs(b)>Math.abs(a)?'加':'減')+(b>0?'多':'空');
const size = e => e.a ? Math.abs(e.b-e.a)/Math.abs(e.a) : null;
const major = e => e.a!==e.b && (e.a*e.b<=0 || size(e)>=0.05);
const add = e => major(e) && e.b!==0 && (e.a*e.b<=0 || Math.abs(e.b)>Math.abs(e.a));
const px = n => Math.round(n).toLocaleString('en-US');

// Reconstruct one net event per UTC day. Reject discontinuities and partial oldest days.
export async function dailyTrades(info,user,coins,now) {
  const start = now- thirtyDays();
  let cursor=start, fills=new Map(), complete=false, firstFullDay=0;
  for(let page=0;page<12;page++) {
    const rows=await info({type:'userFillsByTime',user,startTime:cursor,endTime:now,aggregateByTime:true});
    if(!Array.isArray(rows)) throw Error('Missing fills');
    if(page===0 && rows.length && Math.min(...rows.map(x=>x.time))>start)
      firstFullDay=(Math.floor(Math.min(...rows.map(x=>x.time))/DAY)+1)*DAY;
    for(const f of rows) if(coins.includes(f.coin)) fills.set([f.coin,f.tid,f.oid,f.time,f.sz].join('/'),f);
    if(rows.length<2000){complete=true;break;}
    const next=Math.max(...rows.map(f=>f.time));
    if(next<=cursor) break;
    cursor=next;
  }
  const groups=new Map();
  for(const f of [...fills.values()].sort((x,y)=>x.time-y.time||x.tid-y.tid)) {
    const t=Math.floor(f.time/DAY)*DAY;
    if(t<firstFullDay || (!complete && t+DAY>=cursor)) continue;
    const i=coins.indexOf(f.coin), key=t+'/'+i;
    const a=Number(f.startPosition), d=(f.side==='B'?1:-1)*Number(f.sz);
    const g=groups.get(key)??{t,i,a,b:a,ok:true,buys:[],sells:[]};
    if(Math.abs(g.b-a)>0.000001)g.ok=false;
    g.b=Number((a+d).toFixed(8));
    (d>0?g.buys:g.sells).push(Number(f.px));
    groups.set(key,g);
  }
  return [...groups.values()].filter(g=>g.ok).map(g=>{
    const prices=g.b>g.a?g.buys:g.sells;
    return {t:g.t,i:g.i,a:g.a,b:g.b,lo:prices.length?Math.min(...prices):null,hi:prices.length?Math.max(...prices):null};
  });
}
function thirtyDays(){return 30*DAY;}

export function review(history,events,focus,candles,now) {
  const today=Math.floor(now/DAY)*DAY;
  const monthEvents=events.filter(e=>e.i===focus && e.t>=today-29*DAY).sort((a,b)=>a.t-b.t);
  const recent=history.filter(s=>s.t>=now-thirtyDays());
  const big=monthEvents.filter(major), last=big.at(-1);
  const seen=recent.length?(now-recent[0].t)/DAY:0;
  const path=big.length?big.slice(-3).map(e=>date(e.t)+' '+action(e.a,e.b)).join(' → '):'可核對成交中未見達門檻的調整';
  let msg='近月操作（UTC 交易日）：'+path+'。持倉快照涵蓋'+(seen>=1?Math.floor(seen)+'天':'不足一天')+'；成交紀錄可能不完整。';
  if(last) {
    const ratio=size(last), peers=monthEvents.filter(e=>e.t<last.t && e.a*e.b>0 && e.a!==e.b).map(size);
    msg+='\n最近一次明顯調倉：'+action(last.a,last.b)+(ratio!==null && last.a*last.b>0?'約原倉 '+pct(ratio):'')+'。當天同向成交價 '+px(last.lo)+(last.hi!==last.lo?'–'+px(last.hi):'')+' 美元。';
    msg+=peers.length>=3?'此前有異動日的調倉幅度中位數為 '+pct(median(peers))+'。':'平常調倉幅度的樣本仍少。';
  } else {
    const prev=recent.slice(0,-1).reverse().find(s=>s.q[focus]!==recent.at(-1)?.q[focus]);
    msg+=prev?' 最近快照可見'+action(prev.q[focus],recent.at(-1).q[focus])+'；尚無相應的完整成交區間。':' 尚無可核對的明顯調倉價帶。';
  }
  const bars=new Map(candles.map(c=>[Number(c.t),c]));
  const samples=events.filter(e=>e.i===focus && add(e));
  const stats=[7,30].map(n=>{
    let wins=0, risks=[];
    for(const e of samples) {
      const start=e.t+DAY;
      if(start+n*DAY>now)continue;
      const span=Array.from({length:n},(_,i)=>bars.get(start+i*DAY));
      if(span.some(c=>!c))continue;
      const base=Number(span[0].o), sign=Math.sign(e.b);
      wins+=sign*(Number(span.at(-1).c)-base)>0;
      risks.push(Math.max(0,...span.map(c=>sign>0?1-Number(c.l)/base:Number(c.h)/base-1)));
    }
    return n+'天'+(risks.length?'方向符合 '+wins+'/'+risks.length+'，樣本最大逆走 '+pct(Math.max(...risks)):'暫無到期樣本');
  });
  return msg+'\n波段追蹤（開倉、反手或加倉至少 5%，同日合併，從次日開盤算）：'+stats.join('；')+'。';
}
export function goldComparison(feed,a,b) {
  const x=feed[a],y=feed[b];
  const last=v=>v.goldChange;
  if(last(x)==null||last(y)==null)return '黃金比較基準不足。';
  const d=last(x),e=last(y);
  const move=n=>n===0?'持平':n>0?'往多方調整':'往空方調整';
  return '黃金對照：BTC大佬'+move(d)+'，黃金大佬'+move(e)+'。'+(d*e<0?'兩者的調倉方向出現分歧。':d===0&&e===0?'本期都沒有改變黃金曝險。':'本期未見兩者反向調倉。');
}
