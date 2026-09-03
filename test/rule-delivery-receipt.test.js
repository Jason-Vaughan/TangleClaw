'use strict';

/*
 * #1063 — the startup-rules ledger recorded `delivered` the moment the shards
 * hit disk. That is a fact about the filesystem wearing the name of a fact
 * about the engine, and #759 is what it cost: every Claude SessionStart hook
 * failed, sessions across two projects booted with no prime and no rules, and
 * the ledger stayed clean for as long as the outage lasted.
 *
 * The write-time outcome is now `written`; only a receipt posted by the hook
 * that actually ran upgrades it to `delivered`. The done-when the plan states:
 * a launch whose hook never runs cannot produce a `delivered` row.
 */

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const execFileAsync = promisify(execFile);
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const rulesChannel = require('../lib/session-rules-channel');

const HOOK = path.join(__dirname, '..', 'data', 'hooks', 'sessionstart-rules-claude.sh');

let tmpBase;
before(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-1063-'));
  store._setBasePath(tmpBase);
  store.init();
});
after(() => {
  store.close();
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

/** @returns {object} a fresh rules-hook row in the `written` state */
function writtenRow(sessionId) {
  return store.sessionRuleDeliveries.record({
    sessionId, projectId: 1, engineId: 'claude',
    channel: 'rules-hook', outcome: 'written', ruleIds: [1, 2], digest: 'd'.repeat(64)
  });
}

describe('#1063 — the ledger distinguishes written from delivered', () => {
  it('`written` is a storable outcome and is NOT derived as delivered', () => {
    const row = writtenRow(9001);
    assert.equal(row.outcome, 'written');
    assert.equal(row.delivered, false,
      'the derived flag is what most consumers read — it must not call a write a delivery');
  });

  it('`written` cannot be claimed through no channel', () => {
    // Same reasoning as delivered/unverified: a state that cannot be true must
    // not be storable, or the ledger stops being evidence.
    assert.throws(() => store.sessionRuleDeliveries.record({
      sessionId: 9002, projectId: 1, engineId: 'claude',
      channel: 'none', outcome: 'written', ruleIds: [1], digest: 'x'
    }), /channel 'none' cannot be written/);
  });

  it('the outcome vocabulary and the DB CHECK agree', () => {
    // The enum guard and the CHECK constraint are two independent gates; a
    // value in one and not the other fails at a different layer than the
    // author expects.
    assert.ok(store.SESSION_RULE_DELIVERY_OUTCOMES.includes('written'));
    for (const outcome of store.SESSION_RULE_DELIVERY_OUTCOMES) {
      const entry = {
        sessionId: 9100, projectId: 1, engineId: 'claude',
        channel: outcome === 'no-rules' ? 'none' : 'rules-hook',
        outcome, ruleIds: [], digest: ''
      };
      if (outcome === 'skipped' || outcome === 'unverified') entry.skipReason = 'r';
      assert.doesNotThrow(() => store.sessionRuleDeliveries.record(entry),
        `the DB rejects '${outcome}', which the enum accepts`);
    }
  });
});

describe('#1063 — markDelivered is the only transition, and it is narrow', () => {
  it('upgrades written → delivered', () => {
    const row = writtenRow(9200);
    const up = store.sessionRuleDeliveries.markDelivered(row.id);
    assert.equal(up.outcome, 'delivered');
    assert.equal(up.delivered, true);
    assert.equal(up.id, row.id, 'the same row, not a second one');
  });

  it('is idempotent — a hook that fires twice is not new evidence', () => {
    const row = writtenRow(9201);
    assert.ok(store.sessionRuleDeliveries.markDelivered(row.id));
    assert.equal(store.sessionRuleDeliveries.markDelivered(row.id), null);
  });

  it('NEVER rescues a skipped or unverified row', () => {
    // The security-shaped half: a receipt must not be able to launder a
    // failure into a success, or the ledger's rows stop being trustworthy in
    // exactly the case they matter.
    for (const [outcome, extra] of [['skipped', { skipReason: 'shards failed' }], ['unverified', { skipReason: 'blind paste' }]]) {
      const row = store.sessionRuleDeliveries.record({
        sessionId: 9202, projectId: 1, engineId: 'claude',
        channel: 'rules-hook', outcome, ruleIds: [1], digest: 'x', ...extra
      });
      assert.equal(store.sessionRuleDeliveries.markDelivered(row.id), null, outcome);
      assert.equal(store.sessionRuleDeliveries.listForSession(9202).find((r) => r.id === row.id).outcome,
        outcome, `${outcome} row was mutated`);
    }
  });

  it('answers null for an id that is missing or not a positive integer', () => {
    // The caller is an HTTP route fed an id out of a file on a session's disk,
    // so a wrong id is an ordinary condition, not an exception.
    for (const bad of [999999, 0, -1, null, undefined, 'abc', 1.5, {}]) {
      assert.equal(store.sessionRuleDeliveries.markDelivered(bad), null, String(bad));
    }
  });
});

describe('#1063 — the receipt token', () => {
  let projectPath;
  beforeEach(() => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-1063-proj-'));
  });
  afterEach(() => { fs.rmSync(projectPath, { recursive: true, force: true }); });

  it('names the row and where to post it', () => {
    const written = rulesChannel.writeReceiptToken(projectPath, { deliveryId: 42, api: 'http://localhost:3102' });
    assert.equal(written, rulesChannel.receiptTokenPath(projectPath));
    const token = JSON.parse(fs.readFileSync(written, 'utf8'));
    assert.deepEqual(token, { deliveryId: 42, api: 'http://localhost:3102' });
  });

  it('clearing removes it, and clearing an absent one is not an error', () => {
    assert.equal(rulesChannel.clearReceiptToken(projectPath), false, 'nothing to clear yet');
    rulesChannel.writeReceiptToken(projectPath, { deliveryId: 1, api: 'http://x' });
    assert.equal(rulesChannel.clearReceiptToken(projectPath), true);
    assert.equal(fs.existsSync(rulesChannel.receiptTokenPath(projectPath)), false);
  });

  it('an unwritable location degrades to null rather than throwing', () => {
    // A launch must never fail because an audit token could not be written;
    // the cost of the failure is a row that stays `written`, which is honest.
    const blocked = path.join(projectPath, 'nope');
    fs.writeFileSync(blocked, 'not a directory');
    assert.equal(rulesChannel.writeReceiptToken(blocked, { deliveryId: 1, api: 'http://x' }), null);
  });
});

describe('#1063 — a launch that writes no token clears the previous one', () => {
  // A token outliving the launch that wrote it names ANOTHER session's row, so
  // the next hook to run would upgrade a delivery that this session never
  // received. The launch path clears unconditionally before it decides its
  // outcome, so every non-rules-hook branch is covered by construction — this
  // pins that, because a per-branch clear is what would rot.
  const sessions = require('../lib/sessions');
  const tmux = require('../lib/tmux');
  const enginesModule = require('../lib/engines');

  /**
   * Replace a module method for one test.
   * @param {object} obj - Module.
   * @param {string} name - Method name.
   * @param {Function} fn - Replacement.
   * @returns {Function} Restore.
   */
  function stub(obj, name, fn) {
    const original = obj[name];
    obj[name] = fn;
    return () => { obj[name] = original; };
  }

  it('a project with NO rules leaves no token behind', () => {
    const restores = [
      stub(tmux, 'hasSession', () => false),
      stub(tmux, 'createSession', () => true),
      stub(enginesModule, 'detectEngine', () => ({ available: true, path: '/usr/bin/claude' }))
    ];
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-1063-stale-'));
    const project = store.projects.create({ name: `stale-${Date.now()}`, path: dir });
    try {
      // A token from an imagined previous launch, naming a row that IS
      // upgradeable — so a failure here would be a real false delivery, not a
      // no-op against a row nothing could change.
      const victim = writtenRow(9600);
      rulesChannel.writeReceiptToken(dir, { deliveryId: victim.id, api: 'http://127.0.0.1:1' });

      const result = sessions.launchSession(project.name);
      assert.equal(result.error, null);
      assert.equal(fs.existsSync(rulesChannel.receiptTokenPath(dir)), false,
        'a launch with no rules to deliver must not leave a token pointing at another session\'s row');
      assert.equal(store.sessionRuleDeliveries.listForSession(9600)[0].outcome, 'written',
        'and the victim row is still upgradeable only by its own launch');

      store.sessions.kill(result.session.id, 'test cleanup');
    } finally {
      for (const r of restores) r();
      store.projects.delete(project.id);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('#1063 — the hook posts the receipt, and never fails the session', () => {
  let projectPath;

  beforeEach(() => {
    projectPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-1063-hook-'));
    fs.mkdirSync(path.join(projectPath, '.tangleclaw'), { recursive: true });
    fs.writeFileSync(
      path.join(projectPath, '.tangleclaw', 'session-rules-1.json'),
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'RULE ONE' } }) + '\n'
    );
  });
  afterEach(() => { fs.rmSync(projectPath, { recursive: true, force: true }); });

  /**
   * Run the real hook script against a project dir.
   * @param {string} shard - Shard argument.
   * @param {object} [env] - Extra environment.
   * @returns {{status: number, stdout: string}}
   */
  function runHook(shard, env) {
    const stdout = execFileSync('/bin/bash', [HOOK, shard], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectPath, ...(env || {}) },
      encoding: 'utf8'
    });
    return { stdout };
  }

  it('still emits the shard payload — the receipt must not disturb the delivery', () => {
    const { stdout } = runHook('1');
    assert.match(stdout, /RULE ONE/);
    assert.equal(JSON.parse(stdout).hookSpecificOutput.hookEventName, 'SessionStart');
  });

  it('exits 0 and emits the rules even when the receipt cannot be sent', () => {
    // Every failure mode of the receipt — no token, unreachable server, no
    // curl — has to leave the rules delivered and the hook green. A hook that
    // fails is fed back to the engine as a synthetic turn, so a broken audit
    // path must never become a broken session.
    rulesChannel.writeReceiptToken(projectPath, { deliveryId: 1, api: 'http://127.0.0.1:1' });
    const { stdout } = runHook('1');           // connection refused, fast
    assert.match(stdout, /RULE ONE/);
    // No token at all.
    rulesChannel.clearReceiptToken(projectPath);
    assert.match(runHook('1').stdout, /RULE ONE/);
    // No curl on PATH. The dir carries the tools the hook genuinely needs and
    // ONLY those, so this isolates "curl is missing" — an empty PATH would also
    // take away `cat` and the test would pass for the wrong reason (it did:
    // stdout came back empty, which is a failed delivery, not a skipped receipt).
    const bare = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-1063-nocurl-'));
    try {
      for (const tool of ['cat', 'sed']) {
        fs.symlinkSync(execFileSync('/usr/bin/which', [tool], { encoding: 'utf8' }).trim(), path.join(bare, tool));
      }
      assert.equal(fs.existsSync(path.join(bare, 'curl')), false, 'fixture precondition: no curl on this PATH');
      rulesChannel.writeReceiptToken(projectPath, { deliveryId: 1, api: 'http://127.0.0.1:1' });
      assert.match(runHook('1', { PATH: bare }).stdout, /RULE ONE/);
    } finally {
      fs.rmSync(bare, { recursive: true, force: true });
    }
  });

  it('posts exactly one receipt per launch, from shard 1 only', async () => {
    // Every shard of a launch shares one delivery row, so a post per shard
    // would be N identical upgrades of the same id.
    const http = require('node:http');
    const seen = [];
    const server = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        seen.push({ url: req.url, method: req.method, body: raw });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end('{"upgraded":true}');
      });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const api = `http://127.0.0.1:${server.address().port}`;
    try {
      fs.writeFileSync(
        path.join(projectPath, '.tangleclaw', 'session-rules-2.json'),
        JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: 'RULE TWO' } }) + '\n'
      );
      rulesChannel.writeReceiptToken(projectPath, { deliveryId: 77, api });
      // ASYNC, deliberately: `execFileSync` blocks this process's event loop,
      // so the in-process server above cannot accept the hook's connection and
      // the receipt "fails" for a reason that exists only in the test. That
      // shape passes as a false negative — it looks exactly like a hook that
      // does not post.
      for (const shard of ['1', '2']) {
        await execFileAsync('/bin/bash', [HOOK, shard], {
          env: { ...process.env, CLAUDE_PROJECT_DIR: projectPath }
        });
      }
      assert.equal(seen.length, 1, 'shard 2 must not post a second receipt');
      assert.equal(seen[0].method, 'POST');
      assert.equal(seen[0].url, '/api/tc/rule-receipt');
      assert.equal(JSON.parse(seen[0].body).deliveryId, 77,
        'the hook posts the token verbatim, so the row it vouches for is unambiguous');
    } finally {
      await new Promise((r) => server.close(r));
    }
  });
});

