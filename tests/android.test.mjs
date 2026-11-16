import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {GAMES} from '../src/picker.mjs';
import {loadHistory,DRIVE_IDS,driveUrl,lottochaosUrl,bundledUrl} from '../src/history-storage.mjs';

const ca649CSV=readFileSync(new URL('../public/data/ca649.csv',import.meta.url),'utf8').trim();
const maxCSV=readFileSync(new URL('../public/data/lottomax.csv',import.meta.url),'utf8').trim();
const new649='2026-11-14,sat,1,8,9,21,38,47,10';
const newMax='2026-11-13,fri,4,9,15,25,27,44,47,29';

function createStorage(){
 const map=new Map();
 return {getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v),map};
}

function gameForUrl(url){
 if(url.includes('ca649')||url.includes(DRIVE_IDS.ca649))return 'ca649';
 if(url.includes('lottomax')||url.includes(DRIVE_IDS.lottomax))return 'lottomax';
 throw Error(`Unknown URL: ${url}`);
}

test('Drive URL is fetched FIRST for each game and skips lottochaos when Drive succeeds',async()=>{
 const storage=createStorage(),callsByGame={ca649:[],lottomax:[]};
 let state;
 const fetcher=async url=>{
  const game=gameForUrl(url);
  callsByGame[game].push(url);
  if(url===driveUrl('ca649'))return {ok:true,text:async()=>ca649CSV+'\n'+new649};
  if(url===driveUrl('lottomax'))return {ok:true,text:async()=>maxCSV+'\n'+newMax};
  return {ok:true,text:async()=>game==='ca649'?ca649CSV:maxCSV};
 };
 await loadHistory({storage,fetcher,onChange:s=>state=s});
 for(const game of Object.keys(GAMES)){
  assert.equal(callsByGame[game][0],driveUrl(game));
  assert.ok(!callsByGame[game].includes(lottochaosUrl(game)),`Should not fetch lottochaos when Drive succeeded for ${game}`);
  assert.equal(state[game].updated,true);
 }
 assert.equal(state.ca649.rows.at(-1).date,'2026-11-14');
 assert.equal(state.lottomax.rows.at(-1).date,'2026-11-13');
});

test('failing or invalid Drive CSV falls back to lottochaos',async()=>{
 const storage=createStorage(),callsByGame={ca649:[],lottomax:[]};
 let state;
 const fetcher=async url=>{
  const game=gameForUrl(url);
  callsByGame[game].push(url);
  // ca649 Drive fails with HTTP error; lottomax Drive returns invalid CSV (HTML / bad rows)
  if(url===driveUrl('ca649'))return {ok:false,text:async()=>''};
  if(url===driveUrl('lottomax'))return {ok:true,text:async()=>'<!doctype html><html>not a csv</html>'};
  if(url===lottochaosUrl('ca649'))return {ok:true,text:async()=>ca649CSV+'\n'+new649};
  if(url===lottochaosUrl('lottomax'))return {ok:true,text:async()=>maxCSV+'\n'+newMax};
  return {ok:true,text:async()=>game==='ca649'?ca649CSV:maxCSV};
 };
 await loadHistory({storage,fetcher,onChange:s=>state=s});
 assert.deepEqual(callsByGame.ca649.slice(0,2),[driveUrl('ca649'),lottochaosUrl('ca649')]);
 assert.deepEqual(callsByGame.lottomax.slice(0,2),[driveUrl('lottomax'),lottochaosUrl('lottomax')]);
 assert.equal(state.ca649.updated,true);
 assert.equal(state.ca649.rows.at(-1).date,'2026-11-14');
 assert.equal(state.lottomax.updated,true);
 assert.equal(state.lottomax.rows.at(-1).date,'2026-11-13');
});

test('lottochaos failing falls back to bundled CSV',async()=>{
 const storage=createStorage(),callsByGame={ca649:[],lottomax:[]};
 let state;
 const fetcher=async url=>{
  const game=gameForUrl(url);
  callsByGame[game].push(url);
  if(url.startsWith('https://'))throw Error('network down');
  return {ok:true,text:async()=>game==='ca649'?ca649CSV:maxCSV};
 };
 await loadHistory({storage,fetcher,onChange:s=>state=s});
 for(const game of Object.keys(GAMES)){
  assert.deepEqual(callsByGame[game],[driveUrl(game),lottochaosUrl(game),bundledUrl(game)]);
  assert.equal(state[game].updated,false);
 }
 assert.equal(state.ca649.rows.length,4467);
 assert.equal(state.ca649.rows.at(-1).date,'2026-11-11');
 assert.equal(state.lottomax.rows.length,1286);
 assert.equal(state.lottomax.rows.at(-1).date,'2026-11-10');
});

test('bundled CSV path is base-relative with no leading-slash absolute /data/ fetch',async()=>{
 const storage=createStorage(),allUrls=[];
 const fetcher=async url=>{
  allUrls.push(url);
  const game=gameForUrl(url);
  if(url.startsWith('https://'))return {ok:false,text:async()=>''};
  return {ok:true,text:async()=>game==='ca649'?ca649CSV:maxCSV};
 };
 await loadHistory({storage,fetcher,onChange:()=>{}});
 const bundledCalls=allUrls.filter(u=>!u.startsWith('https://'));
 assert.equal(bundledCalls.length,2);
 for(const url of bundledCalls){
  assert.ok(!url.startsWith('/data/'),`Expected base-relative bundled path, got ${url}`);
  assert.match(url,/(^|\/Drawline\/)data\/(ca649|lottomax)\.csv$/);
 }
});
