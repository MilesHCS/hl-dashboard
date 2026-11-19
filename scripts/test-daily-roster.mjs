import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { TRADERS, RETIRED_ADDRESSES } from './traders.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const day = 86400000;
const localDay = time => new Date(time + 8*3600000).toISOString().slice(0,10);

test('dashboard roster matches the six-address generator and analysis remains below reports', async()=>{
  const html = await fs.readFile(path.join(root,'index.html'),'utf8');
  const configText = html.slice(html.indexOf('const CONFIG ='),html.indexOf('// =================================================================================='));
  const config = new Function(configText+'return CONFIG;')();
  assert.deepEqual(config.traders,TRADERS);
  assert.deepEqual(config.retiredAddresses,RETIRED_ADDRESSES);
  const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
  new Function(script);
  assert.ok(script.includes('const body = sortKey === "analysis" ? analysisPanel(current)'));
  const functions=script.slice(script.indexOf('  function forecastTimelinePanel'),script.indexOf('  let sortKey'));
  const render = new Function('reports','combinedReport','reportError','esc','CONFIG','user',functions+'return analysisPanel(user);');
  const feed = Object.fromEntries(TRADERS.map(({user,name})=>[user,{name,updatedAt:new Date().toISOString(),report:'ADDRESS'}]));
  for(const {user} of TRADERS) {
    const text=render(feed,{updatedAt:new Date().toISOString(),report:'COMBINED'},false,String,config,user);
    assert.ok(text.indexOf('ADDRESS')<text.indexOf('COMBINED'));
    assert.ok(text.indexOf('COMBINED')<text.indexOf('class="forecast-timeline"'));
    assert.equal((text.match(/class="forecast-timeline"/g)||[]).length,1);
  }
  const stale=render({[TRADERS[0].user]:feed[TRADERS[0].user]},{report:'OLD_THREE_ADDRESS_SUMMARY'},false,String,config,TRADERS[0].user);
  assert.ok(!stale.includes('OLD_THREE_ADDRESS_SUMMARY'));
});

test('daily generation keeps all six reports, unknown states, new baselines and archived retired records',async()=>{
  const base=await fs.mkdtemp(path.join(os.tmpdir(),'hl-six-roster-'));
  const now=Date.now(), before=now-day, yesterday=localDay(before);
  try {
    await fs.mkdir(path.join(base,'analysis/daily'),{recursive:true});
    const prior={ [TRADERS[0].user]:{name:TRADERS[0].name,updatedAt:new Date(before).toISOString(),quantities:[0,0,-90]} };
    const history={snapshots:{[RETIRED_ADDRESSES[0]]:[{t:before,q:[-1,0,0]}]},events:{}};
    const cache={version:1,fromISO:new Date(now-29*day).toISOString(),toISO:new Date(before).toISOString(),trades:[],fundingDays:[],hedgeFlows:[]};
    for(const [name,value] of [['observations',history],['strategy-cache',cache],['market-context-cache',{}],['summary',{}]])
      await fs.writeFile(path.join(base,'analysis/'+name+'.json'),JSON.stringify(value));
    await fs.writeFile(path.join(base,'analysis/daily/'+yesterday+'.json'),JSON.stringify(prior));
    await fs.copyFile(path.join(root,'analysis/forecast-nodes.json'),path.join(base,'analysis/forecast-nodes.json'));
    const fixture=`
      const users=${JSON.stringify(TRADERS.map(x=>x.user))};
      const now=Date.now(),DAY=86400000,today=Math.floor(now/DAY)*DAY;
      const p=(coin,szi)=>({position:{coin,szi:String(szi),entryPx:'100',positionValue:String(Math.abs(szi)*100),unrealizedPnl:'1'}});
      globalThis.fetch=async(url,options={})=>{
        if(String(url)!=='https://api.hyperliquid.xyz/info')return new Response('{}',{status:503});
        const b=JSON.parse(options.body),i=users.indexOf(b.user);
        if(b.type==='allMids')return Response.json(b.dex?{'xyz:GOLD':'4000'}:{BTC:'60000',ETH:'2000'});
        if(b.type==='candleSnapshot'){
          const step=b.req.interval==='4h'?14400000:DAY;
          return Response.json(Array.from({length:400},(_,j)=>({t:today-(399-j)*step,T:today-(399-j)*step+step-1,o:'100',c:'100',h:'110',l:'90'})));
        }
        if(b.type==='spotClearinghouseState')return Response.json({balances:[{coin:'HYPE',total:'2'}]});
        if(b.type==='clearinghouseState'){
          if(i===2 && !b.dex)return new Response('{}',{status:503});
          const q=[[0,0,-100],[2,-3,0],[0,0,0],[0,0,4],[-7,5,-6],[0,0,0]][i];
          return Response.json({assetPositions:b.dex?(q[2]?[p('xyz:GOLD',q[2])]:[]):[...(q[0]?[p('BTC',q[0])]:[]),...(q[1]?[p('ETH',q[1])]:[])]});
        }
        throw Error('Unexpected test request');
      };
    `;
    execFileSync(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(fixture),path.join(root,'scripts/daily-analysis.mjs')],{
      cwd:base,env:{...process.env,IRONFLOW_API_KEY:''},timeout:30000,stdio:'pipe',
    });
    const read=async name=>JSON.parse(await fs.readFile(path.join(base,'analysis/'+name+'.json'),'utf8'));
    const feed=await read('latest'), summary=await read('summary'), saved=await read('observations');
    assert.deepEqual(Object.keys(feed),TRADERS.map(x=>x.user));
    assert.deepEqual(feed[TRADERS[2].user].quantities,[null,null,0]);
    assert.equal(feed[TRADERS[1].user].previousQuantities,null);
    assert.deepEqual(feed[TRADERS[0].user].previousQuantities,[0,0,-90]);
    assert.ok(saved.snapshots[RETIRED_ADDRESSES[0]]);
    assert.equal(saved.snapshots[TRADERS[2].user]?.length ?? 0,0);
    assert.equal(summary.whaleAlignment.rows.length,6);
    assert.equal(summary.usage.sqlCalls,0);
    assert.ok(summary.forecastTracking.nodes.length>0);
    assert.ok(summary.report.length<=3700);
    for(const entry of Object.values(feed)) {assert.ok(entry.report.length<=3700);assert.ok(!/NaN|undefined/.test(entry.report));}
    assert.ok(!/BTC大佬|ETH大佬|三個地址/.test(summary.report));
    assert.equal(saved.snapshots[TRADERS[1].user].length,1);
    // A malformed archived time cannot become a fictitious comparison date.
    prior[TRADERS[0].user].updatedAt='invalid-time';
    await fs.writeFile(path.join(base,'analysis/daily/'+yesterday+'.json'),JSON.stringify(prior));
    execFileSync(process.execPath,['--import','data:text/javascript,'+encodeURIComponent(fixture),path.join(root,'scripts/daily-analysis.mjs')],{
      cwd:base,env:{...process.env,IRONFLOW_API_KEY:''},timeout:30000,stdio:'pipe',
    });
    const invalidTimeFeed=await read('latest');
    assert.equal(invalidTimeFeed[TRADERS[0].user].previousQuantities,null);
    assert.ok(!invalidTimeFeed[TRADERS[0].user].report.includes('Invalid Date'));
  } finally {
    const resolved=path.resolve(base);
    if(path.dirname(resolved)!==path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('hl-six-roster-'))throw Error('Unsafe temporary cleanup');
    await fs.rm(resolved,{recursive:true,force:true});
  }
});
