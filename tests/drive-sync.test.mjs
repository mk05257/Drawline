import test from 'node:test';
import assert from 'node:assert/strict';
import {exportSavedLines} from '../src/storage.mjs';
import {
  GOOGLE_OAUTH_CLIENT_ID,
  DRIVE_FOLDER_ID,
  DRIVE_LINES_FILENAME,
  DRIVE_SCOPE,
  AUTHORIZED_ORIGIN,
  REDIRECT_URI
} from '../src/drive-config.mjs';
import {
  getAccessToken,
  setAccessToken,
  clearAccessToken,
  readDeletedIds,
  writeDeletedIds,
  serializeDrivePayload,
  parseDrivePayload,
  mergeWithRemote,
  computeCodeChallenge,
  createPkceRequest,
  exchangeCodeForToken,
  handleOAuthRedirectIfPresent,
  buildFindFileUrl,
  syncSavedLines,
  UnauthorizedDriveError,
  PKCE_SESSION_KEY
} from '../src/drive-sync.mjs';

const line1 = {
  id: 'line-1',
  game: 'ca649',
  numbers: [3, 11, 19, 24, 36, 45],
  bonus: 12,
  savedAt: '2026-11-14T12:00:00.000Z'
};
const line2 = {
  id: 'line-2',
  game: 'lottomax',
  numbers: [4, 9, 15, 25, 27, 44, 47],
  bonus: 29,
  savedAt: '2026-11-15T08:30:00.000Z'
};
const line3 = {
  id: 'line-3',
  game: 'ca649',
  numbers: [2, 8, 16, 22, 33, 41],
  bonus: 7,
  savedAt: '2026-11-16T10:15:00.000Z'
};

function createFakeDrive(initialContent = null) {
  let fileId = initialContent !== null ? 'drive-file-1' : null;
  let content = initialContent;
  const calls = [];

  const fetcher = async (url, init = {}) => {
    const method = init.method || 'GET';
    calls.push({url, method, headers: init.headers || {}, body: init.body});

    const auth = init.headers?.Authorization || '';
    if (auth !== 'Bearer valid-token') {
      return {status: 401, ok: false, json: async () => ({}), text: async () => ''};
    }

    if (method === 'GET' && url.includes('/drive/v3/files?')) {
      return {
        status: 200,
        ok: true,
        json: async () => ({files: fileId ? [{id: fileId, name: DRIVE_LINES_FILENAME}] : []})
      };
    }

    if (method === 'GET' && url.includes('alt=media')) {
      if (!fileId || content === null) {
        return {status: 404, ok: false, text: async () => ''};
      }
      return {status: 200, ok: true, text: async () => content};
    }

    if (method === 'POST' && url.includes('/drive/v3/files')) {
      fileId = 'drive-file-created';
      return {status: 200, ok: true, json: async () => ({id: fileId})};
    }

    if (method === 'PATCH' && url.includes('/upload/drive/v3/files/')) {
      content = init.body;
      return {status: 200, ok: true, json: async () => ({id: fileId})};
    }

    throw Error(`Unexpected Drive call: ${method} ${url}`);
  };

  return {
    fetcher,
    calls,
    getContent: () => content,
    setContent: next => {
      fileId = 'drive-file-1';
      content = next;
    }
  };
}