describe('#1063 — a launch whose hook never runs cannot produce a delivered row', () => {
  it('the #759 replay: shards written, hook never fires, ledger stays honest', () => {
    // The acceptance criterion, driven end to end at the ledger level. Before
    // this change the same sequence produced `delivered` and every surface read
    // green while the sessions had no rules at all.
    const row = writtenRow(9300);
    assert.equal(row.outcome, 'written');

    // ... time passes; no receipt ever arrives, because the hook is broken.
    const seen = store.sessionRuleDeliveries.listForSession(9300);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].outcome, 'written');
    assert.equal(seen[0].delivered, false);

    // Every derived surface must agree, or the ledger is honest in a place
    // nobody looks.
    const awareness = store.awarenessReceipts.sessionAwareness(9300);
    assert.equal(awareness.state, 'unverified',
      'a written row standing after launch is not evidence that awareness arrived');
    assert.match(awareness.basis, /hook never confirmed/);
  });

  it('and the fleet health query counts it as undelivered', () => {
    // `projectsWithUndeliveredRules` keys on "latest outcome is not delivered",
    // so `written` lands on the right side by construction — asserted rather
    // than assumed, since that is the query the dashboard's red state reads.
    const project = store.projects.create({
      name: `p1063-${Date.now()}`, path: fs.mkdtempSync(path.join(os.tmpdir(), 'tc-1063-fleet-'))
    });
    try {
      const rule = store.sessionRules.create({ content: 'a rule that must arrive', projectId: project.id });
      store.sessionRuleDeliveries.record({
        sessionId: 9400, projectId: project.id, engineId: 'claude',
        channel: 'rules-hook', outcome: 'written', ruleIds: [rule.id], digest: 'z'.repeat(64)
      });
      const undelivered = store.sessionRuleDeliveries.projectsWithUndeliveredRules();
      assert.ok(undelivered.some((p) => p.projectId === project.id),
        'a project whose only row is `written` has NOT had its rules delivered');
    } finally {
      store.projects.delete(project.id);
    }
  });

  it('a receipt flips every one of those surfaces together', () => {
    const row = writtenRow(9500);
    store.sessionRuleDeliveries.markDelivered(row.id);
    assert.equal(store.sessionRuleDeliveries.listForSession(9500)[0].delivered, true);
    assert.equal(store.awarenessReceipts.sessionAwareness(9500).state, 'sent',
      'delivered-but-no-tc-invocation is `sent`, exactly as it was before this change');
  });
});

