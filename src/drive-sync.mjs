import {exportSavedLines, parseImportedLines} from './storage.mjs';
import {
  GOOGLE_OAUTH_CLIENT_ID,
  DRIVE_FOLDER_ID,
  DRIVE_LINES_FILENAME,
  DRIVE_SCOPE
} from './drive-config.mjs';

export const DELETED_STORAGE_KEY = 'drawline.deleted.v1';
export const GIS_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
export const GIS_LOAD_ERROR = 'Could not load Google sign-in. Check your connection and try again.';

const DRIVE_FILES_ENDPOINT = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_ENDPOINT = 'https://www.googleapis.com/upload/drive/v3/files';

// In-memory access token only — never written to localStorage, URLs, or logs.
let memoryAccessToken = null;

export function getAccessToken() {
  return memoryAccessToken;
}

export function setAccessToken(token) {
  memoryAccessToken = typeof token === 'string' && token.length > 0 ? token : null;
}

export function clearAccessToken() {
  memoryAccessToken = null;
}

export class UnauthorizedDriveError extends Error {
  constructor(message = 'Session expired. Sign in again.') {
    super(message);
    this.name = 'UnauthorizedDriveError';
    this.status = 401;
  }
}

export function readDeletedIds(storage) {
  try {
    const raw = storage?.getItem?.(DELETED_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter(id => typeof id === 'string' && id.length > 0))];
  } catch {
    return [];
  }
}

export function writeDeletedIds(storage, ids) {
  const clean = [...new Set((ids || []).filter(id => typeof id === 'string' && id.length > 0))];
  storage?.setItem?.(DELETED_STORAGE_KEY, JSON.stringify(clean));
  return clean;
}

export function serializeDrivePayload(lines, deletedIds = []) {
  const base = JSON.parse(exportSavedLines(lines));
  const cleanDeleted = [...new Set((deletedIds || []).filter(id => typeof id === 'string' && id.length > 0))];
  return JSON.stringify(
    cleanDeleted.length > 0 ? {...base, deletedIds: cleanDeleted} : base,
    null,
    2
  );
}

export function parseDrivePayload(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  try {
    const lines = parseImportedLines(text);
    const raw = JSON.parse(text);
    const deletedIds = Array.isArray(raw.deletedIds)
      ? [...new Set(raw.deletedIds.filter(id => typeof id === 'string' && id.length > 0))]
      : [];
    return {version: 1, lines, deletedIds};
  } catch {
    return null;
  }
}

export function mergeWithRemote({localLines = [], localDeletedIds = [], remoteText = null}) {
  const remote = parseDrivePayload(remoteText);
  const deletedSet = new Set(
    (localDeletedIds || []).filter(id => typeof id === 'string' && id.length > 0)
  );
  if (remote) {
    for (const id of remote.deletedIds) deletedSet.add(id);
  }

  const seen = new Set();
  const merged = [];

  for (const line of localLines) {
    if (line && typeof line.id === 'string' && !deletedSet.has(line.id) && !seen.has(line.id)) {
      seen.add(line.id);
      merged.push({...line, numbers: [...line.numbers]});
    }
  }

  if (remote) {
    for (const line of remote.lines) {
      if (!deletedSet.has(line.id) && !seen.has(line.id)) {
        seen.add(line.id);
        merged.push({...line, numbers: [...line.numbers]});
      }
    }
  }

  return {
    lines: merged,
    deletedIds: [...deletedSet],
    remoteValid: Boolean(remote)
  };
}

// --- Google Identity Services (GIS) lazy loader & token client ---

let gisLoadPromise = null;

export function resetGisLoader() {
  gisLoadPromise = null;
}

export function loadGisScript({
  doc = typeof document !== 'undefined' ? document : null,
  win = typeof window !== 'undefined' ? window : globalThis
} = {}) {
  if (win?.google?.accounts?.oauth2?.initTokenClient) {
    return Promise.resolve(win.google.accounts.oauth2);
  }
  if (gisLoadPromise) {
    return gisLoadPromise;
  }
  if (!doc || typeof doc.createElement !== 'function') {
    return Promise.reject(new Error(GIS_LOAD_ERROR));
  }

  gisLoadPromise = new Promise((resolve, reject) => {
    const script = doc.createElement('script');
    script.src = GIS_SCRIPT_URL;
    script.async = true;
    script.defer = true;

    script.onload = () => {
      const oauth2 = win?.google?.accounts?.oauth2;
      if (oauth2 && typeof oauth2.initTokenClient === 'function') {
        resolve(oauth2);
      } else {
        gisLoadPromise = null;
        reject(new Error(GIS_LOAD_ERROR));
      }
    };

    script.onerror = () => {
      gisLoadPromise = null;
      if (typeof script.remove === 'function') script.remove();
      reject(new Error(GIS_LOAD_ERROR));
    };

    const parent = doc.head || doc.documentElement || doc.body;
    if (!parent || typeof parent.appendChild !== 'function') {
      gisLoadPromise = null;
      reject(new Error(GIS_LOAD_ERROR));
      return;
    }
    parent.appendChild(script);
  });

  return gisLoadPromise;
}

