import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {GAMES,pickLines,validLine,randomBelow} from '../src/picker.mjs';
import {nextDraw} from '../src/schedule.mjs';
import {parseHistory,describe,checkLine,historicalPool,newestDrawMatches,recentDraws} from '../src/history.mjs';
import {readSaved,writeSaved,exportSavedLines,parseImportedLines,mergeImportedLines,IMPORT_ERROR} from '../src/storage.mjs';
const histories=Object.fromEntries(Object.keys(GAMES).map(g=>[g,parseHistory(readFileSync(new URL(`../public/data/${g}.csv`,import.meta.url),'utf8'),g)]));
for(const game of Object.keys(GAMES)) test(`${game}: valid uniform picker shapes, unique lines and distinct bonus`,()=>{
 let reachedMax=false;
 for(let i=0;i<100;i++){const lines=pickLines(game,10);assert.equal(new Set(lines.map(l=>l.numbers.join(','))).size,10);for(const l of lines){assert.ok(validLine(l));assert.deepEqual(l.numbers,[...l.numbers].sort((a,b)=>a-b));if(l.numbers.includes(GAMES[game].pool))reachedMax=true;}}
 assert.ok(reachedMax);
});
test('picker bounds and rejection of modulo-biased random words',()=>{
 assert.throws(()=>pickLines('ca649',11));assert.throws(()=>pickLines('bad',3));
 const original=Object.getOwnPropertyDescriptor(globalThis,'crypto');let calls=0;
 Object.defineProperty(globalThis,'crypto',{configurable:true,value:{getRandomValues(a){a[0]=calls++===0?0xffffffff:48;return a;}}});
 try{assert.equal(randomBelow(49),48);assert.equal(calls,2);}finally{Object.defineProperty(globalThis,'crypto',original);}
});
test('next draws follow Toronto calendar (Nov 18 is Wednesday, Nov 17 is Tuesday)',()=>{
 const now=new Date('2026-11-14T04:00:00Z'); // Friday 11 PM ET, after the Max draw
 assert.equal(nextDraw('ca649',now).toISOString(),'2026-11-15T03:30:00.000Z');
 assert.equal(nextDraw('lottomax',now).toISOString(),'2026-11-18T03:30:00.000Z'); // Tuesday Nov 17 ET
 assert.equal(nextDraw('lottomax',new Date('2026-11-13T17:00:00Z')).toISOString(),'2026-11-14T03:30:00.000Z');
 assert.equal(nextDraw('ca649',new Date('2026-11-15T03:30:00Z')).toISOString(),'2026-11-19T03:30:00.000Z');
});
test('Toronto daylight saving and year boundary',()=>{
 assert.equal(nextDraw('ca649',new Date('2026-07-03T12:00:00Z')).toISOString(),'2026-07-05T02:30:00.000Z');
 assert.equal(nextDraw('lottomax',new Date('2026-12-31T12:00:00Z')).toISOString(),'2027-01-02T03:30:00.000Z');
});
test('bundled history counts and frequency spot checks',()=>{
 assert.equal(histories.ca649.length,4467);assert.equal(histories.lottomax.length,1286);
 assert.deepEqual(describe(histories.ca649,'ca649').most[0],{number:45,count:605,gap:describe(histories.ca649,'ca649').most[0].gap});
 assert.equal(describe(histories.lottomax,'lottomax').most[0].number,28);assert.equal(describe(histories.lottomax,'lottomax').most[0].count,208);
});
test('regime boundaries and invalid CSV rows',()=>{
 assert.equal(historicalPool('lottomax','2019-05-10'),49);assert.equal(historicalPool('lottomax','2019-05-14'),50);assert.equal(historicalPool('lottomax','2026-04-13'),50);assert.equal(historicalPool('lottomax','2026-04-14'),52);
 const header='date,weekday,n1,n2,n3,n4,n5,n6,n7,b1\n';
 for(const row of ['2026-04-10,fri,1,2,3,4,5,6,51,8','2026-04-14,tue,1,2,3,4,5,6,7,7','2026-02-30,tue,1,2,3,4,5,6,7,8'])assert.throws(()=>parseHistory(header+row,'lottomax'));
});
test('verified disputed Max rows are preserved',()=>{
 for(const [date,numbers,bonus] of [['2024-11-26',[20,24,31,33,36,41,49],50],['2026-01-02',[5,9,11,22,30,41,43],49],['2026-03-03',[1,3,4,18,20,23,31],2]]){const row=histories.lottomax.find(d=>d.date===date);assert.deepEqual(row.numbers,numbers);assert.equal(row.bonus,bonus);}
});
test('descriptive counts, pairs, gaps and cumulative backtest on a known fixture',()=>{
 const draws=[{date:'2026-01-01',numbers:[1,2,3,4,5,6],pool:49},{date:'2026-01-02',numbers:[1,2,3,7,8,9],pool:49}];
 const s=describe(draws,'ca649');assert.equal(s.most[0].count,2);assert.equal(s.pairs.find(p=>p[0]==='1 + 2')[1],2);assert.equal(s.most.find(n=>n.number===1).gap,0);
 const r=checkLine({game:'ca649',numbers:[1,2,3,4,5,6]},draws);assert.equal(r.best,6);assert.deepEqual(r.counts,{3:2,4:1,5:1,6:1});
 const max=checkLine({game:'lottomax',numbers:[1,2,3,4,5,51,52]},[{...draws[0],pool:50}]);assert.equal(max.total,0);assert.equal(max.excluded,1);
});
test('saved lines survive storage reload and deletion; corrupt storage is rejected',()=>{
 const map=new Map(),storage={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v)};
 const lines=pickLines('lottomax',2).map((l,i)=>({...l,id:String(i),savedAt:'2026-11-14T12:00:00Z'}));writeSaved(storage,lines);assert.deepEqual(readSaved(storage),lines);writeSaved(storage,lines.slice(1));assert.equal(readSaved(storage).length,1);writeSaved(storage,[{}]);assert.throws(()=>readSaved(storage));
});

