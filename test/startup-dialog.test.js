'use strict';

/**
 * Engine startup dialogs (#2128).
 *
 * Claude Code asks whether to trust a folder it has never opened, with "No,
 * exit" under its cursor. A launch that typed into that screen confirmed the
 * default, the pane died, and the session read `crashed` with nothing to say
 * why. The properties that matter:
 *
 * - a declared dialog on screen is seen, and nothing is typed into it;
 * - a session merely quoting the dialog is NOT read as showing it;
 * - a screen nobody recognises never costs a healthy launch its first turn;
 * - the named blocker is still on the session after the pane is gone.
 *
 * Panes, the clock and the launch's senders are stubbed; the store is real.
 */

const { describe, it, before, beforeEach, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { DatabaseSync } = require('node:sqlite');
const { setLevel } = require('../lib/logger');

setLevel('error');

const startupDialog = require('../lib/startup-dialog');
const store = require('../lib/store');
const tmux = require('../lib/tmux');
const sessions = require('../lib/sessions');
const launchKickoff = require('../lib/launch-kickoff');
const { uniqueSessionName } = require('./_tmux-session-names');
const launchBootstrap = require('../lib/launch-bootstrap');
const sessionLeftovers = require('../lib/session-leftovers');

const CLAUDE = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'claude.json'), 'utf8'));
const ESC = '\u001b';

/** A word the way Claude Code draws the selected row: one colour run per word. */
const styled = (text) => text.split(' ').map((w) => `${ESC}[38;5;153m${w}${ESC}[39m`).join(' ');

/**
 * The folder trust dialog as captured on Claude Code 2.1.283, styling included
 * on the rows that carry it. The selected option is "No, exit".
 */
const TRUST_DIALOG = Object.freeze([
  '──────────────────────────────────────────────────────────────',
  ` ${ESC}[1m${ESC}[38;5;220mAccessing${ESC}[0m ${ESC}[1m${ESC}[38;5;220mworkspace:${ESC}[0m`,
  '',
  ' /private/tmp/scratch/repo',
  '',
  ' Quick safety check: Is this a project you created or one you trust? (Like your own code, a well-known open',
  ' source project, or work from your team). If not, take a moment to review what\'s in this folder first.',
  '',
  ' Claude Code\'ll be able to read, edit, and execute files here.',
  '',
  ' Security guide',
  '',
  ` ${styled('❯ No, exit')}`,
  '   Yes, I trust this folder',
  '',
  ` ${styled('Enter to confirm · Esc to cancel')}`,
  ''
]);

/** Claude Code at its composer, as captured after the dialog was accepted. */
const COMPOSER = Object.freeze([
  ' ▐▛███▛█   Claude Code v2.1.283',
  '▝▜██████▀  Opus 5.5 · Claude Max',
  ' ▝▝   ▝▝   /private/tmp/scratch/repo',
  '',
  '──────────────────────────────────────────────────────────────',
  '❯ Try "fix lint errors"',
  '──────────────────────────────────────────────────────────────',
  '  ? for shortcuts'
]);

/** A live session whose transcript quotes the dialog, with its composer below. */
const QUOTING_SESSION = Object.freeze([
  '⏺ The dialog reads:',
  '   ❯ No, exit',
  '     Yes, I trust this folder',
  '   Enter to confirm · Esc to cancel',
  '',
  '──────────────────────────────────────────────────────────────',
  '❯ ',
  '──────────────────────────────────────────────────────────────',
  '  ? for shortcuts'
]);

const DIALOGS = startupDialog.declared(CLAUDE);
const GLYPH = CLAUDE.capabilities.wake.promptGlyph;
const REAL_SEAMS = { ...startupDialog._internal };

