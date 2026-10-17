'use strict';

// #2323: /api/tc/check-watches over an in-process server and a scratch store.
// Only a verified launch registers or cancels a watch, and only for its own
// project; the project, the Operator and its group read it; the repository is
// read from the project's own folder and not taken from the request; and the
// state in every answer is derived from the record at the time of the read.

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const api = require('../lib/check-watch-api');
const watchStore = require('../lib/check-watch-store');
const state = require('../lib/check-watch-state');
const { createServer } = require('../server');
const { operatorHeaders, bindProject, sendAs: sendRaw, signInOperator } = require('./_shared-docs-callers');
const { initRepo } = require('./_temp-repo');

/** Every refusal a request in this file was answered with, for the last test to read. */
const REFUSED = [];

/**
 * Send a request as `sendAs` does, keeping each refusal's body.
 * @param {...*} args - As `sendAs` takes them
 * @returns {Promise<{status: number, headers: object, data: any}>}
 */
async function sendAs(...args) {
  const res = await sendRaw(...args);
  if (res.status >= 400) REFUSED.push({ request: `${args[1]} ${args[2]}`, status: res.status, body: res.data });
  return res;
}

const REPO = 'Jason-Vaughan/TangleClaw';
const ROOT = '/api/tc/check-watches';

/**
 * A git answer as `lib/exec.js` gives one.
 * @param {object} over - Fields to replace
 * @returns {object}
 */
const gitAnswer = (over) => ({ exitCode: 0, stdout: '', stderr: '', error: null, errorCode: null, signal: null, timedOut: false, ...over });