test('Drive sync merge is a union by id; first sync never overwrites (device A has 1,2; device B has 2,3; both get 1,2,3)', async () => {
  const drive = createFakeDrive(null);

  // Device A has lines 1 and 2 and does first sync (creates remote file)
  const syncA1 = await syncSavedLines({
    localLines: [line1, line2],
    localDeletedIds: [],
    token: 'valid-token',
    fetcher: drive.fetcher,
    online: true
  });
  assert.equal(syncA1.status, 'synced');
  assert.deepEqual(syncA1.lines.map(l => l.id), ['line-1', 'line-2']);

  // Device B has lines 2 and 3 locally and syncs against Drive (which has 1,2)
  const syncB = await syncSavedLines({
    localLines: [line2, line3],
    localDeletedIds: [],
    token: 'valid-token',
    fetcher: drive.fetcher,
    online: true
  });
  assert.equal(syncB.status, 'synced');
  assert.deepEqual(new Set(syncB.lines.map(l => l.id)), new Set(['line-1', 'line-2', 'line-3']));
  assert.equal(syncB.lines.length, 3);

  // Device A syncs again and gets line 3 as well
  const syncA2 = await syncSavedLines({
    localLines: syncA1.lines,
    localDeletedIds: syncA1.deletedIds,
    token: 'valid-token',
    fetcher: drive.fetcher,
    online: true
  });
  assert.deepEqual(new Set(syncA2.lines.map(l => l.id)), new Set(['line-1', 'line-2', 'line-3']));
  assert.equal(syncA2.lines.length, 3);

  // Confirm remote file still matches exportSavedLines() schema ({version: 1, lines: [...]})
  const remoteParsed = JSON.parse(drive.getContent());
  assert.equal(remoteParsed.version, 1);
  assert.equal(remoteParsed.lines.length, 3);
});

test('Delete sticks: delete on device A, sync device B with older copy, deleted line does NOT resurrect', async () => {
  const drive = createFakeDrive(exportSavedLines([line1, line2]));

  // Device B already synced earlier and holds [line1, line2] locally
  const deviceBLines = [line1, line2];
  const deviceBDeleted = [];

  // Device A deletes line1 and immediately pushes to Drive with tombstone
  const syncAfterDeleteOnA = await syncSavedLines({
    localLines: [line2],
    localDeletedIds: ['line-1'],
    token: 'valid-token',
    fetcher: drive.fetcher,
    online: true
  });
  assert.deepEqual(syncAfterDeleteOnA.lines.map(l => l.id), ['line-2']);
  assert.ok(syncAfterDeleteOnA.deletedIds.includes('line-1'));

  // Later, Device B opens app / syncs its older copy ([line1, line2]) with no local knowledge of the deletion
  const syncOnB = await syncSavedLines({
    localLines: deviceBLines,
    localDeletedIds: deviceBDeleted,
    token: 'valid-token',
    fetcher: drive.fetcher,
    online: true
  });

  // line-1 must NOT come back on Device B or in Drive
  assert.deepEqual(syncOnB.lines.map(l => l.id), ['line-2']);
  assert.ok(!syncOnB.lines.some(l => l.id === 'line-1'));
  assert.ok(syncOnB.deletedIds.includes('line-1'));

  const remoteAfterB = parseDrivePayload(drive.getContent());
  assert.deepEqual(remoteAfterB.lines.map(l => l.id), ['line-2']);
  assert.ok(remoteAfterB.deletedIds.includes('line-1'));
});

test('Corrupt, empty, or missing remote Drive file falls back to local lines without wiping them', async () => {
  for (const badRemote of [null, '', 'not-json{{{', JSON.stringify({version: 2, lines: []}), JSON.stringify({version: 1, lines: [{bad: true}]})]) {
    const drive = createFakeDrive(badRemote);
    const res = await syncSavedLines({
      localLines: [line1, line2],
      localDeletedIds: [],
      token: 'valid-token',
      fetcher: drive.fetcher,
      online: true
    });
    assert.equal(res.status, 'synced');
    assert.deepEqual(res.lines, [line1, line2]);
    // And repairs the remote file with valid local lines
    const repaired = parseDrivePayload(drive.getContent());
    assert.deepEqual(repaired.lines, [line1, line2]);
  }
});

test('Offline sync makes no network calls and leaves local lines unchanged', async () => {
  let networkCalls = 0;
  const fetcher = async () => {
    networkCalls++;
    throw Error('Should not be called while offline');
  };
  const res = await syncSavedLines({
    localLines: [line1, line2],
    localDeletedIds: [],
    token: 'valid-token',
    fetcher,
    online: false
  });
  assert.equal(res.status, 'offline');
  assert.equal(networkCalls, 0);
  assert.deepEqual(res.lines, [line1, line2]);
});

