import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchTrackedSnapshot } from './position-snapshot.mjs';
const contexts = [{price:100},{price:10},{price:50}];
const clock = () => Date.parse('2026-11-20T01:00:00Z');
const position = (coin, szi) => ({position:{coin,szi,entryPx:'10',positionValue:'20',unrealizedPnl:'1'}});
const run = info => fetchTrackedSnapshot({info,user:'0xsample',contexts,clock});
test('successful empty main and xyz states establish actual flat positions',async()=>{
  const result=await run(async body=>body.type==='spotClearinghouseState'?{balances:[]}:{assetPositions:[]});
  assert.deepEqual(result.quantities,[0,0,0]);assert.equal(result.complete,true);
});
test('failed xyz is unknown while BTC and ETH remain usable',async()=>{
  const result=await run(async body=>{if(body.dex==='xyz')throw Error('HTTP 503');return body.type==='spotClearinghouseState'?{balances:[]}:{assetPositions:[position('BTC','2')]};});
  assert.deepEqual(result.quantities,[2,0,null]);assert.equal(result.levels['xyz:GOLD'].notionalUsd,null);assert.equal(result.complete,false);
});
test('failed main does not invent BTC ETH or HYPE perpetual quantities',async()=>{
  const result=await run(async body=>{if(body.type==='spotClearinghouseState')return{balances:[{coin:'HYPE',total:'3'}]};if(!body.dex)throw Error('HTTP 429');return{assetPositions:[position('xyz:GOLD','-4')]};});
  assert.deepEqual(result.quantities,[null,null,-4]);assert.equal(result.hedge.spotHype,3);assert.equal(result.hedge.perpHype,null);
});
test('malformed response cannot masquerade as an empty state',async()=>{
  const result=await run(async body=>body.type==='spotClearinghouseState'?{}:{error:'not a state'});
  assert.deepEqual(result.quantities,[null,null,null]);assert.equal(result.hedge,null);
});
test('invalid quantity does not become zero',async()=>{
  const result=await run(async body=>body.type==='spotClearinghouseState'?{balances:[]}:{assetPositions:body.dex?[]:[position('BTC',null)]});
  assert.deepEqual(result.quantities,[null,null,0]);
});
test('one spot failure leaves validated perpetuals intact',async()=>{
  const result=await run(async body=>{if(body.type==='spotClearinghouseState')throw Error('Unavailable');return{assetPositions:body.dex?[position('xyz:GOLD','-2')]:[position('ETH','5')]};});
  assert.deepEqual(result.quantities,[0,5,-2]);assert.equal(result.hedge,null);assert.equal(result.complete,true);
});