describe('what an engine declares (#2128)', () => {
  it('Claude Code declares its folder trust dialog, with evidence', () => {
    assert.equal(DIALOGS.length, 1);
    assert.equal(DIALOGS[0].code, 'trust_required');
    assert.deepEqual(DIALOGS[0].markers, ['Yes, I trust this folder', 'No, exit']);
    const entry = CLAUDE.capabilities.startupDialogs[0];
    assert.match(entry.evidence.verifiedOn, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(entry.evidence.source, /2\.1\.283/, 'the evidence names the version it was captured on');
  });

  it('an engine that declares nothing has no dialogs', () => {
    assert.deepEqual(startupDialog.declared({ id: 'x', capabilities: {} }), []);
    assert.deepEqual(startupDialog.declared(null), []);
    assert.deepEqual(startupDialog.declared({ id: 'x', capabilities: { startupDialogs: 'trust' } }), []);
  });

  describe('a profile with no list of its own takes its program\'s', () => {
    // The first reported failures were on an operator-made second profile for
    // Claude Code, which the bundled-profile sync never updates.
    const VARIANT = Object.freeze({ id: 'claude-sonnet-reviewer', command: 'claude', capabilities: { supportsPrimePrompt: true } });

    beforeEach(() => {
      startupDialog.reset();
      startupDialog._internal.engineProfiles = () => [
        { id: 'aider', command: 'aider', capabilities: {} },
        VARIANT,
        CLAUDE
      ];
    });

    afterEach(() => {
      Object.assign(startupDialog._internal, REAL_SEAMS);
      startupDialog.reset();
    });

    it('an operator\'s second profile for the same command is covered', () => {
      assert.deepEqual(startupDialog.declared(VARIANT).map((d) => d.code), ['trust_required']);
    });

    it('a profile for another command is not', () => {
      assert.deepEqual(startupDialog.declared({ id: 'aider', command: 'aider', capabilities: {} }), []);
    });

    it('an empty list of its own is a profile saying its program shows none', () => {
      assert.deepEqual(startupDialog.declared({ ...VARIANT, capabilities: { startupDialogs: [] } }), []);
    });

    it('its own list wins over its program\'s', () => {
      const own = [{ code: 'login_required', label: 'login screen', meaning: 'Sign in.', markers: ['Sign in to continue'] }];
      assert.deepEqual(startupDialog.declared({ ...VARIANT, capabilities: { startupDialogs: own } }).map((d) => d.code), ['login_required']);
    });

    it('profiles that cannot be read leave a profile uncovered rather than failing the launch', () => {
      startupDialog._internal.engineProfiles = () => { throw new Error('unparsable profile'); };
      assert.deepEqual(startupDialog.declared(VARIANT), []);
    });

    it('a store with no profiles yet is not remembered as the answer', () => {
      startupDialog._internal.engineProfiles = () => [];
      assert.deepEqual(startupDialog.declared(VARIANT), []);
      startupDialog._internal.engineProfiles = () => [CLAUDE];
      assert.equal(startupDialog.declared(VARIANT).length, 1);
    });
  });

  it('drops a malformed entry rather than matching on a guess', () => {
    const profile = {
      id: 'x',
      capabilities: {
        startupDialogs: [
          { code: 'trust_required', label: 'l', meaning: 'm', markers: [] },
          { code: 'Trust Required', label: 'l', meaning: 'm', markers: ['a'] },
          { code: 'ok_one', label: 'l', meaning: 'm', markers: ['a', ''] },
          { code: 'sound', label: 'l', meaning: 'm', markers: ['a'] },
          null
        ]
      }
    };
    assert.deepEqual(startupDialog.declared(profile).map((d) => d.code), ['sound']);
  });
});

describe('reading one pane (#2128)', () => {
  it('sees the dialog through the per-word styling', () => {
    const hit = startupDialog.detect(TRUST_DIALOG, DIALOGS, GLYPH);
    assert.equal(hit.code, 'trust_required');
    assert.equal(hit.label, 'folder trust dialog');
    assert.match(hit.meaning, /No, exit/);
  });

  it('sees it whichever option is selected', () => {
    const moved = TRUST_DIALOG.map((row) => row.includes('Yes, I trust') ? ' ❯ Yes, I trust this folder' : row.replace(/❯/, ' '));
    assert.equal(startupDialog.detect(moved, DIALOGS, GLYPH).code, 'trust_required');
  });

  it('does not see one at the composer', () => {
    assert.equal(startupDialog.detect(COMPOSER, DIALOGS, GLYPH), null);
  });

  it('false positive: a session quoting the dialog above its composer is not showing it', () => {
    assert.equal(startupDialog.detect(QUOTING_SESSION, DIALOGS, GLYPH), null);
    // The same text with nothing below it IS the dialog: the composer is what tells them apart.
    assert.equal(startupDialog.detect(QUOTING_SESSION.slice(0, 4), DIALOGS, GLYPH).code, 'trust_required');
  });

  it('false positive: one marker alone is another dialog, not this one', () => {
    const bypass = [' WARNING: Claude Code running in Bypass Permissions mode', ' ❯ 1. No, exit', '   2. Yes, I accept', ' Enter to confirm · Esc to cancel'];
    assert.equal(startupDialog.detect(bypass, DIALOGS, GLYPH), null);
  });

  it('a booting pane is undecided until it shows a prompt or a dialog', () => {
    assert.equal(startupDialog.assessBoot([], DIALOGS, GLYPH).state, 'undecided');
    assert.equal(startupDialog.assessBoot(['', '  starting…'], DIALOGS, GLYPH).state, 'undecided');
    assert.equal(startupDialog.assessBoot(COMPOSER, DIALOGS, GLYPH).state, 'clear');
    assert.equal(startupDialog.assessBoot(TRUST_DIALOG, DIALOGS, GLYPH).state, 'dialog');
  });

  it('a half-drawn dialog is not a prompt, though its selected row leads with the prompt glyph', () => {
    const half = TRUST_DIALOG.slice(0, 13);
    assert.ok(half.some((row) => row.includes('No,')), 'precondition: the selected row is drawn');
    assert.equal(startupDialog.detect(half, DIALOGS, GLYPH), null, 'one marker is not the dialog');
    assert.equal(startupDialog.assessBoot(half, DIALOGS, GLYPH).state, 'undecided');
  });
});

describe('one look before a send (#2128)', () => {
  let frames;
  let settles;

  beforeEach(() => {
    Object.assign(startupDialog._internal, REAL_SEAMS);
    settles = 0;
    startupDialog._internal.wakeProfiles = () => ({ claude: { promptGlyph: GLYPH } });
    startupDialog._internal.settleSync = () => { settles += 1; };
    startupDialog._internal.capturePaneSync = () => {
      const frame = frames.length > 1 ? frames.shift() : frames[0];
      if (frame instanceof Error) throw frame;
      return { lines: frame, alternateScreen: false };
    };
  });

  after(() => { Object.assign(startupDialog._internal, REAL_SEAMS); });

  const look = () => startupDialog.check('t', CLAUDE);

  it('the dialog is a dialog, and not clear', () => {
    frames = [TRUST_DIALOG];
    const res = look();
    assert.equal(res.dialog.code, 'trust_required');
    assert.equal(res.clear, false);
    assert.equal(settles, 0);
  });

  it('the composer is clear', () => {
    frames = [COMPOSER];
    assert.deepEqual(look(), { declared: true, dialog: null, suspect: null, clear: true, unread: null });
  });

  it('a session quoting the dialog above its composer is clear: the prompt is the evidence', () => {
    frames = [QUOTING_SESSION];
    const res = look();
    assert.equal(res.dialog, null);
    assert.equal(res.clear, true);
    assert.equal(settles, 0, 'and it is not mistaken for a half-drawn frame');
  });

  it('a half-drawn dialog is read once more, and the finished frame decides', () => {
    frames = [TRUST_DIALOG.slice(0, 13), TRUST_DIALOG];
    const res = look();
    assert.equal(settles, 1);
    assert.equal(res.dialog.code, 'trust_required');
  });

  it('a frame that stays half-drawn is neither a dialog nor clear, and is named as suspect', () => {
    frames = [TRUST_DIALOG.slice(0, 13)];
    const res = look();
    assert.equal(settles, 1, 'one re-read, not a loop');
    assert.equal(res.dialog, null);
    assert.equal(res.clear, false);
    assert.deepEqual(res.suspect, { code: 'trust_required', label: DIALOGS[0].label, meaning: DIALOGS[0].meaning });
  });

  it('an empty read is unread, not clear', () => {
    frames = [[]];
    const res = look();
    assert.equal(res.clear, false);
    assert.match(res.unread, /came back empty/);
  });

  it('a read that throws is unread, not clear', () => {
    frames = [new Error('tmux did not answer')];
    const res = look();
    assert.equal(res.clear, false);
    assert.equal(res.unread, 'tmux did not answer');
  });

  it('a screen with neither a dialog nor a prompt is not clear', () => {
    frames = [['  Verifying your account…']];
    assert.deepEqual(look(), { declared: true, dialog: null, suspect: null, clear: false, unread: null });
  });

  it('an engine that declares nothing is not read', () => {
    frames = [new Error('must not be read')];
    assert.deepEqual(startupDialog.check('t', { id: 'aider', command: 'aider', capabilities: { startupDialogs: [] } }),
      { declared: false, dialog: null, suspect: null, clear: false, unread: null });
  });
});

describe('the boot watch (#2128)', () => {
  let clock;
  let frames;
  let seen;

  /**
   * Script the pane: each read returns the next frame, the last one repeating.
   * A frame that is an Error is thrown; `null` is a pane tmux says has ended.
   * @param {Array<string[]|Error|null>} script
   */
  const play = (script) => { frames = script.slice(); };

  beforeEach(() => {
    Object.assign(startupDialog._internal, REAL_SEAMS);
    clock = 0;
    seen = [];
    startupDialog._internal.now = () => clock;
    startupDialog._internal.sleep = async (ms) => { clock += ms; };
    startupDialog._internal.wakeProfiles = () => ({ claude: { promptGlyph: GLYPH } });
    startupDialog._internal.paneDigest = (lines) => lines.join('\n');
    startupDialog._internal.probeSession = () => ({ answered: true, live: true, cause: null });
    startupDialog._internal.capturePane = () => {
      const frame = frames.length > 1 ? frames.shift() : frames[0];
      if (frame === null) throw new Error('tmux session "t" does not exist');
      if (frame instanceof Error) throw frame;
      return { lines: frame, alternateScreen: false };
    };
  });

  after(() => { Object.assign(startupDialog._internal, REAL_SEAMS); });

  const watch = (over = {}) => startupDialog.watch({ tmuxName: 't', engineProfile: CLAUDE, onDialog: (d) => seen.push(d), ...over });

  it('every outcome it can return has a declared meaning', async () => {
    play([COMPOSER]);
    const res = await watch();
    assert.equal(res.meaning, startupDialog.OUTCOME_MEANINGS[res.outcome]);
    assert.deepEqual(Object.keys(startupDialog.OUTCOME_MEANINGS).sort(),
      ['answered', 'clear', 'pane-gone', 'timeout', 'unanswered', 'undeclared', 'unprofiled']);
  });

  it('does not watch an engine that declares no dialogs', async () => {
    play([TRUST_DIALOG]);
    const res = await watch({ engineProfile: { id: 'aider', capabilities: {} } });
    assert.equal(res.outcome, 'undeclared');
    assert.equal(clock, 0, 'and reads nothing');
  });

  it('does not watch an engine with no prompt glyph to tell a finished boot by', async () => {
    startupDialog._internal.wakeProfiles = () => ({});
    play([TRUST_DIALOG]);
    assert.equal((await watch()).outcome, 'unprofiled');
  });

  it('no dialog: a prompt that holds still is clear, and nothing is reported', async () => {
    play([[], ['  starting…'], COMPOSER]);
    const res = await watch();
    assert.equal(res.outcome, 'clear');
    assert.equal(res.dialog, null);
    assert.deepEqual(seen, []);
    assert.ok(res.waitedMs < startupDialog.BOOT_WINDOW_MS);
  });

  it('a prompt seen once is not yet clear: the frame after it can be the dialog', async () => {
    play([COMPOSER, TRUST_DIALOG]);
    const res = await watch({ answerWindowMs: 4000 });
    assert.equal(res.outcome, 'unanswered');
    assert.equal(seen.length, 1);
  });

  it('a dialog is reported once, and an unanswered one says which', async () => {
    play([[], TRUST_DIALOG]);
    const res = await watch({ answerWindowMs: 10_000 });
    assert.equal(res.outcome, 'unanswered');
    assert.equal(res.dialog.code, 'trust_required');
    assert.deepEqual(seen.map((d) => d.code), ['trust_required']);
  });

  it('the operator answers: the prompt after a dialog is `answered`', async () => {
    play([TRUST_DIALOG, TRUST_DIALOG, ['  loading…'], COMPOSER]);
    const res = await watch();
    assert.equal(res.outcome, 'answered');
    assert.equal(res.dialog.code, 'trust_required');
    assert.equal(seen.length, 1);
  });

  it('the pane ends behind its dialog: `pane-gone`, still naming the dialog', async () => {
    startupDialog._internal.probeSession = () => ({ answered: true, live: false, cause: null });
    play([TRUST_DIALOG, null]);
    const res = await watch();
    assert.equal(res.outcome, 'pane-gone');
    assert.equal(res.dialog.code, 'trust_required');
  });

  it('timeout: a screen nobody recognises ends the window with no dialog claimed', async () => {
    play([['  Verifying your account…']]);
    const res = await watch();
    assert.equal(res.outcome, 'timeout');
    assert.equal(res.dialog, null);
    assert.deepEqual(seen, []);
    assert.ok(res.waitedMs >= startupDialog.BOOT_WINDOW_MS);
  });

  it('a pane that cannot be read is not assumed gone while tmux does not say so', async () => {
    startupDialog._internal.probeSession = () => ({ answered: false, live: false, cause: 'tmux-unreachable' });
    play([new Error('tmux did not answer')]);
    assert.equal((await watch()).outcome, 'timeout');
  });

  it('never rejects, even when recording the dialog throws', async () => {
    play([TRUST_DIALOG]);
    const res = await startupDialog.watch({
      tmuxName: 't', engineProfile: CLAUDE, answerWindowMs: 2000,
      onDialog: () => { throw new Error('store is closed'); }
    });
    assert.equal(res.outcome, 'unanswered');
  });
});

describe('the session keeps its blocker (#2128)', () => {
  let base;
  let project;
  const realProbe = tmux.probeSession;
  const realHas = tmux.hasSession;
  const realCapture = tmux.capturePane;
  const realSendKeys = tmux.sendKeys;
  const realSendRaw = tmux.sendRawKey;
  const realKickoff = launchKickoff.kickoff;
  const realBootstrap = launchBootstrap.bootstrap;
  const realWatch = startupDialog.watch;
  let typed;
  let kicked;
  let counter = 0;

  before(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-startup-dialog-'));
    store._setBasePath(base);
    store.init();
  });

  after(() => {
    try { store.close(); } catch { /* already closed */ }
    fs.rmSync(base, { recursive: true, force: true });
  });

  beforeEach(() => {
    counter += 1;
    const name = `trust-proj-${counter}`;
    project = store.projects.create({ name, path: path.join(base, name), engine: 'claude' });
    typed = [];
    kicked = [];
    tmux.sendKeys = (session, text) => { typed.push({ session, text }); };
    tmux.sendRawKey = (session, key) => { typed.push({ session, key }); };
    launchKickoff.kickoff = (args) => { kicked.push(args); return Promise.resolve('sent'); };
    // The bootstrap reads a real pane; it is not the subject here, and left
    // real it runs its reads inside the next test's window.
    launchBootstrap.bootstrap = () => Promise.resolve({ code: 'legacy-recorded' });
  });

  afterEach(() => {
    tmux.probeSession = realProbe;
    tmux.hasSession = realHas;
    tmux.capturePane = realCapture;
    tmux.sendKeys = realSendKeys;
    tmux.sendRawKey = realSendRaw;
    launchKickoff.kickoff = realKickoff;
    launchBootstrap.bootstrap = realBootstrap;
    startupDialog.watch = realWatch;
    Object.assign(startupDialog._internal, REAL_SEAMS);
    const active = store.sessions.getActive(project.id);
    if (active) store.sessions.markCrashed(active.id, 'test cleanup');
  });

  const start = () => store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: `t-${counter}` });
  const BLOCKER = Object.freeze({ code: 'trust_required', label: 'folder trust dialog', meaning: 'Answer it in the pane.', engineId: 'claude' });
  const settle = () => new Promise((resolve) => setTimeout(resolve, 40));

  describe('in the store', () => {
    it('schema: a fresh store has the column, and this is the version that added it', () => {
      assert.ok(store.CURRENT_SCHEMA_VERSION >= 57);
      const cols = store.getDb().prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
      assert.ok(cols.includes('launch_blocker'));
    });

    it('an upgraded store gains the column and keeps its sessions', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-startup-dialog-v56-'));
      try {
        store.close();
        store._setBasePath(dir);
        store.init();
        const p = store.projects.create({ name: 'carried', path: path.join(dir, 'carried'), engine: 'claude' });
        const s = store.sessions.start({ projectId: p.id, engineId: 'claude', tmuxSession: 'carried' });
        store.close();
        const db = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
        // Put `sessions` back to its v56 shape by rebuilding it from its own
        // stored DDL with the one column line removed. Not `DROP COLUMN`: the
        // column is the last one and its line carries a trailing SQL comment,
        // and some SQLite builds rewrite that into DDL they then cannot parse.
        const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get().sql;
        const v56Ddl = ddl
          .split('\n')
          .filter((line) => !/^\s*launch_blocker\b/.test(line))
          .join('\n')
          // The line above it ended with the comma that separated the two.
          .replace(/(launch_dirty\s+TEXT),/, '$1')
          .replace(/^CREATE TABLE\s+(IF NOT EXISTS\s+)?"?sessions"?/, 'CREATE TABLE sessions_v56');
        assert.doesNotMatch(v56Ddl, /launch_blocker/, 'precondition: the rebuilt DDL has no such column');
        const kept = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name).filter((c) => c !== 'launch_blocker').join(', ');
        db.exec('PRAGMA foreign_keys = OFF');
        db.exec('PRAGMA legacy_alter_table = ON');
        db.exec(v56Ddl);
        db.exec(`INSERT INTO sessions_v56 (${kept}) SELECT ${kept} FROM sessions`);
        db.exec('DROP TABLE sessions');
        db.exec('ALTER TABLE sessions_v56 RENAME TO sessions');
        assert.ok(!db.prepare('PRAGMA table_info(sessions)').all().some((c) => c.name === 'launch_blocker'),
          'precondition: the v56 store has no launch_blocker column');
        db.exec('DELETE FROM schema_version');
        db.exec('INSERT INTO schema_version (version) VALUES (56)');
        db.close();

        store.init();
        const cols = store.getDb().prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
        assert.ok(cols.includes('launch_blocker'));
        assert.equal(store.getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get().v, store.CURRENT_SCHEMA_VERSION);
        assert.equal(store.sessions.get(s.id).launchBlocker, null, 'a session from before has no blocker');
      } finally {
        store.close();
        store._setBasePath(base);
        store.init();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    it('a session starts with no blocker', () => {
      assert.equal(start().launchBlocker, null);
    });

    it('records a blocker on an active session, and says so in the activity log', () => {
      const s = start();
      const after = store.sessions.setLaunchBlocker(s.id, BLOCKER);
      assert.equal(after.launchBlocker.code, 'trust_required');
      assert.equal(after.launchBlocker.label, 'folder trust dialog');
      assert.equal(after.launchBlocker.engineId, 'claude');
      assert.match(after.launchBlocker.observedAt, /^\d{4}-\d{2}-\d{2}T/);
      const events = store.activity.query({ sessionId: s.id, eventType: 'session.launch_blocked' });
      assert.equal(events.length, 1);
      assert.equal(events[0].detail.code, 'trust_required');
    });

    it('refuses a blocker with no code, and one for a session that has ended', () => {
      const s = start();
      assert.equal(store.sessions.setLaunchBlocker(s.id, { label: 'x' }), null);
      store.sessions.markCrashed(s.id, 'tmux session died');
      assert.equal(store.sessions.setLaunchBlocker(s.id, BLOCKER), null, 'how a session ended is not rewritten afterwards');
      assert.equal(store.sessions.get(s.id).launchBlocker, null);
    });

    it('crash-cause retention: the blocker outlives the pane, and the crash entry names it', () => {
      const s = start();
      store.sessions.setLaunchBlocker(s.id, BLOCKER);
      const crashed = store.sessions.markCrashed(s.id, 'tmux session died');
      assert.equal(crashed.status, 'crashed');
      assert.equal(crashed.launchBlocker.code, 'trust_required');
      assert.equal(store.sessions.getLatest(project.id).launchBlocker.code, 'trust_required', 'and a later read still has it');
      const [event] = store.activity.query({ sessionId: s.id, eventType: 'session.crashed' });
      assert.equal(event.detail.error, 'tmux session died');
      assert.equal(event.detail.cause, 'trust_required');
      assert.equal(event.detail.causeMeaning, 'Answer it in the pane.');
    });

    it('a crash with no blocker names no cause', () => {
      const s = start();
      store.sessions.markCrashed(s.id, 'tmux session died');
      const [event] = store.activity.query({ sessionId: s.id, eventType: 'session.crashed' });
      assert.deepEqual(event.detail, { error: 'tmux session died' });
    });

    it('clears an active session\'s blocker, and never a dead session\'s', () => {
      const s = start();
      assert.equal(store.sessions.clearLaunchBlocker(s.id), null, 'nothing to clear');
      store.sessions.setLaunchBlocker(s.id, BLOCKER);
      assert.equal(store.sessions.clearLaunchBlocker(s.id).launchBlocker, null);
      assert.equal(store.activity.query({ sessionId: s.id, eventType: 'session.launch_unblocked' }).length, 1);

      store.sessions.setLaunchBlocker(s.id, BLOCKER);
      store.sessions.markCrashed(s.id, 'tmux session died');
      assert.equal(store.sessions.clearLaunchBlocker(s.id), null);
      assert.equal(store.sessions.get(s.id).launchBlocker.code, 'trust_required');
    });
  });

  describe('in what the API serves', () => {
    it('a live session at its dialog says so in its status', () => {
      const s = start();
      store.sessions.setLaunchBlocker(s.id, BLOCKER);
      tmux.probeSession = () => ({ answered: false, live: false, cause: 'tmux-unreachable' });
      const status = sessions.getSessionStatus(project.name);
      assert.equal(status.active, true);
      assert.equal(status.launchBlocker.code, 'trust_required');
    });

    it('a healthy live session carries a null blocker, not a missing field', () => {
      start();
      tmux.probeSession = () => ({ answered: false, live: false, cause: 'tmux-unreachable' });
      const status = sessions.getSessionStatus(project.name);
      assert.ok('launchBlocker' in status);
      assert.equal(status.launchBlocker, null);
    });

    it('crash-cause retention: the status read that finds the pane dead still serves the cause', () => {
      const s = start();
      store.sessions.setLaunchBlocker(s.id, BLOCKER);
      tmux.probeSession = () => ({ answered: true, live: false, cause: null });
      const status = sessions.getSessionStatus(project.name);
      assert.equal(status.active, false);
      assert.equal(status.lastSession.sessionId, s.id);
      assert.equal(status.lastSession.status, 'crashed');
      assert.equal(status.lastSession.launchBlocker.code, 'trust_required');
      assert.match(status.lastSession.launchBlocker.meaning, /Answer it in the pane/);
      // And again on the next read, when there is no longer anything to observe.
      assert.equal(sessions.getSessionStatus(project.name).lastSession.launchBlocker.code, 'trust_required');
    });

    describe('the record is kept true to the pane by whoever reads it', () => {
      // Nothing tells TangleClaw when the operator answers a dialog. The boot
      // watch stops after its window, and a server restart ends it early.
      beforeEach(() => {
        tmux.hasSession = () => true;
        tmux.probeSession = () => ({ answered: true, live: true, cause: null });
      });

      it('a status read clears a blocker whose dialog is gone, so a healthy session is not called blocked', () => {
        const s = start();
        store.sessions.setLaunchBlocker(s.id, BLOCKER);
        tmux.capturePane = () => ({ lines: COMPOSER, alternateScreen: false });
        const status = sessions.getSessionStatus(project.name);
        assert.equal(status.active, true);
        assert.equal(status.launchBlocker, null);
        assert.equal(store.sessions.get(s.id).launchBlocker, null);
      });

      it('and a death long after is then not blamed on the dialog', () => {
        const s = start();
        store.sessions.setLaunchBlocker(s.id, BLOCKER);
        tmux.capturePane = () => ({ lines: COMPOSER, alternateScreen: false });
        sessions.getSessionStatus(project.name);
        tmux.probeSession = () => ({ answered: true, live: false, cause: null });
        const status = sessions.getSessionStatus(project.name);
        assert.equal(status.lastSession.status, 'crashed');
        assert.equal(status.lastSession.launchBlocker, null);
        const [event] = store.activity.query({ sessionId: s.id, eventType: 'session.crashed' });
        assert.equal(event.detail.cause, undefined);
      });

      it('a status read keeps a blocker whose dialog is still up', () => {
        const s = start();
        store.sessions.setLaunchBlocker(s.id, BLOCKER);
        tmux.capturePane = () => ({ lines: TRUST_DIALOG, alternateScreen: false });
        assert.equal(sessions.getSessionStatus(project.name).launchBlocker.code, 'trust_required');
        assert.equal(store.activity.query({ sessionId: s.id, eventType: 'session.launch_blocked' }).length, 1, 'and does not record it again');
      });

      it('a pane that could not be read changes nothing: unread is not answered', () => {
        const s = start();
        store.sessions.setLaunchBlocker(s.id, BLOCKER);
        tmux.capturePane = () => { throw new Error('tmux did not answer'); };
        assert.equal(sessions.getSessionStatus(project.name).launchBlocker.code, 'trust_required');
        assert.equal(store.sessions.get(s.id).launchBlocker.code, 'trust_required');
      });

      it('an EMPTY read is not an answered dialog: tmux\'s reader returns no lines when a capture fails', () => {
        const s = start();
        store.sessions.setLaunchBlocker(s.id, BLOCKER);
        tmux.capturePane = () => ({ lines: [], alternateScreen: false });
        assert.equal(sessions.getSessionStatus(project.name).launchBlocker.code, 'trust_required');
        tmux.capturePane = () => ({ lines: ['', '   ', ''], alternateScreen: false });
        assert.equal(sessions.getSessionStatus(project.name).launchBlocker.code, 'trust_required');
        assert.equal(store.sessions.get(s.id).launchBlocker.code, 'trust_required');
      });

      it('a screen showing neither a dialog nor the prompt clears nothing', () => {
        const s = start();
        store.sessions.setLaunchBlocker(s.id, BLOCKER);
        tmux.capturePane = () => ({ lines: ['  Verifying your account…'], alternateScreen: false });
        assert.equal(sessions.getSessionStatus(project.name).launchBlocker.code, 'trust_required');
        assert.equal(store.sessions.get(s.id).launchBlocker.code, 'trust_required');
      });

      it('a healthy session with no blocker is not read for one', () => {
        start();
        let reads = 0;
        const real = startupDialog.check;
        startupDialog.check = (...args) => { reads += 1; return real(...args); };
        try {
          tmux.capturePane = () => ({ lines: COMPOSER, alternateScreen: false });
          sessions.getSessionStatus(project.name);
        } finally {
          startupDialog.check = real;
        }
        assert.equal(reads, 0);
      });
    });

    it('the project list\'s last-session answer carries it too', () => {
      const s = start();
      store.sessions.setLaunchBlocker(s.id, BLOCKER);
      store.sessions.markCrashed(s.id, 'tmux session died');
      const health = sessionLeftovers.read(store.projects.get(project.id));
      assert.equal(health.status, 'crashed');
      assert.equal(health.launchBlocker.code, 'trust_required');
    });
  });

  describe('the launch types nothing into a dialog', () => {
    /** Have the boot watch answer as scripted, reporting a dialog first when it names one. */
    const watchAnswers = (outcome, dialog = null) => {
      startupDialog.watch = async (args) => {
        if (dialog && args.onDialog) args.onDialog(dialog);
        return { outcome, meaning: startupDialog.OUTCOME_MEANINGS[outcome], dialog, waitedMs: 7000 };
      };
    };
    const DIALOG = Object.freeze({ code: 'trust_required', label: 'folder trust dialog', meaning: 'Answer it in the pane.' });
    const PROFILE = Object.freeze({ ...CLAUDE, launch: { ...CLAUDE.launch, startupDelay: 1 } });
    // Pre-keys are spaced 500 ms apart by the launch, so the profile that has
    // one is used only where the pre-key itself is the subject.
    const WITH_PREKEY = Object.freeze({ ...CLAUDE, launch: { ...CLAUDE.launch, startupDelay: 1, preKeys: ['Enter'], preKeyDelay: 1 } });
    const launch = (s, { silentPrime = false, profile = PROFILE, startupDelivery } = {}) => sessions._deferEngineInit(
      s.tmuxSession, project.name, 'claude', profile, 'the prime', null, silentPrime, null,
      { sessionId: s.id, projectId: project.id, hasSequence: true, startupDelivery }
    );

    beforeEach(() => {
      tmux.probeSession = () => ({ answered: true, live: true, cause: null });
      tmux.hasSession = () => true;
    });

    it('an unanswered dialog: no pre-key, no paste, no kickoff, and the blocker is recorded', async () => {
      const s = start();
      watchAnswers('unanswered', DIALOG);
      launch(s, { profile: WITH_PREKEY });
      await new Promise((resolve) => setTimeout(resolve, 650));
      assert.deepEqual(typed, [], 'nothing was typed');
      assert.deepEqual(kicked, [], 'and the kickoff was not asked to');
      const blocker = store.sessions.get(s.id).launchBlocker;
      assert.equal(blocker.code, 'trust_required');
      assert.equal(blocker.engineId, 'claude');
    });

    it('a silently primed launch at a dialog is not kicked off either', async () => {
      const s = start();
      watchAnswers('unanswered', DIALOG);
      launch(s, { silentPrime: true });
      await settle();
      assert.deepEqual(typed, []);
      assert.deepEqual(kicked, []);
    });

    it('the pane dying behind the dialog leaves the blocker for the crash to carry', async () => {
      const s = start();
      watchAnswers('pane-gone', DIALOG);
      launch(s);
      await settle();
      assert.deepEqual(typed, []);
      store.sessions.markCrashed(s.id, 'tmux session died');
      assert.equal(store.sessions.get(s.id).launchBlocker.code, 'trust_required');
    });

    it('an answered dialog: the blocker is cleared and the launch types its first turn', async () => {
      const s = start();
      watchAnswers('answered', DIALOG);
      launch(s);
      await settle();
      assert.equal(store.sessions.get(s.id).launchBlocker, null);
      assert.ok(typed.some((t) => t.text === 'the prime'), 'the prime was pasted');
      assert.equal(kicked.length, 1);
      assert.equal(store.activity.query({ sessionId: s.id, eventType: 'session.launch_unblocked' }).length, 1);
    });

    it('no dialog: the launch types as it always did, and records nothing', async () => {
      const s = start();
      watchAnswers('clear');
      launch(s, { profile: WITH_PREKEY });
      await new Promise((resolve) => setTimeout(resolve, 650));
      assert.ok(typed.some((t) => t.key === 'Enter'), 'the declared pre-key');
      assert.ok(typed.some((t) => t.text === 'the prime'));
      assert.equal(kicked.length, 1);
      assert.equal(store.sessions.get(s.id).launchBlocker, null);
      assert.equal(store.activity.query({ sessionId: s.id, eventType: 'session.launch_blocked' }).length, 0);
    });

    it('timeout: an unrecognised screen does not cost the launch its prime', async () => {
      const s = start();
      watchAnswers('timeout');
      launch(s);
      await settle();
      assert.ok(typed.some((t) => t.text === 'the prime'));
      assert.equal(kicked.length, 1);
      assert.equal(store.sessions.get(s.id).launchBlocker, null);
    });

    it('observation deadline: a dialog that draws after the window is still caught at the send', async () => {
      // The watch gave up having recognised nothing, so the launch goes ahead;
      // the pre-key and the paste each look once more before they type.
      const s = start();
      watchAnswers('timeout');
      tmux.capturePane = () => ({ lines: TRUST_DIALOG, alternateScreen: false });
      launch(s, { profile: WITH_PREKEY });
      await new Promise((resolve) => setTimeout(resolve, 650));
      assert.deepEqual(typed, [], 'neither the pre-key nor the prime was typed');
      assert.equal(store.sessions.get(s.id).launchBlocker.code, 'trust_required');
      assert.equal(store.activity.query({ sessionId: s.id, eventType: 'session.launch_blocked' }).length, 1, 'recorded once, not once per send');
    });

    it('an operator\'s own profile for the same program is watched too', async () => {
      const s = start();
      startupDialog.reset();
      startupDialog._internal.engineProfiles = () => [CLAUDE];
      let watched = 0;
      startupDialog.watch = async () => { watched += 1; return { outcome: 'timeout', meaning: '', dialog: null, waitedMs: 0 }; };
      const variant = { ...PROFILE, id: 'claude-sonnet-reviewer', capabilities: { ...PROFILE.capabilities } };
      delete variant.capabilities.startupDialogs;
      launch(s, { profile: variant });
      await settle();
      assert.equal(watched, 1);
      startupDialog.reset();
    });

    it('a session that ended while its boot was watched types nothing into the pane that reused its name', async () => {
      // Kill and relaunch inside the answer window: the old watch then reads
      // the NEW session's pane, sees its prompt, and reports `answered`.
      const s = start();
      let release;
      startupDialog.watch = (args) => new Promise((resolve) => {
        args.onDialog(DIALOG);
        release = () => resolve({ outcome: 'answered', meaning: '', dialog: DIALOG, waitedMs: 60_000 });
      });
      launch(s);
      await settle();
      store.sessions.kill(s.id, 'operator killed it at the dialog');
      release();
      await settle();
      assert.deepEqual(typed, []);
      assert.deepEqual(kicked, []);
    });

    it('a launch send is withheld on a half-drawn dialog too, at the pre-key and at the paste', async () => {
      const s = start();
      watchAnswers('timeout');
      tmux.capturePane = () => ({ lines: TRUST_DIALOG.slice(0, 13), alternateScreen: false });
      launch(s, { profile: WITH_PREKEY });
      await new Promise((resolve) => setTimeout(resolve, 1900));
      assert.deepEqual(typed, []);
      assert.equal(store.sessions.get(s.id).launchBlocker, null, 'a suspicion records no blocker');
    });

    it('an engine that declares no dialogs is not watched at all', async () => {
      const s = start();
      let watched = 0;
      startupDialog.watch = async () => { watched += 1; return { outcome: 'clear', dialog: null, waitedMs: 0 }; };
      launch(s, { profile: { ...PROFILE, capabilities: { ...PROFILE.capabilities, startupDialogs: [] } } });
      await settle();
      assert.equal(watched, 0);
      assert.ok(typed.some((t) => t.text === 'the prime'));
    });

    it('a native launch is not watched: it types nothing whatever the pane shows', async () => {
      const s = start();
      let watched = 0;
      startupDialog.watch = async () => { watched += 1; return { outcome: 'clear', dialog: null, waitedMs: 0 }; };
      launch(s, { startupDelivery: 'native' });
      await settle();
      assert.equal(watched, 0);
      assert.deepEqual(typed, []);
    });

    it('a watch that fails outright types nothing rather than typing blind', async () => {
      const s = start();
      startupDialog.watch = () => Promise.reject(new Error('defect'));
      launch(s);
      await settle();
      assert.deepEqual(typed, []);
      assert.deepEqual(kicked, []);
    });
  });

  describe('a later send is refused while the dialog is up', () => {
    let pane;

    beforeEach(() => {
      tmux.hasSession = () => true;
      tmux.capturePane = () => ({ lines: pane, alternateScreen: false });
    });

    it('refuses with the named code, types nothing, and records the blocker', () => {
      const s = start();
      pane = TRUST_DIALOG;
      const res = sessions.injectCommand(project.name, 'tc start next');
      assert.equal(res.ok, false);
      assert.match(res.error, /^trust_required: /);
      assert.match(res.error, /nothing was typed into the session, because of its engine's folder trust dialog \(it is on screen\)/);
      assert.equal(res.startupDialog.code, 'trust_required');
      assert.deepEqual(typed, []);
      assert.equal(store.sessions.get(s.id).launchBlocker.code, 'trust_required');
      // A second refusal does not log the same blocker again.
      sessions.injectCommand(project.name, 'tc start next');
      assert.equal(store.activity.query({ sessionId: s.id, eventType: 'session.launch_blocked' }).length, 1);
    });

    it('once the operator has answered, the stale blocker is cleared and the send goes through', () => {
      const s = start();
      store.sessions.setLaunchBlocker(s.id, BLOCKER);
      pane = COMPOSER;
      const res = sessions.injectCommand(project.name, 'tc start next');
      assert.deepEqual(res, { ok: true, error: null });
      assert.deepEqual(typed.map((t) => t.text), ['tc start next']);
      assert.equal(store.sessions.get(s.id).launchBlocker, null);
    });

    it('a refusal the pane writer makes on its own second read keeps its name for the caller', () => {
      // The dialog finishes drawing between injectCommand's read and the writer's.
      start();
      pane = COMPOSER;
      tmux.sendKeys = () => {
        const err = new Error('trust_required: nothing was typed into the session');
        err.code = 'STARTUP_DIALOG';
        err.startupDialog = { code: 'trust_required', label: 'folder trust dialog', meaning: 'Answer it in the pane.' };
        throw err;
      };
      const res = sessions.injectCommand(project.name, 'ls');
      assert.equal(res.ok, false);
      assert.equal(res.startupDialog.code, 'trust_required', 'so the command route answers 409, not 500');
    });

    it('false positive: a session quoting the dialog still takes its input', () => {
      start();
      pane = QUOTING_SESSION;
      assert.equal(sessions.injectCommand(project.name, 'hello').ok, true);
      assert.equal(typed.length, 1);
    });

    it('a pane that cannot be read refuses nothing when no blocker stands', () => {
      start();
      tmux.capturePane = () => { throw new Error('tmux did not answer'); };
      assert.equal(sessions.injectCommand(project.name, 'hello').ok, true);
    });

    describe('a stored blocker withholds every send until a positive prompt reading clears it', () => {
      // The dialog may still be up on a pane this read could not vouch for,
      // and one Enter into it ends the session.
      const NOT_CLEAR = {
        'the pane cannot be read': () => { throw new Error('tmux did not answer'); },
        'the read comes back empty': () => ({ lines: [], alternateScreen: false }),
        'the pane shows neither the dialog nor the prompt': () => ({ lines: ['  Verifying your account…'], alternateScreen: false }),
        'the dialog is half-drawn': () => ({ lines: TRUST_DIALOG.slice(0, 13), alternateScreen: false })
      };

      for (const [when, capture] of Object.entries(NOT_CLEAR)) {
        it(`when ${when}: a command over the API path is refused and the blocker stands`, () => {
          const s = start();
          store.sessions.setLaunchBlocker(s.id, BLOCKER);
          tmux.capturePane = capture;
          const res = sessions.injectCommand(project.name, 'tc start next');
          assert.equal(res.ok, false);
          assert.match(res.error, /^trust_required: nothing was typed into the session/);
          assert.equal(res.startupDialog.code, 'trust_required');
          assert.deepEqual(typed, []);
          assert.equal(store.sessions.get(s.id).launchBlocker.code, 'trust_required');
        });

        it(`when ${when}: the switchboard wake is refused too`, () => {
          const s = start();
          store.sessions.setLaunchBlocker(s.id, BLOCKER);
          tmux.capturePane = capture;
          const res = require('../lib/medusa-wake')._internal.injectCommand(project.name, 'you have mail', { sessionId: s.id, controlExempt: 'medusa-wake' });
          assert.equal(res.ok, false);
          assert.match(res.error, /^trust_required: /);
          assert.deepEqual(typed, []);
        });

        it(`when ${when}: the pane writer itself refuses a direct send`, () => {
          const s = start();
          store.sessions.setLaunchBlocker(s.id, BLOCKER);
          tmux.capturePane = capture;
          // The writer's own decision; a real pane is driven in the pane-writer block below.
          const refusal = tmux._startupDialogOn(s.tmuxSession, 'claude');
          assert.equal(refusal.code, 'trust_required');
          assert.match(refusal.why, /could not be read|neither that dialog nor the engine's prompt/);
        });
      }

      it('when the check itself fails: the writer still withholds, because the blocker stands', () => {
        const s = start();
        store.sessions.setLaunchBlocker(s.id, BLOCKER);
        const realCheck = startupDialog.check;
        startupDialog.check = () => { throw new Error('profiles unreadable'); };
        try {
          const refusal = tmux._startupDialogOn(s.tmuxSession, 'claude');
          assert.equal(refusal.code, 'trust_required');
          assert.match(refusal.why, /could not be checked/);
          store.sessions.clearLaunchBlocker(s.id);
          assert.equal(tmux._startupDialogOn(s.tmuxSession, 'claude'), null, 'and with no blocker a failed check stops nothing');
        } finally {
          startupDialog.check = realCheck;
        }
      });

      it('the positive reading clears it and the send goes through', () => {
        const s = start();
        store.sessions.setLaunchBlocker(s.id, BLOCKER);
        tmux.capturePane = () => ({ lines: COMPOSER, alternateScreen: false });
        assert.equal(tmux._startupDialogOn(s.tmuxSession, 'claude'), null, 'the writer sees the prompt');
        assert.deepEqual(sessions.injectCommand(project.name, 'tc start next'), { ok: true, error: null });
        assert.equal(store.sessions.get(s.id).launchBlocker, null);
      });
    });

    it('a half-drawn dialog withholds a send even with no blocker stored, and records none', () => {
      const s = start();
      tmux.capturePane = () => ({ lines: TRUST_DIALOG.slice(0, 13), alternateScreen: false });
      const res = sessions.injectCommand(project.name, 'hello');
      assert.equal(res.ok, false);
      assert.match(res.error, /^trust_required: .*part of it is on screen and it may still be drawing/);
      assert.deepEqual(typed, []);
      assert.equal(store.sessions.get(s.id).launchBlocker, null, 'a suspicion is not recorded as a dialog');
      assert.equal(tmux._startupDialogOn(s.tmuxSession, 'claude').code, 'trust_required', 'and the writer withholds it too');
    });
  });
});


/**
 * Which TangleClaw send ended the reported sessions.
 *
 * The server log of the first reported launch (session 1352, 2026-10-06) shows
 * the prime paste clearing "a draft" of one row and 8 characters from the
 * prompt 2.1 s after launch, and the pane gone 6.5 s later. These tests pin
 * each launch-time sender against the captured dialog: the senders behind the
 * shared idle gate refuse it, and the blind paste's prompt clear reads the
 * dialog's selected option as exactly that draft before typing over it.
 */
describe('each launch-time sender, against the dialog (#2128)', () => {
  const medusaWake = require('../lib/medusa-wake');
  const WAKE = Object.freeze({
    busyMarker: CLAUDE.capabilities.wake.busyMarker,
    promptRe: new RegExp(CLAUDE.capabilities.wake.promptPattern),
    promptGlyph: CLAUDE.capabilities.wake.promptGlyph,
    promptPad: CLAUDE.capabilities.wake.promptPad,
    placeholderSgr: CLAUDE.capabilities.wake.placeholderSgr,
    idleMarker: CLAUDE.capabilities.wake.idleMarker
  });
  const SELECTED = TRUST_DIALOG.find((row) => row.includes('No,'));

  it('the idle gate the kickoff, the wake nudge and the unready nudge share refuses the dialog', () => {
    // Wherever the terminal cursor rests: unknown, on the selected option, or below the footer.
    for (const cursor of [null, { x: 1, y: 12, line: SELECTED }, { x: 9, y: 12, line: SELECTED }, { x: 0, y: 16, line: '' }]) {
      let state = {};
      for (let tick = 0; tick < 4; tick++) {
        state = medusaWake.assessSessionIdle({ lines: TRUST_DIALOG, profile: WAKE, cursor, prevDigest: state.digest, idleTicks: state.idleTicks });
      }
      assert.equal(state.idle, false, `cursor ${JSON.stringify(cursor && cursor.x)}`);
      assert.ok(['no-prompt', 'composer-has-input'].includes(state.reason), state.reason);
    }
  });

  it('the paste\'s prompt clear reads the selected option as a one-row, 8-character draft: the log\'s signature', () => {
    // The reading does not depend on where along the row the cursor rests, only
    // on its being past the glyph: just after it, or at the end of the text.
    for (const x of [2, 11]) {
      const draft = medusaWake.readComposerDraft(TRUST_DIALOG, { x, y: 12, line: SELECTED }, WAKE);
      assert.equal(draft.state, 'draft', `cursor column ${x}`);
      assert.equal(draft.text, 'No, exit');
      assert.equal(draft.text.length, 8);
      assert.equal(draft.rows, 1);
    }
  });

  describe('every sender that injects is refused at the dialog', () => {
    let base;
    let project;
    let session;
    let typed;
    const real = { hasSession: tmux.hasSession, capturePane: tmux.capturePane, sendKeys: tmux.sendKeys, probeSession: tmux.probeSession };

    before(() => {
      base = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-startup-dialog-senders-'));
      store._setBasePath(base);
      store.init();
      startupDialog.reset();
      project = store.projects.create({ name: 'sender-proj', path: path.join(base, 'sender-proj'), engine: 'claude' });
      session = store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'sender-proj' });
      tmux.hasSession = () => true;
      tmux.probeSession = () => ({ answered: true, live: true, cause: null });
      tmux.capturePane = () => ({ lines: TRUST_DIALOG, alternateScreen: false });
      tmux.sendKeys = (name, text) => { typed.push(text); };
    });

    beforeEach(() => { typed = []; });

    after(() => {
      Object.assign(tmux, real);
      try { store.close(); } catch { /* already closed */ }
      fs.rmSync(base, { recursive: true, force: true });
      startupDialog.reset();
    });

    const SENDERS = {
      'the launch kickoff': () => launchKickoff._internal.inject('sender-proj', 'read your launch context', {}),
      'the unready nudge': () => require('../lib/launch-unready')._internal.inject('sender-proj', 'run tc start next', {}),
      'the switchboard wake': () => medusaWake._internal.injectCommand('sender-proj', 'you have mail', { sessionId: session.id, controlExempt: 'medusa-wake' }),
      'the wrap hand-back': () => require('../lib/wrap-handback')._internal.inject('sender-proj', 'wrap finished', {}),
      'a command sent over the API': () => sessions.injectCommand('sender-proj', 'ls')
    };

    for (const [name, send] of Object.entries(SENDERS)) {
      it(`${name} types nothing and is told why`, () => {
        const res = send();
        assert.equal(res.ok, false);
        assert.match(res.error, /^trust_required: /);
        assert.deepEqual(typed, []);
      });
    }
  });
});