import {mergeHistory,acceptHistory,readHistory,loadHistory,HISTORY_KEY,FETCH_INTERVAL} from '../src/history-storage.mjs';
import {drawDate,countdownParts} from '../src/schedule.mjs';
const maxCSV=readFileSync(new URL('../public/data/lottomax.csv',import.meta.url),'utf8').trim();
const newMax='2026-11-13,fri,4,9,15,25,27,44,47,29';
test('history merge keeps only newer dates and deduplicates',()=>{
 const extra=parseHistory(maxCSV+'\n'+newMax,'lottomax').at(-1);
 const merged=mergeHistory(histories.lottomax,[histories.lottomax[0],extra,extra]);
 assert.equal(merged.length,1287);assert.equal(new Set(merged.map(r=>r.date)).size,1287);
 assert.deepEqual(merged.slice(0,1286),histories.lottomax);
 assert.equal(acceptHistory(histories.lottomax,maxCSV,'lottomax').rows.length,1286);
});
test('entire fetched CSV is discarded if any row fails validation',()=>{
 const result=acceptHistory(histories.lottomax,maxCSV+'\n'+newMax+'\n2026-11-17,tue,1,1,2,3,4,5,6,7','lottomax');
 assert.equal(result.updated,false);assert.equal(result.rows,histories.lottomax);
});
test('missing, stale, corrupt and wrong-version history falls back to bundle',()=>{
 const now=Date.parse('2026-11-15T12:00:00Z');
 for(const raw of [null,'{','{}',JSON.stringify({version:2,games:{}}),JSON.stringify({version:1,games:{lottomax:{fetchedAt:now-FETCH_INTERVAL,csv:maxCSV+'\n'+newMax}}}),JSON.stringify({version:1,games:{lottomax:{fetchedAt:now,csv:'bad'}}})]){
  const state=readHistory({getItem:()=>raw},histories,now);
  assert.equal(state.lottomax.updated,false);assert.deepEqual(state.lottomax.rows,histories.lottomax);
 }
});
test('fresh persisted history skips external downloads; failures use bundle per game',async()=>{
 const map=new Map(),storage={getItem:k=>map.get(k)??null,setItem:(k,v)=>map.set(k,v)};let downloads=0,state;
 const fetcher=async url=>{
  const game=url.includes('ca649')||url.includes('1Egvhy_vYwyK_SSZ4bV6dZ_HEKA6hzMaG')?'ca649':'lottomax';
  if(url.startsWith('https:')){downloads++;if(game==='ca649')throw Error('offline');}
  return {ok:true,text:async()=>game==='lottomax'?maxCSV+(url.startsWith('https:')?'\n'+newMax:''):readFileSync(new URL('../public/data/ca649.csv',import.meta.url),'utf8')};
 };
 await loadHistory({storage,fetcher,onChange:s=>state=s});assert.equal(downloads,3);assert.equal(state.ca649.updated,false);assert.equal(state.lottomax.rows.length,1287);
 assert.ok(map.has(HISTORY_KEY));downloads=0;
 await loadHistory({storage,fetcher,onChange:s=>state=s});assert.equal(downloads,2);assert.equal(state.lottomax.updated,true);
 const r=checkLine({game:'lottomax',numbers:[4,9,15,25,27,44,47]},state.lottomax.rows);assert.equal(r.best,7);assert.equal(r.bestDate,'2026-11-13');
});
test('countdown has Toronto spelled-out date and structured time units',()=>{
 const now=new Date('2026-11-15T12:00:00Z'),draw=nextDraw('lottomax',now);
 assert.equal(drawDate(draw),'Tuesday, 17 NOV 2026');
 assert.deepEqual(countdownParts(draw,now),{DAYS:2,H:15,MIN:30,S:0});
 assert.deepEqual(countdownParts(now,draw),{DAYS:0,H:0,MIN:0,S:0});
});
test('export saved lines shape and import validation, whole-file rejection and deduplication',()=>{
 const sample=[
  {id:'line-1',game:'ca649',numbers:[3,11,19,24,36,45],bonus:12,savedAt:'2026-11-14T12:00:00.000Z'},
  {id:'line-2',game:'lottomax',numbers:[4,9,15,25,27,44,47],bonus:29,savedAt:'2026-11-15T08:30:00.000Z'}
 ];
 const exported=exportSavedLines(sample);
 const parsed=JSON.parse(exported);
 assert.equal(parsed.version,1);
 assert.deepEqual(parsed.lines,sample);
 assert.deepEqual(parseImportedLines(exported),sample);
 const withDupes=JSON.stringify({version:1,lines:[sample[0],sample[1],sample[0]]});
 assert.deepEqual(parseImportedLines(withDupes),sample);
 assert.deepEqual(mergeImportedLines([sample[0]],withDupes),sample);
 for(const bad of [
  'not json',
  '{}',
  JSON.stringify({version:2,lines:sample}),
  JSON.stringify({version:1,lines:'not-an-array'}),
  JSON.stringify({version:1,lines:[sample[0],{...sample[1],id:''}]}),
  JSON.stringify({version:1,lines:[sample[0],{...sample[1],savedAt:'not-a-date'}]}),
  JSON.stringify({version:1,lines:[sample[0],{...sample[1],numbers:[1,2,3]}]}),
  JSON.stringify({version:1,lines:[sample[0],{...sample[1],bonus:4}]})
 ]){
  assert.throws(()=>parseImportedLines(bad),{message:IMPORT_ERROR});
 }
});
test('newest-draw match note checks only the newest draw, requires 3+ matches, sorts best first and respects pool eligibility',()=>{
 const drawsByGame={
  ca649:[
   {date:'2026-11-07',weekday:'sat',numbers:[1,2,3,4,5,6],bonus:7,pool:49},
   {date:'2026-11-11',weekday:'wed',numbers:[10,20,30,40,41,42],bonus:43,pool:49}
  ],
  lottomax:[
   {date:'2026-11-10',weekday:'tue',numbers:[1,2,3,4,5,6,7],bonus:8,pool:52},
   {date:'2026-11-13',weekday:'fri',numbers:[4,9,15,25,27,44,47],bonus:29,pool:52}
  ]
 };
 assert.deepEqual(newestDrawMatches([],drawsByGame),[]);
 assert.deepEqual(newestDrawMatches([{id:'a',game:'ca649',numbers:[1,2,3,4,5,6],bonus:7,savedAt:'2026-11-14T00:00:00Z'}],null),[]);
 // Matched 6 in an older draw (2026-11-07) and only 2 in newest draw -> nothing shown
 const olderOnly=[
  {id:'old-hit',game:'ca649',numbers:[1,2,3,4,5,6],bonus:7,savedAt:'2026-11-14T00:00:00Z'},
  {id:'two-hit',game:'lottomax',numbers:[4,9,1,2,3,6,8],bonus:10,savedAt:'2026-11-14T00:00:00Z'}
 ];
 assert.deepEqual(newestDrawMatches(olderOnly,drawsByGame),[]);
 // 3+ matches in newest draw, sorted best match first
 const matching=[
  {id:'three-hit',game:'ca649',numbers:[10,20,30,1,2,3],bonus:4,savedAt:'2026-11-14T00:00:00Z'},
  {id:'four-hit',game:'lottomax',numbers:[4,9,15,25,1,2,3],bonus:5,savedAt:'2026-11-14T00:00:00Z'},
  ...olderOnly
 ];
 const matches=newestDrawMatches(matching,drawsByGame);
 assert.equal(matches.length,2);
 assert.equal(matches[0].id,'four-hit');assert.equal(matches[0].matches,4);assert.equal(matches[0].date,'2026-11-13');
 assert.equal(matches[1].id,'three-hit');assert.equal(matches[1].matches,3);assert.equal(matches[1].date,'2026-11-11');
 // Pool eligibility rule: if newest draw has pool 50 and line uses 52, it is excluded
 const restrictedPool={lottomax:[{date:'2026-04-10',weekday:'fri',numbers:[1,2,3,4,5,6,7],bonus:8,pool:50}]};
 assert.deepEqual(newestDrawMatches([{id:'pool-out',game:'lottomax',numbers:[1,2,3,4,5,6,52],bonus:8,savedAt:'2026-11-14T00:00:00Z'}],restrictedPool),[]);
});
test('recentDraws returns latest 5 draws newest-first without mutating input',()=>{
 const copy=[...histories.ca649];
 const recent=recentDraws(copy,5);
 assert.equal(recent.length,5);
 assert.equal(recent[0].date,'2026-11-11');
 assert.deepEqual(recent.map(d=>d.date),histories.ca649.slice(-5).map(d=>d.date).reverse());
 assert.equal(copy.at(-1).date,'2026-11-11');
});