describe('#1063 — the deliveries panel classifies every outcome the ledger can store', () => {
  const vm = require('node:vm');

  /** @returns {Function} the extracted outcome→class helper */
  function loadClassifier() {
    const sandbox = { window: {}, document: undefined };
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'public', 'api-helper.js'), 'utf8'), sandbox);
    return sandbox.window.tcDeliveryOutcomeClass;
  }

  it('never renders an unclassified outcome as unstyled text', () => {
    // Driven over the STORE's vocabulary, not a list retyped here, so an
    // outcome added to the ledger without teaching this panel fails at CI. The
    // failure mode it replaces is silent: `written` would have rendered with no
    // class at all, reading like a pass on the one surface an operator checks.
    const classify = loadClassifier();
    for (const outcome of store.SESSION_RULE_DELIVERY_OUTCOMES) {
      const cls = classify(outcome);
      if (outcome === 'no-rules') {
        assert.equal(cls, '', 'nothing was owed — genuinely neutral');
        continue;
      }
      assert.match(cls, /^rules-status-(ok|err|warn)$/, `outcome '${outcome}' has no class`);
    }
  });

  it('classifies the states this issue is about', () => {
    const classify = loadClassifier();
    assert.equal(classify('delivered'), 'rules-status-ok');
    assert.equal(classify('written'), 'rules-status-warn',
      'shards on disk with no receipt must NOT read as a delivery — that is #1063');
    assert.equal(classify('unverified'), 'rules-status-warn');
    assert.equal(classify('skipped'), 'rules-status-err');
  });

  it('an outcome nobody has classified yet defaults to warn, not to blank', () => {
    // The property, not the current membership: a row nobody classified is not
    // evidence of success.
    assert.equal(loadClassifier()('some-future-outcome'), 'rules-status-warn');
  });

  it('the panel reads that one owner rather than its own copy', () => {
    const ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
    assert.match(ui, /const outcomeClass = tcDeliveryOutcomeClass\(d\.outcome\)/,
      'the panel grew a second copy of the map');
    assert.ok(!/d\.outcome === 'delivered' \? 'rules-status-ok'/.test(ui),
      'the inline ternary is back — two maps that can disagree');
  });
});

