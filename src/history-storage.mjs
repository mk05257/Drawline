import {GAMES} from './picker.mjs';
import {parseHistory} from './history.mjs';
export const HISTORY_KEY='drawline.history.v1';
export const FETCH_INTERVAL=60*60*1000;
export const DRIVE_IDS={
 ca649:'1Egvhy_vYwyK_SSZ4bV6dZ_HEKA6hzMaG',
 lottomax:'1uFxrG7OIyHJsWxygAQGbi1C_kDK3WFGl'
};
export const driveUrl=game=>`https://drive.usercontent.google.com/download?id=${DRIVE_IDS[game]}&export=download`;
export const lottochaosUrl=game=>`https://lottochaos.com/data/${game}.csv`;
export function bundledUrl(game){
 const base=import.meta.env?.BASE_URL;
 return `${base&&base!=='/'?base:''}data/${game}.csv`;
}
export const remoteUrls=game=>[driveUrl(game),lottochaosUrl(game)];
const header=game=>['date','weekday',...Array.from({length:GAMES[game].size},(_,i)=>`n${i+1}`),'b1'].join(',');
function toCSV(rows,game){return [header(game),...rows.map(r=>[r.date,r.weekday,...r.numbers,r.bonus].join(','))].join('\n');}
export function mergeHistory(bundled,fetched){
 const newer=new Map();
 for(const row of fetched) if(row.date>bundled.at(-1).date)newer.set(row.date,row);
 return [...bundled,...[...newer.values()].sort((a,b)=>a.date.localeCompare(b.date))];
}
export function acceptHistory(bundled,text,game){
 try{return {rows:mergeHistory(bundled,parseHistory(text,game)),updated:true};}
 catch{return {rows:bundled,updated:false};}
}
export function readHistory(storage,bundled,now=Date.now()){
 try{
  const value=JSON.parse(storage.getItem(HISTORY_KEY));
  if(value?.version!==1||!value.games)throw Error('Invalid history version');
  const result={};
  for(const game of Object.keys(GAMES)){
   const entry=value.games[game];
   if(!entry){result[game]={rows:bundled[game],updated:false};continue;}
   if(!Number.isFinite(entry.fetchedAt)||entry.fetchedAt>now||typeof entry.csv!=='string')throw Error('Invalid stored history');
   const rows=parseHistory(entry.csv,game);
   const merged=mergeHistory(bundled[game],rows);
   if(toCSV(rows,game)!==toCSV(merged,game))throw Error('Stored archive differs from bundle');
   result[game]=now-entry.fetchedAt<FETCH_INTERVAL?{rows:merged,updated:true,fetchedAt:entry.fetchedAt}:{rows:bundled[game],updated:false};
  }
  return result;
 }catch{return Object.fromEntries(Object.keys(GAMES).map(g=>[g,{rows:bundled[g],updated:false}]));}
}
async function fetchRemoteText(game,fetcher){
 for(const url of remoteUrls(game)){
  try{
   const response=await fetcher(url,{signal:AbortSignal.timeout(15000)});
   if(!response.ok)continue;
   const text=await response.text();
   parseHistory(text,game);
   return text;
  }catch{/* fall through to next source */}
 }
 return null;
}
function hasFreshCache(storage,now){
 try{
  const value=JSON.parse(storage.getItem(HISTORY_KEY));
  if(value?.version!==1||!value.games)return {};
  return Object.fromEntries(Object.keys(GAMES).map(g=>{
   const entry=value.games[g];
   return [g,Boolean(entry&&Number.isFinite(entry.fetchedAt)&&entry.fetchedAt<=now&&now-entry.fetchedAt<FETCH_INTERVAL&&typeof entry.csv==='string')];
  }));
 }catch{return {};}
}
export async function loadHistory({storage,fetcher=fetch,onChange,now=Date.now()}){
 const fresh=hasFreshCache(storage,now);
 const remoteTexts={};
 await Promise.all(Object.keys(GAMES).map(async game=>{
  if(!fresh[game])remoteTexts[game]=await fetchRemoteText(game,fetcher);
 }));
 const bundled=Object.fromEntries(await Promise.all(Object.keys(GAMES).map(async game=>{
  const response=await fetcher(bundledUrl(game));
  if(!response.ok)throw Error('Could not load bundled history.');
  return [game,parseHistory(await response.text(),game)];
 })));
 const state=readHistory(storage,bundled,now);
 onChange({...state});
 for(const game of Object.keys(GAMES)){
  if(state[game].updated)continue;
  const text=remoteTexts[game]??(fresh[game]?await fetchRemoteText(game,fetcher):null);
  if(text){
   const accepted=acceptHistory(bundled[game],text,game);
   state[game]={...accepted,...(accepted.updated?{fetchedAt:Date.now()}:{})};
  }else{
   state[game]={rows:bundled[game],updated:false};
  }
  onChange({...state});
 }
 try{storage.setItem(HISTORY_KEY,JSON.stringify({version:1,games:Object.fromEntries(Object.entries(state).filter(([,v])=>v.updated).map(([g,v])=>[g,{fetchedAt:v.fetchedAt,csv:toCSV(v.rows,g)}]))}));}catch{/* History remains usable when storage is unavailable. */}
}
