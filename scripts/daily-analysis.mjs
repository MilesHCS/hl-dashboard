import fs from 'node:fs/promises';

const path = 'analysis/latest.json';
const feed = JSON.parse(await fs.readFile(path, 'utf8'));
const seeds = {
  '0xb83de012dba672c76a7dbbbf3e459cb59d7d6e36': [-2019.90075,188.6593,-6121.3565],
  '0x5b5d51203a0f9079f8aeb098a6523a13f298c060': [-2325.44901,-38057.1865,-6416.1587],
  '0x46921f6961bdb411b756c9712f6bdb58fbd9164f': [0,0,-7433.1986]
};
const coins = ['BTC','ETH','xyz:GOLD'];
const fmt = n => n.toLocaleString('en-US',{maximumFractionDigits:6});
const direction = n => n === 0 ? '無倉' : (n > 0 ? '多 ' : '空 ') + fmt(Math.abs(n));
function change(before, after) {
  if (before === after) return '持平';
  if (!before) return '開倉';
  if (!after) return '平倉';
  if (Math.sign(before) !== Math.sign(after)) return '反手';
  const ratio = Math.abs(after / before) - 1;
  return (ratio > 0 ? '加' : '減') + (after > 0 ? '多 ' : '空 ') + fmt(Math.abs(ratio)*100) + '%';
}
async function getMarket(user,dex) {
  const response = await fetch('https://api.hyperliquid.xyz/info',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'clearinghouseState',user,dex}),signal:AbortSignal.timeout(20000)});
  if (!response.ok) throw Error('Hyperliquid HTTP '+response.status);
  const state = await response.json();
  if (!Array.isArray(state.assetPositions)) throw Error('Missing positions');
  return state.assetPositions.map(x=>x.position);
}
for (const [address, seed] of Object.entries(seeds)) {
  const previous = feed[address];
  const before = previous?.quantities ?? (previous?.updatedAt?.startsWith('2026-11-12T03:50:42.') ? seed : null);
  const positions = [...await getMarket(address,''), ...await getMarket(address,'xyz')];
  const rows = coins.map(coin => {
    const p = positions.find(pos=>pos.coin===coin);
    const qty = p ? Number(p.szi) : 0, value = p ? Number(p.positionValue) : 0;
    if (!Number.isFinite(qty) || !Number.isFinite(value)) throw Error('Invalid position');
    return {qty,value};
  });
  const updatedAt = new Date().toISOString();
  const largest = rows.reduce((i,row,j)=>row.value>rows[i].value?j:i,0);
  const summary = rows[largest].value ? '三項中最大部位為 '+coins[largest]+' '+direction(rows[largest].qty)+'。' : '三項均無持倉。';
  const lines = rows.map(({qty,value},i)=>coins[i]+'　'+(before ? direction(before[i])+' → '+direction(qty)+'（'+change(before[i],qty)+'）' : direction(qty)+'（建立基準）')+'，名目約 '+fmt(Math.round(value))+' 美元');
  feed[address]={from:before?previous.updatedAt:updatedAt,updatedAt,quantities:rows.map(r=>r.qty),report:summary+'\n\n'+lines.join('\n')};
}
await fs.writeFile(path,JSON.stringify(feed,null,2)+'\n');
