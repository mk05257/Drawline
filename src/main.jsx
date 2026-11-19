import React, {useEffect,useMemo,useRef,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {GAMES,pickLines} from './picker.mjs';
import {nextDraw,drawDate,countdownParts} from './schedule.mjs';
import {describe,checkLine,newestDrawMatches,recentDraws} from './history.mjs';
import {readSaved,writeSaved,exportSavedLines,mergeImportedLines} from './storage.mjs';
import {loadHistory} from './history-storage.mjs';
import {GOOGLE_OAUTH_CLIENT_ID,DRIVE_SCOPE,REDIRECT_URI} from './drive-config.mjs';
import {
 getAccessToken,
 clearAccessToken,
 readDeletedIds,
 writeDeletedIds,
 startGoogleSignIn,
 consumeOAuthRedirect,
 syncSavedLines,
 UnauthorizedDriveError
} from './drive-sync.mjs';
import './style.css';

const pad=n=>String(n).padStart(2,'0');
const fmtSyncTime=d=>`${pad(d.getHours())}:${pad(d.getMinutes())}`;
const MONTHS=['JAN','FEB','MAR','APR','MAY','JUN','JUL','AUG','SEP','OCT','NOV','DEC'];
const UNIT_LABELS={DAYS:'DAYS',H:'HOURS',MIN:'MIN',S:'SEC'};
const savedDate=d=>new Date(d).toLocaleDateString('en-CA',{year:'numeric',month:'short',day:'numeric'});
const shortDrawDate=d=>new Intl.DateTimeFormat('en-US',{timeZone:'UTC',month:'short',day:'numeric'}).format(new Date(d+'T12:00:00Z'));
const renderStatItems=items=>items.map(text=><span className="stat-item" key={text}>{text}</span>);

function fmtArchiveDate(iso){
 if(!iso)return '';
 const [y,m,d]=iso.split('-');
 return `${+d} ${MONTHS[+m-1]} ${y}`;
}

function fmtWeekdayDraw(draw){
 if(!draw)return '';
 const [,m,d]=draw.date.split('-');
 const w=draw.weekday?draw.weekday[0].toUpperCase()+draw.weekday.slice(1).toLowerCase():'';
 return `${w} ${+d} ${MONTHS[+m-1]}`;
}

function BottomNav({page}){
 return (
  <nav className="navwrap" aria-label="Primary navigation">
   <div className="nav">
    <a href="#" className={'nav-item'+(page==='picker'?' active':'')} aria-current={page==='picker'?'page':undefined} aria-label="Pick">
     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <rect x="3" y="3" width="8" height="8" rx="2"/>
      <rect x="13" y="3" width="8" height="8" rx="2"/>
      <rect x="3" y="13" width="8" height="8" rx="2"/>
      <rect x="13" y="13" width="8" height="8" rx="2"/>
     </svg>
     <span>Pick</span>
    </a>
    <a href="#history" className={'nav-item'+(page==='history'?' active':'')} aria-current={page==='history'?'page':undefined} aria-label="History">
     <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <rect x="3" y="5" width="18" height="16" rx="3"/>
      <path d="M3 10h18M8 3v4M16 3v4"/>
     </svg>
     <span>History</span>
    </a>
   </div>
  </nav>
 );
}

function History({saved,history,error,initialGame}){
 const [histGame,setHistGame]=useState(initialGame||'ca649');
 const [selected,setSelected]=useState(saved[0]?.id||'');
 const [result,setResult]=useState(null);
 useEffect(()=>{
  if(saved.length&&!saved.some(l=>l.id===selected))setSelected(saved[0].id);
  if(!saved.length&&selected)setSelected('');
 },[saved,selected]);
 const data=useMemo(()=>history&&Object.fromEntries(Object.entries(history).map(([g,v])=>[g,v.rows])),[history]);
 useEffect(()=>setResult(null),[data]);
 const stats=useMemo(()=>data&&Object.fromEntries(Object.keys(GAMES).map(g=>[g,describe(data[g],g)])),[data]);
 const recent=useMemo(()=>data&&Object.fromEntries(Object.keys(GAMES).map(g=>[g,recentDraws(data[g],5)])),[data]);
 const line=saved.find(l=>l.id===selected)||saved[0]||null;
 const checked=useMemo(()=>{
  if(result)return result;
  if(line&&data?.[line.game])return checkLine(line,data[line.game]);
  return null;
 },[result,line,data]);
 const latestDraw=line&&data?.[line.game]?.at(-1);
 const latestMatches=line&&latestDraw&&line.numbers.every(n=>n<=latestDraw.pool)?line.numbers.filter(n=>latestDraw.numbers.includes(n)).length:null;
 const gameDraws=data?.[histGame];
 const gameStats=stats?.[histGame];
 const gameRecent=recent?.[histGame]||[];
 const expected=gameDraws?Math.round((GAMES[histGame].size*gameDraws.length)/GAMES[histGame].pool):0;
 const updatedLabel=history?.[histGame]?.updated?'Last updated through':'Bundled archive through';
 const lastDate=gameDraws?.at(-1)?.date;

 return (
  <main className="screen history-screen">
   <div className="toprow">
    <a className="roundbtn" href="#" aria-label="Back to picker">
     <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="#403147" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 12H5M12 19l-7-7 7-7"/>
     </svg>
    </a>
    <a className="wordmark" href="#">Drawline</a>
   </div>

   <div className="eyebrow">HISTORY</div>
   <h1 className="headline">Past Draws</h1>
   <div className="sub">
    {GAMES[histGame].name} · {lastDate?<><span>{updatedLabel} </span><b>{fmtArchiveDate(lastDate)}</b></>:'Loading history…'}
   </div>

   <div className="segmented" role="tablist" aria-label="History game">
    {Object.entries(GAMES).map(([key,g])=>(
     <button
      key={key}
      type="button"
      role="tab"
      aria-selected={histGame===key}
      className={'seg'+(histGame===key?' active':'')}
      onClick={()=>setHistGame(key)}
     >
      {g.name}
     </button>
    ))}
   </div>

   <section className="checkcard" aria-label="Check a saved line">
    <div className="lbl">YOUR SAVED LINE</div>
    <div className="t">Checked vs the latest draw</div>
    <div className="check-controls">
     <select
      aria-label="Choose a saved line"
      value={line?.id||''}
      onChange={e=>{setSelected(e.target.value);setResult(null);}}
      disabled={!saved.length}
     >
      {!saved.length&&<option value="">Save a line in the picker first</option>}
      {saved.map(l=>(
       <option key={l.id} value={l.id}>
        {GAMES[l.game].name} · {l.numbers.map(pad).join(' ')} (Saved {savedDate(l.savedAt)})
       </option>
      ))}
     </select>
     <button
      type="button"
      className="check-btn"
      disabled={!line||!data}
      onClick={()=>setResult(checkLine(line,data[line.game]))}
     >
      Check
     </button>
    </div>
    {line?(
     <>
      <div className="balls" aria-label={`Main numbers ${line.numbers.join(', ')}; bonus ${line.bonus}`}>
       {line.numbers.map(n=><div className="ball" key={n}>{n}</div>)}
       <div className="ball bonus" title="Bonus">{line.bonus}</div>
      </div>
      {checked&&latestDraw?(
       <div className="res" aria-live="polite">
        <div>
         <b>{latestMatches??0} {(latestMatches??0)===1?'match':'matches'}</b> · {fmtWeekdayDraw(latestDraw)} draw
        </div>
        <div className="res-sub">
         Best in history: <b>{checked.best} {checked.best===1?'match':'matches'}</b>{checked.bestDate?` on ${fmtArchiveDate(checked.bestDate)}`:''} ({checked.total.toLocaleString()} draws)
        </div>
        <div className="res-counts">
         {Object.entries(checked.counts).map(([n,c])=>`${n}+: ${c.toLocaleString()}`).join(' · ')}
         {checked.excluded>0&&` · ${checked.excluded} excluded`}
        </div>
       </div>
      ):(
       <div className="res" aria-live="polite">Checking saved line against history…</div>
      )}
     </>
    ):(
     <div className="res" aria-live="polite">Save a line on the Pick screen to check it against past draws.</div>
    )}
   </section>

   {error?(
    <p role="alert" className="alert-msg">{error}</p>
   ):!data?(
    <p role="status" className="status-msg">Loading history…</p>
   ):(
    <>
     <div className="seclbl">FREQUENCY · {gameDraws.length.toLocaleString()} DRAWS</div>
     <div className="freqrow">
      <div className="numcircle">{gameStats.most[0].number}</div>
      <div className="freq-body">
       <div className="t">Hottest number</div>
       <div className="s">Most often · expected ~{expected}</div>
      </div>
      <div className="count">{gameStats.most[0].count}</div>
     </div>
     <div className="freqrow rose">
      <div className="numcircle">{gameStats.least[0].number}</div>
      <div className="freq-body">
       <div className="t">Coldest number</div>
       <div className="s">Least often · expected ~{expected}</div>
      </div>
      <div className="count">{gameStats.least[0].count}</div>
     </div>
     <div className="freqrow mint">
      <div className="numcircle">{gameStats.gaps[0].number}</div>
      <div className="freq-body">
       <div className="t">Longest gap now</div>
       <div className="s">
        <span className="s-lead">Draws since last drawn</span>
        <div className="stat-list">{renderStatItems(gameStats.gaps.map(n=>`#${n.number} (${n.gap})`))}</div>
       </div>
      </div>
      <div className="count">{gameStats.gaps[0].gap}</div>
     </div>
     <div className="freqrow surface">
      <div className="numcircle pair">{gameStats.pairs[0][0]}</div>
      <div className="freq-body">
       <div className="t">Most common pair</div>
       <div className="s">
        <span className="s-lead">Drawn together</span>
        <div className="stat-list">{renderStatItems(gameStats.pairs.map(([p,n])=>`${p} (${n})`))}</div>
       </div>
      </div>
      <div className="count">{gameStats.pairs[0][1]}</div>
     </div>
     {histGame==='lottomax'&&(
      <p className="pool-note">
       Pools changed from 49 to 50 in May 2019, then to 52 on April 14, 2026. Numbers 50–52 have fewer eligible draws; these raw counts cover different lengths of history.
      </p>
     )}

     <div className="seclbl">RECENT DRAWS</div>
     <div className="recent-draws-list" aria-label="Latest draws">
      {gameRecent.map(d=>{
       const [,m,day]=d.date.split('-');
       return (
        <div className="drawrow" key={d.date}>
         <div className="drawdate">
          <div className="dow">{d.weekday.toUpperCase()}</div>
          <div className="dnum">{+day}</div>
          <div className="dmon">{MONTHS[+m-1]}</div>
         </div>
         <div className="miniballs" aria-label={`Draw ${d.date}: main numbers ${d.numbers.join(', ')}; bonus ${d.bonus}`}>
          {d.numbers.map(n=><div className="miniball" key={n}>{n}</div>)}
          <div className="miniball bonus" title="Bonus">{d.bonus}</div>
         </div>
        </div>
       );
      })}
     </div>

     <p className="source-note">Source: your Drive copy, then lottochaos.com CSVs.</p>
    </>
   )}

   <div className="honesty">History describes the past. It does not predict the next draw.</div>
  </main>
 );
}

function App(){
 const [history,setHistory]=useState(null);
 const [historyError,setHistoryError]=useState('');
 useEffect(()=>{
  let active=true;
  loadHistory({
   storage:{getItem:k=>localStorage.getItem(k),setItem:(k,v)=>localStorage.setItem(k,v)},
   onChange:value=>{if(active)setHistory(value);}
  }).catch(e=>{if(active)setHistoryError(e.message);});
  return ()=>{active=false;};
 },[]);

 const [page,setPage]=useState(location.hash==='#history'?'history':'picker');
 const [game,setGame]=useState('ca649');
 const [count,setCount]=useState(2);
 const [lines,setLines]=useState([]);
 const [saved,setSaved]=useState([]);
 const [deletedIds,setDeletedIds]=useState([]);
 const [storageError,setStorageError]=useState('');
 const [importNotice,setImportNotice]=useState('');
 const [error,setError]=useState('');
 const [now,setNow]=useState(new Date());
 const [syncState,setSyncState]=useState(GOOGLE_OAUTH_CLIENT_ID?'signed_out':'unconfigured');
 const [lastSyncedAt,setLastSyncedAt]=useState(null);
 const [syncMessage,setSyncMessage]=useState('');
 const fileInputRef=useRef(null);
 const driveFileIdRef=useRef(null);
 const savedRef=useRef([]);
 const deletedRef=useRef([]);

 async function runDriveSync(nextLines=savedRef.current,nextDeleted=deletedRef.current){
  if(!GOOGLE_OAUTH_CLIENT_ID){
   setSyncState('unconfigured');
   return;
  }
  const token=getAccessToken();
  if(!token){
   setSyncState('signed_out');
   return;
  }
  if(typeof navigator!=='undefined'&&navigator.onLine===false){
   setSyncState('offline');
   setSyncMessage('');
   return;
  }
  setSyncState('syncing');
  setSyncMessage('');
  try{
   const res=await syncSavedLines({
    localLines:nextLines,
    localDeletedIds:nextDeleted,
    token,
    online:typeof navigator==='undefined'?true:navigator.onLine!==false,
    knownFileId:driveFileIdRef.current
   });
   if(res.fileId)driveFileIdRef.current=res.fileId;
   if(res.status==='offline'){
    setSyncState('offline');
    return;
   }
   try{
    writeSaved(localStorage,res.lines);
    writeDeletedIds(localStorage,res.deletedIds);
   }catch{
    /* localStorage write failure should not discard synced state in memory */
   }
   savedRef.current=res.lines;
   deletedRef.current=res.deletedIds;
   setSaved(res.lines);
   setDeletedIds(res.deletedIds);
   setLastSyncedAt(new Date());
   setSyncState('synced');
   setSyncMessage('');
  }catch(err){
   if(err instanceof UnauthorizedDriveError||err?.status===401){
    clearAccessToken();
    setSyncState('reauth');
    setSyncMessage('Sign in again');
   }else{
    setSyncState('error');
    setSyncMessage(err.message||'Could not sync with Google Drive.');
   }
  }
 }

 useEffect(()=>{
  let initialLines=[];
  let initialDeleted=[];
  try{
   initialLines=readSaved(localStorage);
   initialDeleted=readDeletedIds(localStorage);
   savedRef.current=initialLines;
   deletedRef.current=initialDeleted;
   setSaved(initialLines);
   setDeletedIds(initialDeleted);
  }catch(e){
   setStorageError(e.message||'Local storage unavailable.');
  }
  const oauthResult=consumeOAuthRedirect({
   loc:window.location,
   hist:window.history,
   storage:window.sessionStorage
  });
  if(oauthResult.handled){
   if(oauthResult.ok){
    runDriveSync(initialLines,initialDeleted);
   }else{
    setSyncState('error');
    setSyncMessage(oauthResult.message||'Could not complete Google sign-in.');
   }
  }
  const tick=setInterval(()=>setNow(new Date()),1000);
  const route=()=>setPage(location.hash==='#history'?'history':'picker');
  const onOnline=()=>{if(getAccessToken())runDriveSync();};
  const onOffline=()=>{if(getAccessToken())setSyncState('offline');};
  addEventListener('hashchange',route);
  addEventListener('online',onOnline);
  addEventListener('offline',onOffline);

  return ()=>{
   clearInterval(tick);
   removeEventListener('hashchange',route);
   removeEventListener('online',onOnline);
   removeEventListener('offline',onOffline);
  };
 },[]);

 const draw=nextDraw(game,now);
 const [drawWeekday,drawRest]=drawDate(draw).split(', ');
 const parts=countdownParts(draw,now);
 const recentMatches=useMemo(()=>newestDrawMatches(saved,history),[saved,history]);
 const historyCount=history?.[game]?.rows?.length;

 function persist(nextLines,nextDeleted=deletedRef.current){
  try{
   writeSaved(localStorage,nextLines);
   writeDeletedIds(localStorage,nextDeleted);
   savedRef.current=nextLines;
   deletedRef.current=nextDeleted;
   setSaved(nextLines);
   setDeletedIds(nextDeleted);
   setStorageError('');
  }catch{
   setStorageError('Could not save changes. Browser storage may be full or unavailable.');
   return;
  }
  if(getAccessToken()){
   runDriveSync(nextLines,nextDeleted);
  }
 }

 function save(line){
  setImportNotice('');
  persist([{...line,id:crypto.randomUUID(),savedAt:new Date().toISOString()},...saved],deletedIds);
 }

 function handleGoogleSignIn(prompt='consent'){
  if(!GOOGLE_OAUTH_CLIENT_ID){
   setSyncState('unconfigured');
   return;
  }
  setSyncMessage('');
  try{
   startGoogleSignIn({
    clientId:GOOGLE_OAUTH_CLIENT_ID,
    redirectUri:REDIRECT_URI,
    scope:DRIVE_SCOPE,
    prompt
   });
  }catch(err){
   setSyncState('error');
   setSyncMessage(err.message||'Could not complete Google sign-in.');
  }
 }

 function handleExport(){
  try{
   const blob=new Blob([exportSavedLines(saved)],{type:'application/json'});
   const url=URL.createObjectURL(blob),a=document.createElement('a');
   a.href=url;a.download='drawline-lines.json';document.body.appendChild(a);a.click();a.remove();URL.revokeObjectURL(url);
  }catch(e){
   setStorageError(e.message||'Could not export saved lines.');
  }
 }

 async function handleImport(e){
  const file=e.target.files?.[0];
  e.target.value='';
  if(!file)return;
  try{
   const merged=mergeImportedLines(saved,await file.text());
   const importedIds=new Set(merged.map(l=>l.id));
   const nextDeleted=deletedIds.filter(id=>!importedIds.has(id));
   persist(merged,nextDeleted);
   setImportNotice('');
  }catch(err){
   setImportNotice(err.message||'That file is not a Drawline lines file. Nothing was imported.');
  }
 }

 return (
  <div className="app-shell">
   {page==='history'?(
    <History saved={saved} history={history} error={historyError} initialGame={game}/>
   ):(
    <main className="screen picker-screen">
     <div className="toprow">
      <div className="avatar" aria-hidden="true">J</div>
      <a className="wordmark" href="#">Drawline</a>
     </div>

     <div className="greet">Hello, Jerry</div>
     <h1 className="headline">{drawWeekday}, <br/>{drawRest}</h1>
     <div className="drawtime"><b>10:30 PM</b> · Toronto time</div>

     <div className="chips" role="group" aria-label="Game">
      {Object.entries(GAMES).map(([key,g])=>(
       <button
        key={key}
        type="button"
        aria-pressed={game===key}
        className={'chip'+(game===key?' active':'')}
        onClick={()=>{setGame(key);setLines([]);setError('');}}
       >
        {g.name}
       </button>
      ))}
     </div>

     <section className="card" aria-label="Next draw">
      <div className="card-top">
       <div>
        <div className="card-title">Next Draw</div>
        <div className="card-sub">Countdown to the draw</div>
       </div>
      </div>
      <div className="countdown">
       {Object.entries(parts).map(([label,value])=>(
        <div className="cd-cell" key={label}>
         <div className="cd-num">{pad(value)}</div>
         <div className="cd-unit">{UNIT_LABELS[label]}</div>
        </div>
       ))}
      </div>
      <div className="card-bottom">
       <div className="stats">
        <div className="stat">
         <div className="n">{historyCount?historyCount.toLocaleString():'—'}</div>
         <div className="l">Draws in history</div>
        </div>
        <div className="stat">
         <div className="n">{saved.length}</div>
         <div className="l">{saved.length===1?'Saved line':'Saved lines'}</div>
        </div>
       </div>
       <div className="spheres" aria-hidden="true">
        <div className="tube"></div>
        <div className="sphere s1"></div>
        <div className="sphere s2"></div>
        <div className="sphere s3"></div>
       </div>
      </div>
      <a className="go-btn" href="#history" aria-label="See history">
       <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
        <path d="M7 17L17 7M9 7h8v8"/>
       </svg>
      </a>
     </section>

     {recentMatches.length>0&&(
      <section className="newest-matches" aria-label="Recent draw matches">
       {recentMatches.map(m=>(
        <p className="newest-match" key={m.id}>
         Your saved {m.gameName} line {m.numbers.map(pad).join(' ')} matched {m.matches} numbers in the {shortDrawDate(m.date)} draw. <a href="#history">Check details in History</a>
        </p>
       ))}
      </section>
     )}

     <a
      className="rowcard"
      href="#saved-lines"
      onClick={e=>{
       e.preventDefault();
       document.getElementById('saved-lines')?.scrollIntoView({behavior:'smooth'});
      }}
     >
      <div className="ic" aria-hidden="true">
       <svg width="21" height="21" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M19 21l-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
       </svg>
      </div>
      <div>
       <div className="t">Saved Lines</div>
       <div className="s">{saved.length} {saved.length===1?'line':'lines'} saved · checked against the latest draw</div>
      </div>
     </a>

     <section className="controls" aria-label="Pick controls">
      <h2>How many lines?</h2>
      <div className="stepper">
       <button type="button" aria-label="Decrease lines" disabled={count===1} onClick={()=>setCount(count-1)}>−</button>
       <output className="val" aria-live="polite">{count}</output>
       <button type="button" aria-label="Increase lines" disabled={count===10} onClick={()=>setCount(count+1)}>+</button>
      </div>
      <button
       type="button"
       className="generate"
       onClick={()=>{
        try{setLines(pickLines(game,count));setError('');}catch(e){setError(e.message);}
       }}
      >
       Generate lines
      </button>
      {error&&<p role="alert" className="alert-msg">{error}</p>}
     </section>

     <section className="lines" aria-label="Generated lines" aria-live="polite">
      <div className="lbl">YOUR LINES</div>
      {lines.length?lines.map((line,i)=>{
       const already=saved.some(s=>s.game===line.game&&s.bonus===line.bonus&&s.numbers.join(',')===line.numbers.join(','));
       return (
        <div className="line" key={i}>
         <div className="line-balls" aria-label={`Line ${i+1}: main numbers ${line.numbers.join(', ')}; bonus ${line.bonus}`}>
          {line.numbers.map(n=><div className="ball" key={n}>{n}</div>)}
          <div className="ball bonus" title="Bonus">{line.bonus}</div>
         </div>
         <button
          type="button"
          className="save"
          disabled={already||!!storageError}
          onClick={()=>save(line)}
         >
          {already?'Saved':'Save'}
         </button>
        </div>
       );
      }):(
       <p className="empty">Tap Generate lines to pick your numbers.</p>
      )}
     </section>

     <section id="saved-lines" className="saved" aria-label="Saved lines">
      <div className="saved-header">
       <div className="lbl">SAVED LINES ({saved.length})</div>
       <div className="saved-actions">
        <button type="button" className="text-action" onClick={handleExport} disabled={!saved.length}>Export</button>
        <button type="button" className="text-action" onClick={()=>fileInputRef.current?.click()}>Import</button>
        <input
         ref={fileInputRef}
         type="file"
         accept=".json,application/json"
         className="sr-only"
         aria-label="Import saved lines JSON"
         onChange={handleImport}
        />
       </div>
      </div>
      <div className="sync-bar" aria-live="polite">
       {!GOOGLE_OAUTH_CLIENT_ID||syncState==='unconfigured'?(
        <span className="sync-status">Sync not set up yet</span>
       ):syncState==='synced'&&lastSyncedAt?(
        <span className="sync-status">Sync: on · last synced {fmtSyncTime(lastSyncedAt)}</span>
       ):syncState==='syncing'?(
        <span className="sync-status">Sync: syncing…</span>
       ):syncState==='offline'?(
        <span className="sync-status">Sync: offline — showing local copy</span>
       ):syncState==='reauth'?(
        <>
         <span className="sync-status sync-err">Sync: session expired</span>
         <button type="button" className="text-action sync-action" onClick={()=>handleGoogleSignIn('')}>Sign in again</button>
        </>
       ):syncState==='error'?(
        <>
         <span className="sync-status sync-err">{syncMessage||'Sync error'}</span>
         <button
          type="button"
          className="text-action sync-action"
          onClick={()=>getAccessToken()?runDriveSync():handleGoogleSignIn('consent')}
         >
          {getAccessToken()?'Retry':'Sign in with Google'}
         </button>
        </>
       ):(
        <>
         <span className="sync-status">Sync: not signed in</span>
         <button type="button" className="text-action sync-action" onClick={()=>handleGoogleSignIn('consent')}>Sign in with Google</button>
        </>
       )}
      </div>
      {storageError&&<p role="alert" className="alert-msg">{storageError}</p>}
      {importNotice&&<p role="alert" className="alert-msg">{importNotice}</p>}
      {!saved.length?(
       <p className="empty">No saved lines yet.</p>
      ):(
       <div className="saved-list">
        {saved.map(line=>(
         <div className="saved-line" key={line.id}>
          <div className="saved-info">
           <div className="saved-meta">{GAMES[line.game].name} · {savedDate(line.savedAt)}</div>
           <div className="line-balls">
            {line.numbers.map(n=><div className="ball" key={n}>{n}</div>)}
            <div className="ball bonus" title="Bonus">{line.bonus}</div>
           </div>
          </div>
          <button
           type="button"
           className="delete"
           aria-label={`Delete ${GAMES[line.game].name} line ${line.numbers.join(', ')}`}
           onClick={()=>{
            setImportNotice('');
            const nextDeleted=deletedIds.includes(line.id)?deletedIds:[...deletedIds,line.id];
            persist(saved.filter(s=>s.id!==line.id),nextDeleted);
           }}
          >
           Delete
          </button>
         </div>
        ))}
       </div>
      )}
     </section>
    </main>
   )}

   <footer className="footer">Every combo has the same odds.</footer>
   <BottomNav page={page}/>
  </div>
 );
}

createRoot(document.getElementById('root')).render(<App/>);
