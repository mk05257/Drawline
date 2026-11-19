import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
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
  OAUTH_STATE_KEY,
  GOOGLE_AUTH_ENDPOINT,
  getAccessToken,
  setAccessToken,
  clearAccessToken,
  readDeletedIds,
  writeDeletedIds,
  parseDrivePayload,
  generateOAuthState,
  buildGoogleAuthUrl,
  startGoogleSignIn,
  consumeOAuthRedirect,
  completeOAuthRedirectAndSync,
  buildFindFileUrl,
  syncSavedLines,
  UnauthorizedDriveError
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

test('Drive config, query format, CSP, deleted IDs persistence, and 401 token clearing', async () => {
  assert.equal(GOOGLE_OAUTH_CLIENT_ID, '472482125167-3vlb1ccp2706qmlf53beu7mimr0i7qlo.apps.googleusercontent.com');
  assert.equal(DRIVE_SCOPE, 'https://www.googleapis.com/auth/drive.file');
  assert.equal(AUTHORIZED_ORIGIN, 'https://mk05257.github.io');
  assert.equal(REDIRECT_URI, 'https://mk05257.github.io/Drawline/');
  assert.equal(DRIVE_FOLDER_ID, '1_N5Bl2Rm5xkLiJ6qt2g-229AAkyrqvZg');
  assert.equal(DRIVE_LINES_FILENAME, 'drawline-lines.json');

  // Verify find file query string matches exact specification
  const findUrl = new URL(buildFindFileUrl());
  assert.equal(
    findUrl.searchParams.get('q'),
    "name='drawline-lines.json' and '1_N5Bl2Rm5xkLiJ6qt2g-229AAkyrqvZg' in parents and trashed=false"
  );

  // Verify index.html has tightened CSP: script-src 'self' only, no oauth2/accounts in connect-src, www.googleapis.com stays
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(!html.includes('gsi/client'), 'GIS script must not appear in index.html');
  assert.match(html, /script-src 'self';/);
  assert.doesNotMatch(html, /script-src[^;]*accounts\.google\.com/);
  assert.doesNotMatch(html, /script-src[^;]*'unsafe-inline'/);
  assert.doesNotMatch(html, /connect-src[^;]*oauth2\.googleapis\.com/);
  assert.doesNotMatch(html, /connect-src[^;]*accounts\.google\.com/);
  assert.match(html, /connect-src[^;]*https:\/\/www\.googleapis\.com/);

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

function createFakeSessionStorage() {
  const map = new Map();
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key) : null;
    },
    setItem(key, value) {
      map.set(key, String(value));
    },
    removeItem(key) {
      map.delete(key);
    }
  };
}

function createFakeBrowserNav(initialHash = '') {
  const assigned = [];
  const replaceStateCalls = [];
  const loc = {
    pathname: '/Drawline/',
    search: '',
    hash: initialHash,
    assign(url) {
      assigned.push(url);
    }
  };
  const hist = {
    replaceState(state, title, url) {
      replaceStateCalls.push({state, title, url});
      loc.hash = '';
    }
  };
  return {loc, hist, assigned, replaceStateCalls};
}

