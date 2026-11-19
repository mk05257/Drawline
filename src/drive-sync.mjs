import {exportSavedLines, parseImportedLines} from './storage.mjs';
import {
  GOOGLE_OAUTH_CLIENT_ID,
  DRIVE_FOLDER_ID,
  DRIVE_LINES_FILENAME,
  DRIVE_SCOPE,
  REDIRECT_URI
} from './drive-config.mjs';

export const DELETED_STORAGE_KEY = 'drawline.deleted.v1';
export const PKCE_SESSION_KEY = 'drawline.oauth.pkce.v1';
export const AUTH_CHANNEL_NAME = 'drawline.oauth.callback.v1';

const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
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

// --- PKCE (S256) helpers ---

function base64UrlEncode(bytes) {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function generateRandomUrlSafe(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

export async function computeCodeChallenge(verifier) {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(new Uint8Array(digest));
}

export async function createPkceRequest({
  clientId = GOOGLE_OAUTH_CLIENT_ID,
  redirectUri = REDIRECT_URI,
  scope = DRIVE_SCOPE
} = {}) {
  if (!clientId) throw Error('Sync not set up yet');
  const codeVerifier = generateRandomUrlSafe(32);
  const state = generateRandomUrlSafe(16);
  const codeChallenge = await computeCodeChallenge(codeVerifier);
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
    state
  });
  return {
    authUrl: `${AUTH_ENDPOINT}?${params.toString()}`,
    codeVerifier,
    state
  };
}

export async function exchangeCodeForToken({
  code,
  codeVerifier,
  clientId = GOOGLE_OAUTH_CLIENT_ID,
  redirectUri = REDIRECT_URI,
  fetcher = fetch
}) {
  if (!clientId) throw Error('Sync not set up yet');
  if (!code || !codeVerifier) throw Error('Missing authorization code or PKCE verifier.');
  const body = new URLSearchParams({
    client_id: clientId,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri
  });
  const response = await fetcher(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: {'Content-Type': 'application/x-www-form-urlencoded'},
    body: body.toString()
  });
  if (!response.ok) {
    throw Error('Could not complete Google sign-in.');
  }
  const data = await response.json();
  if (!data || typeof data.access_token !== 'string' || !data.access_token) {
    throw Error('Google did not return an access token.');
  }
  return data.access_token;
}

export async function handleOAuthRedirectIfPresent({
  loc = globalThis.location,
  hist = globalThis.history,
  sessionStore = globalThis.sessionStorage,
  clientId = GOOGLE_OAUTH_CLIENT_ID,
  redirectUri = REDIRECT_URI,
  fetcher = fetch,
  notifyOpener = true
} = {}) {
  if (!loc?.search) return null;
  const params = new URLSearchParams(loc.search);
  const code = params.get('code');
  const error = params.get('error');
  const state = params.get('state');
  if (!code && !error) return null;

  // Clean the URL immediately so code/state never linger in history or address bar.
  const cleanUrl = `${loc.pathname || '/'}${loc.hash || ''}`;
  try {
    hist?.replaceState?.(null, '', cleanUrl);
  } catch {
    /* ignore history replace errors in restricted contexts */
  }

  // If running inside the OAuth popup, relay the callback parameters to the opener and close.
  if (notifyOpener && typeof globalThis.window !== 'undefined') {
    const payload = {type: 'drawline-oauth-callback', code, error, state};
    let relayed = false;
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        const ch = new BroadcastChannel(AUTH_CHANNEL_NAME);
        ch.postMessage(payload);
        ch.close();
        relayed = true;
      }
    } catch {
      /* ignore BroadcastChannel errors */
    }
    try {
      if (globalThis.window.opener && globalThis.window.opener !== globalThis.window) {
        globalThis.window.opener.postMessage(payload, loc.origin);
        relayed = true;
      }
    } catch {
      /* ignore opener postMessage errors */
    }
    if (relayed && globalThis.window.opener) {
      try { globalThis.window.close(); } catch { /* ignore */ }
      return {handledInPopup: true};
    }
  }

  if (error) {
    return {
      ok: false,
      error: error === 'access_denied' ? 'Google sign-in was cancelled.' : 'Google sign-in failed.'
    };
  }

  let stored = null;
  try {
    stored = JSON.parse(sessionStore?.getItem?.(PKCE_SESSION_KEY) || 'null');
    sessionStore?.removeItem?.(PKCE_SESSION_KEY);
  } catch {
    stored = null;
  }

  if (!stored || !stored.codeVerifier || !stored.state || stored.state !== state) {
    return {ok: false, error: 'Sign-in state mismatch. Please try signing in again.'};
  }

  try {
    const token = await exchangeCodeForToken({
      code,
      codeVerifier: stored.codeVerifier,
      clientId,
      redirectUri,
      fetcher
    });
    setAccessToken(token);
    return {ok: true, token};
  } catch (err) {
    return {ok: false, error: err.message || 'Could not complete Google sign-in.'};
  }
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