test('OAuth PKCE S256 parameters, Drive scope, query format, and 401 token clearing', async () => {
  assert.equal(GOOGLE_OAUTH_CLIENT_ID, '472482125167-3vlb1ccp2706qmlf53beu7mimr0i7qlo.apps.googleusercontent.com');
  assert.equal(DRIVE_SCOPE, 'https://www.googleapis.com/auth/drive.file');
  assert.equal(AUTHORIZED_ORIGIN, 'https://mk05257.github.io');
  assert.equal(REDIRECT_URI, 'https://mk05257.github.io/Drawline/');
  assert.equal(DRIVE_FOLDER_ID, '1_N5Bl2Rm5xkLiJ6qt2g-229AAkyrqvZg');
  assert.equal(DRIVE_LINES_FILENAME, 'drawline-lines.json');

  // RFC 7636 Appendix B test vector for S256 challenge
  const sampleVerifier = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk';
  const challenge = await computeCodeChallenge(sampleVerifier);
  assert.equal(challenge, 'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM');

  const pkce = await createPkceRequest({clientId: 'test-client-id'});
  const authUrl = new URL(pkce.authUrl);
  assert.equal(authUrl.origin + authUrl.pathname, 'https://accounts.google.com/o/oauth2/v2/auth');
  assert.equal(authUrl.searchParams.get('client_id'), 'test-client-id');
  assert.equal(authUrl.searchParams.get('redirect_uri'), 'https://mk05257.github.io/Drawline/');
  assert.equal(authUrl.searchParams.get('response_type'), 'code');
  assert.equal(authUrl.searchParams.get('scope'), 'https://www.googleapis.com/auth/drive.file');
  assert.equal(authUrl.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authUrl.searchParams.get('code_challenge'), await computeCodeChallenge(pkce.codeVerifier));

  // Verify find file query string matches exact specification
  const findUrl = new URL(buildFindFileUrl());
  assert.equal(
    findUrl.searchParams.get('q'),
    "name='drawline-lines.json' and '1_N5Bl2Rm5xkLiJ6qt2g-229AAkyrqvZg' in parents and trashed=false"
  );

  // Verify redirect handler exchanges code without client_secret and cleans URL via history.replaceState
  const sessionMap = new Map([[PKCE_SESSION_KEY, JSON.stringify({codeVerifier: pkce.codeVerifier, state: pkce.state})]]);
  let replacedUrl = null;
  let tokenPostBody = null;
  const redirectResult = await handleOAuthRedirectIfPresent({
    loc: {search: `?code=auth-code-123&state=${pkce.state}`, pathname: '/Drawline/', hash: ''},
    hist: {replaceState: (_s, _t, u) => { replacedUrl = u; }},
    sessionStore: {
      getItem: k => sessionMap.get(k) || null,
      removeItem: k => sessionMap.delete(k)
    },
    clientId: 'test-client-id',
    notifyOpener: false,
    fetcher: async (_url, init) => {
      tokenPostBody = new URLSearchParams(init.body);
      return {ok: true, status: 200, json: async () => ({access_token: 'mem-token-xyz'})};
    }
  });
  assert.equal(replacedUrl, '/Drawline/');
  assert.equal(redirectResult.ok, true);
  assert.equal(getAccessToken(), 'mem-token-xyz');
  assert.equal(tokenPostBody.get('client_id'), 'test-client-id');
  assert.equal(tokenPostBody.get('code_verifier'), pkce.codeVerifier);
  assert.equal(tokenPostBody.get('client_secret'), null);

  // 401 clears in-memory token and throws UnauthorizedDriveError
  const drive = createFakeDrive(null);
  setAccessToken('expired-token');
  await assert.rejects(
    () => syncSavedLines({localLines: [line1], token: getAccessToken(), fetcher: drive.fetcher, online: true}),
    UnauthorizedDriveError
  );
  assert.equal(getAccessToken(), null);

  // Deleted IDs local persistence helper
  const delStore = new Map();
  const s = {getItem: k => delStore.get(k) || null, setItem: (k, v) => delStore.set(k, v)};
  writeDeletedIds(s, ['line-1', 'line-1']);
  assert.deepEqual(readDeletedIds(s), ['line-1']);
  clearAccessToken();
});
