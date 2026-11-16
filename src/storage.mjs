import {validLine} from './picker.mjs';
export const STORAGE_KEY='drawline.saved.v1';
export const IMPORT_ERROR='That file is not a Drawline lines file. Nothing was imported.';
function validSavedEntry(l) {
  return validLine(l) && typeof l.id === 'string' && l.id.length > 0 && typeof l.savedAt === 'string' && Number.isFinite(Date.parse(l.savedAt));
}
export function readSaved(storage) {
  const raw=storage.getItem(STORAGE_KEY);
  if(!raw) return [];
  const lines=JSON.parse(raw);
  if(!Array.isArray(lines)||!lines.every(validSavedEntry)) throw Error('Saved lines could not be read. Stored data has been left untouched.');
  return lines;
}
export function writeSaved(storage,lines) { storage.setItem(STORAGE_KEY,JSON.stringify(lines)); }
export function exportSavedLines(lines) {
  if(!Array.isArray(lines)||!lines.every(validSavedEntry)) throw Error('Saved lines could not be exported.');
  return JSON.stringify({version:1,lines:lines.map(({id,game,numbers,bonus,savedAt})=>({id,game,numbers:[...numbers],bonus,savedAt}))},null,2);
}
export function parseImportedLines(text,existing=[]) {
  let parsed;
  try { parsed=JSON.parse(text); } catch { throw Error(IMPORT_ERROR); }
  if(!parsed||typeof parsed!=='object'||parsed.version!==1||!Array.isArray(parsed.lines)||!parsed.lines.every(validSavedEntry)) throw Error(IMPORT_ERROR);
  const seen=new Set(existing.map(l=>l.id)), result=[];
  for(const {id,game,numbers,bonus,savedAt} of parsed.lines) {
    if(!seen.has(id)) { seen.add(id); result.push({id,game,numbers:[...numbers],bonus,savedAt}); }
  }
  return result;
}
export function mergeImportedLines(existing,text) {
  return [...existing,...parseImportedLines(text,existing)];
}
