'use strict';

/*
 * Stranded wraps from local records (#868) and their per-item acknowledgement
 * (#1538).
 *
 * A stranded wrap is a wrap branch that reached the remote with no pull request
 * behind it. The commit step records it; these cases pin what the reader makes
 * of those records: which items exist, which are grandfathered (recorded before
 * the full record existed), which are acknowledged at the head they are at now,
 * and what a session is told about them at start. Every case runs on a temp
 * store — never the live one.
 */

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const stranded = require('../lib/stranded-wraps');

const REMOTE = 'https://github.com/example/sandbox.git';
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

describe('stranded wraps — local records (#868, #1538)', () => {
  let storeDir;
  let prevBase;
  let project;
  let seq = 0;

  before(() => {
    prevBase = store._getBasePath();
    storeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-stranded-wraps-'));
    store.close();
    store._setBasePath(storeDir);
    store.init();
  });

  after(() => {
    store.close();
    store._setBasePath(prevBase);
    fs.rmSync(storeDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    // A project per case: activity rows are project-scoped, so one case never
    // sees another's records.
    seq += 1;
    const dir = fs.mkdtempSync(path.join(storeDir, 'proj-'));
    project = store.projects.create({ name: `stranded-${seq}`, path: dir, engine: 'claude' });
  });

  /**
   * Write a legacy `wrap.auto_pr` row, the only record a stranded wrap had
   * before the full record existed.
   * @param {string} branch
   * @param {boolean} isStranded
   */
  function legacyAutoPr(branch, isStranded) {
    store.activity.log({
      projectId: project.id,
      eventType: 'wrap.auto_pr',
      detail: {
        branch, pushed: true, prUrl: isStranded ? null : 'https://github.com/example/sandbox/pull/1',
        autoMergeArmed: !isStranded, stranded: isStranded, skippedReason: null, error: null
      }
    });
  }

  describe('record()', () => {
    it('writes a wrap.stranded row carrying the remote, branch and head SHA', () => {
      stranded.record({ projectId: project.id, sessionId: null, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
      const rows = store.activity.query({ projectId: project.id, eventType: 'wrap.stranded' });
      assert.equal(rows.length, 1);
      assert.deepEqual(rows[0].detail, { remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
    });

    it('strips credentials from the remote before it is stored, because the record is served over the API', () => {
      stranded.record({
        projectId: project.id, remote: 'https://x-access-token:ghp_secret@github.com/example/sandbox.git',
        branch: 'wrap/1-x', headSha: SHA_A
      });
      const [row] = store.activity.query({ projectId: project.id, eventType: 'wrap.stranded' });
      assert.equal(row.detail.remote, REMOTE);
      assert.doesNotMatch(JSON.stringify(row.detail), /ghp_secret|x-access-token/);
    });
  });

  describe('list()', () => {
    it('lists a recorded stranded wrap with the full item shape', () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
      const { items } = stranded.list(project);
      assert.equal(items.length, 1);
      const item = items[0];
      assert.equal(item.scope, 'repo');
      assert.equal(item.remote, REMOTE);
      assert.equal(item.branch, 'wrap/1-x');
      assert.equal(item.headSha, SHA_A);
      assert.equal(item.grandfathered, false);
      assert.equal(item.acknowledged, false);
      assert.equal(item.acknowledgedBy, null);
      assert.equal(item.acknowledgedAt, null);
      assert.equal(item.sessionId, null);
      assert.match(item.recordedAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    });

    it('lists an older stranded record with no full record as grandfathered, with no remote or SHA', () => {
      legacyAutoPr('wrap/0-old', true);
      const { items } = stranded.list(project);
      assert.equal(items.length, 1);
      assert.equal(items[0].branch, 'wrap/0-old');
      assert.equal(items[0].grandfathered, true);
      assert.equal(items[0].remote, null);
      assert.equal(items[0].headSha, null);
    });

    it('does not list an older record twice when the full record for the same branch exists', () => {
      legacyAutoPr('wrap/1-x', true);
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
      const { items } = stranded.list(project);
      assert.equal(items.length, 1);
      assert.equal(items[0].grandfathered, false);
    });

    it('ignores wrap records that were not stranded', () => {
      legacyAutoPr('wrap/2-fine', false);
      assert.deepEqual(stranded.list(project).items, []);
    });

    it('keeps only the newest head for a branch that was stranded again at a new SHA', () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_B });
      const { items } = stranded.list(project);
      assert.equal(items.length, 1);
      assert.equal(items[0].headSha, SHA_B);
    });

    it('lists the newest item first', () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-first', headSha: SHA_A });
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/2-second', headSha: SHA_B });
      assert.deepEqual(stranded.list(project).items.map((i) => i.branch), ['wrap/2-second', 'wrap/1-first']);
    });

    it("does not show another project's stranded wraps", () => {
      const otherDir = fs.mkdtempSync(path.join(storeDir, 'other-'));
      const other = store.projects.create({ name: `other-${seq}`, path: otherDir, engine: 'claude' });
      stranded.record({ projectId: other.id, remote: REMOTE, branch: 'wrap/9-other', headSha: SHA_A });
      assert.deepEqual(stranded.list(project).items, []);
    });

    it('reads past the per-type retention cap, so no retained record is left unread', () => {
      assert.ok(stranded._internal.QUERY_LIMIT > store.ACTIVITY_LOG_RETENTION,
        'a query capped below retention would silently drop the oldest stranded wraps');
    });
  });

  describe('acknowledge()', () => {
    it('records who acknowledged the item and when, and the item then reads as acknowledged', () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
      const result = stranded.acknowledge(project, { branch: 'wrap/1-x', headSha: SHA_A }, 'operator');
      assert.equal(result.ok, true);
      assert.equal(result.item.acknowledged, true);
      assert.equal(result.item.acknowledgedBy, 'operator');
      assert.match(result.item.acknowledgedAt, /^\d{4}-\d{2}-\d{2}T/);

      const [ack] = store.activity.query({ projectId: project.id, eventType: 'wrap.strand_ack' });
      assert.deepEqual(Object.keys(ack.detail).sort(), ['at', 'branch', 'by', 'headSha', 'remote']);
      assert.equal(ack.detail.remote, REMOTE);
      assert.equal(ack.detail.by, 'operator');

      const [item] = stranded.list(project).items;
      assert.equal(item.acknowledged, true);
      assert.equal(item.acknowledgedBy, 'operator');
    });

    it('records an unknown acknowledger as null rather than inventing one', () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
      const result = stranded.acknowledge(project, { branch: 'wrap/1-x', headSha: SHA_A }, null);
      assert.equal(result.ok, true);
      assert.equal(result.item.acknowledgedBy, null);
      const [ack] = store.activity.query({ projectId: project.id, eventType: 'wrap.strand_ack' });
      assert.equal(ack.detail.by, null);
    });

    it('brings the item back unacknowledged when the branch is stranded again at a new head', () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
      stranded.acknowledge(project, { branch: 'wrap/1-x', headSha: SHA_A }, 'operator');
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_B });
      const [item] = stranded.list(project).items;
      assert.equal(item.headSha, SHA_B);
      assert.equal(item.acknowledged, false,
        'an acknowledgement covers the head it was given at, not the branch forever');
    });

    it('refuses an acknowledgement for an item that is not in the list', () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
      const result = stranded.acknowledge(project, { branch: 'wrap/1-x', headSha: SHA_B }, 'operator');
      assert.equal(result.ok, false);
      assert.equal(result.code, 'NOT_FOUND');
      assert.deepEqual(store.activity.query({ projectId: project.id, eventType: 'wrap.strand_ack' }), []);
    });

    it('refuses an acknowledgement for a superseded head, since that is not what the branch is at now', () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_B });
      const result = stranded.acknowledge(project, { branch: 'wrap/1-x', headSha: SHA_A }, 'operator');
      assert.equal(result.code, 'NOT_FOUND');
    });

    it('acknowledges a grandfathered item by branch with a null head SHA', () => {
      legacyAutoPr('wrap/0-old', true);
      const result = stranded.acknowledge(project, { branch: 'wrap/0-old', headSha: null }, 'operator');
      assert.equal(result.ok, true);
      const [item] = stranded.list(project).items;
      assert.equal(item.acknowledged, true);
    });

    it('does not let a null head SHA acknowledge a fully recorded item', () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
      const result = stranded.acknowledge(project, { branch: 'wrap/1-x', headSha: null }, 'operator');
      assert.equal(result.code, 'NOT_FOUND');
    });

    it('records nothing new when the item is already acknowledged at that head', () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
      const first = stranded.acknowledge(project, { branch: 'wrap/1-x', headSha: SHA_A }, 'operator');
      const again = stranded.acknowledge(project, { branch: 'wrap/1-x', headSha: SHA_A }, 'someone-else');
      assert.equal(first.created, true);
      assert.equal(again.ok, true);
      assert.equal(again.created, false);
      assert.equal(again.item.acknowledgedBy, 'operator', 'the original acknowledgement stands');
      assert.equal(store.activity.query({ projectId: project.id, eventType: 'wrap.strand_ack' }).length, 1);
    });

    it('reports a failed save as a failure, not as an acknowledgement', () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
      const real = stranded._internal.log;
      stranded._internal.log = () => {};
      let result;
      try {
        result = stranded.acknowledge(project, { branch: 'wrap/1-x', headSha: SHA_A }, 'operator');
      } finally {
        stranded._internal.log = real;
      }
      assert.equal(result.ok, false);
      assert.equal(result.code, 'WRITE_FAILED');
      assert.equal(stranded.list(project).items[0].acknowledged, false);
    });

    it('rejects a short SHA, because only the full SHA identifies the head', () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
      const result = stranded.acknowledge(project, { branch: 'wrap/1-x', headSha: SHA_A.slice(0, 7) }, 'operator');
      assert.equal(result.code, 'NOT_FOUND');
    });

    it('rejects a request with no branch', () => {
      const result = stranded.acknowledge(project, { headSha: SHA_A }, 'operator');
      assert.equal(result.ok, false);
      assert.equal(result.code, 'BAD_REQUEST');
    });

    it('rejects a head SHA that is neither a string nor null', () => {
      const result = stranded.acknowledge(project, { branch: 'wrap/1-x', headSha: 42 }, 'operator');
      assert.equal(result.code, 'BAD_REQUEST');
    });

    it('rejects a missing head SHA, so a grandfathered acknowledgement is always said on purpose', () => {
      const result = stranded.acknowledge(project, { branch: 'wrap/1-x' }, 'operator');
      assert.equal(result.code, 'BAD_REQUEST');
    });
  });

  describe('isBlocking()', () => {
    const base = { grandfathered: false, acknowledged: false };
    it('blocks an unacknowledged, fully recorded item', () => {
      assert.equal(stranded.isBlocking(base), true);
    });
    it('never blocks a grandfathered item, acknowledged or not', () => {
      assert.equal(stranded.isBlocking({ ...base, grandfathered: true }), false);
    });
    it('does not block an acknowledged item', () => {
      assert.equal(stranded.isBlocking({ ...base, acknowledged: true }), false);
    });
    it('does not block nothing', () => {
      assert.equal(stranded.isBlocking(null), false);
    });
  });

  describe('primeLines()', () => {
    const itemAt = (n, extra = {}) => ({
      scope: 'repo', remote: REMOTE, branch: `wrap/${n}-x`, headSha: SHA_A,
      recordedAt: '2026-09-10T12:00:00Z', sessionId: null, grandfathered: false,
      acknowledged: false, acknowledgedBy: null, acknowledgedAt: null, ...extra
    });

    it('says in one line that none are recorded', () => {
      const lines = stranded.primeLines({ project: 'demo', items: [] });
      assert.deepEqual(lines, ['Stranded wraps: none recorded for this project.', '']);
    });

    it('says a failed read could not be read, never that there are none', () => {
      const text = stranded.primeLines({ project: 'demo', error: 'database is locked' }).join('\n');
      assert.match(text, /could not be read/);
      assert.match(text, /database is locked/);
      assert.doesNotMatch(text, /none recorded/);
    });

    it('names each unacknowledged item with its branch, full SHA and date, and points at the full list', () => {
      const text = stranded.primeLines({ project: 'demo', items: [itemAt(1)] }).join('\n');
      assert.match(text, /^## Stranded wraps/m);
      assert.ok(text.includes(`\`wrap/1-x\` at \`${SHA_A}\`, recorded 2026-09-10`),
        'the full SHA is shown, because an acknowledgement needs the full SHA');
      assert.match(text, /GET \/api\/projects\/demo\/stranded-wraps/);
      assert.match(text, /operator/, 'acknowledging is the operator\'s call, and the section says so');
      assert.match(text, /1 wrap branch was pushed .* Its version bump/);
      assert.match(text, /Tell the operator about it before/);
    });

    it('marks a grandfathered item as an older record with no head SHA', () => {
      const text = stranded.primeLines({
        project: 'demo', items: [itemAt(1, { grandfathered: true, headSha: null, remote: null })]
      }).join('\n');
      assert.match(text, /`wrap\/1-x`, recorded 2026-09-10 \(older record/);
    });

    it('counts acknowledged items without listing them', () => {
      const text = stranded.primeLines({
        project: 'demo', items: [itemAt(1, { acknowledged: true, acknowledgedBy: 'op' })]
      }).join('\n');
      assert.match(text, /none unacknowledged/);
      assert.match(text, /1 acknowledged/);
      assert.doesNotMatch(text, /wrap\/1-x/);
    });

    it('stays within its budget with fifty items', () => {
      const items = Array.from({ length: 50 }, (_, i) => itemAt(i + 1));
      const lines = stranded.primeLines({ project: 'demo', items });
      const text = lines.join('\n');
      assert.ok(text.length <= stranded._internal.PRIME_BUDGET_CHARS,
        `section is ${text.length} chars, budget ${stranded._internal.PRIME_BUDGET_CHARS}`);
      assert.equal((text.match(/^- `wrap\//gm) || []).length, stranded._internal.PRIME_MAX_ITEMS);
      assert.match(text, /and 45 more/);
      assert.match(text, /50 wrap branches were pushed .* Their version bump/);
    });

    it('encodes the project name in the API path', () => {
      const text = stranded.primeLines({ project: 'my project', items: [itemAt(1)] }).join('\n');
      assert.match(text, /\/api\/projects\/my%20project\/stranded-wraps/);
    });

    it('names no engine, engine config file or UI element, so every engine reads the same text', () => {
      const text = [
        stranded.primeLines({ project: 'demo', items: [] }),
        stranded.primeLines({ project: 'demo', error: 'x' }),
        stranded.primeLines({ project: 'demo', items: [itemAt(1), itemAt(2, { grandfathered: true, headSha: null })] })
      ].flat().join('\n');
      assert.doesNotMatch(text, /claude|codex|gemini|aider|CLAUDE\.md|AGENTS\.md|GEMINI\.md|\.claude\/|button|click|drawer|dashboard/i);
    });
  });

  describe('primeSection()', () => {
    it('renders the section for a project from its records', () => {
      stranded.record({ projectId: project.id, remote: REMOTE, branch: 'wrap/1-x', headSha: SHA_A });
      const text = stranded.primeSection(project).join('\n');
      assert.match(text, /`wrap\/1-x`/);
    });

    it('renders a read failure as could-not-be-read', () => {
      const real = stranded._internal.query;
      stranded._internal.query = () => { throw new Error('disk I/O error'); };
      try {
        const text = stranded.primeSection(project).join('\n');
        assert.match(text, /could not be read/);
        assert.match(text, /disk I\/O error/);
      } finally {
        stranded._internal.query = real;
      }
    });

    it('renders nothing for a project with no id', () => {
      assert.deepEqual(stranded.primeSection({ name: 'x' }), []);
      assert.deepEqual(stranded.primeSection(null), []);
    });
  });
});
