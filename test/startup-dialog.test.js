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
      assert.ok(store.CURRENT_SCHEMA_VERSION >= 56);
      const cols = store.getDb().prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
      assert.ok(cols.includes('launch_blocker'));
    });

    it('an upgraded store gains the column and keeps its sessions', () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-startup-dialog-v55-'));
      try {
        store.close();
        store._setBasePath(dir);
        store.init();
        const p = store.projects.create({ name: 'carried', path: path.join(dir, 'carried'), engine: 'claude' });
        const s = store.sessions.start({ projectId: p.id, engineId: 'claude', tmuxSession: 'carried' });
        store.close();
        const db = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
        db.exec('ALTER TABLE sessions DROP COLUMN launch_blocker');
        db.exec('DELETE FROM schema_version');
        db.exec('INSERT INTO schema_version (version) VALUES (55)');
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

    it('an engine that declares no dialogs is not watched at all', async () => {
      const s = start();
      let watched = 0;
      startupDialog.watch = async () => { watched += 1; return { outcome: 'clear', dialog: null, waitedMs: 0 }; };
      launch(s, { profile: { ...PROFILE, capabilities: { ...PROFILE.capabilities, startupDialogs: undefined } } });
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
      assert.match(res.error, /nothing was typed into it/);
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

    it('false positive: a session quoting the dialog still takes its input', () => {
      start();
      pane = QUOTING_SESSION;
      assert.equal(sessions.injectCommand(project.name, 'hello').ok, true);
      assert.equal(typed.length, 1);
    });

    it('a pane that cannot be read refuses nothing', () => {
      start();
      tmux.capturePane = () => { throw new Error('tmux did not answer'); };
      assert.equal(sessions.injectCommand(project.name, 'hello').ok, true);
    });
  });
});
