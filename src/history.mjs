import { GAMES } from './picker.mjs';
export function historicalPool(game,date) { return game==='ca649'?49:date<'2019-05-14'?49:date<'2026-04-14'?50:52; }
export function parseHistory(text,game) {
  const size=GAMES[game].size, rows=text.trim().split(/\r?\n/);
  const expected=['date','weekday',...Array.from({length:size},(_,i)=>`n${i+1}`),'b1'].join(',');
  if(rows.shift().replace(/^\uFEFF/,'')!==expected) throw Error(`Unexpected ${game} CSV header`);
  let previous='';
  return rows.map((row,i)=>{
    const cells=row.split(','),[date,weekday]=cells, nums=cells.slice(2).map(Number), pool=historicalPool(game,date);
    const parsed=new Date(date+'T12:00:00Z');
    if(cells.length!==size+3 || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(+parsed) || parsed.toISOString().slice(0,10)!==date || date<=previous || nums.some(n=>!Number.isInteger(n)||n<1||n>pool) || new Set(nums).size!==size+1) throw Error(`Invalid ${game} CSV row ${i+2}`);
    previous=date;
    return {date,weekday,numbers:nums.slice(0,size),bonus:nums[size],pool};
  });
}
export function describe(draws,game) {
  const counts=Array(GAMES[game].pool+1).fill(0), last=Array(counts.length).fill(-1), pairs=new Map();
  draws.forEach((draw,index)=>draw.numbers.forEach((n,i)=>{ counts[n]++;last[n]=index;draw.numbers.slice(i+1).forEach(m=>{const key=[n,m].sort((a,b)=>a-b).join(' + ');pairs.set(key,(pairs.get(key)||0)+1);}); }));
  const frequencies=counts.slice(1).map((count,i)=>({number:i+1,count,gap:draws.length-1-last[i+1]}));
  return {most:[...frequencies].sort((a,b)=>b.count-a.count||a.number-b.number).slice(0,3),least:[...frequencies].sort((a,b)=>a.count-b.count||a.number-b.number).slice(0,3),gaps:[...frequencies].sort((a,b)=>b.gap-a.gap||a.number-b.number).slice(0,3),pairs:[...pairs].sort((a,b)=>b[1]-a[1]||a[0].localeCompare(b[0])).slice(0,3)};
}
export function checkLine(line,draws) {
  // Only draws in which this selection was possible belong in its comparison.
  const eligible=draws.filter(d=>line.numbers.every(n=>n<=d.pool));
  const counts=Object.fromEntries(Array.from({length:GAMES[line.game].size-2},(_,i)=>[i+3,0]));
  let best=0,bestDate=null;
  for(const d of eligible) {const matches=line.numbers.filter(n=>d.numbers.includes(n)).length;if(matches>best){best=matches;bestDate=d.date;}for(const threshold of Object.keys(counts)) if(matches>=+threshold) counts[threshold]++;}
  return {best,bestDate,counts,total:eligible.length,excluded:draws.length-eligible.length};
}
export function newestDrawMatches(savedLines,drawsByGame) {
  if(!Array.isArray(savedLines)||!savedLines.length||!drawsByGame) return [];
  const results=[];
  for(const line of savedLines) {
    const entry=drawsByGame[line?.game], draws=Array.isArray(entry)?entry:entry?.rows;
    if(!GAMES[line?.game]||!Array.isArray(draws)||!draws.length) continue;
    const newest=draws.at(-1);
    if(!line.numbers.every(n=>n<=newest.pool)) continue;
    const matches=line.numbers.filter(n=>newest.numbers.includes(n)).length;
    if(matches>=3) results.push({id:line.id,game:line.game,gameName:GAMES[line.game].name,numbers:[...line.numbers],matches,date:newest.date});
  }
  return results.sort((a,b)=>b.matches-a.matches);
}
export function recentDraws(draws,count=5) {
  if(!Array.isArray(draws)) return [];
  return draws.slice(-count).reverse();
}