describe('#1063 — schema v33→v34 on a REAL old DB', () => {
  it('preserves old rows verbatim and accepts written after migration', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-v34-mig-'));
    const prevBase = store._getBasePath();
    try {
      const { DatabaseSync } = require('node:sqlite');
      const seed = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
      seed.exec(`
        CREATE TABLE schema_version (
          version INTEGER PRIMARY KEY,
          applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        INSERT INTO schema_version (version) VALUES (33);
        CREATE TABLE session_rule_deliveries (
          id           INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id   INTEGER,
          project_id   INTEGER,
          engine_id    TEXT    NOT NULL,
          kind         TEXT    NOT NULL DEFAULT 'startup',
          channel      TEXT    NOT NULL CHECK (channel IN ('prime-file','prime-paste','rules-hook','none')),
          outcome      TEXT    NOT NULL CHECK (outcome IN ('delivered','no-rules','skipped','unverified')),
          skip_reason  TEXT,
          rule_ids     TEXT    NOT NULL DEFAULT '[]',
          rule_count   INTEGER NOT NULL DEFAULT 0,
          digest       TEXT    NOT NULL,
          created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
          CHECK (outcome NOT IN ('delivered','unverified') OR channel != 'none'),
          CHECK (outcome NOT IN ('skipped','unverified')   OR skip_reason IS NOT NULL)
        );
        INSERT INTO session_rule_deliveries
          (session_id, project_id, engine_id, kind, channel, outcome, skip_reason, rule_ids, rule_count, digest)
        VALUES
          (1, 1, 'claude', 'startup', 'rules-hook', 'delivered', NULL, '[1]', 1, 'old-digest'),
          (2, 1, 'claude', 'startup', 'prime-paste', 'unverified', 'blind', '[1]', 1, 'old-digest');
      `);
      seed.close();

      // The old DB must be REJECTED before the migration, or the assertion
      // below proves nothing about what the migration did.
      const pre = new DatabaseSync(path.join(tmpDir, 'tangleclaw.db'));
      assert.throws(() => pre.prepare(
        "INSERT INTO session_rule_deliveries (engine_id, channel, outcome, digest) VALUES ('claude','rules-hook','written','d')"
      ).run(), /CHECK constraint failed/, 'fixture precondition: v33 really does reject written');
      pre.close();

      store.close();
      store._setBasePath(tmpDir);
      store.init();

      const rows = store.sessionRuleDeliveries.listForSession(1)
        .concat(store.sessionRuleDeliveries.listForSession(2));
      assert.equal(rows.length, 2, 'rows are preserved — an audit trail outlives what it describes');
      assert.equal(rows[0].outcome, 'delivered',
        'a historical delivered row is NOT rewritten to written: it attests what the writer of the day believed');
      assert.equal(rows[1].outcome, 'unverified');
      assert.equal(rows[1].skipReason, 'blind');

      assert.doesNotThrow(() => store.sessionRuleDeliveries.record({
        sessionId: 3, projectId: 1, engineId: 'claude',
        channel: 'rules-hook', outcome: 'written', ruleIds: [1], digest: 'new'
      }));
      // The other CHECKs still bite after the rebuild.
      assert.throws(() => store.sessionRuleDeliveries.record({
        sessionId: 4, projectId: 1, engineId: 'claude',
        channel: 'none', outcome: 'written', ruleIds: [], digest: ''
      }), /cannot be written/);
    } finally {
      try { store.close(); } catch { /* already closed */ }
      store._setBasePath(prevBase);
      store.init();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
