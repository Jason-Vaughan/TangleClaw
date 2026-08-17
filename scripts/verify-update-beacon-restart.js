'use strict';

/*
 * Integration verification for #954 / #955 — the sequence a browser would show,
 * driven against real parts instead of stubs.
 *
 * REAL in this harness: the git binary and a real bare repo standing in for
 * origin (so `git ls-remote --tags` genuinely runs and genuinely returns tags);
 * the real `lib/update-checker.js` including its throttle, single-flight and
 * cache; a real HTTP server carrying the two real route bodies; real `fetch`
 * over the loopback; the real `public/update-beacon.js`; the real
 * `loadUpdateStatus` / `pollTick` / `updateCheckDue` lifted from
 * `public/session.js`; and the real mini-DOM the frontend tests use, so the dot
 * is actually created and actually removed.
 *
 * STUBBED: only `_internal.lsRemote`'s ARGUMENT — it points at the local bare
 * repo instead of a network origin. The transport is still `execFile` running
 * real git. The clean room on habitat is `internal: true` by design, so a
 * network origin could not have been reached there either; a local bare repo is
 * what makes this runnable anywhere, offline.
 *
 * The sequence is the one the operator hit on 2026-08-16 updating 5.5.0 -> 5.6.0:
 * an update is offered, it gets applied somewhere else, the server restarts, and
 * the question is whether a session page that did nothing drops the offer on its
 * own or sits on it until someone refreshes.
 */

const assert = require('node:assert/strict');
const { execFileSync, execFile } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');

const REPO = path.resolve(__dirname, '..');
const uc = require(path.join(REPO, 'lib/update-checker.js'));
const { makeDocument } = require(path.join(REPO, 'test/_mini-dom.js'));

const log = (...a) => console.log(...a);
const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

/* ---------- a real bare repo standing in for origin ---------- */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-verify-955-'));
const work = path.join(tmp, 'work');
const origin = path.join(tmp, 'origin.git');
fs.mkdirSync(work);
git(tmp, ['init', '--quiet', '--bare', origin]);
git(tmp, ['init', '--quiet', work]);
fs.writeFileSync(path.join(work, 'f'), 'x');
git(work, ['add', '.']);
git(work, ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '--quiet', '-m', 'init']);
for (const t of ['v5.0.0', 'v9.9.9']) git(work, ['tag', t]);
git(work, ['remote', 'add', 'origin', origin]);
git(work, ['push', '--quiet', 'origin', '--tags']);
log(`origin tags: ${git(work, ['ls-remote', '--tags', origin]).split('\n').length} refs`);

// The only substitution: point the real execFile-based lsRemote at that repo.
uc._internal.lsRemote = (cb) => execFile('git', ['ls-remote', '--tags', origin],
  { timeout: 15000, encoding: 'utf8' }, (err, stdout) => cb(err, stdout));

/* ---------- a real server carrying the two real route bodies ---------- */

const server = http.createServer((req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' });
    res.end(JSON.stringify(obj));
  };
  if (req.method === 'GET' && req.url === '/api/update-status') {
    return send(200, uc.getCachedStatus());          // the real cache read
  }
  if (req.method === 'POST' && req.url === '/api/update/check') {
    let body = '';
    req.on('data', (c) => { body += c; });
    return req.on('end', () => {
      let manual = false;
      try { manual = JSON.parse(body || '{}').manual === true; } catch { /* malformed -> auto floor */ }
      uc.refreshIfStale(uc.resolveRefreshFloor(manual), (status) => send(200, status));
    });
  }
  send(404, { error: 'not found', code: 'NOT_FOUND' });
});

/* ---------- the real client, in a real (mini) DOM ---------- */

const SESSION_SRC = fs.readFileSync(path.join(REPO, 'public/session.js'), 'utf8');
const BEACON_SRC = fs.readFileSync(path.join(REPO, 'public/update-beacon.js'), 'utf8');

function lift(decl, src) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced');
}
const constOf = (n) => Number(new RegExp(`const ${n} = (\\d+);`).exec(SESSION_SRC)[1]);

