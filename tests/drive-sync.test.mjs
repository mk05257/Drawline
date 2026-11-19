import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {exportSavedLines} from '../src/storage.mjs';
import {
  GOOGLE_OAUTH_CLIENT_ID,
  DRIVE_FOLDER_ID,
  DRIVE_LINES_FILENAME,
  DRIVE_SCOPE,
  AUTHORIZED_ORIGIN
} from '../src/drive-config.mjs';
import {
  getAccessToken,
  setAccessToken,
  clearAccessToken,
  readDeletedIds,
  writeDeletedIds,
  parseDrivePayload,
  GIS_SCRIPT_URL,
  GIS_LOAD_ERROR,
  resetGisLoader,
  loadGisScript,
  requestGoogleAccessToken,
  reauthGoogleAccessToken,
  signInAndSync,
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
  assert.equal(DRIVE_FOLDER_ID, '1_N5Bl2Rm5xkLiJ6qt2g-229AAkyrqvZg');
  assert.equal(DRIVE_LINES_FILENAME, 'drawline-lines.json');

  // Verify find file query string matches exact specification
  const findUrl = new URL(buildFindFileUrl());
  assert.equal(
    findUrl.searchParams.get('q'),
    "name='drawline-lines.json' and '1_N5Bl2Rm5xkLiJ6qt2g-229AAkyrqvZg' in parents and trashed=false"
  );

  // Verify index.html has no static GIS script tag and CSP allows accounts.google.com in script-src without unsafe-inline
  const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  assert.ok(!html.includes('accounts.google.com/gsi/client'), 'GIS script must not be statically loaded in index.html');
  assert.match(html, /script-src 'self' https:\/\/accounts\.google\.com;/);
  assert.doesNotMatch(html, /script-src[^;]*'unsafe-inline'/);

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

function createFakeDom() {
  const appended = [];
  const doc = {
    createElement(tag) {
      return {
        tagName: tag.toUpperCase(),
        src: '',
        async: false,
        defer: false,
        onload: null,
        onerror: null,
        removed: false,
        remove() {
          this.removed = true;
        }
      };
    },
    head: {
      appendChild(el) {
        appended.push(el);
        return el;
      }
    }
  };
  return {doc, appended};
}

test('GIS loader injects the script only on a sign-in attempt and only once', async () => {
  resetGisLoader();
  clearAccessToken();
  const {doc, appended} = createFakeDom();
  const win = {};

  // Nothing is injected before a sign-in attempt
  assert.equal(appended.length, 0);

  // Two concurrent load calls inject only one <script> tag and share the cached promise
  const p1 = loadGisScript({doc, win});
  const p2 = loadGisScript({doc, win});
  assert.equal(p1, p2);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].src, GIS_SCRIPT_URL);
  assert.equal(appended[0].async, true);
  assert.equal(appended[0].defer, true);

  const fakeOAuth2 = {initTokenClient: () => ({requestAccessToken: () => {}})};
  win.google = {accounts: {oauth2: fakeOAuth2}};
  appended[0].onload();

  const [res1, res2] = await Promise.all([p1, p2]);
  assert.equal(res1, fakeOAuth2);
  assert.equal(res2, fakeOAuth2);

  // Subsequent sign-in attempt reuses loaded GIS without injecting another script
  const res3 = await loadGisScript({doc, win});
  assert.equal(res3, fakeOAuth2);
  assert.equal(appended.length, 1);
  resetGisLoader();
});

