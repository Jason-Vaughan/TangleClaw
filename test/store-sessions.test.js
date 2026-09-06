'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');

describe('store.sessions (write methods)', () => {
  let tmpDir;
  let projectId;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-store-sessions-'));
    store._setBasePath(tmpDir);
    store.init();

    // Create a project to attach sessions to
    const project = store.projects.create({
      name: 'sess-test',
      path: '/tmp/sess-test'
    });
    projectId = project.id;
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('start', () => {
    it('creates a session with status active', () => {
      const session = store.sessions.start({
        projectId,
        engineId: 'claude',
        tmuxSession: 'sess-test',
        primePrompt: '# Hello'
      });

      assert.ok(session.id);
      assert.equal(session.projectId, projectId);
      assert.equal(session.engineId, 'claude');
      assert.equal(session.tmuxSession, 'sess-test');
      assert.equal(session.status, 'active');
      assert.equal(session.primePrompt, '# Hello');
      assert.ok(session.startedAt);
      assert.equal(session.endedAt, null);
    });

    it('rejects missing projectId', () => {
      assert.throws(() => {
        store.sessions.start({ engineId: 'claude' });
      }, /projectId and engineId are required/);
    });

    it('rejects missing engineId', () => {
      assert.throws(() => {
        store.sessions.start({ projectId });
      }, /projectId and engineId are required/);
    });

    it('logs session.started activity', () => {
      const session = store.sessions.start({
        projectId,
        engineId: 'codex',
        tmuxSession: 'sess-test-2'
      });

      const activity = store.activity.query({ sessionId: session.id, eventType: 'session.started' });
      assert.ok(activity.length >= 1);
      assert.equal(activity[0].detail.engine, 'codex');
    });
  });

  describe('wrap', () => {
    it('sets status to wrapped with summary', () => {
      const session = store.sessions.start({
        projectId,
        engineId: 'claude',
        tmuxSession: 'wrap-test'
      });

      const wrapped = store.sessions.wrap(session.id, 'Completed chunk 5');
      assert.equal(wrapped.status, 'wrapped');
      assert.equal(wrapped.wrapSummary, 'Completed chunk 5');
      assert.ok(wrapped.endedAt);
      assert.ok(wrapped.durationSeconds >= 0);
    });

    it('logs session.wrapped activity', () => {
      const session = store.sessions.start({
        projectId,
        engineId: 'claude',
        tmuxSession: 'wrap-log-test'
      });

      store.sessions.wrap(session.id, 'Done');

      const activity = store.activity.query({ sessionId: session.id, eventType: 'session.wrapped' });
      assert.ok(activity.length >= 1);
      assert.equal(activity[0].detail.summaryLength, 4);
    });

    it('handles null summary', () => {
      const session = store.sessions.start({
        projectId,
        engineId: 'claude',
        tmuxSession: 'wrap-null-test'
      });

      const wrapped = store.sessions.wrap(session.id);
      assert.equal(wrapped.status, 'wrapped');
      assert.equal(wrapped.wrapSummary, null);
    });
  });

  describe('kill', () => {
    it('sets status to killed', () => {
      const session = store.sessions.start({
        projectId,
        engineId: 'claude',
        tmuxSession: 'kill-test'
      });

      const killed = store.sessions.kill(session.id, 'User requested');
      assert.equal(killed.status, 'killed');
      assert.ok(killed.endedAt);
      assert.ok(killed.durationSeconds >= 0);
    });

    it('logs session.killed activity', () => {
      const session = store.sessions.start({
        projectId,
        engineId: 'claude',
        tmuxSession: 'kill-log-test'
      });

      store.sessions.kill(session.id, 'Manual');

      const activity = store.activity.query({ sessionId: session.id, eventType: 'session.killed' });
      assert.ok(activity.length >= 1);
      assert.equal(activity[0].detail.reason, 'Manual');
    });
  });

  describe('markCrashed', () => {
    it('sets status to crashed', () => {
      const session = store.sessions.start({
        projectId,
        engineId: 'claude',
        tmuxSession: 'crash-test'
      });

      const crashed = store.sessions.markCrashed(session.id, 'Segfault');
      assert.equal(crashed.status, 'crashed');
      assert.ok(crashed.endedAt);
    });

    it('logs session.crashed activity', () => {
      const session = store.sessions.start({
        projectId,
        engineId: 'claude',
        tmuxSession: 'crash-log-test'
      });

      store.sessions.markCrashed(session.id, 'OOM');

      const activity = store.activity.query({ sessionId: session.id, eventType: 'session.crashed' });
      assert.ok(activity.length >= 1);
      assert.equal(activity[0].detail.error, 'OOM');
    });
  });

  describe('the status vocabulary', () => {
    it('models exactly the statuses a session can hold', () => {
      assert.deepEqual([...store.SESSION_STATUSES].sort(),
        ['active', 'crashed', 'killed', 'wrapped']);
    });

    it('gives every status a transition entry, and admits no status outside the enum', () => {
      // Exhaustive in BOTH directions on purpose. One direction alone lets a
      // status exist with no modelled transitions, or a transition be modelled
      // for a status the product does not have — and the second is worse,
      // because a map that admits an unreachable state licenses code to handle
      // it. Adding `wrapping` back to either side reds this.
      const modelled = Object.keys(store.SESSION_STATUS_TRANSITIONS).sort();
      assert.deepEqual(modelled, [...store.SESSION_STATUSES].sort());
      for (const [from, targets] of Object.entries(store.SESSION_STATUS_TRANSITIONS)) {
        for (const to of targets) {
          assert.ok(store.SESSION_STATUSES.includes(to),
            `${from} -> ${to} names a status that is not in the enum`);
        }
      }
    });

    it('leaves active as the only status anything follows', () => {
      const nonTerminal = Object.entries(store.SESSION_STATUS_TRANSITIONS)
        .filter(([, targets]) => targets.length > 0)
        .map(([from]) => from);
      assert.deepEqual(nonTerminal, ['active']);
    });

    it('rejects a transition that is not in the map', () => {
      assert.equal(store.canTransition('active', 'wrapped'), true);
      assert.equal(store.canTransition('active', 'killed'), true);
      assert.equal(store.canTransition('active', 'crashed'), true);
      // Terminal means terminal — no resurrection, and no ending twice.
      assert.equal(store.canTransition('wrapped', 'killed'), false);
      assert.equal(store.canTransition('killed', 'active'), false);
      assert.equal(store.canTransition('crashed', 'wrapped'), false);
      // A status the vocabulary does not contain is not a transition anyone
      // can make, in either direction.
      assert.equal(store.canTransition('active', 'wrapping'), false);
      assert.equal(store.canTransition('wrapping', 'wrapped'), false);
    });
  });

  describe('transition enforcement', () => {
    it('refuses to re-end a session that has already ended', () => {
      const session = store.sessions.start({
        projectId, engineId: 'claude', tmuxSession: 'terminal-guard-test'
      });
      const killed = store.sessions.kill(session.id, 'first');
      assert.equal(killed.status, 'killed');

      // `null` is the whole point: a caller cannot tell a refused `wrap` from a
      // successful one by reading `.status` back — both say `wrapped` — so the
      // outcome has to travel in the return value.
      assert.equal(store.sessions.kill(session.id, 'second'), null);
      assert.equal(store.sessions.wrap(session.id, 'should not land'), null);
      assert.equal(store.sessions.markCrashed(session.id, 'should not land'), null);

      const after = store.sessions.get(session.id);
      assert.equal(after.status, 'killed');
      assert.equal(after.endedAt, killed.endedAt, 'ended_at must not be rewritten');
      assert.equal(after.wrapSummary, null);
    });

    it('refuses a target no modelled status can reach', () => {
      // The transition map is data, and a future edit can leave a status with no
      // inbound transition. The precondition is then over an empty source list,
      // and this pins that such a call refuses like any other disallowed
      // transition — writing nothing and throwing nothing. Reached through the
      // internal helper because no public writer targets an unreachable status
      // today.
      const session = store.sessions.start({
        projectId, engineId: 'claude', tmuxSession: 'unreachable-target-test'
      });
      const result = store._transitionSession(session.id, 'not-a-status', "ended_at = datetime('now')", []);
      assert.equal(result.changed, false);
      assert.equal(result.session.status, 'active', 'the row is untouched');
      assert.equal(store.sessions.get(session.id).status, 'active');
      store.sessions.kill(session.id, 'test cleanup');
    });

    it('writes no activity row for a refused transition', () => {
      const session = store.sessions.start({
        projectId, engineId: 'claude', tmuxSession: 'terminal-activity-test'
      });
      store.sessions.wrap(session.id, 'done');
      store.sessions.wrap(session.id, 'again');
      store.sessions.kill(session.id, 'and again');

      // The refusal is the point: a duplicate `session.wrapped` here would
      // corrupt the only durable record of what the lifecycle actually did.
      const wrapped = store.activity.query({ sessionId: session.id, eventType: 'session.wrapped' });
      assert.equal(wrapped.length, 1);
      const killedRows = store.activity.query({ sessionId: session.id, eventType: 'session.killed' });
      assert.equal(killedRows.length, 0);
    });
  });

  describe('getActive', () => {
    it('resolves the newest row when two share a started_at second', () => {
      // `started_at` is second-resolution. This lookup is what a wrap and a
      // kill resolve their target through, so a tie must not be settled by
      // whatever order SQLite happens to scan in — it settled on the OLDER row.
      // Earlier tests in this file leave active rows behind; clear them so the
      // pair below is unambiguously what `getActive` is choosing between.
      for (let a = store.sessions.getActive(projectId); a; a = store.sessions.getActive(projectId)) {
        store.sessions.kill(a.id, 'test setup');
      }
      const older = store.sessions.start({
        projectId, engineId: 'claude', tmuxSession: 'tie-older'
      });
      const newer = store.sessions.start({
        projectId, engineId: 'claude', tmuxSession: 'tie-newer'
      });
      // Force the tie rather than hoping the two inserts land in the same
      // second. Without this the assertions below pass on any run that straddles
      // a second boundary — including with the `id DESC` tiebreak removed, which
      // makes the guard for this chunk's own defect unfalsifiable most of the time.
      store.getDb().prepare(
        'UPDATE sessions SET started_at = (SELECT MAX(started_at) FROM sessions) WHERE id IN (?, ?)'
      ).run(older.id, newer.id);
      assert.equal(store.sessions.get(older.id).startedAt, store.sessions.get(newer.id).startedAt,
        'the precondition this guard needs: the two rows share a started_at');

      assert.equal(store.sessions.getActive(projectId).id, newer.id);
      assert.equal(store.sessions.getLatest(projectId).id, newer.id);
      // `list` orders the same way and then applies a LIMIT, so the tie decides
      // which of the two a caller with a page size of one actually sees.
      const page = store.sessions.list(projectId, { limit: 1 });
      assert.equal(page[0].id, newer.id);
      store.sessions.kill(newer.id, 'test cleanup');
      store.sessions.kill(older.id, 'test cleanup');
    });

    it('returns null after session is wrapped', () => {
      const session = store.sessions.start({
        projectId,
        engineId: 'claude',
        tmuxSession: 'active-wrap-test'
      });
      store.sessions.wrap(session.id, 'done');

      const active = store.sessions.getActive(projectId);
      // Should be null because we wrapped the last active one
      // (unless other tests left one active)
      if (active) {
        assert.notEqual(active.id, session.id);
      }
    });
  });

  describe('list with status filter', () => {
    it('filters by status', () => {
      const wrapped = store.sessions.list(projectId, { status: 'wrapped' });
      assert.ok(wrapped.length > 0);
      for (const s of wrapped) {
        assert.equal(s.status, 'wrapped');
      }
    });
  });

  describe('count', () => {
    it('counts all sessions for a project', () => {
      const total = store.sessions.count(projectId);
      assert.ok(total > 0);
    });

    it('counts by status', () => {
      const wrappedCount = store.sessions.count(projectId, { status: 'wrapped' });
      const wrapped = store.sessions.list(projectId, { status: 'wrapped', limit: 10000 });
      assert.equal(wrappedCount, wrapped.length);
    });

    it('returns 0 for unknown project', () => {
      const count = store.sessions.count(99999);
      assert.equal(count, 0);
    });
  });
});