async function main() {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const base = `http://127.0.0.1:${port}`;
  log(`server: ${base}\n`);

  const { doc, ids } = makeDocument(['logoWrap']);
  const anchor = ids.logoWrap;

  const now = { t: 0 };
  const sandbox = {
    console, document: doc, setTimeout: () => 1, clearTimeout: () => {},
    Date: { now: () => now.t },
    fetch,
    alert: () => {},
    // Real api()/apiMutate() semantics: null on failure, lastErrorCode set.
    // Real api()/apiMutate() semantics, including the one that matters here:
    // they CATCH a transport failure and return null rather than throwing, so a
    // dead server is "no answer" and not an exception. (The poll-site guard
    // added for R-1/R-16 is insurance for the case where something else throws.)
    api: async (url) => {
      try {
        const r = await fetch(base + url);
        if (!r.ok) { sandbox.api.lastErrorCode = 'NOT_FOUND'; return null; }
        sandbox.api.lastErrorCode = null;
        return await r.json();
      } catch { sandbox.api.lastErrorCode = 'NETWORK'; return null; }
    },
    apiMutate: async (url, method, body) => {
      try {
        const r = await fetch(base + url, {
          method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
        });
        if (!r.ok) { sandbox.api.lastErrorCode = 'NOT_FOUND'; return null; }
        sandbox.api.lastErrorCode = null;
        return await r.json();
      } catch { sandbox.api.lastErrorCode = 'NETWORK'; return null; }
    },
    pollStatus: async () => {}
  };
  sandbox.window = sandbox;
  sandbox.global = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);

  // The real beacon script, evaluated exactly as the page loads it.
  vm.runInContext(BEACON_SRC, sandbox);
  assert.equal(typeof sandbox.window.tcIsUpdateAnswer, 'function',
    'update-beacon.js must publish the shared predicate onto window');
  log('OK  update-beacon.js loaded; window.tcIsUpdateAnswer resolves');

  vm.runInContext(`
    const updateBeacon = window.tcCreateUpdateBeacon({
      doc: document, anchorId: 'logoWrap', api, apiMutate,
      getInFlight: () => false, setInFlight: () => {},
      restart: { postServerRestart: async () => ({}), pollServerBackAndReload: () => {} }
    });
    const UPDATE_CHECK_INTERVAL_MS = ${constOf('UPDATE_CHECK_INTERVAL_MS')};
    const UPDATE_RETRY_INTERVAL_MS = ${constOf('UPDATE_RETRY_INTERVAL_MS')};
    let _lastUpdateCheckAt = 0;
    let _updateIntervalMs = UPDATE_CHECK_INTERVAL_MS;
    ${lift('function updateCheckDue(lastAt, now, intervalMs)', SESSION_SRC)}
    ${lift('async function loadUpdateStatus()', SESSION_SRC)}
    ${lift('async function pollTick()', SESSION_SRC)}
    globalThis.pollTick = pollTick;
    globalThis.cadence = () => _updateIntervalMs;
  `, sandbox);

  const dot = () => !!anchor.querySelector('.beacon-dot');
  const RETRY = constOf('UPDATE_RETRY_INTERVAL_MS');
  const FULL = constOf('UPDATE_CHECK_INTERVAL_MS');
  const tick = async (advance) => { now.t += advance; await sandbox.pollTick(); };

  // 1. An update exists. The page learns about it from its own poll.
  await tick(FULL);
  assert.equal(dot(), true, 'the dot must appear for an available update');
  log(`OK  update offered      dot=${dot()}  cadence=${sandbox.cadence()}ms`);

  // 2. The update is applied from ANOTHER surface and the server restarts. Two
  //    distinct things happen, and the old code conflated them: the newer tag
  //    goes away, AND the server is briefly DOWN. The outage is what a lingering
  //    session page actually meets first.
  git(work, ['tag', '-d', 'v9.9.9']);
  git(work, ['push', '--quiet', '--delete', 'origin', 'v9.9.9']);
  await new Promise((r) => server.close(r));          // the restart window

  // 3. A poll lands during the outage. The request fails, so the page has no
  //    answer — it must HOLD the dot (an unknown is not "up to date", #716) and
  //    it must NOT spend the full interval waiting to ask again. This is the
  //    step that used to cost five minutes, and it is where the retry earns its
  //    keep.
  await tick(FULL);
  assert.equal(dot(), true, 'an unreachable server must not clear a real offer');
  assert.equal(sandbox.cadence(), RETRY, 'a failed request must shorten the cadence');
  log(`OK  outage              dot=${dot()}  cadence=${sandbox.cadence()}ms  (held, retry armed)`);

  // 4. The server comes back — new process, so no cache at all.
  uc._reset();
  uc._internal.lsRemote = (cb) => execFile('git', ['ls-remote', '--tags', origin],
    { timeout: 15000, encoding: 'utf8' }, (err, stdout) => cb(err, stdout));
  await new Promise((r) => server.listen(port, '127.0.0.1', r));

  // 5. The retry fires 30s later, not 5 minutes later. `refreshIfStale` treats a
  //    never-measured cache as always stale, so this measures on the spot rather
  //    than reciting the empty cache — the offer goes away with no refresh, no
  //    focus, and no operator action.
  await tick(RETRY);
  log(`OK  retry fired         dot=${dot()}  cadence=${sandbox.cadence()}ms`);
  assert.equal(dot(), false, 'the offer must clear on its own after the restart');
  assert.equal(sandbox.cadence(), FULL, 'and the cadence must return to normal');

  // 6. It must not come back, and must not re-pop a toast for a running version.
  await tick(FULL);
  assert.equal(dot(), false, 'the offer must not return');
  assert.equal(!!anchor.querySelector('.beacon-toast'), false, 'no toast for an installed version');
  log(`OK  stays cleared       dot=${dot()}  toast=${!!anchor.querySelector('.beacon-toast')}`);

  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  log('\nPASS — the stale offer clears without a refresh.');
}

main().catch((e) => {
  server.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.error('\nFAIL:', e.message);
  process.exit(1);
});