export function formatGisError(err) {
  const code = typeof err === 'string' ? err : err?.error || err?.type || '';
  if (code === 'access_denied') {
    return 'Google sign-in was cancelled.';
  }
  if (code === 'popup_closed') {
    return 'Google sign-in was closed before completing.';
  }
  if (code === 'popup_failed_to_open') {
    return 'Popup blocked. Allow popups for this site and try again.';
  }
  if (err instanceof Error && err.message) {
    return err.message;
  }
  return 'Could not complete Google sign-in.';
}

export async function requestGoogleAccessToken({
  clientId = GOOGLE_OAUTH_CLIENT_ID,
  scope = DRIVE_SCOPE,
  prompt = 'consent',
  loadGis = loadGisScript,
  doc,
  win
} = {}) {
  if (!clientId) {
    throw new Error('Sync not set up yet');
  }

  const oauth2 = await loadGis(doc || win ? {doc, win} : undefined);

  return await new Promise((resolve, reject) => {
    let settled = false;
    const finishResolve = token => {
      if (settled) return;
      settled = true;
      setAccessToken(token);
      resolve(token);
    };
    const finishReject = err => {
      if (settled) return;
      settled = true;
      reject(err instanceof Error ? err : new Error(formatGisError(err)));
    };

    let tokenClient;
    try {
      tokenClient = oauth2.initTokenClient({
        client_id: clientId,
        scope,
        callback: response => {
          if (response?.error) {
            finishReject(new Error(formatGisError(response)));
            return;
          }
          if (!response || typeof response.access_token !== 'string' || !response.access_token) {
            finishReject(new Error('Google did not return an access token.'));
            return;
          }
          finishResolve(response.access_token);
        },
        error_callback: err => {
          finishReject(new Error(formatGisError(err)));
        }
      });
    } catch (err) {
      finishReject(new Error(formatGisError(err)));
      return;
    }

    try {
      tokenClient.requestAccessToken({prompt});
    } catch (err) {
      finishReject(new Error(formatGisError(err)));
    }
  });
}

export async function reauthGoogleAccessToken({
  clientId = GOOGLE_OAUTH_CLIENT_ID,
  scope = DRIVE_SCOPE,
  loadGis = loadGisScript,
  doc,
  win
} = {}) {
  try {
    return await requestGoogleAccessToken({
      clientId,
      scope,
      prompt: '',
      loadGis,
      doc,
      win
    });
  } catch {
    clearAccessToken();
    throw new UnauthorizedDriveError('Sign in again');
  }
}

export async function signInAndSync({
  localLines = [],
  localDeletedIds = [],
  clientId = GOOGLE_OAUTH_CLIENT_ID,
  scope = DRIVE_SCOPE,
  prompt = 'consent',
  loadGis = loadGisScript,
  doc,
  win,
  fetcher = fetch,
  online = typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  knownFileId = null,
  folderId = DRIVE_FOLDER_ID,
  fileName = DRIVE_LINES_FILENAME
} = {}) {
  const token = await requestGoogleAccessToken({clientId, scope, prompt, loadGis, doc, win});
  return await syncSavedLines({
    localLines,
    localDeletedIds,
    token,
    fetcher,
    online,
    knownFileId,
    folderId,
    fileName
  });
}

// --- Drive API client (injectable fetch, private file only) ---

export function buildFindFileUrl(folderId = DRIVE_FOLDER_ID, fileName = DRIVE_LINES_FILENAME) {
  const q = `name='${fileName}' and '${folderId}' in parents and trashed=false`;
  const params = new URLSearchParams({
    q,
    fields: 'files(id,name)',
    pageSize: '1',
    spaces: 'drive'
  });
  return `${DRIVE_FILES_ENDPOINT}?${params.toString()}`;
}