describe('/api/tc/check-watches (#2323)', () => {
  let tmpDir;
  let server;
  let op;
  let owner;
  let neighbour;
  let outsider;
  let bOwner;
  let bNeighbour;
  let bOutsider;
  let origin;
  let originCalls;
  let clock;
  let shaSeed = 0;
  const original = { ...api._internal };

  const mkProject = (name) => {
    const dir = path.join(tmpDir, name);
    fs.mkdirSync(dir);
    return store.projects.create({ name, path: dir, engine: 'claude' });
  };

  /** @returns {string} A commit id no other test has used */
  const nextSha = () => { shaSeed += 1; return shaSeed.toString(16).padStart(40, '0'); };

  /**
   * A registration body, on a commit of its own.
   * @param {object} [over] - Fields to replace
   * @returns {object}
   */
  const watchBody = (over = {}) => ({ prNumber: 2341, headSha: nextSha(), checkName: 'test', dueInMinutes: 30, ...over });

  /**
   * Register as a launch and return the watch.
   * @param {object} [over] - Fields to replace in the body
   * @param {object} [binding] - Whose launch; the owner's by default
   * @returns {Promise<object>}
   */
  const registered = async (over = {}, binding = bOwner) => {
    const res = await sendAs(server, 'POST', ROOT, watchBody(over), binding.headers);
    assert.equal(res.status, 201, JSON.stringify(res.data));
    return res.data.watch;
  };

  before(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-api-check-watch-'));
    store._setBasePath(tmpDir);
    store.init();
    owner = mkProject('builder-a');
    neighbour = mkProject('integrator');
    outsider = mkProject('elsewhere');
    const group = store.projectGroups.create({ name: 'lanes' });
    store.projectGroups.addMember(group.id, owner.id);
    store.projectGroups.addMember(group.id, neighbour.id);
    bOwner = bindProject(owner);
    bNeighbour = bindProject(neighbour);
    bOutsider = bindProject(outsider);
    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    op = operatorHeaders(server);
  });

  beforeEach(() => {
    // Every project folder is a checkout of REPO, and the clock is the real one, unless a test says otherwise.
    origin = () => gitAnswer({ stdout: `https://github.com/${REPO}.git\n` });
    originCalls = [];
    clock = null;
    api._internal.readOrigin = async (cwd) => { originCalls.push(cwd); return origin(cwd); };
    api._internal.now = () => (clock === null ? Date.now() : clock);
  });

  after(async () => {
    Object.assign(api._internal, original);
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('who is asking', () => {
    const ROUTES = [
      ['POST', ROOT, { prNumber: 1, headSha: 'a'.repeat(40), checkName: 'test', dueInMinutes: 5 }],
      ['GET', ROOT, undefined],
      ['GET', `${ROOT}/cw_000000000000000000000000`, undefined],
      ['POST', `${ROOT}/cw_000000000000000000000000/cancel`, {}]
    ];

    it('an unbound caller reaches no route', async () => {
      for (const [method, urlPath, body] of ROUTES) {
        const res = await sendAs(server, method, urlPath, body, {});
        assert.equal(res.status, 403, `${method} ${urlPath}`);
        assert.ok(res.data.code, `${method} ${urlPath} names a code`);
      }
      assert.equal(originCalls.length, 0, 'no folder is read on behalf of an unverified caller');
    });

    it('a launch that claims another project, and a service token, are not principals', async () => {
      const spoofed = { 'x-tangleclaw-project-id': String(owner.id), 'x-tangleclaw-launch-id': bOutsider.launchId };
      const token = { authorization: 'Bearer anything', 'x-tangleclaw-project-id': String(owner.id) };
      const before = watchStore.listWatches(owner.id).length;
      for (const headers of [spoofed, token]) {
        assert.equal((await sendAs(server, 'POST', ROOT, watchBody(), headers)).status, 403);
        assert.equal((await sendAs(server, 'GET', ROOT, undefined, headers)).status, 403);
      }
      assert.equal(watchStore.listWatches(owner.id).length, before);
    });

    it('a launch that has ended can neither register nor cancel', async () => {
      const gone = mkProject('ended');
      const bGone = bindProject(gone);
      const watch = await registered({}, bGone);
      store.sessions.kill(store.sessions.getActive(gone.id).id, 'test: the session ended');
      assert.equal((await sendAs(server, 'POST', ROOT, watchBody(), bGone.headers)).status, 403);
      assert.equal((await sendAs(server, 'POST', `${ROOT}/${watch.watchId}/cancel`, {}, bGone.headers)).status, 403);
      assert.equal(watchStore.getWatch(watch.watchId).cancelled, null);
    });

    it('the Operator reads and cannot register or cancel', async () => {
      const watch = await registered();
      const made = await sendAs(server, 'POST', ROOT, watchBody(), op);
      assert.equal(made.status, 403);
      assert.equal(made.data.code, 'CHECK_WATCH_LAUNCH_ONLY');
      const cancelled = await sendAs(server, 'POST', `${ROOT}/${watch.watchId}/cancel`, {}, op);
      assert.equal(cancelled.status, 403);
      assert.equal(cancelled.data.code, 'CHECK_WATCH_LAUNCH_ONLY');
      assert.equal(watchStore.getWatch(watch.watchId).cancelled, null);
      const one = await sendAs(server, 'GET', `${ROOT}/${watch.watchId}`, undefined, op);
      assert.equal(one.status, 200);
      const all = await sendAs(server, 'GET', `${ROOT}?projectId=${owner.id}`, undefined, op);
      assert.equal(all.status, 200);
      assert.equal(all.data.yours, false);
      assert.ok(all.data.watches.some((w) => w.watchId === watch.watchId));
      const unnamed = await sendAs(server, 'GET', ROOT, undefined, op);
      assert.equal(unnamed.status, 400, 'the Operator has no project of its own to default to');
      assert.equal(unnamed.data.code, 'CHECK_WATCH_MALFORMED');
    });
  });

  describe('registering', () => {
    it('records the watch for the caller\'s own project, on the repository its folder is a checkout of', async () => {
      const sha = nextSha();
      const res = await sendAs(server, 'POST', ROOT, { prNumber: 2341, headSha: sha, checkName: 'test', dueInMinutes: 45 }, bOwner.headers);
      assert.equal(res.status, 201, JSON.stringify(res.data));
      const watch = res.data.watch;
      assert.equal(watch.projectId, owner.id);
      assert.equal(watch.repo, REPO);
      assert.equal(watch.prNumber, 2341);
      assert.equal(watch.headSha, sha);
      assert.equal(watch.checkName, 'test');
      assert.equal(watch.state, 'waiting');
      assert.deepEqual(watch.reasons, []);
      assert.equal(watch.open, true);
      assert.equal(watch.registeredBy.sessionId, bOwner.sessionId);
      assert.deepEqual(originCalls, [owner.path], 'the folder read is the project\'s own');
      const ahead = Date.parse(watch.dueAt) - Date.parse(watch.registeredAt);
      assert.ok(ahead > 44 * 60000 && ahead <= 45 * 60000, `due ${ahead} ms ahead`);
      const kept = watchStore.getWatch(watch.watchId);
      assert.equal(kept.registeredBy.launchId, bOwner.launchId, 'the record keeps the launch');
    });

    it('takes neither a project nor a repository from the body', async () => {
      const res = await sendAs(server, 'POST', ROOT, watchBody({ projectId: neighbour.id, repo: 'someone/else' }), bOwner.headers);
      assert.equal(res.status, 201, JSON.stringify(res.data));
      assert.equal(res.data.watch.projectId, owner.id);
      assert.equal(res.data.watch.repo, REPO);
    });

    it('says in every answer that the watch is monitored: the server wakes the project itself', async () => {
      const watch = await registered();
      const made = await sendAs(server, 'POST', ROOT, watchBody(), bOwner.headers);
      const one = await sendAs(server, 'GET', `${ROOT}/${watch.watchId}`, undefined, bOwner.headers);
      const all = await sendAs(server, 'GET', ROOT, undefined, bOwner.headers);
      for (const res of [made, one, all]) assert.equal(res.data.monitored, true);
      assert.equal(api.MONITORED, true);
    });

    it('refuses a malformed pull request, commit or check name, by name, before any folder is read', async () => {
      const bad = [
        { prNumber: 0 }, { prNumber: '2341' }, { prNumber: 1.5 }, { prNumber: undefined },
        { headSha: 'abc123' }, { headSha: 'A'.repeat(40) }, { headSha: undefined },
        { checkName: '' }, { checkName: ' test' }, { checkName: 'x'.repeat(state.MAX_CHECK_NAME + 1) }, { checkName: 'a\nb' }, { checkName: undefined }
      ];
      for (const over of bad) {
        const res = await sendAs(server, 'POST', ROOT, watchBody(over), bOwner.headers);
        assert.equal(res.status, 400, JSON.stringify(over));
        assert.equal(res.data.code, 'CHECK_WATCH_MALFORMED', JSON.stringify(over));
      }
      const longest = await sendAs(server, 'POST', ROOT, watchBody({ checkName: 'x'.repeat(state.MAX_CHECK_NAME) }), bOwner.headers);
      assert.equal(longest.status, 201, 'a name of exactly the limit is taken');
      assert.equal(originCalls.length, 1, 'only the accepted registration read the folder');
    });

    it('needs a due time, a whole number of minutes from 1 to the limit', async () => {
      assert.equal(api.MAX_DUE_MINUTES, 24 * 60);
      for (const dueInMinutes of [undefined, null, 0, -5, 1.5, '30', api.MAX_DUE_MINUTES + 1, Number.MAX_SAFE_INTEGER]) {
        const res = await sendAs(server, 'POST', ROOT, watchBody({ dueInMinutes }), bOwner.headers);
        assert.equal(res.status, 400, String(dueInMinutes));
        assert.equal(res.data.code, 'CHECK_WATCH_DUE_OUT_OF_RANGE', String(dueInMinutes));
        assert.equal(res.data.maxDueInMinutes, api.MAX_DUE_MINUTES);
      }
      for (const dueInMinutes of [1, api.MAX_DUE_MINUTES]) {
        const res = await sendAs(server, 'POST', ROOT, watchBody({ dueInMinutes }), bOwner.headers);
        assert.equal(res.status, 201, `${dueInMinutes}: ${JSON.stringify(res.data)}`);
      }
      // A body that tries to name the time itself gets no watch: only minutes from now are taken.
      const named = await sendAs(server, 'POST', ROOT, { prNumber: 1, headSha: nextSha(), checkName: 'test', dueAt: '2099-01-01T00:00:00.000Z' }, bOwner.headers);
      assert.equal(named.status, 400);
      assert.equal(named.data.code, 'CHECK_WATCH_DUE_OUT_OF_RANGE');
    });

    it('refuses a second open watch on the same check of the same commit, naming the first, and takes one again once the first is cancelled', async () => {
      const first = await registered();
      const again = { prNumber: first.prNumber, headSha: first.headSha, checkName: first.checkName, dueInMinutes: 10 };
      const dup = await sendAs(server, 'POST', ROOT, again, bOwner.headers);
      assert.equal(dup.status, 409);
      assert.equal(dup.data.code, 'CHECK_WATCH_DUPLICATE');
      assert.equal(dup.data.watchId, first.watchId);
      // Another project may watch the same check: the limit is one per project.
      const other = await sendAs(server, 'POST', ROOT, again, bNeighbour.headers);
      assert.equal(other.status, 201, JSON.stringify(other.data));
      assert.equal((await sendAs(server, 'POST', `${ROOT}/${first.watchId}/cancel`, {}, bOwner.headers)).status, 200);
      const after = await sendAs(server, 'POST', ROOT, again, bOwner.headers);
      assert.equal(after.status, 201, JSON.stringify(after.data));
      assert.notEqual(after.data.watch.watchId, first.watchId);
    });

    it('refuses a project at its limit of open watches, and a cancelled one frees a place', async () => {
      const full = mkProject('full');
      const bFull = bindProject(full);
      const made = [];
      for (let i = 0; i < state.MAX_OPEN_PER_PROJECT; i += 1) made.push(await registered({}, bFull));
      const over = await sendAs(server, 'POST', ROOT, watchBody(), bFull.headers);
      assert.equal(over.status, 409);
      assert.equal(over.data.code, 'CHECK_WATCH_LIMIT');
      const list = await sendAs(server, 'GET', ROOT, undefined, bFull.headers);
      assert.equal(list.data.openCount, state.MAX_OPEN_PER_PROJECT);
      assert.equal(list.data.maxOpen, state.MAX_OPEN_PER_PROJECT);
      assert.equal((await sendAs(server, 'POST', `${ROOT}/${made[0].watchId}/cancel`, {}, bFull.headers)).status, 200);
      assert.equal((await sendAs(server, 'POST', ROOT, watchBody(), bFull.headers)).status, 201);
    });

    it('refuses a project whose folder is no checkout of a GitHub repository, and one whose folder could not be read', async () => {
      const before = watchStore.listWatches(owner.id).length;
      const unknown = [
        gitAnswer({ exitCode: 2, stderr: 'error: No such remote \'origin\'' }),
        gitAnswer({ exitCode: 128, stderr: 'fatal: not a git repository' }),
        gitAnswer({ stdout: 'https://gitlab.com/someone/thing.git\n' }),
        gitAnswer({ stdout: '\n' })
      ];
      for (const answer of unknown) {
        origin = () => answer;
        const res = await sendAs(server, 'POST', ROOT, watchBody(), bOwner.headers);
        assert.equal(res.status, 409, JSON.stringify(answer));
        assert.equal(res.data.code, 'CHECK_WATCH_REPO_UNKNOWN');
      }
      const unreadable = [
        gitAnswer({ exitCode: 124, timedOut: true, error: 'timed out after 4000ms' }),
        gitAnswer({ exitCode: 1, error: 'spawn git ENOENT', errorCode: 'ENOENT' }),
        gitAnswer({ exitCode: 1, signal: 'SIGKILL' })
      ];
      for (const answer of unreadable) {
        origin = () => answer;
        const res = await sendAs(server, 'POST', ROOT, watchBody(), bOwner.headers);
        assert.equal(res.status, 503, JSON.stringify(answer));
        assert.equal(res.data.code, 'CHECK_WATCH_REPO_UNREADABLE');
        assert.equal(/; repeat the request/.test(res.data.error), answer.errorCode !== 'ENOENT', res.data.error);
      }
      origin = () => { throw new Error('the seam itself broke'); };
      const thrown = await sendAs(server, 'POST', ROOT, watchBody(), bOwner.headers);
      assert.equal(thrown.status, 503);
      assert.equal(thrown.data.code, 'CHECK_WATCH_REPO_UNREADABLE');
      assert.equal(watchStore.listWatches(owner.id).length, before, 'none of them registered anything');
    });

    it('reads a real folder\'s origin with git, in every form a GitHub remote is written', async () => {
      api._internal.readOrigin = original.readOrigin;
      const real = mkProject('real-checkout');
      initRepo(real.path);
      const bReal = bindProject(real);
      const none = await sendAs(server, 'POST', ROOT, watchBody(), bReal.headers);
      assert.equal(none.status, 409, JSON.stringify(none.data));
      assert.equal(none.data.code, 'CHECK_WATCH_REPO_UNKNOWN');
      execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:Some-Owner/some.repo.git'], { cwd: real.path });
      const made = await sendAs(server, 'POST', ROOT, watchBody(), bReal.headers);
      assert.equal(made.status, 201, JSON.stringify(made.data));
      assert.equal(made.data.watch.repo, 'Some-Owner/some.repo');
      // A project whose folder is gone is told so, not registered against nothing.
      const gone = mkProject('folder-gone');
      const bGone = bindProject(gone);
      fs.rmSync(gone.path, { recursive: true });
      const res = await sendAs(server, 'POST', ROOT, watchBody(), bGone.headers);
      assert.equal(res.status, 503, JSON.stringify(res.data));
      assert.equal(res.data.code, 'CHECK_WATCH_REPO_UNREADABLE');
      assert.match(res.data.error, /folder \(.*folder-gone\) or git itself is missing, so repeating the request will not help/);
      assert.ok(!/; repeat the request/.test(res.data.error));
    });
  });

  describe('reading', () => {
    it('the project, a project in its group and the Operator read a watch; to anyone else it does not exist', async () => {
      const watch = await registered();
      for (const headers of [bOwner.headers, bNeighbour.headers, op]) {
        const one = await sendAs(server, 'GET', `${ROOT}/${watch.watchId}`, undefined, headers);
        assert.equal(one.status, 200);
        assert.equal(one.data.watch.watchId, watch.watchId);
        assert.equal(one.data.projectName, 'builder-a');
        const all = await sendAs(server, 'GET', `${ROOT}?projectId=${owner.id}`, undefined, headers);
        assert.equal(all.status, 200);
        assert.ok(all.data.watches.some((w) => w.watchId === watch.watchId));
      }
      const hidden = await sendAs(server, 'GET', `${ROOT}/${watch.watchId}`, undefined, bOutsider.headers);
      const missing = await sendAs(server, 'GET', `${ROOT}/cw_000000000000000000000000`, undefined, bOutsider.headers);
      assert.equal(hidden.status, 404);
      assert.deepEqual(hidden.data, missing.data, 'a watch one may not read answers exactly as one that does not exist');
      const list = await sendAs(server, 'GET', `${ROOT}?projectId=${owner.id}`, undefined, bOutsider.headers);
      const noProject = await sendAs(server, 'GET', `${ROOT}?projectId=999999`, undefined, bOutsider.headers);
      assert.equal(list.status, 404);
      assert.deepEqual(list.data, noProject.data);
      assert.equal(list.data.code, 'CHECK_WATCH_PROJECT_NOT_FOUND');
    });

    it('a launch that names no project reads its own, and only its own', async () => {
      const mine = await registered();
      const theirs = await registered({}, bNeighbour);
      const list = await sendAs(server, 'GET', ROOT, undefined, bOwner.headers);
      assert.equal(list.status, 200);
      assert.equal(list.data.projectId, owner.id);
      assert.equal(list.data.yours, true);
      assert.ok(list.data.watches.some((w) => w.watchId === mine.watchId));
      assert.ok(!list.data.watches.some((w) => w.watchId === theirs.watchId));
      assert.ok(list.data.watches.every((w) => w.projectId === owner.id));
      const named = await sendAs(server, 'GET', `${ROOT}?projectId=${neighbour.id}`, undefined, bOwner.headers);
      assert.equal(named.data.yours, false);
      assert.ok(named.data.watches.some((w) => w.watchId === theirs.watchId));
    });

    it('refuses a project id or a watch id that is not one', async () => {
      for (const id of ['abc', '0', '-1', '1.5', '1e3']) {
        const res = await sendAs(server, 'GET', `${ROOT}?projectId=${id}`, undefined, bOwner.headers);
        assert.equal(res.status, 400, id);
        assert.equal(res.data.code, 'CHECK_WATCH_MALFORMED');
      }
      for (const id of ['has.dot', 'x'.repeat(65), 'sp%20ace']) {
        const res = await sendAs(server, 'GET', `${ROOT}/${id}`, undefined, bOwner.headers);
        assert.equal(res.status, 400, id);
        assert.equal(res.data.code, 'CHECK_WATCH_MALFORMED');
      }
    });

    it('derives the state at the time of the read: waiting, then unknown once the due time has passed, with the reason', async () => {
      const watch = await registered({ dueInMinutes: 10 });
      const due = Date.parse(watch.dueAt);
      clock = due - 1;
      let one = await sendAs(server, 'GET', `${ROOT}/${watch.watchId}`, undefined, bOwner.headers);
      assert.equal(one.data.watch.state, 'waiting');
      clock = due;
      one = await sendAs(server, 'GET', `${ROOT}/${watch.watchId}`, undefined, bOwner.headers);
      assert.equal(one.data.watch.state, 'unknown');
      assert.deepEqual(one.data.watch.reasons, ['past-due']);
      assert.equal(one.data.watch.open, true, 'past due is still open: a late result is still its result');
      const all = await sendAs(server, 'GET', ROOT, undefined, bOwner.headers);
      assert.equal(all.data.watches.find((w) => w.watchId === watch.watchId).state, 'unknown');
    });

    it('shows a recorded result as ready or failed, a failed read as unknown, and never ready or failed without a result', async () => {
      const green = await registered();
      const red = await registered();
      const blind = await registered();
      const running = await registered();
      watchStore.recordRead(green.watchId, { status: 'concluded', conclusion: 'success', runId: '9001', completedAt: '2026-10-12T10:00:00.000Z' });
      watchStore.recordRead(red.watchId, { status: 'concluded', conclusion: 'timed_out', runId: '9002', completedAt: '2026-10-12T10:00:00.000Z' });
      watchStore.recordRead(blind.watchId, { status: 'unavailable', reason: 'gh api exited 1: rate limited' });
      watchStore.recordRead(running.watchId, { status: 'running' });
      const read = async (w) => (await sendAs(server, 'GET', `${ROOT}/${w.watchId}`, undefined, bOwner.headers)).data;
      const g = await read(green);
      assert.equal(g.watch.state, 'ready');
      assert.equal(g.watch.open, false);
      assert.deepEqual(g.watch.result && { conclusion: g.watch.result.conclusion, runId: g.watch.result.runId }, { conclusion: 'success', runId: '9001' });
      assert.deepEqual(g.facts.map((f) => f.kind), ['registered', 'resolved']);
      const r = await read(red);
      assert.equal(r.watch.state, 'failed');
      assert.equal(r.watch.result.conclusion, 'timed_out');
      const b = await read(blind);
      assert.equal(b.watch.state, 'unknown');
      assert.deepEqual(b.watch.reasons, ['read-failed']);
      assert.equal(b.watch.result, null);
      assert.equal(b.watch.lastRead.outcome, 'failed');
      assert.match(b.watch.lastRead.detail, /rate limited/);
      const w = await read(running);
      assert.equal(w.watch.state, 'waiting');
      assert.equal(w.watch.lastRead.outcome, 'ok');
      const all = (await sendAs(server, 'GET', ROOT, undefined, bOwner.headers)).data.watches;
      for (const listed of all) {
        if (!listed.result) assert.ok(['waiting', 'unknown'].includes(listed.state), `${listed.watchId} reads ${listed.state} with no result`);
      }
    });

    it('lists the newest watches first and says how many there are when it does not show them all', async () => {
      const busy = mkProject('busy');
      const bBusy = bindProject(busy);
      const total = api.LIST_LIMIT + 3;
      let last;
      for (let i = 0; i < total; i += 1) {
        last = await registered({}, bBusy);
        if (i < total - 1) watchStore.cancelWatch(last.watchId, { projectId: busy.id, launchId: bBusy.launchId });
      }
      const list = await sendAs(server, 'GET', ROOT, undefined, bBusy.headers);
      assert.equal(list.data.total, total);
      assert.equal(list.data.watches.length, api.LIST_LIMIT);
      assert.equal(list.data.watches[0].watchId, last.watchId);
      assert.equal(list.data.openCount, 1);
    });

    it('hands no launch id to any reader, in a watch or in its history', async () => {
      const watch = await registered();
      await sendAs(server, 'POST', `${ROOT}/${watch.watchId}/cancel`, {}, bOwner.headers);
      for (const headers of [bOwner.headers, bNeighbour.headers, op]) {
        const one = await sendAs(server, 'GET', `${ROOT}/${watch.watchId}`, undefined, headers);
        const all = await sendAs(server, 'GET', `${ROOT}?projectId=${owner.id}`, undefined, headers);
        for (const text of [JSON.stringify(one.data), JSON.stringify(all.data)]) {
          assert.ok(!text.includes(bOwner.launchId), 'the launch id is in an answer');
          assert.ok(!/launchId/.test(text), 'a launch id field is in an answer');
        }
        assert.deepEqual(one.data.facts.map((f) => f.kind), ['registered', 'cancelled']);
        assert.equal(one.data.facts[1].detail.projectId, owner.id);
      }
    });
  });

  describe('cancelling', () => {
    it('the project cancels its own watch once; it then reads cancelled and unknown, and is no longer open', async () => {
      const watch = await registered();
      const done = await sendAs(server, 'POST', `${ROOT}/${watch.watchId}/cancel`, {}, bOwner.headers);
      assert.equal(done.status, 200, JSON.stringify(done.data));
      assert.equal(done.data.watch.state, 'unknown');
      assert.deepEqual(done.data.watch.reasons, ['cancelled']);
      assert.equal(done.data.watch.open, false);
      assert.equal(done.data.watch.cancelled.projectId, owner.id);
      const listed = (await sendAs(server, 'GET', ROOT, undefined, bOwner.headers)).data.watches.find((w) => w.watchId === watch.watchId);
      assert.deepEqual([listed.state, listed.reasons, listed.open], ['unknown', ['cancelled'], false]);
      const twice = await sendAs(server, 'POST', `${ROOT}/${watch.watchId}/cancel`, {}, bOwner.headers);
      assert.equal(twice.status, 409);
      assert.equal(twice.data.code, 'CHECK_WATCH_CANCELLED');
    });

    it('another project cannot cancel it: one that may read it is refused, and to one that may not it does not exist', async () => {
      const watch = await registered();
      const reader = await sendAs(server, 'POST', `${ROOT}/${watch.watchId}/cancel`, {}, bNeighbour.headers);
      assert.equal(reader.status, 403);
      assert.equal(reader.data.code, 'CHECK_WATCH_NOT_OWNER');
      const stranger = await sendAs(server, 'POST', `${ROOT}/${watch.watchId}/cancel`, {}, bOutsider.headers);
      assert.equal(stranger.status, 404);
      assert.equal(stranger.data.code, 'CHECK_WATCH_NOT_FOUND');
      assert.equal(watchStore.getWatch(watch.watchId).cancelled, null);
      assert.equal((await sendAs(server, 'GET', `${ROOT}/${watch.watchId}`, undefined, bOwner.headers)).data.watch.state, 'waiting');
    });

    it('a watch that already has its result can still be cancelled, and keeps the result', async () => {
      const watch = await registered();
      watchStore.recordRead(watch.watchId, { status: 'concluded', conclusion: 'success', runId: '9003', completedAt: '2026-10-12T10:00:00.000Z' });
      const done = await sendAs(server, 'POST', `${ROOT}/${watch.watchId}/cancel`, {}, bOwner.headers);
      assert.equal(done.status, 200, JSON.stringify(done.data));
      assert.equal(done.data.watch.state, 'ready');
      assert.equal(done.data.watch.result.runId, '9003');
      assert.ok(done.data.watch.cancelled);
    });
  });

  describe('a held lane', () => {
    let signedIn;
    let loginWas;

    // Releasing a HOLD is the operator's, and needs the operator signed in
    // (#2378): this suite turns the login on, and puts it back as it was.
    before(async () => {
      const config = store.config.load();
      loginWas = { authEnabled: config.authEnabled, basicAuthUser: config.basicAuthUser, basicAuthHash: config.basicAuthHash };
      store.config.save({ ...config, authEnabled: true, basicAuthUser: null, basicAuthHash: null });
      signedIn = await signInOperator(server);
    });

    after(() => {
      store.config.save({ ...store.config.load(), ...loginWas });
    });

    it('still registers, reads and cancels: a watch changes nothing outside its own record', async () => {
      const made = await sendAs(server, 'POST', '/api/control/assignments', { projectId: owner.id, requestId: 'cw-asg-1', issueRef: '#2323' }, signedIn);
      assert.equal(made.status, 201, JSON.stringify(made.data));
      const assignmentId = made.data.assignment.assignmentId;
      const hold = await sendAs(server, 'POST', `/api/control/assignments/${assignmentId}/hold`, { requestId: 'cw-hold-1', reasonCode: 'boundary' }, signedIn);
      assert.equal(hold.status, 201, JSON.stringify(hold.data));
      try {
        const watch = await registered();
        assert.equal((await sendAs(server, 'GET', `${ROOT}/${watch.watchId}`, undefined, bOwner.headers)).status, 200);
        assert.equal((await sendAs(server, 'POST', `${ROOT}/${watch.watchId}/cancel`, {}, bOwner.headers)).status, 200);
      } finally {
        const released = await sendAs(server, 'POST', `/api/control/assignments/${assignmentId}/release`, {
          requestId: 'cw-rel-1', reasonCode: 'resolved', holdIds: [hold.data.holdId], expectedGeneration: hold.data.assignment.stateGeneration
        }, signedIn);
        assert.equal(released.status, 200, JSON.stringify(released.data));
      }
    });
  });

  // The monitor, the tracked send, the exchange rows and this server's own
  // arrival observer are the real ones. Only the Hub is stood in for: each
  // listener gets a socket the test drives, and a send is answered here.
  describe('what became of a watch\'s messages', () => {
    const medusa = require('../lib/medusa');
    const monitor = require('../lib/check-watch');
    const exchanges = require('../lib/medusa-exchanges');
    const MESSAGES = '/api/sessions/builder-a/medusa';
    const realSend = medusa.sendMessage;
    const realMonitor = { ...monitor._internal };
    const realStoreNow = watchStore._internal.now;
    /** Each listener's socket and workspace, by listener key. */
    const wires = new Map();
    /** What the stand-in Hub does with the next sends: `deliver`, `lost` or `refuse`. */
    let hubDoes = 'deliver';
    let issued = 0;

    /** A socket the test opens, registers and feeds frames to. */
    class Socket {
      /** Start closed, with nothing sent. */
      constructor() { this.readyState = 0; this.handlers = {}; }
      /**
       * @param {string} type - Event name
       * @param {Function} handler - Its handler
       * @returns {void}
       */
      addEventListener(type, handler) { (this.handlers[type] || (this.handlers[type] = [])).push(handler); }
      /** @returns {void} */
      send() {}
      /** @returns {void} */
      close() { this.readyState = 3; }
      /**
       * @param {object} frame - A frame from the Hub
       * @returns {void}
       */
      frame(frame) { for (const h of this.handlers.message || []) h({ data: JSON.stringify(frame) }); }
      /**
       * Open the socket and register it, so its listener is connected.
       * @param {string} workspaceId - The workspace it registers as
       * @returns {void}
       */
      up(workspaceId) {
        this.readyState = 1;
        for (const h of this.handlers.open || []) h({});
        this.frame({ type: 'registered', workspaceId, connectionId: 'c-1' });
      }
    }

    /**
     * Start a listener on a socket of the test's, or answer for the one already there.
     * @param {object} options - As `medusa.startSession` takes them
     * @returns {object} The listener's status
     */
    const listen = (options) => {
      const key = String(options.sessionId);
      if (wires.has(key) && medusa.getStatus(key).state !== 'off') return medusa.getStatus(key);
      let socket;
      const status = medusa.startSession({ ...options, wsFactory: () => (socket = new Socket()) });
      wires.set(key, { socket, workspaceId: status.workspaceId });
      return status;
    };

    /**
     * Bring a listener's connection up.
     * @param {string|number} key - Listener key
     * @returns {string} Its workspace id
     */
    const connect = (key) => {
      const wire = wires.get(String(key));
      wire.socket.up(wire.workspaceId);
      return wire.workspaceId;
    };

    /**
     * Give a watch its result, as the monitor's read of GitHub would.
     * @param {object} watch - The watch
     * @param {string} [conclusion] - How the check ended
     * @returns {void}
     */
    const resolve = (watch, conclusion = 'success') => {
      const out = watchStore.recordRead(watch.watchId, { status: 'concluded', conclusion, runId: '77', completedAt: '2026-10-12T05:13:25.000Z' });
      assert.equal(out.ok, true, JSON.stringify(out));
    };

    /**
     * What a read of a watch says became of its messages.
     * @param {object} watch - The watch
     * @param {object} [binding] - Whose launch reads
     * @returns {Promise<{wake: object, alarm: object}>}
     */
    const delivery = async (watch, binding = bOwner) => {
      const res = await sendAs(server, 'GET', `${ROOT}/${watch.watchId}`, undefined, binding.headers);
      assert.equal(res.status, 200, JSON.stringify(res.data));
      return res.data.watch.delivery;
    };

    /**
     * One pass of the monitor that reads nothing new from GitHub.
     * @param {number} [ahead] - How far past the real clock to judge it, in ms
     * @returns {Promise<object>} The pass's summary
     */
    const pass = (ahead = 0) => monitor.tick(Date.now() + ahead);

    before(() => {
      monitor._internal.readCheck = async () => ({ status: 'running', runId: '1', app: 'github-actions' });
      monitor._internal.medusa = () => ({ ...medusa, startSession: listen });
      medusa.sendMessage = async ({ sessionId, to, message, beforeHub }) => {
        const from = medusa.getStatus(sessionId).workspaceId;
        if (!from) throw Object.assign(new Error('not listening'), { httpStatus: 409, code: 'NOT_LISTENING' });
        beforeHub({ from });
        if (hubDoes !== 'deliver') {
          throw Object.assign(new Error(`hub ${hubDoes}`), { httpStatus: 502, code: 'SEND_REJECTED', hubOutcome: hubDoes === 'refuse' ? 'refused' : 'unknown' });
        }
        const id = `api-hub-${++issued}`;
        const recipient = [...wires.values()].find((wire) => wire.workspaceId === to);
        // The message is with the recipient before the Hub's answer is back.
        recipient.socket.frame({ type: 'new_message', messageId: id, message: { id, from, to, message: message.trim() } });
        return { status: 'received', id, to };
      };
      listen({ projectPath: owner.path, sessionId: bOwner.sessionId, name: owner.name });
      connect(bOwner.sessionId);
    });

    beforeEach(() => { hubDoes = 'deliver'; });

    after(async () => {
      monitor.stop();
      await monitor.settled();
      medusa.stopSession(bOwner.sessionId);
      medusa.sendMessage = realSend;
      Object.assign(monitor._internal, realMonitor);
      watchStore._internal.now = realStoreNow;
    });

    it('says not-owed before there is a result, and owed once there is one and nothing has been sent', async () => {
      const watch = await registered();
      const blank = { state: 'not-owed', secondAttempt: false, attempts: [], undeliverable: null };
      assert.deepEqual(await delivery(watch), { wake: blank, alarm: blank });
      resolve(watch);
      assert.deepEqual(await delivery(watch), { wake: { ...blank, state: 'owed' }, alarm: blank });
      for (const stateName of ['not-owed', 'owed']) assert.ok(api.DELIVERY_STATES.includes(stateName));
    });

    it('follows a wake from accepted and arrived to read and acknowledged, on the recipient\'s own word', async () => {
      const watch = await registered();
      resolve(watch);
      // The monitor's own listener comes up on the first pass and is not connected yet, so nothing is sent.
      assert.equal((await pass()).sent, 0);
      assert.equal((await delivery(watch)).wake.state, 'owed');
      connect(monitor.LISTENER_KEY);
      // Every watch this file has resolved so far is owed its wake, so the pass sends more than this one.
      assert.ok((await pass()).sent >= 1);

      const arrived = (await delivery(watch)).wake;
      assert.equal(arrived.state, 'arrived', 'this server\'s arrival observer bound it by its marker');
      assert.equal(arrived.secondAttempt, false);
      assert.equal(arrived.attempts.length, 1);
      const [attempt] = arrived.attempts;
      assert.deepEqual(
        { attempt: attempt.attempt, state: attempt.state, to: attempt.to },
        { attempt: 1, state: 'arrived', to: wires.get(String(bOwner.sessionId)).workspaceId }
      );
      const sent = store.medusaExchanges.get(attempt.exchangeId);
      assert.equal(sent.request_id, `check-watch:wake:${watch.watchId}`);
      assert.match(sent.hub_id, /^api-hub-\d+$/);

      // A neighbour in the same group reads the same thing; the dashboard marking it handled is not the session.
      assert.equal((await delivery(watch, bNeighbour)).wake.state, 'arrived');
      exchanges.recordAcknowledged([sent.hub_id], attempt.to, { kind: 'operator-ui' });
      assert.equal(store.medusaExchanges.get(attempt.exchangeId).terminal_code, 'acknowledged-in-dashboard');
      assert.equal((await delivery(watch)).wake.state, 'arrived');

      const inbox = await sendAs(server, 'GET', `${MESSAGES}/messages`, undefined, bOwner.headers);
      assert.equal(inbox.status, 200, JSON.stringify(inbox.data));
      const mine = inbox.data.messages.find((m) => m.id === sent.hub_id);
      assert.equal(mine.message.split('\n').at(-1), `ref: check-watch:wake:${watch.watchId}`);
      assert.equal((await delivery(watch)).wake.state, 'read');

      const acked = await sendAs(server, 'POST', `${MESSAGES}/read`, { ids: [sent.hub_id] }, bOwner.headers);
      assert.equal(acked.status, 200, JSON.stringify(acked.data));
      assert.equal((await delivery(watch)).wake.state, 'acknowledged');

      const shown = await sendAs(server, 'GET', `${ROOT}/${watch.watchId}`, undefined, bOwner.headers);
      const woke = shown.data.facts.find((f) => f.kind === 'woke');
      assert.deepEqual({ code: woke.code, exchangeId: woke.exchangeId }, { code: 'accepted', exchangeId: attempt.exchangeId });
      const listed = await sendAs(server, 'GET', ROOT, undefined, bOwner.headers);
      assert.equal(listed.data.watches.find((w) => w.watchId === watch.watchId).delivery.wake.state, 'acknowledged');
    });

    it('says undeliverable, with why, for a project with nobody to tell', async () => {
      const watch = await registered({}, bNeighbour);
      resolve(watch);
      await pass();
      const wake = (await delivery(watch, bNeighbour)).wake;
      assert.equal(wake.state, 'undeliverable');
      assert.equal(wake.undeliverable.code, 'no-switchboard-session');
      assert.deepEqual(wake.attempts, []);
    });

    it('says refused for a send the Hub declined', async () => {
      const watch = await registered();
      resolve(watch, 'failure');
      hubDoes = 'refuse';
      assert.equal((await pass()).sent, 1);
      const wake = (await delivery(watch)).wake;
      assert.equal(wake.state, 'refused');
      assert.deepEqual(wake.attempts.map((a) => a.state), ['refused']);
      assert.equal(wake.secondAttempt, false);
      hubDoes = 'deliver';
      assert.equal((await pass(10 * 60000)).secondAttempts, 0);
      assert.equal((await delivery(watch)).wake.state, 'refused');
    });

    it('says unconfirmed while no attempt is proven, shows the second attempt, and reads as far as either got', async () => {
      const watch = await registered();
      resolve(watch);
      hubDoes = 'lost';
      assert.equal((await pass()).sent, 1);
      let wake = (await delivery(watch)).wake;
      assert.deepEqual([wake.state, wake.secondAttempt, wake.attempts.map((a) => a.state)], ['unconfirmed', false, ['unconfirmed']]);

      assert.equal((await pass(monitor.SECOND_ATTEMPT_AFTER_MS + 1000)).secondAttempts, 1);
      wake = (await delivery(watch)).wake;
      assert.deepEqual([wake.state, wake.secondAttempt, wake.attempts.map((a) => a.state)], ['unconfirmed', true, ['unconfirmed', 'unconfirmed']]);
      assert.deepEqual(wake.attempts.map((a) => a.attempt), [1, 2]);

      // A second attempt the Hub takes is what the message reads as; the first stays unproven.
      const other = await registered();
      resolve(other);
      assert.equal((await pass()).sent, 1);
      hubDoes = 'deliver';
      assert.equal((await pass(monitor.SECOND_ATTEMPT_AFTER_MS + 1000)).secondAttempts, 1);
      wake = (await delivery(other)).wake;
      assert.deepEqual([wake.state, wake.secondAttempt, wake.attempts.map((a) => a.state)], ['arrived', true, ['unconfirmed', 'arrived']]);
    });

    it('reads the alarm the same way, apart from the wake', async () => {
      const watch = await registered({ dueInMinutes: 1 });
      const later = Date.now() + 2 * 60000;
      clock = later;
      watchStore._internal.now = () => new Date(later).toISOString();
      try {
        assert.equal((await delivery(watch)).alarm.state, 'owed');
        assert.equal((await monitor.tick(later)).sent, 1);
        const both = await delivery(watch);
        assert.equal(both.alarm.state, 'arrived');
        assert.equal(both.wake.state, 'not-owed');
        assert.equal(store.medusaExchanges.get(both.alarm.attempts[0].exchangeId).request_id, `check-watch:alarm:${watch.watchId}`);
      } finally {
        watchStore._internal.now = realStoreNow;
      }
    });

    it('a cancelled watch owes nothing', async () => {
      const watch = await registered();
      resolve(watch);
      const cancelled = await sendAs(server, 'POST', `${ROOT}/${watch.watchId}/cancel`, {}, bOwner.headers);
      assert.equal(cancelled.status, 200);
      assert.equal(cancelled.data.watch.delivery.wake.state, 'not-owed');
    });
  });

  describe('what the page says', () => {
    it('names the limits the code holds', () => {
      const page = fs.readFileSync(path.join(__dirname, '..', 'docs', 'check-watch.md'), 'utf8');
      assert.ok(page.includes(`at most ${state.MAX_OPEN_PER_PROJECT} open watches`));
      assert.ok(page.includes(`(${api.MAX_DUE_MINUTES} minutes)`) && page.includes(`over ${api.MAX_DUE_MINUTES}`));
      assert.ok(page.includes(`at most ${state.MAX_CHECK_NAME} characters`));
      assert.ok(page.includes(`the newest ${api.LIST_LIMIT} `));
      for (const code of [...Object.values(state.REFUSALS).filter((c) => /MALFORMED|NOT_FOUND|DUPLICATE|LIMIT|DUE_OUT|NOT_OWNER|_CANCELLED/.test(c)), ...Object.values(api.API_REFUSALS)]) {
        assert.ok(page.includes(`\`${code}\``), `${code} is not on the page`);
      }
    });
  });

  describe('what a refusal says', () => {
    it('a failure inside a handler is a 503 that claims nothing', async () => {
      const watch = await registered();
      const keep = watchStore.getWatch;
      watchStore.getWatch = () => { throw new Error('the database is gone'); };
      try {
        for (const [method, urlPath] of [['GET', `${ROOT}/${watch.watchId}`], ['POST', `${ROOT}/${watch.watchId}/cancel`]]) {
          const res = await sendAs(server, method, urlPath, method === 'POST' ? {} : undefined, bOwner.headers);
          assert.equal(res.status, 503);
          assert.equal(res.data.code, 'CHECK_WATCH_UNAVAILABLE');
          assert.ok(!/database is gone/.test(JSON.stringify(res.data)), 'the internal error is not handed out');
        }
      } finally {
        watchStore.getWatch = keep;
      }
      assert.equal(watchStore.getWatch(watch.watchId).cancelled, null);
    });

    it('every refusal answered in this file carries a code and a sentence', () => {
      const refusals = REFUSED.filter((r) => r.request.includes(ROOT));
      assert.ok(refusals.length > 40, `only ${refusals.length} refusals were seen`);
      for (const r of refusals) {
        assert.equal(typeof r.body.code, 'string', `${r.request} ${r.status}`);
        assert.ok(typeof r.body.error === 'string' && r.body.error.length > 20, `${r.request} [${r.body.code}] says "${r.body.error}"`);
        assert.ok(!/undefined|\[object/.test(r.body.error), `${r.request} [${r.body.code}] says "${r.body.error}"`);
      }
      const codes = new Set(refusals.map((r) => r.body.code));
      for (const code of [
        'CALLER_NOT_VERIFIED', 'CHECK_WATCH_LAUNCH_ONLY', 'CHECK_WATCH_MALFORMED', 'CHECK_WATCH_DUE_OUT_OF_RANGE', 'CHECK_WATCH_DUPLICATE',
        'CHECK_WATCH_LIMIT', 'CHECK_WATCH_REPO_UNKNOWN', 'CHECK_WATCH_REPO_UNREADABLE', 'CHECK_WATCH_NOT_FOUND', 'CHECK_WATCH_PROJECT_NOT_FOUND',
        'CHECK_WATCH_NOT_OWNER', 'CHECK_WATCH_CANCELLED', 'CHECK_WATCH_UNAVAILABLE'
      ]) assert.ok(codes.has(code), `${code} was never answered in this file`);
    });
  });
});
