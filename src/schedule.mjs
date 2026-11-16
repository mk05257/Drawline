const zone = 'America/Toronto';
function parts(date) {
  return Object.fromEntries(new Intl.DateTimeFormat('en-CA',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).formatToParts(date).map(p=>[p.type,p.value]));
}
function zonedTime(y,m,d) {
  const target = Date.UTC(y,m-1,d,22,30);
  let value = target;
  for(let i=0;i<3;i++) { const p=parts(new Date(value)); value += target-Date.UTC(+p.year,+p.month-1,+p.day,+p.hour,+p.minute,+p.second); }
  return new Date(value);
}
export function nextDraw(game, now = new Date()) {
  const p=parts(now), days = game === 'ca649' ? [3,6] : [2,5];
  for(let i=0;i<8;i++) {
    const date = new Date(Date.UTC(+p.year,+p.month-1,+p.day+i,12));
    if(days.includes(date.getUTCDay())) {
      const draw=zonedTime(date.getUTCFullYear(),date.getUTCMonth()+1,date.getUTCDate());
      if(draw > now) return draw;
    }
  }
}
export function drawLabel(date) { return new Intl.DateTimeFormat('en-US',{timeZone:zone,weekday:'short',month:'short',day:'numeric',hour:'numeric',minute:'2-digit'}).format(date)+' ET'; }
export function remaining(date,now) { const s=Math.max(0,Math.floor((date-now)/1000)); return `${Math.floor(s/86400)}d ${Math.floor(s%86400/3600)}h ${Math.floor(s%3600/60)}m ${s%60}s left`; }

export function drawDate(date){const p=parts(date);const weekday=new Intl.DateTimeFormat('en-US',{timeZone:zone,weekday:'long'}).format(date);const months=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];return `${weekday}, ${+p.day} ${months[+p.month-1]} ${p.year}`;}
export function countdownParts(date,now){const s=Math.max(0,Math.floor((date-now)/1000));return {DAYS:Math.floor(s/86400),H:Math.floor(s%86400/3600),MIN:Math.floor(s%3600/60),S:s%60};}