test('Auth URL builder and sign-in redirect use exact OAuth implicit parameters; re-auth uses prompt=""', () => {
  const urlStr = buildGoogleAuthUrl({state: 'probe_state-123'});
  const parsed = new URL(urlStr);
  assert.equal(`${parsed.origin}${parsed.pathname}`, GOOGLE_AUTH_ENDPOINT);
  assert.equal(parsed.searchParams.get('client_id'), GOOGLE_OAUTH_CLIENT_ID);
  assert.equal(parsed.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(parsed.searchParams.get('response_type'), 'token');
  assert.equal(parsed.searchParams.get('scope'), DRIVE_SCOPE);
  assert.equal(parsed.searchParams.get('state'), 'probe_state-123');
  assert.equal(parsed.searchParams.get('prompt'), 'consent');

  // State generator produces URL-safe random values from crypto.getRandomValues
  const s1 = generateOAuthState();
  const s2 = generateOAuthState();
  assert.match(s1, /^[A-Za-z0-9_-]{32}$/);
  assert.notEqual(s1, s2);

  // First sign-in stores state in sessionStorage and navigates the full page with window.location.assign
  const storage = createFakeSessionStorage();
  const nav = createFakeBrowserNav();
  const started = startGoogleSignIn({storage, loc: nav.loc});
  assert.equal(storage.getItem(OAUTH_STATE_KEY), started.state);
  assert.equal(nav.assigned.length, 1);
  assert.equal(nav.assigned[0], started.url);
  const firstUrl = new URL(nav.assigned[0]);
  assert.equal(firstUrl.searchParams.get('client_id'), GOOGLE_OAUTH_CLIENT_ID);
  assert.equal(firstUrl.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(firstUrl.searchParams.get('response_type'), 'token');
  assert.equal(firstUrl.searchParams.get('scope'), DRIVE_SCOPE);
  assert.equal(firstUrl.searchParams.get('state'), started.state);
  assert.equal(firstUrl.searchParams.get('prompt'), 'consent');

  // Re-auth uses prompt='' (omits forced consent prompt so Google re-issues or prompts as needed)
  const reauthNav = createFakeBrowserNav();
  const reauth = startGoogleSignIn({prompt: '', storage, loc: reauthNav.loc});
  assert.equal(storage.getItem(OAUTH_STATE_KEY), reauth.state);
  assert.equal(reauthNav.assigned.length, 1);
  const reauthUrl = new URL(reauthNav.assigned[0]);
  assert.equal(reauthUrl.searchParams.get('client_id'), GOOGLE_OAUTH_CLIENT_ID);
  assert.equal(reauthUrl.searchParams.get('redirect_uri'), REDIRECT_URI);
  assert.equal(reauthUrl.searchParams.get('response_type'), 'token');
  assert.equal(reauthUrl.searchParams.get('scope'), DRIVE_SCOPE);
  assert.equal(reauthUrl.searchParams.get('state'), reauth.state);
  assert.equal(reauthUrl.searchParams.has('prompt'), false);
});

test('OAuth fragment on load: success stores in-memory token, scrubs fragment before sync, removes state, and syncs', async () => {
  clearAccessToken();
  const storage = createFakeSessionStorage();
  storage.setItem(OAUTH_STATE_KEY, 'valid-state-xyz');
  const nav = createFakeBrowserNav(
    '#state=valid-state-xyz&access_token=valid-token&token_type=Bearer&expires_in=3599&scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Fdrive.file'
  );
  const drive = createFakeDrive(exportSavedLines([line2]));

  // Verify fragment is already scrubbed via history.replaceState BEFORE any Drive fetch runs
  let hashWasScrubbedBeforeFirstFetch = false;
  const orderCheckingFetcher = async (url, init) => {
    if (drive.calls.length === 0) {
      hashWasScrubbedBeforeFirstFetch = nav.replaceStateCalls.length === 1 && nav.loc.hash === '';
    }
    return await drive.fetcher(url, init);
  };

  const result = await completeOAuthRedirectAndSync({
    localLines: [line1],
    localDeletedIds: [],
    loc: nav.loc,
    hist: nav.hist,
    storage,
    fetcher: orderCheckingFetcher,
    online: true
  });

  assert.equal(result.handled, true);
  assert.equal(result.ok, true);
  assert.equal(getAccessToken(), 'valid-token');
  assert.equal(nav.replaceStateCalls.length, 1);
  assert.equal(nav.replaceStateCalls[0].url, '/Drawline/');
  assert.equal(nav.loc.hash, '');
  assert.equal(hashWasScrubbedBeforeFirstFetch, true);
  assert.equal(storage.getItem(OAUTH_STATE_KEY), null);
  assert.equal(result.sync.status, 'synced');
  assert.deepEqual(new Set(result.sync.lines.map(l => l.id)), new Set(['line-1', 'line-2']));

  // Non-OAuth fragments (empty or #history) are untouched and load normally
  const histNav = createFakeBrowserNav('#history');
  storage.setItem(OAUTH_STATE_KEY, 'untouched-state');
  const nonOAuth = consumeOAuthRedirect({loc: histNav.loc, hist: histNav.hist, storage});
  assert.equal(nonOAuth.handled, false);
  assert.equal(histNav.replaceStateCalls.length, 0);
  assert.equal(histNav.loc.hash, '#history');
  assert.equal(storage.getItem(OAUTH_STATE_KEY), 'untouched-state');
  clearAccessToken();
});

test('OAuth fragment state mismatch rejects with clear error, stores no token, scrubs fragment, and skips sync', async () => {
  clearAccessToken();
  const storage = createFakeSessionStorage();
  storage.setItem(OAUTH_STATE_KEY, 'expected-state');
  const nav = createFakeBrowserNav('#state=wrong-state&access_token=valid-token&token_type=Bearer');
  let fetchCalls = 0;

  const result = await completeOAuthRedirectAndSync({
    localLines: [line1],
    loc: nav.loc,
    hist: nav.hist,
    storage,
    fetcher: async () => {
      fetchCalls++;
      throw Error('Sync must not run on state mismatch');
    },
    online: true
  });

  assert.equal(result.handled, true);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'state_mismatch');
  assert.equal(result.message, "Sign-in didn't match. Please try signing in again.");
  assert.equal(getAccessToken(), null);
  assert.equal(nav.replaceStateCalls.length, 1);
  assert.equal(nav.loc.hash, '');
  assert.equal(storage.getItem(OAUTH_STATE_KEY), null);
  assert.equal(fetchCalls, 0);

  // Also rejects when sessionStorage has no stored state at all
  const missingStateNav = createFakeBrowserNav('#state=unsolicited&access_token=valid-token');
  const unsolicited = consumeOAuthRedirect({loc: missingStateNav.loc, hist: missingStateNav.hist, storage});
  assert.equal(unsolicited.handled, true);
  assert.equal(unsolicited.ok, false);
  assert.equal(unsolicited.error, 'state_mismatch');
  assert.equal(unsolicited.message, "Sign-in didn't match. Please try signing in again.");
  assert.equal(getAccessToken(), null);
  clearAccessToken();
});

test('OAuth fragment error (access_denied / other) and missing token produce clear errors without storing a token', () => {
  clearAccessToken();

  // access_denied -> cancelled message
  const storage1 = createFakeSessionStorage();
  storage1.setItem(OAUTH_STATE_KEY, 'state-1');
  const nav1 = createFakeBrowserNav('#error=access_denied&state=state-1');
  const denied = consumeOAuthRedirect({loc: nav1.loc, hist: nav1.hist, storage: storage1});
  assert.equal(denied.handled, true);
  assert.equal(denied.ok, false);
  assert.equal(denied.error, 'access_denied');
  assert.equal(denied.message, 'Google sign-in was cancelled.');
  assert.equal(getAccessToken(), null);
  assert.equal(nav1.replaceStateCalls.length, 1);
  assert.equal(storage1.getItem(OAUTH_STATE_KEY), null);

  // Other OAuth error -> generic sign-in error
  const storage2 = createFakeSessionStorage();
  storage2.setItem(OAUTH_STATE_KEY, 'state-2');
  const nav2 = createFakeBrowserNav('#error=temporarily_unavailable&state=state-2');
  const otherErr = consumeOAuthRedirect({loc: nav2.loc, hist: nav2.hist, storage: storage2});
  assert.equal(otherErr.handled, true);
  assert.equal(otherErr.ok, false);
  assert.equal(otherErr.error, 'temporarily_unavailable');
  assert.equal(otherErr.message, 'Could not complete Google sign-in.');
  assert.equal(getAccessToken(), null);
  assert.equal(nav2.replaceStateCalls.length, 1);

  // Matching state but missing access_token -> clear error
  const storage3 = createFakeSessionStorage();
  storage3.setItem(OAUTH_STATE_KEY, 'state-3');
  const nav3 = createFakeBrowserNav('#state=state-3&token_type=Bearer');
  const missingToken = consumeOAuthRedirect({loc: nav3.loc, hist: nav3.hist, storage: storage3});
  assert.equal(missingToken.handled, true);
  assert.equal(missingToken.ok, false);
  assert.equal(missingToken.error, 'missing_token');
  assert.equal(missingToken.message, 'Google did not return an access token.');
  assert.equal(getAccessToken(), null);
  assert.equal(nav3.replaceStateCalls.length, 1);
  assert.equal(storage3.getItem(OAUTH_STATE_KEY), null);
  clearAccessToken();
});