test('GIS token callback sets in-memory token and triggers Drive sync; re-auth uses prompt="" with Sign in again fallback', async () => {
  resetGisLoader();
  clearAccessToken();
  const drive = createFakeDrive(exportSavedLines([line2]));
  const initConfigs = [];
  const prompts = [];
  let nextResponse = {access_token: 'valid-token'};

  const fakeOAuth2 = {
    initTokenClient(config) {
      initConfigs.push(config);
      return {
        requestAccessToken(opts) {
          prompts.push(opts?.prompt);
          config.callback(nextResponse);
        }
      };
    }
  };

  const syncResult = await signInAndSync({
    localLines: [line1],
    localDeletedIds: [],
    loadGis: async () => fakeOAuth2,
    fetcher: drive.fetcher,
    online: true
  });

  assert.equal(initConfigs.length, 1);
  assert.equal(initConfigs[0].client_id, GOOGLE_OAUTH_CLIENT_ID);
  assert.equal(initConfigs[0].scope, DRIVE_SCOPE);
  assert.equal(prompts[0], 'consent');
  assert.equal(getAccessToken(), 'valid-token');
  assert.equal(syncResult.status, 'synced');
  assert.deepEqual(new Set(syncResult.lines.map(l => l.id)), new Set(['line-1', 'line-2']));

  // Re-auth after expiry uses prompt: '' silently when granted
  clearAccessToken();
  nextResponse = {access_token: 'refreshed-token'};
  const refreshed = await reauthGoogleAccessToken({loadGis: async () => fakeOAuth2});
  assert.equal(prompts[1], '');
  assert.equal(refreshed, 'refreshed-token');
  assert.equal(getAccessToken(), 'refreshed-token');

  // If silent re-auth returns no token or an error, it falls back with a clear "Sign in again" message
  nextResponse = {error: 'interaction_required'};
  await assert.rejects(
    () => reauthGoogleAccessToken({loadGis: async () => fakeOAuth2}),
    err => err instanceof UnauthorizedDriveError && err.message === 'Sign in again'
  );
  assert.equal(getAccessToken(), null);
  clearAccessToken();
});

test('GIS token errors produce clear user-facing error messages', async () => {
  resetGisLoader();
  clearAccessToken();

  const runWithOutcome = outcome =>
    requestGoogleAccessToken({
      loadGis: async () => ({
        initTokenClient(config) {
          return {
            requestAccessToken() {
              if (outcome.viaErrorCallback) {
                config.error_callback(outcome.payload);
              } else {
                config.callback(outcome.payload);
              }
            }
          };
        }
      })
    });

  await assert.rejects(
    () => runWithOutcome({payload: {error: 'access_denied'}}),
    {message: 'Google sign-in was cancelled.'}
  );
  assert.equal(getAccessToken(), null);

  await assert.rejects(
    () => runWithOutcome({payload: {}}),
    {message: 'Google did not return an access token.'}
  );
  assert.equal(getAccessToken(), null);

  await assert.rejects(
    () => runWithOutcome({viaErrorCallback: true, payload: {type: 'popup_closed'}}),
    {message: 'Google sign-in was closed before completing.'}
  );

  await assert.rejects(
    () => runWithOutcome({viaErrorCallback: true, payload: {type: 'popup_failed_to_open'}}),
    {message: 'Popup blocked. Allow popups for this site and try again.'}
  );
  clearAccessToken();
});

test('GIS load failure produces a clear error and clears cached promise for retry', async () => {
  resetGisLoader();
  clearAccessToken();
  const {doc, appended} = createFakeDom();
  const win = {};

  const failedLoad = requestGoogleAccessToken({doc, win});
  assert.equal(appended.length, 1);
  appended[0].onerror(new Error('network error'));

  await assert.rejects(() => failedLoad, {message: GIS_LOAD_ERROR});
  assert.equal(appended[0].removed, true);
  assert.equal(getAccessToken(), null);

  // A subsequent retry can inject a fresh script and succeed
  const retryLoad = loadGisScript({doc, win});
  assert.equal(appended.length, 2);
  const fakeOAuth2 = {initTokenClient: () => ({requestAccessToken: () => {}})};
  win.google = {accounts: {oauth2: fakeOAuth2}};
  appended[1].onload();
  assert.equal(await retryLoad, fakeOAuth2);
  resetGisLoader();
});