/**
 * The floor under every sender: the pane writer itself.
 *
 * The check a sender makes before typing only protects the senders that make
 * it. Two that type a line ending in Enter did not (the wrap's content prompt
 * and the /critic action), so the refusal also sits in `tmux.sendKeys`, where
 * every typed send converges.
 */
describe('the pane writer refuses a declared dialog (#2128)', () => {
  const realCheck = startupDialog.check;
  let base;

  before(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-startup-dialog-writer-'));
    store._setBasePath(base);
    store.init();
  });

  afterEach(() => { startupDialog.check = realCheck; });

  after(() => {
    startupDialog.check = realCheck;
    try { store.close(); } catch { /* already closed */ }
    fs.rmSync(base, { recursive: true, force: true });
  });

  // A real pane, as `test/tmux-draft-capture.test.js` uses: the writer asks tmux
  // itself whether the session exists, so there is nothing to stub in its place.
  const PANE = uniqueSessionName('startup_dialog_writer');
  const openPane = () => {
    tmux.createSession(PANE, { command: 'exec bash --norc --noprofile' });
    require('node:child_process').execSync('sleep 0.3');
  };
  const paneText = () => {
    require('node:child_process').execSync('sleep 0.3');
    return tmux.capturePane(PANE, { full: true }).lines.join('\n');
  };

  it('throws STARTUP_DIALOG, naming the dialog, and types nothing', () => {
    try {
      openPane();
      let asked = null;
      startupDialog.check = (session, profile) => {
        asked = { session, engine: profile && profile.id };
        return { declared: true, dialog: { code: 'trust_required', label: 'folder trust dialog', meaning: 'Answer it in the pane.' }, suspect: null, clear: false, unread: null };
      };
      assert.throws(() => tmux.sendKeys(PANE, 'SHOULD-NOT-PASTE', { enter: true, engineId: 'claude' }), (err) => {
        assert.equal(err.code, 'STARTUP_DIALOG');
        assert.equal(err.startupDialog.code, 'trust_required');
        assert.match(err.message, /^trust_required: nothing was typed into the session, because of its engine's folder trust dialog \(it is on screen\)/);
        return true;
      });
      assert.deepEqual(asked, { session: PANE, engine: 'claude' });
      assert.doesNotMatch(paneText(), /SHOULD-NOT-PASTE/);
    } finally {
      try { tmux.killSession(PANE); } catch { /* already gone */ }
    }
  });

  it('a stored blocker the read did not clear stops a real send through the writer', () => {
    const p = store.projects.create({ name: 'writer-proj', path: path.join(base, 'writer-proj'), engine: 'claude' });
    try {
      openPane();
      const session = store.sessions.start({ projectId: p.id, engineId: 'claude', tmuxSession: PANE });
      store.sessions.setLaunchBlocker(session.id, { code: 'trust_required', label: 'folder trust dialog', meaning: 'Answer it in the pane.' });
      startupDialog.check = () => ({ declared: true, dialog: null, suspect: null, clear: false, unread: 'the pane read came back empty' });
      assert.throws(() => tmux.sendKeys(PANE, 'SHOULD-NOT-PASTE', { enter: true, engineId: 'claude' }), (err) => {
        assert.equal(err.code, 'STARTUP_DIALOG');
        assert.match(err.message, /^trust_required: .*its pane could not be read/);
        return true;
      });
      assert.doesNotMatch(paneText(), /SHOULD-NOT-PASTE/);
      // The same unread pane with no blocker standing is an ordinary send.
      store.sessions.clearLaunchBlocker(session.id);
      tmux.sendKeys(PANE, 'echo NOW-PASTED', { enter: false, engineId: 'claude' });
      assert.match(paneText(), /NOW-PASTED/);
    } finally {
      try { tmux.killSession(PANE); } catch { /* already gone */ }
    }
  });

  it('with no dialog on the pane the send goes through', () => {
    try {
      openPane();
      startupDialog.check = () => ({ declared: true, dialog: null, suspect: null, clear: true, unread: null });
      tmux.sendKeys(PANE, 'echo DID-PASTE', { enter: false, engineId: 'claude' });
      assert.match(paneText(), /DID-PASTE/);
    } finally {
      try { tmux.killSession(PANE); } catch { /* already gone */ }
    }
  });

  it('a check that cannot be made does not stop a send', () => {
    try {
      openPane();
      startupDialog.check = () => { throw new Error('profiles unreadable'); };
      tmux.sendKeys(PANE, 'echo STILL-PASTED', { enter: false, engineId: 'claude' });
      assert.match(paneText(), /STILL-PASTED/);
    } finally {
      try { tmux.killSession(PANE); } catch { /* already gone */ }
    }
  });

  it('every caller of the pane writer names the session\'s engine, which is what arms the check', () => {
    const lib = path.join(__dirname, '..', 'lib');
    const files = [];
    (function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js') && full !== path.join(lib, 'tmux.js')) files.push(full);
      }
    })(lib);
    const unarmed = [];
    let calls = 0;
    for (const file of files) {
      const src = fs.readFileSync(file, 'utf8');
      const re = /\bsendKeys\(/g;
      let m;
      while ((m = re.exec(src)) !== null) {
        const lineStart = src.lastIndexOf('\n', m.index) + 1;
        const line = src.slice(lineStart, src.indexOf('\n', m.index));
        // A comment, a declaration, or a seam that only forwards to the writer is not a call that types.
        if (/^\s*(\/\/|\*)/.test(line) || /=>\s*require\(/.test(line) || /function\s+sendKeys/.test(line)) continue;
        calls += 1;
        // The call's own argument list, by bracket matching.
        let depth = 0;
        let end = m.index + m[0].length - 1;
        for (let i = end; i < src.length; i++) {
          if (src[i] === '(') depth += 1;
          else if (src[i] === ')' && --depth === 0) { end = i; break; }
        }
        if (!/\bengineId\b/.test(src.slice(m.index, end))) unarmed.push(`${path.relative(lib, file)}: ${line.trim()}`);
      }
    }
    assert.ok(calls >= 5, `expected to find the known senders, found ${calls}`);
    assert.deepEqual(unarmed, [], 'a typed send that does not name its engine is not checked for a startup dialog');
  });
});

