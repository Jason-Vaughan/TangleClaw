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

  describe('a prompt is evidence only below the last marker', () => {
    it('a stale composer ABOVE a half-drawn dialog is not clear: the minimal case', () => {
      frames = [['❯', 'No, exit']];
      const res = look();
      assert.equal(res.clear, false);
      assert.equal(res.dialog, null);
      assert.equal(res.suspect.code, 'trust_required');
    });

    it('the same with a real composer row and a boxed prompt above the dialog being drawn', () => {
      frames = [[...COMPOSER, ...TRUST_DIALOG.slice(0, 13)]];
      const res = look();
      assert.equal(res.clear, false);
      assert.equal(res.suspect.code, 'trust_required');
    });

    it('a composer above the FULL dialog is still the dialog', () => {
      frames = [[...COMPOSER, ...TRUST_DIALOG]];
      assert.equal(look().dialog.code, 'trust_required');
    });

    it('a quoted dialog with the composer BELOW it is still clear', () => {
      frames = [QUOTING_SESSION];
      assert.equal(look().clear, true);
      frames = [['⏺ it said "No, exit"', '', '❯\u00a0']];
      assert.equal(look().clear, true);
    });
  });

  describe('a first partial read is not lost when the re-read cannot see the pane', () => {
    it('partial, then an empty re-read: still suspect, and unread', () => {
      frames = [TRUST_DIALOG.slice(0, 13), []];
      const res = look();
      assert.equal(settles, 1);
      assert.equal(res.suspect.code, 'trust_required');
      assert.equal(res.clear, false);
      assert.match(res.unread, /came back empty/);
    });

    it('partial, then a re-read that throws: still suspect', () => {
      frames = [TRUST_DIALOG.slice(0, 13), new Error('tmux did not answer')];
      const res = look();
      assert.equal(res.suspect.code, 'trust_required');
      assert.equal(res.unread, 'tmux did not answer');
    });

    it('partial, then a re-read that shows the prompt: the readable frame decides, and it is clear', () => {
      frames = [TRUST_DIALOG.slice(0, 13), COMPOSER];
      const res = look();
      assert.equal(res.suspect, null);
      assert.equal(res.clear, true);
    });
  });

  it('a profile with no prompt glyph is never read as clear: it has no positive evidence to give', () => {
    startupDialog._internal.wakeProfiles = () => ({});
    frames = [COMPOSER];
    assert.deepEqual(look(), { declared: true, dialog: null, suspect: null, clear: false, unread: null });
    frames = [TRUST_DIALOG];
    assert.equal(look().dialog.code, 'trust_required', 'though it still sees the dialog by its markers');
  });

  describe('withholdFor: a send goes ahead only on positive evidence, or when nothing stands against it', () => {
    const STORED = { code: 'trust_required', label: 'folder trust dialog', meaning: 'Answer it.' };
    const seen = (over) => ({ declared: true, dialog: null, suspect: null, clear: false, unread: null, ...over });
    const w = startupDialog.withholdFor;

    it('a dialog on screen withholds, stored or not', () => {
      assert.equal(w(seen({ dialog: STORED }), null).why, 'it is on screen');
      assert.equal(w(seen({ dialog: STORED }), STORED).why, 'it is on screen');
    });

    it('a positive reading withholds nothing, stored or not', () => {
      assert.equal(w(seen({ clear: true }), null), null);
      assert.equal(w(seen({ clear: true }), STORED), null);
    });

    it('with a blocker stored, EVERY reading short of positive withholds', () => {
      const short = {
        'the check could not be made': null,
        'the profile declares nothing now': seen({ declared: false }),
        'no profile was found': { declared: false, dialog: null, suspect: null, clear: false, unread: null },
        'the pane was unread': seen({ unread: 'tmux did not answer' }),
        'the read was empty': seen({ unread: 'the pane read came back empty' }),
        'neither dialog nor prompt': seen(),
        'a suspect frame': seen({ suspect: STORED }),
        'a suspect frame whose re-read was unread': seen({ suspect: STORED, unread: 'x' })
      };
      for (const [name, answer] of Object.entries(short)) {
        const res = w(answer, STORED);
        assert.equal(res && res.code, 'trust_required', name);
      }
    });

    it('with none stored, only a suspect frame withholds', () => {
      assert.equal(w(null, null), null);
      assert.equal(w(seen({ declared: false }), null), null);
      assert.equal(w(seen({ unread: 'x' }), null), null);
      assert.equal(w(seen(), null), null);
      assert.equal(w(seen({ suspect: STORED }), null).code, 'trust_required');
      assert.equal(w(seen({ suspect: STORED, unread: 'x' }), null).code, 'trust_required', 'a first partial kept across an unread re-read');
    });
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
  let launchFinished;
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
    // It is also the LAST thing a launch's deferred init schedules, after the
    // pre-keys, the paste and the kickoff, so its call is the signal that the
    // launch has finished: a test waits on that, never on a guessed delay.
    launchFinished = null;
    launchBootstrap.bootstrap = () => {
      if (launchFinished) launchFinished();
      return Promise.resolve({ code: 'legacy-recorded' });
    };
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
  /** Let promise continuations and zero-delay timers that are already queued run. */
  const turns = async (n = 4) => {
    for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve));
  };

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
        // The rebuild above dropped the table's three indexes with it. A real
        // v56 store has them; init creates them if absent, so the upgraded
        // store ends with the same indexes as a fresh one.
        const indexes = store.getDb().prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'sessions' AND name LIKE 'idx_sessions_%'").all().map((r) => r.name).sort();
        assert.deepEqual(indexes, ['idx_sessions_project', 'idx_sessions_started', 'idx_sessions_status']);
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

    /**
     * Launch, and wait for the launch itself to finish: every send it was
     * going to make has been made or withheld by the time this resolves.
     * @param {object} s - The session row
     * @param {object} [opts] - As `launch`
     * @returns {Promise<void>}
     */
    const launched = async (s, opts) => {
      const done = new Promise((resolve) => { launchFinished = resolve; });
      launch(s, opts);
      await done;
      // The bootstrap is scheduled at the launch's base delay. The paste is
      // scheduled at that delay PLUS the profile's startup delay whenever the
      // boot watch saw no prompt, so it can still be pending here. A timer of
      // that same length, set now, cannot expire before the paste's: timers
      // fire in order of expiry, and this one was set later for no less time.
      const startupDelay = ((opts && opts.profile) || PROFILE).launch.startupDelay || 1500;
      await new Promise((resolve) => setTimeout(resolve, startupDelay + 2));
      await turns();
    };

    beforeEach(() => {
      tmux.probeSession = () => ({ answered: true, live: true, cause: null });
      tmux.hasSession = () => true;
      // The launch reads the pane before each send. Left to the real tmux,
      // that read is as slow as the host makes it, and on a slow one a launch
      // ran on into the next test. Each test states what the pane shows.
      tmux.capturePane = () => ({ lines: COMPOSER, alternateScreen: false });
      startupDialog._internal.settleSync = () => {};
    });

    it('an unanswered dialog: no pre-key, no paste, no kickoff, and the blocker is recorded', async () => {
      const s = start();
      watchAnswers('unanswered', DIALOG);
      await launched(s, { profile: WITH_PREKEY });
      assert.deepEqual(typed, [], 'nothing was typed');
      assert.deepEqual(kicked, [], 'and the kickoff was not asked to');
      const blocker = store.sessions.get(s.id).launchBlocker;
      assert.equal(blocker.code, 'trust_required');
      assert.equal(blocker.engineId, 'claude');
    });

    it('a silently primed launch at a dialog is not kicked off either', async () => {
      const s = start();
      watchAnswers('unanswered', DIALOG);
      await launched(s, { silentPrime: true });
      assert.deepEqual(typed, []);
      assert.deepEqual(kicked, []);
    });

    it('the pane dying behind the dialog leaves the blocker for the crash to carry', async () => {
      const s = start();
      watchAnswers('pane-gone', DIALOG);
      await launched(s);
      assert.deepEqual(typed, []);
      store.sessions.markCrashed(s.id, 'tmux session died');
      assert.equal(store.sessions.get(s.id).launchBlocker.code, 'trust_required');
    });

    it('an answered dialog: the blocker is cleared and the launch types its first turn', async () => {
      const s = start();
      watchAnswers('answered', DIALOG);
      await launched(s);
      assert.equal(store.sessions.get(s.id).launchBlocker, null);
      assert.ok(typed.some((t) => t.text === 'the prime'), 'the prime was pasted');
      assert.equal(kicked.length, 1);
      assert.equal(store.activity.query({ sessionId: s.id, eventType: 'session.launch_unblocked' }).length, 1);
    });

    it('no dialog: the launch types as it always did, and records nothing', async () => {
      const s = start();
      watchAnswers('clear');
      await launched(s, { profile: WITH_PREKEY });
      assert.ok(typed.some((t) => t.key === 'Enter'), 'the declared pre-key');
      assert.ok(typed.some((t) => t.text === 'the prime'));
      assert.equal(kicked.length, 1);
      assert.equal(store.sessions.get(s.id).launchBlocker, null);
      assert.equal(store.activity.query({ sessionId: s.id, eventType: 'session.launch_blocked' }).length, 0);
    });

    it('timeout: an unrecognised screen does not cost the launch its prime', async () => {
      const s = start();
      watchAnswers('timeout');
      await launched(s);
      assert.ok(typed.some((t) => t.text === 'the prime'));
      assert.equal(kicked.length, 1);
      assert.equal(store.sessions.get(s.id).launchBlocker, null);
    });

    it('observation deadline: a dialog that draws after the window is still caught at the send', async () => {
      // The watch gave up having recognised nothing, so the launch goes ahead;
      // the pre-key and the paste each look once more before they type.
      const s = start();
      watchAnswers('timeout');
      let reads = 0;
      tmux.capturePane = () => { reads += 1; return { lines: TRUST_DIALOG, alternateScreen: false }; };
      await launched(s, { profile: WITH_PREKEY });
      assert.deepEqual(typed, [], 'neither the pre-key nor the prime was typed');
      assert.equal(reads >= 2, true, `both sends were reached and looked at the pane (reads: ${reads})`);
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
      await launched(s, { profile: variant });
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
      // This launch never finishes: its sends are dropped before any is
      // scheduled, so there is no finish to wait on, only the watch's answer.
      launch(s);
      await turns();
      store.sessions.kill(s.id, 'operator killed it at the dialog');
      release();
      await turns();
      assert.deepEqual(typed, []);
      assert.deepEqual(kicked, []);
    });

    it('a launch send is withheld on a half-drawn dialog too, at the pre-key and at the paste', async () => {
      const s = start();
      watchAnswers('timeout');
      let looks = 0;
      const realCheck = startupDialog.check;
      startupDialog.check = (...args) => { looks += 1; return realCheck(...args); };
      tmux.capturePane = () => ({ lines: TRUST_DIALOG.slice(0, 13), alternateScreen: false });
      try {
        await launched(s, { profile: WITH_PREKEY });
      } finally {
        startupDialog.check = realCheck;
      }
      assert.deepEqual(typed, []);
      assert.equal(looks, 2, 'the pre-key and the paste were both reached, and each looked');
      assert.equal(store.sessions.get(s.id).launchBlocker, null, 'a suspicion records no blocker');
    });

    describe('a send at the moment of typing, when the launch\'s session is not there to ask', () => {
      const PASTE = Object.freeze({ ...PROFILE });

      it('the session ended after the watch let the launch through: the paste is withheld, and the ledger says why', async () => {
        const s = start();
        const rows = [];
        const realRecord = store.sessionRuleDeliveries.record;
        store.sessionRuleDeliveries.record = (entry) => { rows.push(entry); return entry; };
        let attempts = 0;
        const realCheck = startupDialog.check;
        startupDialog.check = (...args) => { attempts += 1; return realCheck(...args); };
        startupDialog.watch = async () => {
          // The watch answers, the launch is scheduled, and the session is
          // killed before its paste timer fires.
          setImmediate(() => store.sessions.kill(s.id, 'killed between the watch and the paste'));
          return { outcome: 'timeout', meaning: '', dialog: null, waitedMs: 0 };
        };
        const profile = { ...PASTE, launch: { ...PASTE.launch, startupDelay: 30 } };
        try {
          const done = new Promise((resolve) => { launchFinished = resolve; });
          sessions._deferEngineInit(
            s.tmuxSession, project.name, 'claude', profile, 'the prime', null, false,
            { sessionId: s.id, projectId: project.id, engineId: 'claude', kind: 'startup', ruleIds: [1], digest: 'd' },
            { sessionId: s.id, projectId: project.id, hasSequence: true }
          );
          await done;
          await new Promise((resolve) => setTimeout(resolve, 32));
          await turns();
        } finally {
          store.sessionRuleDeliveries.record = realRecord;
          startupDialog.check = realCheck;
        }
        assert.deepEqual(typed, []);
        // The paste was reached and refused, not merely not yet attempted: it
        // wrote its row, and it never got as far as reading the pane.
        assert.equal(rows.length, 1);
        assert.equal(rows[0].channel, 'prime-paste');
        assert.equal(rows[0].outcome, 'skipped');
        assert.match(rows[0].skipReason, /^session_ended: nothing was typed when the prime was due, because the launch's session had ended \(killed\)/);
        assert.equal(attempts, 0);
      });

      it('a store that cannot say whether the session ended leaves the decision to the pane and its holder', () => {
        const s = start();
        store.sessions.setLaunchBlocker(s.id, BLOCKER);
        const realGet = store.sessions.get;
        store.sessions.get = () => { throw new Error('database is locked'); };
        try {
          tmux.capturePane = () => ({ lines: [], alternateScreen: false });
          assert.equal(sessions._startupDialogAtSend(s.tmuxSession, CLAUDE, 'claude', project.name, { sessionId: s.id }).code, 'trust_required');
          tmux.capturePane = () => ({ lines: COMPOSER, alternateScreen: false });
          assert.equal(sessions._startupDialogAtSend(s.tmuxSession, CLAUDE, 'claude', project.name, { sessionId: s.id }), null);
        } finally {
          store.sessions.get = realGet;
        }
      });

      it('an ended session\'s send is named as such, whatever the pane shows', () => {
        const s = start();
        store.sessions.kill(s.id, 'ended');
        const res = sessions._startupDialogAtSend(s.tmuxSession, CLAUDE, 'claude', project.name, { sessionId: s.id });
        assert.equal(res.code, 'session_ended');
        assert.match(res.why, /had ended \(killed\)/);
      });

      it('an id the store does not hold is not an ended session: the pane\'s holder is asked instead', () => {
        const holder = start();
        store.sessions.setLaunchBlocker(holder.id, BLOCKER);
        tmux.capturePane = () => ({ lines: [], alternateScreen: false });
        assert.equal(sessions._startupDialogAtSend(holder.tmuxSession, CLAUDE, 'claude', project.name, { sessionId: 987654 }).code, 'trust_required');
        assert.equal(sessions._startupDialogAtSend('nobody-holds-this', CLAUDE, 'claude', project.name, { sessionId: 987654 }), null);
      });

      it('a caller launching no session still honours the blocker stored for that pane', () => {
        const s = start();
        store.sessions.setLaunchBlocker(s.id, BLOCKER);
        tmux.capturePane = () => { throw new Error('tmux did not answer'); };
        assert.equal(sessions._startupDialogAtSend(s.tmuxSession, CLAUDE, 'claude', project.name, null).code, 'trust_required');
        const realCheck = startupDialog.check;
        startupDialog.check = () => { throw new Error('profiles unreadable'); };
        try {
          assert.equal(sessions._startupDialogAtSend(s.tmuxSession, CLAUDE, 'claude', project.name, null).code, 'trust_required', 'and when the check itself throws');
          store.sessions.clearLaunchBlocker(s.id);
          assert.equal(sessions._startupDialogAtSend(s.tmuxSession, CLAUDE, 'claude', project.name, null), null, 'with none stored it is an ordinary send');
        } finally {
          startupDialog.check = realCheck;
        }
      });
    });

    it('an engine that declares no dialogs is not watched at all', async () => {
      const s = start();
      let watched = 0;
      startupDialog.watch = async () => { watched += 1; return { outcome: 'clear', dialog: null, waitedMs: 0 }; };
      await launched(s, { profile: { ...PROFILE, capabilities: { ...PROFILE.capabilities, startupDialogs: [] } } });
      assert.equal(watched, 0);
      assert.ok(typed.some((t) => t.text === 'the prime'));
    });

    it('a native launch is not watched: it types nothing whatever the pane shows', async () => {
      const s = start();
      let watched = 0;
      startupDialog.watch = async () => { watched += 1; return { outcome: 'clear', dialog: null, waitedMs: 0 }; };
      await launched(s, { startupDelivery: 'native' });
      assert.equal(watched, 0);
      assert.deepEqual(typed, []);
    });

    it('a watch that fails outright types nothing rather than typing blind', async () => {
      const s = start();
      startupDialog.watch = () => Promise.reject(new Error('defect'));
      // Nothing is scheduled after a failed watch, so there is no finish to wait on.
      launch(s);
      await turns();
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

    describe('a trust_required raised somewhere else is not this blocker', () => {
      // Live on 2026-10-07 (session 1363, Codex 0.156.1, a project directory
      // renamed that day): the native startup fire was refused `trust_required`
      // from Codex's own config, twice, while the pane showed Codex's ordinary
      // prompt and no dialog. That refusal is a fire-row fact from another
      // mechanism. The session's launch blocker is set only from what the pane
      // shows, so a refusal like that one can neither store it nor make it stick.
      const CODEX = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'codex.json'), 'utf8'));
      const CODEX_AT_REST = ['', '› Ask Codex to do anything', '', '  gpt-6-sol high · 100% left'];

      it('a Codex session at its ordinary prompt has no blocker, takes its sends, and its pane is not even read for one', () => {
        const s = store.sessions.start({ projectId: project.id, engineId: 'codex', tmuxSession: `t-codex-${counter}` });
        const realGet = store.engines.get;
        store.engines.get = (id) => (id === 'codex' ? CODEX : realGet(id));
        let reads = 0;
        tmux.capturePane = () => { reads += 1; return { lines: CODEX_AT_REST, alternateScreen: false }; };
        tmux.probeSession = () => ({ answered: true, live: true, cause: null });
        try {
          assert.deepEqual(startupDialog.declared(CODEX), [], 'precondition: Codex declares no startup dialog here');
          const res = sessions.injectCommand(project.name, 'tc start next', { sessionId: s.id });
          assert.deepEqual(res, { ok: true, error: null });
          assert.equal(tmux._startupDialogOn(s.tmuxSession, 'codex'), null);
          assert.equal(store.sessions.get(s.id).launchBlocker, null);
          assert.equal(reads, 0, 'no declaration, so no pane read was made on its account');
          assert.equal(store.activity.query({ sessionId: s.id, eventType: 'session.launch_blocked' }).length, 0);
        } finally {
          store.engines.get = realGet;
          store.sessions.kill(s.id, 'test cleanup');
        }
      });

      it('nothing but a pane read can record the blocker: its only writers are the boot watch and the reconcile', () => {
        const lib = path.join(__dirname, '..', 'lib');
        const writers = [];
        (function walk(dir) {
          for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) { walk(full); continue; }
            if (!entry.name.endsWith('.js') || full === path.join(lib, 'store.js')) continue;
            const src = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
            const n = (src.match(/\bsetLaunchBlocker\(/g) || []).length;
            if (n) writers.push(`${path.relative(lib, full)}:${n}`);
          }
        })(lib);
        assert.deepEqual(writers, ['sessions.js:2'],
          'a new writer of the launch blocker must be one that has just read the dialog off the pane');
        const sessionsSrc = fs.readFileSync(path.join(lib, 'sessions.js'), 'utf8');
        // Both writers pass the dialog a pane read returned, never a code from elsewhere.
        assert.match(sessionsSrc, /setLaunchBlocker\(session\.id, \{ \.\.\.seen\.dialog, engineId \}\)/);
        assert.match(sessionsSrc, /setLaunchBlocker\(sessionId, \{ \.\.\.dialog, engineId \}\)/);
      });

      it('a blocker that was recorded for a pane now at its prompt is cleared by the next look: it cannot stick', () => {
        const s = start();
        store.sessions.setLaunchBlocker(s.id, BLOCKER);
        pane = COMPOSER;
        tmux.probeSession = () => ({ answered: true, live: true, cause: null });
        assert.equal(sessions.getSessionStatus(project.name).launchBlocker, null, 'so the badge and banner have nothing to show');
        assert.deepEqual(sessions.injectCommand(project.name, 'tc start next'), { ok: true, error: null });
      });
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

      it('when the session\'s own check throws: the API path is refused and the record stands', () => {
        const s = start();
        store.sessions.setLaunchBlocker(s.id, BLOCKER);
        const realCheck = startupDialog.check;
        startupDialog.check = () => { throw new Error('profiles unreadable'); };
        try {
          const res = sessions.injectCommand(project.name, 'tc start next');
          assert.equal(res.ok, false);
          assert.match(res.error, /^trust_required: .*its pane could not be checked/);
          assert.deepEqual(typed, []);
          tmux.probeSession = () => ({ answered: true, live: true, cause: null });
          assert.equal(sessions.getSessionStatus(project.name).launchBlocker.code, 'trust_required');
        } finally {
          startupDialog.check = realCheck;
        }
      });

      it('when the STORE cannot be read: the writer decides on the pane alone, which is stated, not hidden', () => {
        // Deliberately fail-open on the stored half only (see `_startupDialogOn`).
        const s = start();
        store.sessions.setLaunchBlocker(s.id, BLOCKER);
        const realLookup = store.sessions.getActiveByTmuxSession;
        store.sessions.getActiveByTmuxSession = () => { throw new Error('database is closed'); };
        try {
          tmux.capturePane = () => ({ lines: TRUST_DIALOG, alternateScreen: false });
          assert.equal(tmux._startupDialogOn(s.tmuxSession, 'claude').code, 'trust_required', 'a dialog on screen still withholds');
          tmux.capturePane = () => ({ lines: TRUST_DIALOG.slice(0, 13), alternateScreen: false });
          assert.equal(tmux._startupDialogOn(s.tmuxSession, 'claude').code, 'trust_required', 'and so does a half-drawn one');
          tmux.capturePane = () => ({ lines: [], alternateScreen: false });
          assert.equal(tmux._startupDialogOn(s.tmuxSession, 'claude'), null, 'an unread pane with an unreadable store is the one case that is let through');
        } finally {
          store.sessions.getActiveByTmuxSession = realLookup;
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

    describe('a stored blocker stands when its declaration is lost', () => {
      // An operator's own profile can lose its declaration, or the lookup can
      // find no profile at all. Neither is evidence the dialog was answered.
      let realGet;
      beforeEach(() => { realGet = store.engines.get; });
      afterEach(() => { store.engines.get = realGet; });

      const LOST = {
        'the profile declares none now': () => ({ ...CLAUDE, capabilities: { ...CLAUDE.capabilities, startupDialogs: [] } }),
        'no profile is found': () => null
      };

      for (const [when, get] of Object.entries(LOST)) {
        it(`when ${when}: the API path, the wake and the pane writer all still refuse`, () => {
          const s = start();
          store.sessions.setLaunchBlocker(s.id, BLOCKER);
          pane = COMPOSER;
          store.engines.get = get;
          const viaApi = sessions.injectCommand(project.name, 'tc start next');
          assert.equal(viaApi.ok, false);
          assert.match(viaApi.error, /^trust_required: .*declares no such dialog now/);
          const viaWake = require('../lib/medusa-wake')._internal.injectCommand(project.name, 'you have mail', { sessionId: s.id, controlExempt: 'medusa-wake' });
          assert.equal(viaWake.ok, false);
          assert.equal(tmux._startupDialogOn(s.tmuxSession, 'claude').code, 'trust_required');
          assert.deepEqual(typed, []);
          assert.equal(store.sessions.get(s.id).launchBlocker.code, 'trust_required', 'and the record is not cleared');
        });
      }

      it('a send that names no engine is refused by the writer too while the blocker stands', () => {
        const s = start();
        store.sessions.setLaunchBlocker(s.id, BLOCKER);
        assert.equal(tmux._startupDialogOn(s.tmuxSession, null).code, 'trust_required');
        store.sessions.clearLaunchBlocker(s.id);
        assert.equal(tmux._startupDialogOn(s.tmuxSession, null), null, 'and is an ordinary send with none stored');
      });

      it('a status read does not clear it either', () => {
        const s = start();
        store.sessions.setLaunchBlocker(s.id, BLOCKER);
        tmux.probeSession = () => ({ answered: true, live: true, cause: null });
        pane = COMPOSER;
        store.engines.get = LOST['the profile declares none now'];
        assert.equal(sessions.getSessionStatus(project.name).launchBlocker.code, 'trust_required');
      });
    });

    it('a stale composer above a half-drawn dialog does not clear a stored blocker or let a send through', () => {
      const s = start();
      store.sessions.setLaunchBlocker(s.id, BLOCKER);
      pane = ['❯', 'No, exit'];
      const res = sessions.injectCommand(project.name, 'tc start next');
      assert.equal(res.ok, false);
      assert.equal(store.sessions.get(s.id).launchBlocker.code, 'trust_required');
      assert.equal(tmux._startupDialogOn(s.tmuxSession, 'claude').code, 'trust_required');
      assert.deepEqual(typed, []);
    });

    it('a first partial read followed by an empty re-read withholds the send, with no blocker stored', () => {
      const s = start();
      const reads = [TRUST_DIALOG.slice(0, 13), []];
      tmux.capturePane = () => ({ lines: reads.length > 1 ? reads.shift() : reads[0], alternateScreen: false });
      const res = sessions.injectCommand(project.name, 'hello');
      assert.equal(res.ok, false);
      assert.match(res.error, /^trust_required: .*may still be drawing/);
      assert.deepEqual(typed, []);
      assert.equal(store.sessions.get(s.id).launchBlocker, null);
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