async function checkDriveResponse(response) {
  if (response.status === 401) {
    clearAccessToken();
    throw new UnauthorizedDriveError();
  }
  if (!response.ok) {
    throw Error(`Drive request failed (${response.status}).`);
  }
  return response;
}

export async function findDriveLinesFile({
  token = getAccessToken(),
  fetcher = fetch,
  folderId = DRIVE_FOLDER_ID,
  fileName = DRIVE_LINES_FILENAME
} = {}) {
  if (!token) throw new UnauthorizedDriveError();
  const response = await checkDriveResponse(
    await fetcher(buildFindFileUrl(folderId, fileName), {
      method: 'GET',
      headers: {Authorization: `Bearer ${token}`}
    })
  );
  const data = await response.json();
  const file = Array.isArray(data?.files) ? data.files[0] : null;
  return file?.id || null;
}

export async function readDriveLinesFile({
  fileId,
  token = getAccessToken(),
  fetcher = fetch
} = {}) {
  if (!token) throw new UnauthorizedDriveError();
  const url = `${DRIVE_FILES_ENDPOINT}/${encodeURIComponent(fileId)}?alt=media`;
  const response = await checkDriveResponse(
    await fetcher(url, {
      method: 'GET',
      headers: {Authorization: `Bearer ${token}`}
    })
  );
  return await response.text();
}

export async function createDriveLinesFile({
  content,
  token = getAccessToken(),
  fetcher = fetch,
  folderId = DRIVE_FOLDER_ID,
  fileName = DRIVE_LINES_FILENAME
} = {}) {
  if (!token) throw new UnauthorizedDriveError();
  // Step 1: create private file metadata in the Drawline folder (default private — no permissions added).
  const createResp = await checkDriveResponse(
    await fetcher(`${DRIVE_FILES_ENDPOINT}?fields=id`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name: fileName,
        parents: [folderId],
        mimeType: 'application/json'
      })
    })
  );
  const created = await createResp.json();
  if (!created?.id) throw Error('Drive did not return a file ID.');
  // Step 2: write media payload with files.update.
  if (typeof content === 'string') {
    await updateDriveLinesFile({fileId: created.id, content, token, fetcher});
  }
  return created.id;
}

export async function updateDriveLinesFile({
  fileId,
  content,
  token = getAccessToken(),
  fetcher = fetch
} = {}) {
  if (!token) throw new UnauthorizedDriveError();
  const url = `${DRIVE_UPLOAD_ENDPOINT}/${encodeURIComponent(fileId)}?uploadType=media`;
  await checkDriveResponse(
    await fetcher(url, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: content
    })
  );
  return fileId;
}

// High-level sync: reads Drive file (if any), merges with local lines + tombstones,
// writes the merged list back to Drive, and updates local storage.
export async function syncSavedLines({
  localLines = [],
  localDeletedIds = [],
  token = getAccessToken(),
  fetcher = fetch,
  online = typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  knownFileId = null,
  folderId = DRIVE_FOLDER_ID,
  fileName = DRIVE_LINES_FILENAME
} = {}) {
  if (!online) {
    return {
      status: 'offline',
      lines: localLines.filter(l => !localDeletedIds.includes(l.id)),
      deletedIds: [...new Set(localDeletedIds)],
      fileId: knownFileId
    };
  }
  if (!token) throw new UnauthorizedDriveError();

  let fileId = knownFileId || (await findDriveLinesFile({token, fetcher, folderId, fileName}));
  let remoteText = null;
  if (fileId) {
    try {
      remoteText = await readDriveLinesFile({fileId, token, fetcher});
    } catch (err) {
      if (err instanceof UnauthorizedDriveError || err?.status === 401) throw err;
      // Missing or unreadable remote content falls back to local lines without wiping them.
      remoteText = null;
    }
  }

  const merged = mergeWithRemote({localLines, localDeletedIds, remoteText});
  const payload = serializeDrivePayload(merged.lines, merged.deletedIds);

  if (fileId) {
    await updateDriveLinesFile({fileId, content: payload, token, fetcher});
  } else {
    fileId = await createDriveLinesFile({content: payload, token, fetcher, folderId, fileName});
  }

  return {
    status: 'synced',
    lines: merged.lines,
    deletedIds: merged.deletedIds,
    fileId
  };
}
