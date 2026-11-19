import {exportSavedLines, parseImportedLines} from './storage.mjs';
import {
  GOOGLE_OAUTH_CLIENT_ID,
  DRIVE_FOLDER_ID,
  DRIVE_LINES_FILENAME,
  DRIVE_SCOPE,
  REDIRECT_URI
} from './drive-config.mjs';

export const DELETED_STORAGE_KEY = 'drawline.deleted.v1';
export const OAUTH_STATE_KEY = 'drawline.oauth.state.v1';
export const GOOGLE_AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';

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

// --- OAuth 2.0 full-page redirect implicit flow (response_type=token) ---

function base64UrlEncode(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateOAuthState(byteLength = 24, cryptoObj = globalThis.crypto) {
  if (!cryptoObj || typeof cryptoObj.getRandomValues !== 'function') {
    throw new Error('Secure random generator unavailable.');
  }
  const bytes = new Uint8Array(byteLength);
  cryptoObj.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export function buildGoogleAuthUrl({
  clientId = GOOGLE_OAUTH_CLIENT_ID,
  redirectUri = REDIRECT_URI,
  scope = DRIVE_SCOPE,
  state,
  prompt = 'consent'
} = {}) {
  if (!clientId) {
    throw new Error('Sync not set up yet');
  }
  if (!redirectUri) {
    throw new Error('Missing redirect URI.');
  }
  if (!state) {
    throw new Error('Missing OAuth state.');
  }
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'token',
    scope,
    state
  });
  if (prompt) {
    params.set('prompt', prompt);
  }
  return `${GOOGLE_AUTH_ENDPOINT}?${params.toString()}`;
}

export function startGoogleSignIn({
  clientId = GOOGLE_OAUTH_CLIENT_ID,
  redirectUri = REDIRECT_URI,
  scope = DRIVE_SCOPE,
  prompt = 'consent',
  storage = typeof sessionStorage !== 'undefined' ? sessionStorage : null,
  loc = typeof window !== 'undefined' ? window.location : null,
  cryptoObj = globalThis.crypto
} = {}) {
  if (!clientId) {
    throw new Error('Sync not set up yet');
  }
  const state = generateOAuthState(24, cryptoObj);
  if (!storage || typeof storage.setItem !== 'function') {
    throw new Error('Session storage unavailable. Cannot start Google sign-in.');
  }
  storage.setItem(OAUTH_STATE_KEY, state);
  const url = buildGoogleAuthUrl({clientId, redirectUri, scope, state, prompt});
  if (!loc || typeof loc.assign !== 'function') {
    throw new Error('Cannot navigate to Google sign-in.');
  }
  loc.assign(url);
  return {state, url};
}

function scrubOAuthFragment(loc, hist) {
  if (!hist || typeof hist.replaceState !== 'function') return;
  const cleanUrl =
    typeof loc?.pathname === 'string'
      ? `${loc.pathname}${loc.search || ''}`
      : typeof loc?.href === 'string'
        ? loc.href.split('#')[0]
        : '/';
  hist.replaceState(null, '', cleanUrl);
}

export function consumeOAuthRedirect({
  loc = typeof window !== 'undefined' ? window.location : null,
  hist = typeof window !== 'undefined' ? window.history : null,
  storage = typeof sessionStorage !== 'undefined' ? sessionStorage : null,
  hash = loc?.hash ?? ''
} = {}) {
  const rawHash = typeof hash === 'string' ? hash.replace(/^#/, '') : '';
  if (!rawHash) {
    return {handled: false};
  }

  const params = new URLSearchParams(rawHash);
  const isOAuthFragment =
    params.has('access_token') ||
    params.has('error') ||
    params.has('state') ||
    params.has('token_type');

  if (!isOAuthFragment) {
    return {handled: false};
  }

  // Scrub the fragment from the address bar immediately before any navigation or sync call.
  scrubOAuthFragment(loc, hist);

  let expectedState = null;
  try {
    expectedState = storage?.getItem?.(OAUTH_STATE_KEY) || null;
    storage?.removeItem?.(OAUTH_STATE_KEY);
  } catch {
    expectedState = null;
  }

  const errorCode = params.get('error');
  if (errorCode) {
    const message =
      errorCode === 'access_denied'
        ? 'Google sign-in was cancelled.'
        : 'Could not complete Google sign-in.';
    return {handled: true, ok: false, error: errorCode, message};
  }

  const returnedState = params.get('state');
  if (!expectedState || !returnedState || returnedState !== expectedState) {
    return {
      handled: true,
      ok: false,
      error: 'state_mismatch',
      message: "Sign-in didn't match. Please try signing in again."
    };
  }

  const accessToken = params.get('access_token');
  if (!accessToken) {
    return {
      handled: true,
      ok: false,
      error: 'missing_token',
      message: 'Google did not return an access token.'
    };
  }

  setAccessToken(accessToken);
  return {handled: true, ok: true, token: accessToken};
}

export async function completeOAuthRedirectAndSync({
  localLines = [],
  localDeletedIds = [],
  loc = typeof window !== 'undefined' ? window.location : null,
  hist = typeof window !== 'undefined' ? window.history : null,
  storage = typeof sessionStorage !== 'undefined' ? sessionStorage : null,
  hash = loc?.hash ?? '',
  fetcher = fetch,
  online = typeof navigator === 'undefined' ? true : navigator.onLine !== false,
  knownFileId = null,
  folderId = DRIVE_FOLDER_ID,
  fileName = DRIVE_LINES_FILENAME
} = {}) {
  const auth = consumeOAuthRedirect({loc, hist, storage, hash});
  if (!auth.handled || !auth.ok) {
    return auth;
  }
  const sync = await syncSavedLines({
    localLines,
    localDeletedIds,
    token: auth.token,
    fetcher,
    online,
    knownFileId,
    folderId,
    fileName
  });
  return {handled: true, ok: true, token: auth.token, sync};
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
