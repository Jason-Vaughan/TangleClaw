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
const { setLevel, setConsoleStream } = require('../lib/logger');

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

/**
 * A fresh Claude Code composer row as captured on 2.1.283 (2026-10-07, an
 * empty repository, no turn taken): the glyph, its NBSP pad, and the engine's
 * own suggestion. `capture-pane` without `-e` gives the text; with `-e` the
 * suggestion is wrapped in SGR 2 (faint). The cursor sat at column 2, the
 * first input column.
 */
const SUGGESTION_ROW = '❯\u00a0Try "edit <filepath> to..."';
const SUGGESTION_CURSOR = Object.freeze({ visible: true, x: 2, y: 5, line: `❯\u00a0${ESC}[2mTry "edit <filepath> to..."${ESC}[0m\n` });

/** Cursors stated for particular frames (`at`); any other frame gets the suggestion row's when it shows one. */
const CURSORS = new Map();

/**
 * State where the cursor is on a frame.
 * @param {string[]} lines - The frame
 * @param {object|null} cursor - The cursor `tmux.cursorInfo` would report on it
 * @returns {string[]} The same frame
 */
const at = (lines, cursor) => { CURSORS.set(lines, cursor); return lines; };

/** The cursor a pane showing these rows would report: the one stated for the frame, else on the suggestion row when it is there. */
const cursorOf = (lines) => {
  if (CURSORS.has(lines)) return CURSORS.get(lines);
  // A frame built from a stated one: the cursor is where it was on the part drawn last.
  for (const [frame, cursor] of [...CURSORS].reverse()) {
    if (lines && lines.length > frame.length && frame.every((row, i) => lines[lines.length - frame.length + i] === row)) return cursor;
  }
  return (lines || []).includes(SUGGESTION_ROW) ? SUGGESTION_CURSOR : null;
};

/** The rows the last stubbed pane read served, so the stubbed cursor read answers for the same pane. */
let lastServed = [];

/**
 * A stubbed pane read: the capture, with the cursor that goes with it.
 * @param {string[]} lines - The rows the pane shows
 * @returns {{lines: string[], alternateScreen: boolean, cursor: (object|null)}}
 */
const served = (lines) => { lastServed = lines; return { lines, alternateScreen: false, cursor: cursorOf(lines) }; };

/** Claude Code at its composer, as captured after the dialog was accepted. */
const COMPOSER = Object.freeze([
  ' ▐▛███▛█   Claude Code v2.1.283',
  '▝▜██████▀  Opus 5.5 · Claude Max',
  ' ▝▝   ▝▝   /private/tmp/scratch/repo',
  '',
  '──────────────────────────────────────────────────────────────',
  SUGGESTION_ROW,
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
/** Claude Code's measured prompt signature, compiled the way production compiles it. */
const WAKE = require('../lib/medusa-wake')._buildWakeProfiles([CLAUDE]).claude;
// File-wide: the cursor read answers for whichever pane the last stubbed read served.
startupDialog._internal.cursorInfoSync = () => cursorOf(lastServed);
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

    describe('and its program\'s measured prompt signature', () => {
      // An operator's second profile often has no `wake` block of its own. The
      // prompt, like the dialog, belongs to the program.
      const pane = { lines: COMPOSER };
      beforeEach(() => {
        startupDialog._internal.wakeProfiles = () => ({ claude: WAKE });
        startupDialog._internal.capturePaneSync = () => served(pane.lines);
        startupDialog._internal.capturePane = async () => served(pane.lines);
        startupDialog._internal.paneDigest = (lines) => lines.join('\n');
        startupDialog._internal.settleSync = () => {};
        let clock = 0;
        startupDialog._internal.now = () => clock;
        startupDialog._internal.sleep = async (ms) => { clock += ms; };
      });

      it('takes the declaring profile\'s glyph, so its pane can be read as clear', () => {
        assert.equal(startupDialog.promptSignatureFor(VARIANT).promptGlyph, GLYPH);
        pane.lines = COMPOSER;
        const res = startupDialog.check('t', VARIANT);
        assert.equal(res.promptKnown, true);
        assert.equal(res.clear, true);
      });

      it('so its boot IS watched, to a dialog or to its prompt', async () => {
        pane.lines = TRUST_DIALOG;
        const blocked = await startupDialog.watch({ tmuxName: 't', engineProfile: VARIANT, answerWindowMs: 4000 });
        assert.equal(blocked.outcome, 'unanswered');
        assert.equal(blocked.dialog.code, 'trust_required');
        pane.lines = COMPOSER;
        assert.equal((await startupDialog.watch({ tmuxName: 't', engineProfile: VARIANT })).outcome, 'clear');
      });

      it('a dialog that draws late, after blank and booting frames, is caught before the first send', async () => {
        // The case an unwatched boot misses: a look at launch sees nothing,
        // and the dialog arrives after it.
        const frames = [[], ['  starting…'], ['  starting…'], TRUST_DIALOG];
        startupDialog._internal.capturePane = async () => served(frames.length > 1 ? frames.shift() : frames[0]);
        const seen = [];
        const res = await startupDialog.watch({ tmuxName: 't', engineProfile: VARIANT, answerWindowMs: 4000, onDialog: (d) => seen.push(d.code) });
        assert.deepEqual(seen, ['trust_required'], 'reported once, when it drew');
        assert.equal(res.outcome, 'unanswered');
        assert.notEqual(res.outcome, 'unprofiled');
      });

      it('a lookalike glyph is not borrowed across commands', () => {
        const other = { id: 'codex-variant', command: 'codex', capabilities: {} };
        startupDialog._internal.wakeProfiles = () => ({ claude: WAKE, codex: { promptGlyph: '›' } });
        assert.equal(startupDialog.promptSignatureFor(other), null, 'no dialog is declared for that command, so there is nothing to resolve a glyph for');
        assert.equal(startupDialog.promptSignatureFor({ id: 'x', command: 'claude-next', capabilities: {} }), null, 'a different command is a different program');
      });

      it('its own measured signature wins over the program\'s', () => {
        const own = { ...WAKE, promptGlyph: '›', promptRe: /^›$/ };
        startupDialog._internal.wakeProfiles = () => ({ claude: WAKE, 'claude-sonnet-reviewer': own });
        assert.equal(startupDialog.promptSignatureFor(VARIANT), own);
      });

      it('what is inherited is the whole measured signature, not the glyph alone', () => {
        const got = startupDialog.promptSignatureFor(VARIANT);
        assert.equal(got, WAKE, 'the declaring profile\'s wake profile itself');
        assert.ok(got.promptRe instanceof RegExp, 'with the bare-composer pattern');
        assert.equal(got.promptPad, '\u00a0');
        assert.deepEqual(got.placeholderSgr, [2], 'and the suggestion styling the cursor reading needs');
      });

      it('a glyph with no measured composer pattern is not a signature, for a profile or for its program', () => {
        startupDialog._internal.wakeProfiles = () => ({ claude: { promptGlyph: GLYPH } });
        assert.equal(startupDialog.promptSignatureFor(CLAUDE), null);
        assert.equal(startupDialog.promptSignatureFor(VARIANT), null);
        startupDialog._internal.wakeProfiles = () => ({ claude: WAKE, 'claude-sonnet-reviewer': { promptGlyph: '›' } });
        assert.equal(startupDialog.promptSignatureFor(VARIANT), WAKE, 'an unmeasured block of its own does not hide its program\'s measured one');
      });

      it('with no measured glyph for the profile or its command there is none, and nothing is guessed', async () => {
        startupDialog._internal.wakeProfiles = () => ({});
        assert.equal(startupDialog.promptSignatureFor(VARIANT), null);
        pane.lines = COMPOSER;
        const res = startupDialog.check('t', VARIANT);
        assert.equal(res.promptKnown, false);
        assert.equal(res.clear, false);
        assert.equal((await startupDialog.watch({ tmuxName: 't', engineProfile: VARIANT })).outcome, 'unprofiled');
      });
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
    const hit = startupDialog.detect(TRUST_DIALOG, DIALOGS, WAKE);
    assert.equal(hit.code, 'trust_required');
    assert.equal(hit.label, 'folder trust dialog');
    assert.match(hit.meaning, /No, exit/);
  });

  it('sees it whichever option is selected', () => {
    const moved = TRUST_DIALOG.map((row) => row.includes('Yes, I trust') ? ' ❯ Yes, I trust this folder' : row.replace(/❯/, ' '));
    assert.equal(startupDialog.detect(moved, DIALOGS, WAKE).code, 'trust_required');
  });

  it('does not see one at the composer', () => {
    assert.equal(startupDialog.detect(COMPOSER, DIALOGS, WAKE), null);
  });

  it('false positive: a session quoting the dialog above its composer is not showing it', () => {
    assert.equal(startupDialog.detect(QUOTING_SESSION, DIALOGS, WAKE), null);
    // The same text with nothing below it IS the dialog: the composer is what tells them apart.
    assert.equal(startupDialog.detect(QUOTING_SESSION.slice(0, 4), DIALOGS, WAKE).code, 'trust_required');
  });

  it('false positive: one marker alone is another dialog, not this one', () => {
    const bypass = [' WARNING: Claude Code running in Bypass Permissions mode', ' ❯ 1. No, exit', '   2. Yes, I accept', ' Enter to confirm · Esc to cancel'];
    assert.equal(startupDialog.detect(bypass, DIALOGS, WAKE), null);
  });

  it('a booting pane is undecided until it shows a prompt or a dialog', () => {
    assert.equal(startupDialog.assessBoot([], DIALOGS, WAKE).state, 'undecided');
    assert.equal(startupDialog.assessBoot(['', '  starting…'], DIALOGS, WAKE).state, 'undecided');
    assert.equal(startupDialog.assessBoot(COMPOSER, DIALOGS, WAKE, cursorOf(COMPOSER)).state, 'clear');
    assert.equal(startupDialog.assessBoot(COMPOSER, DIALOGS, WAKE).state, 'undecided', 'the suggestion row is not a prompt without the cursor that says so');
    assert.equal(startupDialog.assessBoot(TRUST_DIALOG, DIALOGS, WAKE).state, 'dialog');
  });

  it('a half-drawn dialog is not a prompt, though its selected row leads with the prompt glyph', () => {
    const half = TRUST_DIALOG.slice(0, 13);
    assert.ok(half.some((row) => row.includes('No,')), 'precondition: the selected row is drawn');
    assert.equal(startupDialog.detect(half, DIALOGS, WAKE), null, 'one marker is not the dialog');
    assert.equal(startupDialog.assessBoot(half, DIALOGS, WAKE).state, 'undecided');
  });
});

describe('one look before a send (#2128)', () => {
  let frames;
  let settles;

  beforeEach(() => {
    Object.assign(startupDialog._internal, REAL_SEAMS);
    settles = 0;
    startupDialog._internal.wakeProfiles = () => ({ claude: WAKE });
    startupDialog._internal.settleSync = () => { settles += 1; };
    startupDialog._internal.capturePaneSync = () => {
      const frame = frames.length > 1 ? frames.shift() : frames[0];
      if (frame instanceof Error) throw frame;
      return served(frame);
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
    assert.deepEqual(look(), { declared: true, dialog: null, suspect: null, clear: true, noncomposer: false, unread: null, promptKnown: true, unreadable: null, unresolved: null, unresolvedCause: null });
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
    assert.deepEqual(look(), { declared: true, dialog: null, suspect: null, clear: false, noncomposer: false, unread: null, promptKnown: false, unreadable: null, unresolved: null, unresolvedCause: null });
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

    it('when the stored blocker could not be read, only a positive reading sends', () => {
      const unknown = { storedUnknown: 'database is locked' };
      assert.equal(w(seen({ clear: true }), null, unknown), null);
      assert.equal(w(seen({ dialog: STORED }), null, unknown).code, 'trust_required');
      assert.equal(w(seen({ suspect: STORED }), null, unknown).code, 'trust_required');
      for (const [name, answer] of Object.entries({
        'check not made': null,
        'undeclared': seen({ declared: false }),
        'unread': seen({ unread: 'x' }),
        'neither': seen()
      })) {
        const res = w(answer, null, unknown);
        assert.equal(res && res.code, 'launch_blocker_unreadable', name);
        assert.equal(res.label, null, `${name}: names no dialog`);
      }
    });

    it('a blocker that stands on a profile with no verified prompt signature says so, and says the way out', () => {
      const res = w(seen({ promptKnown: false }), STORED);
      assert.equal(res.code, 'trust_required');
      assert.match(res.why, /no verified prompt signature, so TangleClaw cannot confirm the dialog was answered/);
      assert.match(res.why, /relaunch the session after approving it, or add a measured wake declaration/);
      assert.doesNotMatch(res.why, /shows neither/);
      assert.match(w(seen({ promptKnown: true }), STORED).why, /shows neither that dialog nor the engine's prompt/);
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
    assert.deepEqual(look(), { declared: true, dialog: null, suspect: null, clear: false, noncomposer: false, unread: null, promptKnown: true, unreadable: null, unresolved: null, unresolvedCause: null });
  });

  it('an engine that declares nothing is not read', () => {
    frames = [new Error('must not be read')];
    assert.deepEqual(startupDialog.check('t', { id: 'aider', command: 'aider', capabilities: { startupDialogs: [] } }),
      { declared: false, dialog: null, suspect: null, clear: false, noncomposer: false, unread: null, promptKnown: false, unreadable: null, unresolved: null, unresolvedCause: null });
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
    startupDialog._internal.wakeProfiles = () => ({ claude: WAKE });
    startupDialog._internal.paneDigest = (lines) => lines.join('\n');
    startupDialog._internal.probeSession = () => ({ answered: true, live: true, cause: null });
    startupDialog._internal.capturePane = () => {
      const frame = frames.length > 1 ? frames.shift() : frames[0];
      if (frame === null) throw new Error('tmux session "t" does not exist');
      if (frame instanceof Error) throw frame;
      return served(frame);
    };
  });

  after(() => { Object.assign(startupDialog._internal, REAL_SEAMS); });

  const watch = (over = {}) => startupDialog.watch({ tmuxName: 't', engineProfile: CLAUDE, onDialog: (d) => seen.push(d), ...over });

  it('every outcome it can return has a declared meaning', async () => {
    play([COMPOSER]);
    const res = await watch();
    assert.equal(res.meaning, startupDialog.OUTCOME_MEANINGS[res.outcome]);
    assert.deepEqual(Object.keys(startupDialog.OUTCOME_MEANINGS).sort(),
      ['answered', 'clear', 'pane-gone', 'timeout', 'unanswered', 'undeclared', 'unprofiled', 'unreadable']);
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

  describe('after a dialog, the watch judges a frame as every later look does', () => {
    // Text of an answered dialog can stay in the rows of history the watch
    // captures. Judged by the boot rule (no marker anywhere), such a pane is
    // never clear again and the launch never resumes.
    const ANSWERED_WITH_HISTORY = Object.freeze([...TRUST_DIALOG, ...COMPOSER]);

    it('dialog text left in history with a stable prompt below it resumes: `answered`', async () => {
      play([TRUST_DIALOG, ANSWERED_WITH_HISTORY]);
      const res = await watch();
      assert.equal(res.outcome, 'answered');
      assert.equal(res.dialog.code, 'trust_required');
      assert.ok(res.waitedMs < startupDialog.ANSWER_WINDOW_MS, 'well before the answer window ends');
    });

    it('it still takes two stable reads: a prompt seen once below the history is not yet the answer', async () => {
      const moving = [...TRUST_DIALOG, ...COMPOSER, '  output still arriving'];
      play([TRUST_DIALOG, ANSWERED_WITH_HISTORY, moving, ANSWERED_WITH_HISTORY, ANSWERED_WITH_HISTORY]);
      startupDialog._internal.paneDigest = (lines) => lines.join('\n');
      const reads = [];
      const real = startupDialog._internal.capturePane;
      startupDialog._internal.capturePane = (...a) => { const r = real(...a); reads.push(r.lines.length); return r; };
      const res = await watch();
      assert.equal(res.outcome, 'answered');
      assert.ok(reads.length >= 5, `answered only once the frame held still (reads: ${reads.length})`);
    });

    it('a stale composer ABOVE a live dialog still withholds', async () => {
      play([TRUST_DIALOG, [...COMPOSER, ...TRUST_DIALOG]]);
      const res = await watch({ answerWindowMs: 6000 });
      assert.equal(res.outcome, 'unanswered');
    });

    it('a stale composer above a HALF-DRAWN dialog still withholds', async () => {
      play([TRUST_DIALOG, [...COMPOSER, ...TRUST_DIALOG.slice(0, 13)]]);
      assert.equal((await watch({ answerWindowMs: 6000 })).outcome, 'unanswered');
    });

    it('the boot stage stays conservative: marker text with a prompt below it is not yet clear', async () => {
      // Before any dialog has been seen, text that looks like one is taken as
      // one on its way. A fresh pane has no history to quote it from.
      play([ANSWERED_WITH_HISTORY]);
      const res = await watch();
      assert.equal(res.outcome, 'timeout');
      assert.deepEqual(seen, [], 'and no dialog is reported, because none was fully on screen');
    });

    it('the one-read check and the answer stage agree on every frame', () => {
      const frames = {
        dialog: TRUST_DIALOG,
        composer: COMPOSER,
        'answered, text in history': ANSWERED_WITH_HISTORY,
        'composer above a dialog': [...COMPOSER, ...TRUST_DIALOG],
        'composer above half a dialog': [...COMPOSER, ...TRUST_DIALOG.slice(0, 13)],
        'half a dialog': TRUST_DIALOG.slice(0, 13),
        quoting: QUOTING_SESSION,
        neither: ['  Verifying your account…'],
        empty: []
      };
      startupDialog._internal.settleSync = () => {};
      for (const [name, lines] of Object.entries(frames)) {
        startupDialog._internal.capturePaneSync = () => served(lines);
        const viaCheck = startupDialog.check('t', CLAUDE);
        const viaClassify = startupDialog.classify(lines, DIALOGS, WAKE, cursorOf(lines));
        assert.equal(viaCheck.clear, viaClassify.state === 'clear', `clear: ${name}`);
        assert.equal(!!viaCheck.dialog, viaClassify.state === 'dialog', `dialog: ${name}`);
      }
      assert.equal(startupDialog.classify(ANSWERED_WITH_HISTORY, DIALOGS, WAKE, cursorOf(ANSWERED_WITH_HISTORY)).state, 'clear');
      assert.equal(startupDialog.classify([...COMPOSER, ...TRUST_DIALOG], DIALOGS, WAKE).state, 'dialog');
    });
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
      assert.ok(store.CURRENT_SCHEMA_VERSION >= 58);
      const stamped = store.getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get().v;
      assert.equal(stamped, store.CURRENT_SCHEMA_VERSION);
      const cols = store.getDb().prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
      assert.ok(cols.includes('launch_blocker'));
    });

    // v57 is the store just before this migration (v57 added a column to
    // another table, #2186). v56 is one release further back, and must come
    // through both steps.
    for (const from of [57, 56]) it(`a v${from} store gains the column on upgrade and keeps its sessions`, () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tc-startup-dialog-v${from}-`));
      try {
        store.close();
        store._setBasePath(dir);
        store.init();
        const p = store.projects.create({ name: 'carried', path: path.join(dir, 'carried'), engine: 'claude' });
        const s = store.sessions.start({ projectId: p.id, engineId: 'claude', tmuxSession: 'carried' });
        store.close();
        const db = new DatabaseSync(path.join(dir, 'tangleclaw.db'));
        // Put `sessions` back to its earlier shape by rebuilding it from its own
        // stored DDL with the one column line removed. Not `DROP COLUMN`: the
        // column is the last one and its line carries a trailing SQL comment,
        // and some SQLite builds rewrite that into DDL they then cannot parse.
        const ddl = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'sessions'").get().sql;
        const beforeDdl = ddl
          .split('\n')
          .filter((line) => !/^\s*launch_blocker\b/.test(line))
          .join('\n')
          // The line above it ended with the comma that separated the two.
          .replace(/(launch_dirty\s+TEXT),/, '$1')
          .replace(/^CREATE TABLE\s+(IF NOT EXISTS\s+)?"?sessions"?/, 'CREATE TABLE sessions_before');
        assert.doesNotMatch(beforeDdl, /launch_blocker/, 'precondition: the rebuilt DDL has no such column');
        const kept = db.prepare('PRAGMA table_info(sessions)').all().map((c) => c.name).filter((c) => c !== 'launch_blocker').join(', ');
        db.exec('PRAGMA foreign_keys = OFF');
        db.exec('PRAGMA legacy_alter_table = ON');
        db.exec(beforeDdl);
        db.exec(`INSERT INTO sessions_before (${kept}) SELECT ${kept} FROM sessions`);
        db.exec('DROP TABLE sessions');
        db.exec('ALTER TABLE sessions_before RENAME TO sessions');
        assert.ok(!db.prepare('PRAGMA table_info(sessions)').all().some((c) => c.name === 'launch_blocker'),
          'precondition: the earlier store has no launch_blocker column');
        db.exec('DELETE FROM schema_version');
        db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(from);
        db.close();

        store.init();
        const cols = store.getDb().prepare('PRAGMA table_info(sessions)').all().map((c) => c.name);
        assert.ok(cols.includes('launch_blocker'));
        assert.equal(store.getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get().v, store.CURRENT_SCHEMA_VERSION);
        assert.ok(store.getDb().prepare('SELECT MAX(version) AS v FROM schema_version').get().v >= 58, 'this migration is v58: v57 belongs to #2186');
        assert.ok(store.getDb().prepare('PRAGMA table_info(startup_prompt_fires)').all().some((c) => c.name === 'dispatch_note'), 'and the v57 column is there too');
        assert.equal(store.sessions.get(s.id).launchBlocker, null, 'a session from before has no blocker');
        // The rebuild above dropped the table's three indexes with it. A real
        // earlier store has them; init creates them if absent, so the upgraded
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
        tmux.capturePane = () => served(COMPOSER);
        const status = sessions.getSessionStatus(project.name);
        assert.equal(status.active, true);
        assert.equal(status.launchBlocker, null);
        assert.equal(store.sessions.get(s.id).launchBlocker, null);
      });

      it('and a death long after is then not blamed on the dialog', () => {
        const s = start();
        store.sessions.setLaunchBlocker(s.id, BLOCKER);
        tmux.capturePane = () => served(COMPOSER);
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
        tmux.capturePane = () => served(TRUST_DIALOG);
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
        tmux.capturePane = () => served([]);
        assert.equal(sessions.getSessionStatus(project.name).launchBlocker.code, 'trust_required');
        tmux.capturePane = () => served(['', '   ', '']);
        assert.equal(sessions.getSessionStatus(project.name).launchBlocker.code, 'trust_required');
        assert.equal(store.sessions.get(s.id).launchBlocker.code, 'trust_required');
      });

      it('a screen showing neither a dialog nor the prompt clears nothing', () => {
        const s = start();
        store.sessions.setLaunchBlocker(s.id, BLOCKER);
        tmux.capturePane = () => served(['  Verifying your account…']);
        assert.equal(sessions.getSessionStatus(project.name).launchBlocker.code, 'trust_required');
        assert.equal(store.sessions.get(s.id).launchBlocker.code, 'trust_required');
      });

      it('a healthy session with no blocker is not read for one', () => {
        start();
        let reads = 0;
        const real = startupDialog.check;
        startupDialog.check = (...args) => { reads += 1; return real(...args); };
        try {
          tmux.capturePane = () => served(COMPOSER);
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
      tmux.capturePane = () => served(COMPOSER);
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
      tmux.capturePane = () => served(TRUST_DIALOG.slice(0, 13));
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

      it('with no row to ask and a holder lookup that throws, only a positive reading sends', () => {
        const realLookup = store.sessions.getActiveByTmuxSession;
        store.sessions.getActiveByTmuxSession = () => { throw new Error('database is locked'); };
        try {
          tmux.capturePane = () => served([]);
          assert.equal(sessions._startupDialogAtSend('some-pane', CLAUDE, 'claude', project.name, null).code, 'launch_blocker_unreadable');
          tmux.capturePane = () => served(COMPOSER);
          assert.equal(sessions._startupDialogAtSend('some-pane', CLAUDE, 'claude', project.name, null), null);
        } finally {
          store.sessions.getActiveByTmuxSession = realLookup;
        }
      });

      it('a store that cannot say whether the session ended leaves the decision to the pane and its holder', () => {
        const s = start();
        store.sessions.setLaunchBlocker(s.id, BLOCKER);
        const realGet = store.sessions.get;
        store.sessions.get = () => { throw new Error('database is locked'); };
        try {
          tmux.capturePane = () => served([]);
          assert.equal(sessions._startupDialogAtSend(s.tmuxSession, CLAUDE, 'claude', project.name, { sessionId: s.id }).code, 'trust_required');
          tmux.capturePane = () => served(COMPOSER);
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
        tmux.capturePane = () => served([]);
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

    it('dialogs declared but no prompt signature known: the launch types nothing, and the ledger names the remedy', async () => {
      const s = start();
      const rows = [];
      const realRecord = store.sessionRuleDeliveries.record;
      store.sessionRuleDeliveries.record = (entry) => { rows.push(entry); return entry; };
      watchAnswers('unprofiled');
      try {
        const done = new Promise((resolve) => { launchFinished = resolve; });
        sessions._deferEngineInit(
          s.tmuxSession, project.name, 'claude', WITH_PREKEY, 'the prime', null, false,
          { sessionId: s.id, projectId: project.id, engineId: 'claude', kind: 'startup', ruleIds: [1], digest: 'd' },
          { sessionId: s.id, projectId: project.id, hasSequence: true }
        );
        await done;
        await new Promise((resolve) => setTimeout(resolve, WITH_PREKEY.launch.startupDelay + 2));
        await turns();
      } finally {
        store.sessionRuleDeliveries.record = realRecord;
      }
      assert.deepEqual(typed, [], 'no pre-key and no paste');
      assert.deepEqual(kicked, []);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].outcome, 'skipped');
      assert.match(rows[0].skipReason, /^prompt_unverified: .*cannot tell a finished boot from a dialog and typed nothing/);
      assert.match(rows[0].skipReason, /Add a measured wake declaration to the profile, or start the session by typing in its pane/);
      assert.equal(store.sessions.get(s.id).launchBlocker, null, 'no dialog was seen, so none is recorded');
    });

    it('the operator answers, the dialog\'s text stays in history: the REAL watch resumes and the prime and kickoff are sent', async () => {
      const s = start();
      const history = [...TRUST_DIALOG, ...COMPOSER];
      const frames = [TRUST_DIALOG, TRUST_DIALOG, history];
      let clock = 0;
      startupDialog._internal.now = () => clock;
      startupDialog._internal.sleep = async (ms) => { clock += ms; };
      startupDialog._internal.wakeProfiles = () => ({ claude: WAKE });
      startupDialog._internal.paneDigest = (lines) => lines.join('\n');
      startupDialog._internal.capturePane = async () => served(frames.length > 1 ? frames.shift() : frames[0]);
      // What each send's own look sees once the watch has let the launch go.
      tmux.capturePane = () => served(history);
      await launched(s);
      assert.ok(typed.some((t) => t.text === 'the prime'), 'the prime was pasted');
      assert.equal(kicked.length, 1, 'and the kickoff was asked');
      assert.equal(store.sessions.get(s.id).launchBlocker, null, 'the blocker recorded at the dialog is cleared');
      assert.equal(store.activity.query({ sessionId: s.id, eventType: 'session.launch_blocked' }).length, 1);
      assert.equal(store.activity.query({ sessionId: s.id, eventType: 'session.launch_unblocked' }).length, 1);
    });

    it('a withheld launch says why in the log even when no prime was owed', async () => {
      const s = start();
      watchAnswers('unprofiled');
      let out = '';
      setConsoleStream({ write: (chunk) => { out += chunk; } });
      setLevel('warn');
      try {
        await launched(s, { silentPrime: true });
      } finally {
        setLevel('error');
        setConsoleStream(null);
      }
      assert.deepEqual(typed, []);
      assert.match(out, /Launch sends withheld by the boot gate/);
      assert.match(out, /prompt_unverified/);
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
      tmux.capturePane = () => served(pane);
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
        'the read comes back empty': () => served([]),
        'the pane shows neither the dialog nor the prompt': () => served(['  Verifying your account…']),
        'the dialog is half-drawn': () => served(TRUST_DIALOG.slice(0, 13))
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

      describe('when the stored blocker cannot be READ, it is not assumed absent', () => {
        // The record is the floor under the readings that fall short. A lookup
        // that throws is "unknown", and only a positive prompt reading may
        // then let a send through.
        let realLookup;
        beforeEach(() => {
          realLookup = store.sessions.getActiveByTmuxSession;
          store.sessions.getActiveByTmuxSession = () => { throw new Error('database is locked'); };
        });
        afterEach(() => { store.sessions.getActiveByTmuxSession = realLookup; });

        it('an unreadable pane refuses, and says the record could not be read, not that a dialog was seen', () => {
          const s = start();
          for (const capture of [
            () => { throw new Error('tmux did not answer'); },
            () => served([])
          ]) {
            tmux.capturePane = capture;
            const refusal = tmux._startupDialogOn(s.tmuxSession, 'claude');
            assert.equal(refusal.code, 'launch_blocker_unreadable');
            assert.equal(refusal.label, null);
            assert.match(refusal.why, /could not read whether a launch blocker is recorded for this session \(database is locked\)/);
            assert.doesNotMatch(startupDialog.refusalText(refusal), /trust|dialog/i, 'it claims no dialog');
          }
        });

        it('an undecided pane (neither dialog nor prompt) refuses the same way', () => {
          const s = start();
          tmux.capturePane = () => served(['  Verifying your account…']);
          assert.equal(tmux._startupDialogOn(s.tmuxSession, 'claude').code, 'launch_blocker_unreadable');
        });

        it('a dialog, or part of one, still withholds under its own name', () => {
          const s = start();
          tmux.capturePane = () => served(TRUST_DIALOG);
          assert.equal(tmux._startupDialogOn(s.tmuxSession, 'claude').code, 'trust_required');
          tmux.capturePane = () => served(TRUST_DIALOG.slice(0, 13));
          assert.equal(tmux._startupDialogOn(s.tmuxSession, 'claude').code, 'trust_required');
        });

        it('only a positive prompt reading lets the send through', () => {
          const s = start();
          tmux.capturePane = () => served(COMPOSER);
          assert.equal(tmux._startupDialogOn(s.tmuxSession, 'claude'), null);
          tmux.capturePane = () => served(QUOTING_SESSION);
          assert.equal(tmux._startupDialogOn(s.tmuxSession, 'claude'), null, 'a prompt below quoted dialog text is positive too');
          tmux.capturePane = () => served(['❯', 'No, exit']);
          assert.notEqual(tmux._startupDialogOn(s.tmuxSession, 'claude'), null, 'a prompt ABOVE a marker is not');
        });

        it('a send that names no engine, or an engine with no declared dialog, cannot be positively read, so it is refused', () => {
          const s = start();
          tmux.capturePane = () => served(COMPOSER);
          assert.equal(tmux._startupDialogOn(s.tmuxSession, null).code, 'launch_blocker_unreadable');
          assert.equal(tmux._startupDialogOn(s.tmuxSession, 'aider').code, 'launch_blocker_unreadable');
        });

        it('the real writer throws STARTUP_DIALOG with that code and types nothing', () => {
          const s = start();
          tmux.capturePane = () => served([]);
          tmux.sendKeys = realSendKeys;
          const unreadablePane = uniqueSessionName('startup_dialog_unreadable');
          tmux.hasSession = realHas;
          tmux.createSession(unreadablePane, { command: 'exec bash --norc --noprofile' });
          try {
            assert.throws(() => tmux.sendKeys(unreadablePane, 'SHOULD-NOT-PASTE', { enter: true, engineId: 'claude' }), (err) => {
              assert.equal(err.code, 'STARTUP_DIALOG');
              assert.equal(err.startupDialog.code, 'launch_blocker_unreadable');
              assert.match(err.message, /^launch_blocker_unreadable: nothing was typed into the session\. /);
              return true;
            });
            tmux.capturePane = realCapture;
            require('node:child_process').execSync('sleep 0.3');
            assert.doesNotMatch(tmux.capturePane(unreadablePane, { full: true }).lines.join('\n'), /SHOULD-NOT-PASTE/);
          } finally {
            try { tmux.killSession(unreadablePane); } catch { /* already gone */ }
          }
          assert.ok(s.id);
        });
      });

      describe('a lookup that SUCCEEDS and finds no session is a different fact: an ordinary send', () => {
        it('no active row for the pane, and the pane unread: not refused', () => {
          tmux.capturePane = () => served([]);
          assert.equal(store.sessions.getActiveByTmuxSession('nobody-holds-this-pane'), null, 'precondition: the lookup answers, with no row');
          assert.equal(tmux._startupDialogOn('nobody-holds-this-pane', 'claude'), null);
          assert.equal(tmux._startupDialogOn('nobody-holds-this-pane', null), null);
        });

        it('a process with no store open is its own explicit case, asked of the store, not inferred from a throw', () => {
          const realGetDb = store.getDb;
          const realLookup = store.sessions.getActiveByTmuxSession;
          let asked = 0;
          store.getDb = () => null;
          store.sessions.getActiveByTmuxSession = () => { asked += 1; throw new Error('Store not initialized'); };
          try {
            tmux.capturePane = () => served([]);
            assert.equal(tmux._startupDialogOn('standalone-pane', 'claude'), null);
            assert.equal(asked, 0, 'the lookup is not attempted, so nothing is inferred from its failure');
            tmux.capturePane = () => served(TRUST_DIALOG);
            assert.equal(tmux._startupDialogOn('standalone-pane', 'claude').code, 'trust_required', 'and a dialog on screen still withholds there');
          } finally {
            store.getDb = realGetDb;
            store.sessions.getActiveByTmuxSession = realLookup;
          }
        });
      });

      it('the positive reading clears it and the send goes through', () => {
        const s = start();
        store.sessions.setLaunchBlocker(s.id, BLOCKER);
        tmux.capturePane = () => served(COMPOSER);
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
          const viaWake = require('../lib/medusa-wake')._internal.injectCommand(project.name, 'you have mail', { sessionId: s.id, controlExempt: 'medusa-wake' });
          assert.equal(viaWake.ok, false);
          if (when === 'no profile is found') {
            // A profile that cannot be fetched is refused in its own right, for
            // every sender. The recorded blocker is named in it as recorded and
            // uncleared, never as on screen.
            assert.match(viaApi.error, /^startup_dialogs_unreadable: .*engine profile "claude" could not be fetched: no such engine profile is installed/);
            assert.match(viaApi.error, /A launch blocker is also recorded for this session and has not been cleared \(trust_required, the engine's folder trust dialog\); TangleClaw cannot tell from here whether that dialog is still on screen/);
            assert.equal(tmux._startupDialogOn(s.tmuxSession, 'claude').code, startupDialog.DECLARATION_UNREADABLE);
          } else {
            assert.match(viaApi.error, /^trust_required: .*declares no such dialog now/);
            assert.equal(tmux._startupDialogOn(s.tmuxSession, 'claude').code, 'trust_required');
          }
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
      tmux.capturePane = () => served(reads.length > 1 ? reads.shift() : reads[0]);
      const res = sessions.injectCommand(project.name, 'hello');
      assert.equal(res.ok, false);
      assert.match(res.error, /^trust_required: .*may still be drawing/);
      assert.deepEqual(typed, []);
      assert.equal(store.sessions.get(s.id).launchBlocker, null);
    });

    it('a half-drawn dialog withholds a send even with no blocker stored, and records none', () => {
      const s = start();
      tmux.capturePane = () => served(TRUST_DIALOG.slice(0, 13));
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
      tmux.capturePane = () => served(TRUST_DIALOG);
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

  it('the synchronous cursor read says whether the cursor is shown, on a real pane', () => {
    try {
      openPane();
      assert.equal(tmux.cursorInfo(PANE).visible, true, 'a shell shows its cursor');
      require('node:child_process').execSync(`tmux send-keys -t '=${PANE}:' 'tput civis' Enter`);
      require('node:child_process').execSync('sleep 0.5');
      assert.equal(tmux.cursorInfo(PANE).visible, false, 'and tmux reports it hidden once the program hides it');
    } finally {
      try { tmux.killSession(PANE); } catch { /* already gone */ }
    }
  });

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

/**
 * What counts as the engine's prompt (the A160 hold on #2183).
 *
 * The first cut of this module read ANY row led by the prompt glyph as the
 * composer. A selector draws its selected option with that glyph, so
 * "❯ 2. Yes, I accept" read as a prompt, a send was allowed, and a stored
 * blocker was cleared on it.
 *
 * Frames marked REAL were captured from Claude Code 2.1.283 on 2026-10-07 in an
 * empty repository with no turn taken: rows, the styled cursor row and the
 * cursor column as tmux reported them. Four selectors were captured that way (the
 * `/model` menu, the onboarding theme picker, the login-method selector, and the
 * folder trust dialog). The Bypass Permissions confirmation
 * could not be captured (the host has it switched off, and a private config
 * home stops at a login first), so that frame is the
 * text from the report, and is marked UNVERIFIED.
 */
describe('only the composer at rest is a prompt (#2128, A160)', () => {
  const medusaWake = require('../lib/medusa-wake');
  const BORDER = '─'.repeat(100);
  const FOOTER = ['  repo (main) | Opus 5.5', '  ⏵⏵ auto mode on (shift+tab to cycle)'];
  const HEAD = ['', ' ▐▛███▛█   Claude Code v2.1.283', '▝▜██████▀  Opus 5.5 · Claude Max', ' ▝▝   ▝▝   /…/scratchpad/spike2128/repo', ''];

  // REAL: the fresh composer. Border, the row, border; cursor shown at column 2.
  const FRESH_ROW = '❯ Try "how does <filepath> work?"';
  const FRESH_CURSOR = Object.freeze({ visible: true, x: 2, y: 36, line: `${ESC}[39m❯ ${ESC}[2mTry "how does <filepath> work?"${ESC}[0m` });
  const FRESH = at(Object.freeze([...HEAD, BORDER, FRESH_ROW, BORDER, ...FOOTER]), FRESH_CURSOR);

  // REAL: `/model` typed and not submitted. Cursor shown after the text.
  const DRAFT_CURSOR = Object.freeze({ visible: true, x: 8, y: 36, line: `${ESC}[39m❯ ${ESC}[38;5;153m/model${ESC}[39m` });
  const DRAFT = at(Object.freeze([...HEAD, BORDER, '❯ /model', BORDER, ...FOOTER]), DRAFT_CURSOR);

  // REAL: the `/model` selector. The cursor is hidden and parked ON the selected row's glyph.
  const MENU_HEAD = ['▔'.repeat(100), '   Select model', '   Switch between Claude models. Your pick becomes the default for new sessions.', ''];
  const MENU_FOOT = ['     4.  Haiku 4.5              Fastest for quick answers', '', '   Enter to set as default · s to use this session only · Esc to cancel'];
  const MODEL_MENU = at(Object.freeze([
    ...HEAD, ...MENU_HEAD,
    '     1.  Default (recommended)  Opus 5.5 · Best for everyday, complex tasks',
    '   ❯ 2.  Opus 5.5 ✔             For complex work and everyday tasks',
    '     3.  Fable 5.1              For your toughest challenges',
    ...MENU_FOOT
  ]), Object.freeze({
    visible: false, x: 3, y: 26,
    line: `   ${ESC}[38;5;153m❯${ESC}[39m ${ESC}[38;5;246m2.  ${ESC}[38;5;114mOpus 5.5${ESC}[39m ${ESC}[38;5;114m✔${ESC}[39m             ${ESC}[38;5;246mFor complex work and everyday tasks${ESC}[39m`
  }));
  const MODEL_MENU_DOWN = at(Object.freeze([
    ...HEAD, ...MENU_HEAD,
    '     1.  Default (recommended)  Opus 5.5 · Best for everyday, complex tasks',
    '     2.  Opus 5.5 ✔             For complex work and everyday tasks',
    '   ❯ 3.  Fable 5.1              For your toughest challenges',
    ...MENU_FOOT
  ]), Object.freeze({
    visible: false, x: 3, y: 27,
    line: `   ${ESC}[38;5;153m❯${ESC}[39m ${ESC}[38;5;246m3.  ${ESC}[38;5;153mFable 5.1${ESC}[39m              ${ESC}[38;5;246mFor your toughest challenges${ESC}[39m`
  }));

  // REAL: after Esc. The submitted `/model` is a transcript row under the same glyph; the composer is bare.
  const AFTER_MENU = at(Object.freeze([
    ...HEAD, '❯ /model', '  ⎿  Kept model as Opus 5.5', '', BORDER, '❯ ', BORDER, ...FOOTER
  ]), Object.freeze({ x: 2, y: 36, line: `${ESC}[39m❯ ` }));

  // REAL: the folder trust dialog's cursor, hidden and parked on the selected row's glyph.
  const TRUST_CURSOR = Object.freeze({ visible: false, x: 1, y: 14, line: ` ${ESC}[38;5;153m❯${ESC}[39m ${ESC}[38;5;153mNo,${ESC}[39m ${ESC}[38;5;153mexit${ESC}[39m` });

  // UNVERIFIED: the Bypass Permissions confirmation, from the report's text. It carries ONE of the trust dialog's two markers.
  const BYPASS_HEAD = [BORDER, ' WARNING: Claude Code running in Bypass Permissions mode', '', ' In Bypass Permissions mode, Claude Code will not ask for your approval before running', ' potentially dangerous commands.', ''];
  const BYPASS_FOOT = ['', ' Enter to confirm · Esc to cancel'];
  const BYPASS_1 = Object.freeze([...BYPASS_HEAD, ' ❯ 1. No, exit', '   2. Yes, I accept', ...BYPASS_FOOT]);
  const BYPASS_2 = Object.freeze([...BYPASS_HEAD, '   1. No, exit', ' ❯ 2. Yes, I accept', ...BYPASS_FOOT]);

  // REAL: first-run onboarding in an empty config home (no account): the theme picker and the
  // login-method selector. Both numbered, neither carrying declared text; cursor hidden on the glyph.
  const THEME_PICKER = at(Object.freeze([
    'Welcome to Claude Code v2.1.283', '', " Let's get started.", '', ' Choose the text style that looks best with your terminal', ' To change this later, run /theme', '',
    '   1. Auto (match terminal)', ' ❯ 2. Dark mode ✔', '   3. Light mode', '   4. Dark mode (colorblind-friendly)', '',
    ` ${'╌'.repeat(99)}`, '  1  function greet() {', '  3  }', ` ${'╌'.repeat(99)}`, '  Syntax theme: Monokai Extended (ctrl+t to disable)'
  ]), Object.freeze({
    visible: false, x: 1, y: 23,
    line: ` ${ESC}[38;5;153m❯${ESC}[39m ${ESC}[38;5;246m2.${ESC}[39m ${ESC}[38;5;114mDark${ESC}[39m ${ESC}[38;5;114mmode${ESC}[39m ${ESC}[38;5;114m✔${ESC}[39m`
  }));
  const LOGIN_METHOD = at(Object.freeze([
    'Welcome to Claude Code v2.1.283', '', ' Claude Code can be used with your Claude subscription or billed based on API usage.', '', ' Select login method:', '',
    ' ❯ 1. Claude account with subscription · Pro, Max, Team, or Enterprise', '   2. Anthropic Console account · API usage billing',
    '   3. 3rd-party platform · Amazon Bedrock, Microsoft Foundry, or Vertex AI'
  ]), Object.freeze({
    visible: false, x: 1, y: 22,
    line: ` ${ESC}[38;5;153m❯${ESC}[39m ${ESC}[38;5;246m1.${ESC}[39m ${ESC}[38;5;153mClaude account with subscription · ${ESC}[38;5;246mPro, Max, Team, or Enterprise${ESC}[39m`
  }));

  // A selector with no declared text at all.
  const MENU_1 = Object.freeze([' Do you want to proceed?', ' ❯ 1. Yes', '   2. No', '', ' Esc to cancel']);
  const MENU_2 = Object.freeze([' Do you want to proceed?', '   1. Yes', ' ❯ 2. No', '', ' Esc to cancel']);

  /** Every cursor a selector row could plausibly be read with: none, on the glyph, just past it, at the row's end. */
  const cursorsOn = (row) => [null, { x: row.indexOf('❯'), y: 9, line: row }, { x: row.indexOf('❯') + 2, y: 9, line: row }, { x: row.length, y: 9, line: row }];

  const classify = (lines, cursor = cursorOf(lines)) => startupDialog.classify(lines, DIALOGS, WAKE, cursor).state;
  const boot = (lines, cursor = cursorOf(lines)) => startupDialog.assessBoot(lines, DIALOGS, WAKE, cursor).state;

  const NOT_A_PROMPT = Object.freeze({
    'bypass confirmation, option 1 selected': BYPASS_1,
    'bypass confirmation, option 2 selected': BYPASS_2,
    'a selector with no declared text, option 1 selected': MENU_1,
    'a selector with no declared text, option 2 selected': MENU_2,
    'the real /model selector': MODEL_MENU,
    'the real /model selector, next option selected': MODEL_MENU_DOWN,
    'the real onboarding theme picker': THEME_PICKER,
    'the real login-method selector': LOGIN_METHOD,
    'a composer holding typed text': DRAFT
  });

  afterEach(() => { Object.assign(startupDialog._internal, REAL_SEAMS); });

  describe('one frame', () => {
    it('the measured bare-composer pattern is what Claude declares, and an option row does not match it', () => {
      assert.equal(WAKE.promptRe.source, CLAUDE.capabilities.wake.promptPattern);
      for (const bare of ['❯', '❯ ', '❯ ', '  ❯ ']) assert.ok(WAKE.promptRe.test(bare), JSON.stringify(bare));
      for (const not of [' ❯ 2. Yes, I accept', ' ❯ 1. Yes', FRESH_ROW, '❯ /model', '❯  ']) assert.ok(!WAKE.promptRe.test(not), JSON.stringify(not));
    });

    it('REAL: a fresh composer showing its suggestion is clear, on its cursor, its styling and its box together', () => {
      assert.equal(medusaWake._composerEmpty(FRESH_CURSOR, WAKE), true, 'precondition: the cursor reading says empty');
      assert.equal(classify(FRESH), 'clear');
      assert.equal(boot(FRESH), 'clear');
    });

    it('the same frame is NOT clear without each of those', () => {
      assert.equal(classify(FRESH, null), 'noncomposer', 'no cursor reading');
      assert.equal(boot(FRESH, null), 'undecided');
      const unstyled = { ...FRESH_CURSOR, line: FRESH_ROW };
      assert.equal(classify(FRESH, unstyled), 'noncomposer', 'a cursor row with no styling: the suggestion reads as typed text');
      assert.equal(classify(FRESH, { ...FRESH_CURSOR, visible: false }), 'noncomposer', 'the cursor hidden, as on every selector captured');
      assert.equal(classify(FRESH, { ...FRESH_CURSOR, visible: null }), 'noncomposer', 'tmux did not say whether the cursor is shown');
      const { visible: _omitted, ...noFlag } = FRESH_CURSOR;
      assert.equal(classify(FRESH, noFlag), 'noncomposer', 'a cursor reading with no visibility flag at all');
      assert.equal(boot(FRESH, noFlag), 'undecided');
      assert.equal(classify(FRESH, { ...FRESH_CURSOR, x: 0 }), 'noncomposer', 'the cursor on the glyph, as a selector parks it');
      assert.equal(classify(FRESH, { ...FRESH_CURSOR, x: 12 }), 'noncomposer', 'the cursor past text: that text was typed');
      assert.equal(classify(FRESH, { x: 2, y: 3, line: `❯ ${ESC}[2mTry something else${ESC}[0m` }), 'noncomposer', 'the cursor on some other row');
      const noUpper = FRESH.filter((row, i) => i !== FRESH.indexOf(BORDER));
      assert.equal(classify(noUpper, FRESH_CURSOR), 'noncomposer', 'no border directly above');
      const noLower = FRESH.filter((row, i) => i !== FRESH.lastIndexOf(BORDER));
      assert.equal(classify(noLower, FRESH_CURSOR), 'noncomposer', 'no border directly below');
    });

    it('REAL: a bare composer is clear with no cursor reading, and the transcript row above it under the same glyph does not matter', () => {
      assert.equal(classify(AFTER_MENU, null), 'clear');
      assert.equal(classify(AFTER_MENU), 'clear');
      assert.equal(boot(AFTER_MENU, null), 'clear');
    });

    for (const [name, lines] of Object.entries(NOT_A_PROMPT)) {
      it(`${name}: never a prompt, wherever the cursor is`, () => {
        const selected = lines.find((row) => row.trimStart().startsWith(GLYPH));
        for (const cursor of [cursorOf(lines), ...cursorsOn(selected)]) {
          const state = classify(lines, cursor);
          assert.notEqual(state, 'clear', `cursor ${JSON.stringify(cursor && cursor.x)}`);
          assert.notEqual(state, 'unknown', 'and not the "nothing recognised" a launch types through');
          assert.equal(boot(lines, cursor), 'undecided');
          assert.equal(startupDialog.detect(lines, DIALOGS, WAKE, cursor), null, 'nor is it reported as the folder trust dialog');
        }
      });
    }

    it('names what it can: the bypass frame shows declared text, so it is part of a dialog with either option selected; the rest name none', () => {
      for (const lines of [BYPASS_1, BYPASS_2]) {
        for (const cursor of [null, ...cursorsOn(lines.find((row) => row.trimStart().startsWith(GLYPH))).map((c) => c && { ...c, visible: true })]) {
          assert.equal(classify(lines, cursor), 'partial', 'whatever the cursor reading, shown included: it has no composer box');
        }
        assert.equal(startupDialog.classify(lines, DIALOGS, WAKE).partial.code, 'trust_required');
      }
      for (const lines of [MENU_1, MENU_2, MODEL_MENU, MODEL_MENU_DOWN, THEME_PICKER, LOGIN_METHOD, DRAFT]) assert.equal(classify(lines), 'noncomposer');
    });

    it('REAL: on every selector captured, the cursor is on the selected row\'s glyph, which the composer reading rejects by itself', () => {
      for (const lines of [MODEL_MENU, MODEL_MENU_DOWN, THEME_PICKER, LOGIN_METHOD]) {
        const cursor = cursorOf(lines);
        assert.equal([...medusaWake._strip(cursor.line)].indexOf(GLYPH), cursor.x, 'the cursor column is the glyph\'s');
        assert.equal(medusaWake._composerEmpty(cursor, WAKE), null);
        assert.ok(!cursor.line.includes(`${ESC}[2m`), 'and nothing on the row is drawn faint');
      }
    });

    it('REAL: the folder trust dialog is still the dialog with its real cursor', () => {
      assert.equal(medusaWake._composerEmpty(TRUST_CURSOR, WAKE), null, 'the cursor sits on the glyph, not at an input column');
      assert.equal(classify(TRUST_DIALOG, TRUST_CURSOR), 'dialog');
    });

    it('a selected option painted faint, with the cursor where a composer keeps it, is still not a prompt', () => {
      // `_composerEmpty` alone passes this row. Whether any menu paints an
      // option this way is unverified, so nothing rests on its not happening.
      const faint = { visible: true, x: 2, y: 9, line: `❯ ${ESC}[2m2. Yes, I accept${ESC}[0m` };
      assert.equal(medusaWake._composerEmpty(faint, WAKE), true, 'precondition: the cursor reading alone says "empty composer"');
      const row = '❯ 2. Yes, I accept';
      assert.equal(classify([...BYPASS_HEAD, '   1. No, exit', row, ...BYPASS_FOOT], faint), 'partial', 'no border on either side, under declared text');
      assert.equal(classify([' Proceed?', '   1. No', row, '', ' Esc to cancel'], faint), 'noncomposer', 'the same with no declared text');
      assert.equal(classify([' Proceed?', BORDER, row, '   3. Something else', BORDER], faint), 'noncomposer', 'a border above only: the option below gives it away');
      assert.equal(classify([' Proceed?', BORDER, '   1. No', row, BORDER], faint), 'noncomposer', 'a border below only');
    });

    it('ordering: a stale composer ABOVE a selected option does not clear, with the cursor reading on either row', () => {
      const staleBare = [...AFTER_MENU, ...BYPASS_2];
      assert.equal(classify(staleBare, null), 'partial');
      assert.equal(classify(staleBare, cursorOf(AFTER_MENU)), 'partial', 'the cursor still reported on the old composer');
      assert.equal(classify([...AFTER_MENU, ...MENU_2], cursorOf(AFTER_MENU)), 'noncomposer', 'the same with no declared marker on screen');
      const staleFresh = [...FRESH, ...BYPASS_2];
      assert.equal(classify(staleFresh, FRESH_CURSOR), 'partial');
      assert.equal(classify([...FRESH, ...MENU_2], FRESH_CURSOR), 'noncomposer', 'the same with no declared marker on screen');
      assert.equal(classify([...FRESH, ...BYPASS_1], FRESH_CURSOR), 'partial');
      assert.equal(boot(staleFresh, FRESH_CURSOR), 'undecided');
    });

    it('ordering: an answered menu left ABOVE a fresh composer is history, and the composer clears', () => {
      assert.equal(classify([...BYPASS_2, ...FRESH], FRESH_CURSOR), 'clear');
      assert.equal(classify([...BYPASS_1, ...AFTER_MENU], null), 'clear');
      assert.equal(classify([...MENU_2, ...FRESH], FRESH_CURSOR), 'clear');
      assert.equal(classify([...TRUST_DIALOG, ...FRESH], FRESH_CURSOR), 'clear', 'the #2213 case, on the real suggestion row');
      assert.equal(classify([...TRUST_DIALOG, ...FRESH], null), 'partial', 'and without the cursor that proves it, the dialog\'s text still withholds every sender');
      assert.equal(classify([...TRUST_DIALOG, ...FRESH], { ...FRESH_CURSOR, visible: false }), 'partial', 'the same with the cursor hidden');
      assert.equal(classify([...TRUST_DIALOG, ...FRESH], { ...FRESH_CURSOR, visible: null }), 'partial', 'or with tmux not saying whether it is shown');
      assert.equal(boot([...BYPASS_2, ...FRESH], FRESH_CURSOR), 'undecided', 'boot is stricter: marker text on a fresh pane is a dialog on its way');
    });

    it('an option whose label wrapped below a bare glyph is not a prompt', () => {
      const wrapped = [...BYPASS_HEAD, '   1. No, exit', ' ❯ ', '   2. Yes, I accept', ...BYPASS_FOOT];
      assert.equal(classify(wrapped, null), 'partial');
      assert.equal(boot(wrapped, null), 'undecided');
      assert.equal(classify([' Proceed?', ' ❯ ', '   1. Yes'], null), 'noncomposer');
      assert.equal(classify(['some output', '❯ ', ''], null), 'clear', 'a blank row beneath is not text');
      assert.equal(classify(['some output', '❯ '], null), 'clear', 'nor is the end of the capture');
    });

    it('the cursor is bound to the judged row by its text: on another row it proves nothing', () => {
      // The cursor reports the fresh composer, but the last glyph-led row is different text.
      const other = [...FRESH, BORDER, '❯ Try "something else"', BORDER];
      assert.equal(classify(other, FRESH_CURSOR), 'noncomposer');
      // Two identical boxed suggestion rows: the cursor's text matches the last one, which is judged.
      assert.equal(classify([...FRESH, ...FRESH], FRESH_CURSOR), 'clear');
    });

    it('a profile with no measured composer pattern never reads clear, whatever is on screen', () => {
      for (const wake of [null, { promptGlyph: GLYPH }, { promptGlyph: GLYPH, promptPad: ' ', placeholderSgr: [2] }]) {
        for (const lines of [FRESH, AFTER_MENU, COMPOSER, QUOTING_SESSION]) {
          assert.notEqual(startupDialog.classify(lines, DIALOGS, wake, cursorOf(lines)).state, 'clear');
          assert.notEqual(startupDialog.assessBoot(lines, DIALOGS, wake, cursorOf(lines)).state, 'clear');
        }
      }
    });
  });

  describe('the one look before a send', () => {
    const STORED = Object.freeze({ code: 'trust_required', label: 'folder trust dialog', meaning: 'Answer it in the pane.' });
    let cursorReads;

    beforeEach(() => {
      cursorReads = 0;
      startupDialog._internal.wakeProfiles = () => ({ claude: WAKE });
      startupDialog._internal.settleSync = () => {};
      startupDialog._internal.cursorInfoSync = () => { cursorReads += 1; return cursorOf(lastServed); };
    });

    const look = (lines) => {
      startupDialog._internal.capturePaneSync = () => served(lines);
      return startupDialog.check('t', CLAUDE);
    };

    for (const [name, lines] of Object.entries(NOT_A_PROMPT)) {
      it(`${name}: not clear; a stored blocker stands, and a launch send is refused with or without one`, () => {
        const seen = look(lines);
        assert.equal(seen.clear, false);
        assert.equal(seen.dialog, null);
        const stored = startupDialog.withholdFor(seen, STORED);
        assert.equal(stored.code, 'trust_required', 'a stored blocker keeps every sender out');
        assert.equal(startupDialog.withholdFor(seen, STORED, { launchSend: true }).code, 'trust_required');
        const launch = startupDialog.withholdFor(seen, null, { launchSend: true });
        assert.ok(launch, 'a launch send is refused with no blocker stored');
        if (lines === BYPASS_1 || lines === BYPASS_2) {
          assert.equal(launch.code, 'trust_required', 'it shows declared text with no composer below: withheld as a suspect frame');
          assert.equal(startupDialog.withholdFor(seen, null).code, 'trust_required', 'for every sender');
        } else {
          assert.equal(seen.noncomposer, true);
          assert.equal(launch.code, startupDialog.NOT_AT_PROMPT);
          assert.equal(launch.label, null, 'it names no dialog');
          assert.doesNotMatch(startupDialog.refusalText(launch), /trust/i);
          assert.match(startupDialog.refusalText(launch), /^pane_not_at_prompt: nothing was typed into the session\./);
        }
      });
    }

    it('a later injection with no blocker stored and no declared marker is not refused on a non-composer row: it keeps and clears a draft as before', () => {
      for (const lines of [DRAFT, MENU_2, MODEL_MENU]) {
        assert.equal(startupDialog.withholdFor(look(lines), null), null);
      }
    });

    it('declared text quoted ABOVE a located draft is a transcript: a later injection keeps its draft path, a launch send does not, and a blocker is not cleared', () => {
      const quoting = at([...QUOTING_SESSION.slice(0, 5), ...DRAFT], DRAFT_CURSOR);
      const seen = look(quoting);
      assert.equal(seen.noncomposer, true);
      assert.equal(seen.clear, false);
      assert.equal(seen.dialog, null, 'and it is not recorded as the dialog');
      assert.equal(startupDialog.withholdFor(seen, null), null);
      assert.equal(startupDialog.withholdFor(seen, null, { launchSend: true }).code, startupDialog.NOT_AT_PROMPT);
      assert.equal(startupDialog.withholdFor(seen, STORED).code, 'trust_required');
      // The draft must be positively located: each piece missing puts every sender back out.
      const lacking = {
        'no cursor reading': null,
        'the cursor hidden': { ...DRAFT_CURSOR, visible: false },
        'tmux not saying whether it is shown': { ...DRAFT_CURSOR, visible: null },
        'the cursor on the glyph, as a selector parks it': { ...DRAFT_CURSOR, x: 0 },
        'the cursor on another row': { ...DRAFT_CURSOR, line: `${GLYPH} other text` }
      };
      for (const [why, cursor] of Object.entries(lacking)) {
        startupDialog._internal.cursorInfoSync = () => cursor;
        const got = look(quoting);
        assert.equal(got.noncomposer, false, why);
        assert.equal(startupDialog.withholdFor(got, null).code, 'trust_required', why);
      }
      startupDialog._internal.cursorInfoSync = () => DRAFT_CURSOR;
      const unboxed = quoting.filter((row) => row !== BORDER);
      assert.equal(startupDialog.withholdFor(look(unboxed), null).code, 'trust_required', 'no composer box');
    });

    it('bypass option 2, no blocker stored: a later injection is refused too, with the cursor shown or not', () => {
      const selected = BYPASS_2.find((row) => row.trimStart().startsWith(GLYPH));
      for (const cursor of [null, ...cursorsOn(selected), ...cursorsOn(selected).filter(Boolean).map((c) => ({ ...c, visible: true }))]) {
        startupDialog._internal.cursorInfoSync = () => cursor;
        const seen = look(BYPASS_2);
        assert.equal(seen.clear, false);
        assert.equal(startupDialog.withholdFor(seen, null).code, 'trust_required');
      }
    });

    it('a screen with no glyph-led row at all keeps its old allowance, for a launch send too', () => {
      const seen = look(['  Verifying your account…']);
      assert.equal(seen.noncomposer, false);
      assert.equal(startupDialog.withholdFor(seen, null, { launchSend: true }), null);
    });

    it('REAL: the fresh composer and the bare one are clear, so a stored blocker is released', () => {
      for (const lines of [FRESH, AFTER_MENU, [...TRUST_DIALOG, ...FRESH], [...BYPASS_2, ...FRESH]]) {
        const seen = look(lines);
        assert.equal(seen.clear, true);
        assert.equal(startupDialog.withholdFor(seen, STORED, { launchSend: true }), null);
      }
    });

    it('the cursor is read only when it can change the answer', () => {
      look(AFTER_MENU);
      assert.equal(cursorReads, 0, 'a bare composer needs none');
      look(['  Verifying your account…']);
      assert.equal(cursorReads, 0, 'nor does a screen with no glyph-led row');
      look(FRESH);
      assert.equal(cursorReads, 1, 'a non-bare glyph row does');
    });

    it('a cursor that cannot be read, or reads as nothing, never clears the suggestion row', () => {
      startupDialog._internal.cursorInfoSync = () => { throw new Error('tmux did not answer'); };
      assert.equal(look(FRESH).clear, false);
      assert.equal(look(FRESH).noncomposer, true);
      assert.equal(look(AFTER_MENU).clear, true, 'the bare composer does not depend on it');
      startupDialog._internal.cursorInfoSync = () => null;
      assert.equal(look(FRESH).clear, false);
    });

    it('the pane changing between the row read and the cursor read does not clear', () => {
      // Rows read: a menu. Cursor read, a moment later: the composer that replaced it.
      startupDialog._internal.cursorInfoSync = () => FRESH_CURSOR;
      assert.equal(look(MENU_2).clear, false);
      // Rows read: the fresh composer. Cursor read: the menu that replaced it.
      startupDialog._internal.cursorInfoSync = () => cursorOf(MODEL_MENU);
      assert.equal(look(FRESH).clear, false);
    });

    it('the one-read check, the classifier and the watch\'s reader agree on every frame, with and without a cursor', async () => {
      const frames = { ...NOT_A_PROMPT, fresh: FRESH, 'after the menu': AFTER_MENU, trust: TRUST_DIALOG, 'history then fresh': [...TRUST_DIALOG, ...FRESH], 'stale then option': [...FRESH, ...BYPASS_2] };
      for (const [name, lines] of Object.entries(frames)) {
        for (const cursor of [cursorOf(lines), null]) {
          startupDialog._internal.cursorInfoSync = () => cursor;
          const viaCheck = look(lines);
          const viaClassify = startupDialog.classify(lines, DIALOGS, WAKE, cursor).state;
          assert.equal(viaCheck.clear, viaClassify === 'clear', `clear: ${name}, cursor ${cursor ? 'read' : 'missing'}`);
          assert.equal(!!viaCheck.dialog, viaClassify === 'dialog', `dialog: ${name}`);
          assert.equal(viaCheck.noncomposer, viaClassify === 'noncomposer', `noncomposer: ${name}`);
          // The watch reads the same frame through the async reader.
          let clock = 0;
          startupDialog._internal.now = () => clock;
          startupDialog._internal.sleep = async (ms) => { clock += ms; };
          startupDialog._internal.paneDigest = (rows) => rows.join('\n');
          startupDialog._internal.probeSession = () => ({ answered: true, live: true, cause: null });
          startupDialog._internal.capturePane = async () => ({ lines, alternateScreen: false, cursor });
          const watched = await startupDialog.watch({ tmuxName: 't', engineProfile: CLAUDE, bootWindowMs: 3000, answerWindowMs: 6000 });
          const bootState = startupDialog.assessBoot(lines, DIALOGS, WAKE, cursor).state;
          const expected = bootState === 'clear' ? 'clear' : (bootState === 'dialog' ? (viaClassify === 'clear' ? 'answered' : 'unanswered') : 'timeout');
          assert.equal(watched.outcome, expected, `watch: ${name}, cursor ${cursor ? 'read' : 'missing'}`);
        }
      }
    });
  });

  describe('the watch', () => {
    let clock;
    let frames;
    let reads;

    beforeEach(() => {
      clock = 0;
      reads = 0;
      startupDialog._internal.now = () => clock;
      startupDialog._internal.sleep = async (ms) => { clock += ms; };
      startupDialog._internal.wakeProfiles = () => ({ claude: WAKE });
      startupDialog._internal.probeSession = () => ({ answered: true, live: true, cause: null });
      // The transcript digest is held EQUAL throughout: it leaves out the last
      // glyph-led row and everything under it, which is where these frames differ.
      startupDialog._internal.paneDigest = () => 'same transcript';
      startupDialog._internal.capturePane = async () => {
        reads += 1;
        const frame = frames.length > 1 ? frames.shift() : frames[0];
        return { lines: frame.lines, alternateScreen: false, cursor: frame.cursor };
      };
    });

    const f = (lines, cursor = cursorOf(lines)) => ({ lines, cursor });
    const watch = (over = {}) => startupDialog.watch({ tmuxName: 't', engineProfile: CLAUDE, ...over });

    for (const [name, lines] of Object.entries(NOT_A_PROMPT)) {
      it(`${name}: boot does not clear on it, however long it holds still`, async () => {
        frames = [f(lines)];
        assert.equal((await watch()).outcome, 'timeout');
      });

      it(`${name}: after a dialog, it is not the answer and the launch does not resume`, async () => {
        frames = [f(TRUST_DIALOG), f(lines)];
        const res = await watch({ answerWindowMs: 60_000 });
        assert.equal(res.outcome, 'unanswered');
        assert.equal(res.dialog.code, 'trust_required');
      });
    }

    it('REAL: after a dialog, a bare composer below the retained history resumes after two stable reads', async () => {
      frames = [f(TRUST_DIALOG), f([...TRUST_DIALOG, ...AFTER_MENU], null)];
      const res = await watch();
      assert.equal(res.outcome, 'answered');
      assert.equal(reads, 3, 'the dialog, then the composer twice');
    });

    it('REAL: so does the fresh composer showing its suggestion, on its cursor', async () => {
      frames = [f(TRUST_DIALOG), f([...TRUST_DIALOG, ...FRESH], FRESH_CURSOR)];
      assert.equal((await watch()).outcome, 'answered');
      frames = [f(TRUST_DIALOG), f([...TRUST_DIALOG, ...FRESH], null)];
      assert.equal((await watch({ answerWindowMs: 60_000 })).outcome, 'unanswered', 'and not without it');
    });

    it('REAL: a fresh boot with no dialog clears on the suggestion row, and only with its cursor', async () => {
      frames = [f(FRESH)];
      assert.equal((await watch()).outcome, 'clear');
      frames = [f(FRESH, null)];
      assert.equal((await watch()).outcome, 'timeout');
    });

    it('two clear reads count as stable only if the judged row and the cursor held still too', async () => {
      const other = [...HEAD, BORDER, '❯ Try "refactor <filepath>"', BORDER, ...FOOTER];
      const otherCursor = { visible: true, x: 2, y: 36, line: `${ESC}[39m❯ ${ESC}[2mTry "refactor <filepath>"${ESC}[0m` };
      // Each frame is clear on its own, and the transcript digest never changes.
      frames = [f(FRESH), f(other, otherCursor), f(FRESH), f(other, otherCursor), f(other, otherCursor)];
      assert.equal((await watch()).outcome, 'clear');
      assert.equal(reads, 5, 'not on any pair of differing rows: only once one frame repeated');
      // A cursor that moves on an unchanged row is movement as well.
      reads = 0;
      const styledTwice = { ...FRESH_CURSOR, line: `${FRESH_CURSOR.line}${ESC}[0m` };
      frames = [f(FRESH), f(FRESH, styledTwice), f(FRESH), f(FRESH)];
      assert.equal((await watch()).outcome, 'clear');
      assert.equal(reads, 4);
    });

    it('the same holds in the answer stage', async () => {
      const other = [...TRUST_DIALOG, ...HEAD, BORDER, '❯ Try "refactor <filepath>"', BORDER, ...FOOTER];
      const otherCursor = { visible: true, x: 2, y: 36, line: `${ESC}[39m❯ ${ESC}[2mTry "refactor <filepath>"${ESC}[0m` };
      const fresh = [...TRUST_DIALOG, ...FRESH];
      frames = [f(TRUST_DIALOG), f(fresh, FRESH_CURSOR), f(other, otherCursor), f(fresh, FRESH_CURSOR), f(fresh, FRESH_CURSOR)];
      assert.equal((await watch()).outcome, 'answered');
      assert.equal(reads, 5);
    });
  });

  describe('through the session and the pane writer', () => {
    const real = {
      hasSession: tmux.hasSession, capturePane: tmux.capturePane, sendKeys: tmux.sendKeys, sendRawKey: tmux.sendRawKey,
      probeSession: tmux.probeSession, kickoff: launchKickoff.kickoff, bootstrap: launchBootstrap.bootstrap, watch: startupDialog.watch
    };
    const BLOCKER = Object.freeze({ code: 'trust_required', label: 'folder trust dialog', meaning: 'Answer it in the pane.', engineId: 'claude' });
    const WITH_PREKEY = Object.freeze({ ...CLAUDE, launch: { ...CLAUDE.launch, startupDelay: 1, preKeys: ['Enter'], preKeyDelay: 1 } });
    let base;
    let project;
    let typed;
    let pane;
    let counter = 0;
    let launchFinished;

    before(() => {
      base = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-startup-dialog-a160-'));
      store._setBasePath(base);
      store.init();
      startupDialog.reset();
    });

    after(() => {
      try { store.close(); } catch { /* already closed */ }
      fs.rmSync(base, { recursive: true, force: true });
      startupDialog.reset();
    });

    beforeEach(() => {
      counter += 1;
      project = store.projects.create({ name: `a160-proj-${counter}`, path: path.join(base, `a160-proj-${counter}`), engine: 'claude' });
      typed = [];
      pane = FRESH;
      tmux.hasSession = () => true;
      tmux.probeSession = () => ({ answered: true, live: true, cause: null });
      tmux.capturePane = () => served(pane);
      tmux.sendKeys = (session, text) => { typed.push({ text }); };
      tmux.sendRawKey = (session, key) => { typed.push({ key }); };
      startupDialog._internal.settleSync = () => {};
      launchFinished = null;
      launchBootstrap.bootstrap = () => { if (launchFinished) launchFinished(); return Promise.resolve({ code: 'legacy-recorded' }); };
    });

    afterEach(() => {
      tmux.hasSession = real.hasSession;
      tmux.capturePane = real.capturePane;
      tmux.sendKeys = real.sendKeys;
      tmux.sendRawKey = real.sendRawKey;
      tmux.probeSession = real.probeSession;
      launchKickoff.kickoff = real.kickoff;
      launchBootstrap.bootstrap = real.bootstrap;
      startupDialog.watch = real.watch;
      Object.assign(startupDialog._internal, REAL_SEAMS);
      const active = store.sessions.getActive(project.id);
      if (active) store.sessions.markCrashed(active.id, 'test cleanup');
    });

    const start = () => store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: `a160-${counter}` });
    const turns = async (n = 4) => { for (let i = 0; i < n; i++) await new Promise((resolve) => setImmediate(resolve)); };

    /**
     * Launch after a boot watch that recognised nothing, with the kickoff's own
     * send made as the real kickoff makes it, and wait for every send to have
     * been made or withheld.
     * @param {object} s - The session row
     * @param {object} [profile] - The engine profile to launch with
     * @returns {Promise<{kicks: object[], rows: object[]}>} What the kickoff's send answered, and the delivery rows written
     */
    const launchedAfterTimeout = async (s, profile = WITH_PREKEY) => {
      const kicks = [];
      const rows = [];
      startupDialog.watch = async () => ({ outcome: 'timeout', meaning: startupDialog.OUTCOME_MEANINGS.timeout, dialog: null, waitedMs: 45000 });
      launchKickoff.kickoff = (args) => {
        const sent = launchKickoff._internal.inject(args.projectName, 'Run `tc start next`', { sessionId: args.sessionId, launchSend: true });
        kicks.push(sent);
        return Promise.resolve(sent.ok ? 'sent' : 'inject-failed');
      };
      const realRecord = store.sessionRuleDeliveries.record;
      store.sessionRuleDeliveries.record = (entry) => { rows.push(entry); return entry; };
      try {
        const done = new Promise((resolve) => { launchFinished = resolve; });
        sessions._deferEngineInit(
          s.tmuxSession, project.name, 'claude', profile, 'the prime', null, false,
          { sessionId: s.id, projectId: project.id, engineId: 'claude', kind: 'startup', ruleIds: [1], digest: 'd' },
          { sessionId: s.id, projectId: project.id, hasSequence: true }
        );
        await done;
        await new Promise((resolve) => setTimeout(resolve, WITH_PREKEY.launch.startupDelay + 2));
        await turns();
      } finally {
        store.sessionRuleDeliveries.record = realRecord;
      }
      return { kicks, rows };
    };

    describe('with the guarded dialogs a profile declares for its blind keys (#2177): two guards, one launch', () => {
      // Each guard reads its own declaration. A launch that this module watched
      // makes its pre-key and prime sends in the same place the other guard
      // checks them, so both must still refuse there, and neither must stop a
      // send the other allows.
      const BOTH = Object.freeze({
        ...WITH_PREKEY,
        launch: { ...WITH_PREKEY.launch, guardedDialogs: [{ id: 'update', match: 'Update available', humanAction: 'Skip it with Escape.' }] }
      });
      const UPDATE_PROMPT = Object.freeze(['  Update available · 1 → 2', '  1. Update now', '  enter continue · esc skip']);
      const sent = () => typed.filter((t) => t.key || t.text === 'the prime');

      it('a guarded dialog on screen, which this module does not know: the pre-key and the prime are still withheld, by the other guard', async () => {
        const s = start();
        pane = UPDATE_PROMPT;
        assert.equal(startupDialog.classify(UPDATE_PROMPT, DIALOGS, WAKE, null).state, 'unknown', 'precondition: nothing here for this module to refuse');
        const { rows } = await launchedAfterTimeout(s, BOTH);
        assert.deepEqual(sent(), [], 'no pre-key and no prime');
        assert.equal(rows.length, 1);
        assert.equal(rows[0].outcome, 'skipped');
        assert.match(rows[0].skipReason, /is showing its update prompt, which TangleClaw does not answer/);
        assert.match(rows[0].skipReason, /Skip it with Escape\./);
      });

      it('the folder trust dialog on screen: withheld by this module, named, and recorded', async () => {
        const s = start();
        pane = TRUST_DIALOG;
        const { rows } = await launchedAfterTimeout(s, BOTH);
        assert.deepEqual(sent(), []);
        assert.match(rows[0].skipReason, /^trust_required: nothing was typed when the prime was due/);
        assert.equal(store.sessions.get(s.id).launchBlocker.code, 'trust_required');
      });

      it('a selector neither declaration names: withheld as not at the prompt', async () => {
        const s = start();
        pane = MENU_2;
        const { rows } = await launchedAfterTimeout(s, BOTH);
        assert.deepEqual(sent(), []);
        assert.match(rows[0].skipReason, /^pane_not_at_prompt: /);
      });

      it('a bare composer: both guards pass, and the pre-key and the prime are typed', async () => {
        const s = start();
        pane = AFTER_MENU;
        await launchedAfterTimeout(s, BOTH);
        assert.deepEqual(sent().map((t) => t.key || t.text), ['Enter', 'the prime']);
      });

      it('KNOWN LIMIT (#2221): on a profile declaring both kinds, a fresh composer showing its suggestion has its prime refused by the other guard as unrecognised', async () => {
        // This module reads the suggestion row as the composer (cursor shown,
        // boxed, empty). The #2177 guard knows only the bare pattern, so a pane
        // it never observed ready is "unrecognised" to it. No shipped profile
        // declares both; this pins the limit so a change to either side shows.
        const s = start();
        pane = FRESH;
        assert.equal(startupDialog.check(s.tmuxSession, BOTH).clear, true, 'precondition: clear to this module');
        const { rows } = await launchedAfterTimeout(s, BOTH);
        assert.ok(!typed.some((t) => t.text === 'the prime'), 'the prime was not pasted');
        // The pre-key IS sent: the #2177 guard withholds a key only from a declared
        // prompt or an unreadable pane, never from a screen it does not recognise.
        assert.deepEqual(typed.filter((t) => t.key).map((t) => t.key), ['Enter'], 'the pre-key is still sent');
        assert.match(rows[0].skipReason, /was never observed ready and shows neither its composer nor a guarded dialog/);
        for (const file of ['claude.json', 'codex.json']) {
          const shipped = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', file), 'utf8'));
          const both = !!(shipped.capabilities && shipped.capabilities.startupDialogs && shipped.capabilities.startupDialogs.length)
            && !!(shipped.launch && shipped.launch.guardedDialogs && shipped.launch.guardedDialogs.length);
          assert.equal(both, false, `${file} must not declare both kinds while this limit stands`);
        }
      });

      it('a profile whose guarded dialog cannot be read gets no pre-key and no prime, even over a bare composer', async () => {
        const s = start();
        pane = AFTER_MENU;
        const broken = { ...BOTH, launch: { ...BOTH.launch, guardedDialogs: [{ id: 'update' }] } };
        const { rows } = await launchedAfterTimeout(s, broken);
        assert.deepEqual(sent(), []);
        assert.match(rows[0].skipReason, /declares a guarded dialog TangleClaw could not read/);
      });
    });

    for (const [name, lines] of Object.entries(NOT_A_PROMPT)) {
      it(`launch, no blocker stored, ${name}: no pre-key, no prime and no kickoff is typed`, async () => {
        const s = start();
        pane = lines;
        const { kicks, rows } = await launchedAfterTimeout(s);
        assert.deepEqual(typed, [], 'nothing reached the pane');
        assert.equal(kicks.length, 1, 'the kickoff was reached');
        assert.equal(kicks[0].ok, false, 'and its send was refused');
        const code = (lines === BYPASS_1 || lines === BYPASS_2) ? 'trust_required' : startupDialog.NOT_AT_PROMPT;
        assert.equal(kicks[0].startupDialog.code, code);
        assert.equal(rows.length, 1, 'the prime that was owed is on the ledger');
        assert.equal(rows[0].outcome, 'skipped');
        assert.match(rows[0].skipReason, new RegExp(`^${code}: nothing was typed when the prime was due`));
        assert.equal(store.sessions.get(s.id).launchBlocker, null, 'no dialog was recognised, so none is recorded');
      });

      it(`a stored blocker, ${name}: every sender is refused and the blocker is NOT cleared`, () => {
        const s = start();
        store.sessions.setLaunchBlocker(s.id, BLOCKER);
        pane = lines;
        assert.equal(sessions.getSessionStatus(project.name).launchBlocker.code, 'trust_required', 'a status read leaves it');
        const sent = sessions.injectCommand(project.name, 'ls');
        assert.equal(sent.ok, false);
        assert.equal(sent.startupDialog.code, 'trust_required');
        assert.equal(tmux._startupDialogOn(s.tmuxSession, 'claude').code, 'trust_required', 'the pane writer refuses too');
        assert.equal(sessions._startupDialogAtSend(s.tmuxSession, CLAUDE, 'claude', project.name, { sessionId: s.id }).code, 'trust_required', 'and so does a launch send');
        assert.deepEqual(typed, []);
        assert.equal(store.sessions.get(s.id).launchBlocker.code, 'trust_required', 'still recorded after all four looks');
      });
    }

    describe('a startup-dialog declaration that cannot be read fails closed (#2224)', () => {
      // A mistyped entry was written to name a dialog nothing can recognise
      // now. Reading the list as shorter, or as empty, would launch unwatched
      // into that dialog. Only a literal [] says "this program shows none".
      const SOUND = CLAUDE.capabilities.startupDialogs[0];
      const withDialogs = (value, extra = {}) => ({ ...WITH_PREKEY, ...extra, capabilities: { ...WITH_PREKEY.capabilities, startupDialogs: value } });
      const CASES = {
        'every entry unreadable': withDialogs([{ code: 'trust_required', label: 'l', meaning: 'm', markers: [] }]),
        'one sound entry and one unreadable': withDialogs([SOUND, { code: 'Bad Code', label: 'l', meaning: 'm', markers: ['x'] }]),
        'a value that is not a list': withDialogs('trust'),
        'null where a list belongs': withDialogs(null),
        'an object where a list belongs': withDialogs({ code: 'trust_required' })
      };

      afterEach(() => { startupDialog.reset(); });

      for (const [name, profile] of Object.entries(CASES)) {
        it(`${name}: no pre-key, no prime and no kickoff, over a pane at its bare prompt, and the ledger names the profile and the entry`, async () => {
          const s = start();
          pane = AFTER_MENU;
          assert.ok(startupDialog.unreadable(profile).length >= 1);
          const rows = [];
          const kicked = [];
          const realRecord = store.sessionRuleDeliveries.record;
          store.sessionRuleDeliveries.record = (entry) => { rows.push(entry); return entry; };
          launchKickoff.kickoff = (args) => { kicked.push(args); return Promise.resolve('sent'); };
          try {
            // The REAL watch: it must answer before reading the pane at all.
            const done = new Promise((resolve) => { launchFinished = resolve; });
            sessions._deferEngineInit(
              s.tmuxSession, project.name, 'claude', profile, 'the prime', null, false,
              { sessionId: s.id, projectId: project.id, engineId: 'claude', kind: 'startup', ruleIds: [1], digest: 'd' },
              { sessionId: s.id, projectId: project.id, hasSequence: true }
            );
            await done;
            await new Promise((resolve) => setTimeout(resolve, 5));
            await turns();
          } finally {
            store.sessionRuleDeliveries.record = realRecord;
          }
          assert.deepEqual(typed, [], 'nothing was typed');
          assert.deepEqual(kicked, [], 'and the kickoff was not asked to');
          assert.equal(rows.length, 1);
          assert.equal(rows[0].outcome, 'skipped');
          assert.match(rows[0].skipReason, /^startup_dialogs_unreadable: engine profile "claude" declares startup dialogs TangleClaw could not read/);
          assert.match(rows[0].skipReason, name === 'every entry unreadable' ? /entry 1: / : (name.startsWith('one sound') ? /entry 2: / : /its declaration: /));
          assert.match(rows[0].skipReason, /set "startupDialogs": \[\] to declare none/);
        });

        it(`${name}: a launch send asked on its own is refused too, and a later injection is judged by what could be read`, () => {
          const s = start();
          pane = AFTER_MENU;
          const launch = sessions._startupDialogAtSend(s.tmuxSession, profile, 'claude', project.name, { sessionId: s.id });
          assert.equal(launch.code, startupDialog.DECLARATION_UNREADABLE);
          assert.equal(launch.label, null);
          const seen = startupDialog.check(s.tmuxSession, profile);
          assert.ok(seen.unreadable);
          const later = startupDialog.withholdFor(seen, null);
          if (name !== 'every entry unreadable') {
            // A sound entry of its own, or (for a value that is not a list) its
            // program's dialogs, which the installed profiles supply here.
            assert.equal(seen.unresolved, null);
            assert.equal(seen.declared, true);
            assert.equal(later, null, 'the pane was read against a known dialog: a later injection into a bare composer is an ordinary send');
          } else {
            // Nothing of the declaration could be read, so there is nothing to
            // read the pane against: every sender is refused, not only the launch.
            assert.equal(seen.unresolvedCause, 'declaration');
            assert.equal(later.code, startupDialog.DECLARATION_UNREADABLE);
            assert.match(startupDialog.refusalText(later), /Correct the declaration in the engine profile, or set "startupDialogs": \[\] to declare none/);
          }
        });
      }

      it('the sound entry of a mixed list still catches its dialog for every sender', () => {
        const s = start();
        pane = TRUST_DIALOG;
        const seen = startupDialog.check(s.tmuxSession, CASES['one sound entry and one unreadable']);
        assert.equal(seen.dialog.code, 'trust_required');
        assert.equal(startupDialog.withholdFor(seen, null).code, 'trust_required');
      });

      it('only a literal [] opts a profile out: it is not watched, and it types', async () => {
        const s = start();
        pane = AFTER_MENU;
        const optedOut = withDialogs([]);
        assert.deepEqual(startupDialog.unreadable(optedOut), []);
        let watched = 0;
        startupDialog.watch = async () => { watched += 1; return { outcome: 'clear', dialog: null, waitedMs: 0 }; };
        launchKickoff.kickoff = () => Promise.resolve('sent');
        const done = new Promise((resolve) => { launchFinished = resolve; });
        sessions._deferEngineInit(s.tmuxSession, project.name, 'claude', optedOut, 'the prime', null, false, null, { sessionId: s.id, projectId: project.id, hasSequence: true });
        await done;
        await new Promise((resolve) => setTimeout(resolve, 5));
        await turns();
        assert.equal(watched, 0);
        assert.ok(typed.some((t) => t.text === 'the prime'));
      });

      it('a profile with no list of its own inherits the refusal from the profile that declares for its command, and a profile for another command does not', async () => {
        const source = { ...CASES['one sound entry and one unreadable'], id: 'claude', command: 'claude' };
        const variant = { id: 'claude-sonnet-reviewer', command: 'claude', capabilities: { supportsPrimePrompt: true } };
        const other = { id: 'aider', command: 'aider', capabilities: {} };
        startupDialog.reset();
        startupDialog._internal.engineProfiles = () => [other, variant, source];
        assert.equal(startupDialog.unreadable(variant).length, 1);
        assert.equal(startupDialog.unreadable(variant)[0].profile, 'claude', 'it names the profile that holds the bad entry');
        assert.equal((await startupDialog.watch({ tmuxName: 't', engineProfile: variant })).outcome, 'unreadable');
        assert.deepEqual(startupDialog.unreadable(other), []);
        assert.deepEqual(startupDialog.unreadable({ id: 'x', command: 'claude-next', capabilities: {} }), [], 'an unknown command has nothing declared for it');
        assert.equal((await startupDialog.watch({ tmuxName: 't', engineProfile: other })).outcome, 'undeclared');
        // A profile that says [] for itself is not touched by its program's bad entry.
        assert.deepEqual(startupDialog.unreadable({ ...variant, capabilities: { startupDialogs: [] } }), []);
      });

      it('a launch on a profile with no list of its own, whose program\'s declaration is unreadable, types nothing', async () => {
        const source = { ...CASES['one sound entry and one unreadable'], id: 'claude', command: 'claude' };
        const variant = { ...WITH_PREKEY, id: 'claude-sonnet-reviewer', command: 'claude', capabilities: { ...WITH_PREKEY.capabilities } };
        delete variant.capabilities.startupDialogs;
        startupDialog.reset();
        startupDialog._internal.engineProfiles = () => [variant, source];
        const s = start();
        pane = AFTER_MENU;
        const rows = [];
        const kicked = [];
        const realRecord = store.sessionRuleDeliveries.record;
        store.sessionRuleDeliveries.record = (entry) => { rows.push(entry); return entry; };
        launchKickoff.kickoff = (args) => { kicked.push(args); return Promise.resolve('sent'); };
        try {
          const done = new Promise((resolve) => { launchFinished = resolve; });
          sessions._deferEngineInit(
            s.tmuxSession, project.name, 'claude-sonnet-reviewer', variant, 'the prime', null, false,
            { sessionId: s.id, projectId: project.id, engineId: 'claude-sonnet-reviewer', kind: 'startup', ruleIds: [1], digest: 'd' },
            { sessionId: s.id, projectId: project.id, hasSequence: true }
          );
          await done;
          await new Promise((resolve) => setTimeout(resolve, 5));
          await turns();
        } finally {
          store.sessionRuleDeliveries.record = realRecord;
        }
        assert.deepEqual(typed, []);
        assert.deepEqual(kicked, []);
        assert.match(rows[0].skipReason, /^startup_dialogs_unreadable: engine profile "claude" declares startup dialogs TangleClaw could not read \(entry 2: /);
      });

      describe('when the installed profiles cannot be consulted, a profile that inherits has lost its declaration (A160 R8)', () => {
        // The first failures this module answers were on an operator's second
        // profile for Claude Code, which has no list of its own. If the lookup
        // that finds its program's dialogs fails and that reads as "nothing
        // declared", a store fault switches the protection off.
        const VARIANT = Object.freeze({ ...WITH_PREKEY, id: 'claude-sonnet-reviewer', command: 'claude', capabilities: { supportsPrimePrompt: true } });
        const FAULTS = {
          'the profile list throws': () => { throw new Error('profile-list-read-failed'); },
          'the profile list comes back empty': () => [],
          'the profile list comes back as nothing': () => null
        };

        /**
         * Launch through the real `_deferEngineInit` and the real watch, and wait
         * for every send to have been made or withheld.
         * @param {object} s - The session row
         * @param {object} profile - The engine profile
         * @returns {Promise<{rows: object[], kicked: object[]}>}
         */
        const launchReal = async (s, profile) => {
          const rows = [];
          const kicked = [];
          const realRecord = store.sessionRuleDeliveries.record;
          store.sessionRuleDeliveries.record = (entry) => { rows.push(entry); return entry; };
          launchKickoff.kickoff = (args) => { kicked.push(args); return Promise.resolve('sent'); };
          try {
            const done = new Promise((resolve) => { launchFinished = resolve; });
            sessions._deferEngineInit(
              s.tmuxSession, project.name, profile.id, profile, 'the prime', null, false,
              { sessionId: s.id, projectId: project.id, engineId: profile.id, kind: 'startup', ruleIds: [1], digest: 'd' },
              { sessionId: s.id, projectId: project.id, hasSequence: true }
            );
            await done;
            await new Promise((resolve) => setTimeout(resolve, 5));
            await turns();
          } finally {
            store.sessionRuleDeliveries.record = realRecord;
          }
          return { rows, kicked };
        };

        for (const [name, list] of Object.entries(FAULTS)) {
          it(`${name}, cold cache: not "undeclared"; the watch answers unreadable without reading the pane`, async () => {
            startupDialog.reset();
            startupDialog._internal.engineProfiles = list;
            let paneReads = 0;
            startupDialog._internal.capturePane = async () => { paneReads += 1; return served(AFTER_MENU); };
            assert.deepEqual(startupDialog.declared(VARIANT), []);
            const problems = startupDialog.unreadable(VARIANT);
            assert.equal(problems.length, 1);
            assert.equal(problems[0].profile, 'claude-sonnet-reviewer');
            assert.match(problems[0].errors[0], /declared for its command "claude" could not be looked up/);
            const res = await startupDialog.watch({ tmuxName: 't', engineProfile: VARIANT });
            assert.equal(res.outcome, 'unreadable');
            assert.equal(paneReads, 0);
          });

          it(`${name}, cold cache: a launch types no pre-key, no prime and no kickoff, over a pane at its bare prompt`, async () => {
            startupDialog.reset();
            startupDialog._internal.engineProfiles = list;
            const s = start();
            pane = AFTER_MENU;
            const { rows, kicked } = await launchReal(s, VARIANT);
            assert.deepEqual(typed, [], 'nothing was typed');
            assert.deepEqual(kicked, [], 'and the kickoff was not asked to');
            assert.equal(rows.length, 1);
            assert.equal(rows[0].outcome, 'skipped');
            assert.match(rows[0].skipReason, /^startup_dialogs_unreadable: startup dialogs that apply to engine profile "claude-sonnet-reviewer" could not be looked up: it takes them from the profile that declares for its command "claude"/);
            assert.match(rows[0].skipReason, /failure to read TangleClaw's installed engine profiles, not an error in that profile/);
            assert.doesNotMatch(rows[0].skipReason, /clears by itself/);
            assert.doesNotMatch(rows[0].skipReason, /Fix the declaration|declares startup dialogs TangleClaw could not read|the dialog it was written for/, 'it must not send anyone to edit a profile');
          });

          it(`${name}: a launch send asked on its own, and the kickoff's send, are refused too`, () => {
            startupDialog.reset();
            startupDialog._internal.engineProfiles = list;
            const s = start();
            pane = AFTER_MENU;
            assert.equal(sessions._startupDialogAtSend(s.tmuxSession, VARIANT, 'claude', project.name, { sessionId: s.id }).code, startupDialog.DECLARATION_UNREADABLE);
            const seen = startupDialog.check(s.tmuxSession, VARIANT);
            assert.equal(startupDialog.withholdFor(seen, null, { launchSend: true }).code, startupDialog.DECLARATION_UNREADABLE);
          });
        }

        it('the fault is not remembered: once the list reads again the profile is watched and typed into as usual, and a later fault is not hidden by the good read', async () => {
          startupDialog.reset();
          let mode = 'throw';
          startupDialog._internal.engineProfiles = () => {
            if (mode === 'throw') throw new Error('profile-list-read-failed');
            return [VARIANT, { ...CLAUDE, id: 'claude', command: 'claude' }];
          };
          assert.equal(startupDialog.unreadable(VARIANT).length, 1);
          mode = 'ok';
          assert.deepEqual(startupDialog.unreadable(VARIANT), [], 'recovered at the next ask');
          assert.deepEqual(startupDialog.declared(VARIANT).map((d) => d.code), ['trust_required']);
          // A good read is kept, as before: the declarations of installed profiles do not change under a running server.
          mode = 'throw';
          assert.deepEqual(startupDialog.unreadable(VARIANT), []);
          assert.deepEqual(startupDialog.declared(VARIANT).map((d) => d.code), ['trust_required']);
        });

        describe('one snapshot per operation: a fault that comes or goes mid-operation cannot be mixed into "nothing declared, nothing wrong"', () => {
          const GOOD = () => [VARIANT, { ...CLAUDE, id: 'claude', command: 'claude' }];
          /**
           * A profile list that throws on the listed call numbers and reads well on the rest.
           * @param {number[]} failOn - 1-based call numbers that throw
           * @returns {{list: Function, calls: () => number}}
           */
          const flaky = (failOn) => {
            let n = 0;
            return {
              list: () => { n += 1; if (failOn.includes(n)) throw new Error('profile-list-read-failed'); return GOOD(); },
              calls: () => n
            };
          };

          it('resolve asks the list at most once, and never answers "no dialogs and no problems" for a profile that inherits', () => {
            for (const failOn of [[], [1], [2], [1, 2], [1, 3], [2, 3], [1, 2, 3]]) {
              startupDialog.reset();
              const f = flaky(failOn);
              startupDialog._internal.engineProfiles = f.list;
              for (let i = 0; i < 4; i++) {
                const before = f.calls();
                const got = startupDialog.resolve(VARIANT);
                assert.ok(f.calls() - before <= 1, `one lookup per snapshot (failOn ${failOn})`);
                assert.ok(got.dialogs.length > 0 || got.problems.length > 0, `failOn ${JSON.stringify(failOn)}, ask ${i + 1}: neither part may be empty together`);
                assert.equal(got.dialogs.length > 0 && got.problems.length > 0, false, 'and they are never mixed either way');
              }
            }
          });

          it('check, throw then recover: the look that met the fault refuses a launch send; the next look is ordinary', () => {
            startupDialog.reset();
            const f = flaky([1]);
            startupDialog._internal.engineProfiles = f.list;
            const s = start();
            pane = AFTER_MENU;
            const first = startupDialog.check(s.tmuxSession, VARIANT);
            assert.equal(f.calls(), 1, 'one lookup for the whole look');
            assert.equal(first.declared, false);
            assert.ok(first.unreadable, 'the fault is carried, not lost between two asks');
            assert.equal(startupDialog.withholdFor(first, null, { launchSend: true }).code, startupDialog.DECLARATION_UNREADABLE);
            const second = startupDialog.check(s.tmuxSession, VARIANT);
            assert.equal(second.unreadable, null);
            assert.equal(second.clear, true);
            assert.equal(startupDialog.withholdFor(second, null, { launchSend: true }), null);
          });

          it('a launch send, throw then recover: the send that met the fault is refused', () => {
            startupDialog.reset();
            startupDialog._internal.engineProfiles = flaky([1]).list;
            const s = start();
            pane = AFTER_MENU;
            assert.equal(sessions._startupDialogAtSend(s.tmuxSession, VARIANT, 'claude', project.name, { sessionId: s.id }).code, startupDialog.DECLARATION_UNREADABLE);
            assert.equal(sessions._startupDialogAtSend(s.tmuxSession, VARIANT, 'claude', project.name, { sessionId: s.id }), null, 'the next one, with the list read, is not');
          });

          it('the kickoff\'s send, throw then recover: refused, nothing typed', () => {
            startupDialog.reset();
            startupDialog._internal.engineProfiles = flaky([1]).list;
            const s = start();
            pane = AFTER_MENU;
            const realGet = store.engines.get;
            store.engines.get = (id) => (id === 'claude' ? VARIANT : realGet.call(store.engines, id));
            try {
              const sent = launchKickoff._internal.inject(project.name, 'Run `tc start next`', { sessionId: s.id, launchSend: true });
              assert.equal(sent.ok, false);
              assert.equal(sent.startupDialog.code, startupDialog.DECLARATION_UNREADABLE);
              assert.deepEqual(typed, []);
            } finally {
              store.engines.get = realGet;
            }
          });

          it('watch, throw then recover: one snapshot, so it answers unreadable and does not go on to read the pane', async () => {
            startupDialog.reset();
            const f = flaky([1]);
            startupDialog._internal.engineProfiles = f.list;
            let paneReads = 0;
            startupDialog._internal.capturePane = async () => { paneReads += 1; return served(AFTER_MENU); };
            const res = await startupDialog.watch({ tmuxName: 't', engineProfile: VARIANT });
            assert.equal(res.outcome, 'unreadable');
            assert.equal(f.calls(), 1);
            assert.equal(paneReads, 0);
          });

          it('a launch, throw then recover: the decision and the watch share one snapshot, and no pre-key, prime or kickoff is typed', async () => {
            startupDialog.reset();
            const f = flaky([1]);
            startupDialog._internal.engineProfiles = f.list;
            const s = start();
            pane = AFTER_MENU;
            const { rows, kicked } = await launchReal(s, VARIANT);
            assert.equal(f.calls(), 1, 'the launch asked the list once: the watch used the launch\'s own snapshot');
            assert.deepEqual(typed, []);
            assert.deepEqual(kicked, []);
            assert.match(rows[0].skipReason, /^startup_dialogs_unreadable: /);
          });

          it('a launch, recover then throw: the good read stands for the whole launch, which is watched and then types', async () => {
            startupDialog.reset();
            const f = flaky([2, 3, 4, 5, 6, 7, 8]);
            startupDialog._internal.engineProfiles = f.list;
            let clock = 0;
            let watchReads = 0;
            startupDialog._internal.now = () => clock;
            startupDialog._internal.sleep = async (ms) => { clock += ms; };
            startupDialog._internal.wakeProfiles = () => ({ claude: WAKE });
            startupDialog._internal.paneDigest = (lines) => lines.join('\n');
            startupDialog._internal.capturePane = async () => { watchReads += 1; return served(AFTER_MENU); };
            const s = start();
            pane = AFTER_MENU;
            const { rows } = await launchReal(s, VARIANT);
            assert.ok(watchReads >= 2, 'the boot was watched, on the declaration read at the start');
            assert.ok(typed.some((t) => t.text === 'the prime'), 'and, the prompt having been seen, the launch typed');
            assert.ok(!rows.some((r) => r.outcome === 'skipped'));
            assert.deepEqual(startupDialog.resolve(VARIANT).dialogs.map((d) => d.code), ['trust_required'], 'the declaration is still in force after the later faults');
          });

          it('the dialog itself, recover then throw: still seen and still refused for every sender', () => {
            startupDialog.reset();
            startupDialog._internal.engineProfiles = flaky([2, 3, 4]).list;
            startupDialog._internal.wakeProfiles = () => ({ claude: WAKE });
            const s = start();
            pane = TRUST_DIALOG;
            for (let i = 0; i < 3; i++) {
              const seen = startupDialog.check(s.tmuxSession, VARIANT);
              assert.equal(seen.dialog.code, 'trust_required');
              assert.equal(startupDialog.withholdFor(seen, null).code, 'trust_required');
            }
          });
        });

        describe('every later sender is refused too, while the lookup stays unresolved (A160 R10)', () => {
          // With the lookup failed there is no dialog to read the pane against,
          // so no send by anyone can be shown safe. This is a different state
          // from a list with one bad entry, whose sound entries still read.
          const broken = () => { throw new Error('profile-list-read-failed'); };
          let paneReads;
          let realEngineGet;

          beforeEach(() => {
            paneReads = 0;
            tmux.capturePane = () => { paneReads += 1; return served(pane); };
            realEngineGet = store.engines.get;
            // The session's engine resolves to the inheriting profile.
            store.engines.get = (id) => (id === 'claude' ? VARIANT : realEngineGet.call(store.engines, id));
          });

          afterEach(() => { store.engines.get = realEngineGet; });

          it('the structured mark: a lookup fault sets `unresolved`; a malformed entry does not', () => {
            startupDialog.reset();
            startupDialog._internal.engineProfiles = broken;
            const fault = startupDialog.resolve(VARIANT);
            assert.equal(typeof fault.lookupFault, 'string');
            assert.equal(startupDialog.check('t', VARIANT).unresolved !== null, true);
            const mixed = CASES['one sound entry and one unreadable'];
            assert.equal(startupDialog.resolve(mixed).lookupFault, null);
            pane = AFTER_MENU;
            const seen = startupDialog.check('t', mixed);
            assert.ok(seen.unreadable, 'still reported');
            assert.equal(seen.unresolved, null, 'but it is not the lookup-fault state');
            assert.equal(startupDialog.resolve({ ...VARIANT, capabilities: { startupDialogs: [] } }).lookupFault, null);
          });

          const SENDERS = {
            'a command sent over the API': (s) => sessions.injectCommand(project.name, 'ls'),
            'the switchboard wake': (s) => require('../lib/medusa-wake')._internal.injectCommand(project.name, 'you have mail', { sessionId: s.id, controlExempt: 'medusa-wake' }),
            'the unready nudge': (s) => require('../lib/launch-unready')._internal.inject(project.name, 'run tc start next', {}),
            'the wrap hand-back': (s) => require('../lib/wrap-handback')._internal.inject(project.name, 'wrap finished', {}),
            'the launch kickoff': (s) => launchKickoff._internal.inject(project.name, 'read your launch context', { sessionId: s.id, launchSend: true })
          };

          for (const [name, send] of Object.entries(SENDERS)) {
            it(`persistent fault, ${name}: refused as startup_dialogs_unreadable, nothing typed, the pane not read`, () => {
              startupDialog.reset();
              startupDialog._internal.engineProfiles = broken;
              const s = start();
              pane = AFTER_MENU;
              const sent = send(s);
              assert.equal(sent.ok, false);
              assert.equal(sent.startupDialog.code, startupDialog.DECLARATION_UNREADABLE);
              assert.equal(sent.startupDialog.label, null);
              assert.match(sent.error, /^startup_dialogs_unreadable: nothing was typed into the session\. The startup dialogs that apply to engine profile "claude-sonnet-reviewer" could not be looked up/);
              assert.match(sent.error, /Sends go through again as soon as TangleClaw can read its engine profiles\. If this keeps happening, an engine profile file cannot be read and needs repair: the server log names the error/);
              assert.doesNotMatch(sent.error, /launch's own text|Fix the declaration|Correct the declaration|clears by itself|nothing .* needs fixing/, 'wording true for any sender, and no promise that it mends itself');
              assert.deepEqual(typed, []);
              assert.equal(paneReads, 0, 'there is nothing to read the pane against');
              assert.equal(store.sessions.get(s.id).launchBlocker, null, 'and no dialog is recorded on a fault');
            });
          }

          it('persistent fault, the pane writer itself: refused for a send that names the engine, with the trust dialog up or not', () => {
            startupDialog.reset();
            startupDialog._internal.engineProfiles = broken;
            const s = start();
            for (const frame of [AFTER_MENU, TRUST_DIALOG, FRESH]) {
              pane = frame;
              const refused = tmux._startupDialogOn(s.tmuxSession, 'claude');
              assert.equal(refused.code, startupDialog.DECLARATION_UNREADABLE);
              assert.equal(startupDialog.refusalText(refused).startsWith('startup_dialogs_unreadable: nothing was typed into the session.'), true);
            }
            assert.equal(paneReads, 0);
          });

          it('persistent fault: a status read neither records nor clears anything, and a stored blocker does not let a send through', () => {
            startupDialog.reset();
            startupDialog._internal.engineProfiles = broken;
            const s = start();
            pane = AFTER_MENU;
            assert.equal(sessions.getSessionStatus(project.name).launchBlocker, null);
            store.sessions.setLaunchBlocker(s.id, BLOCKER);
            assert.equal(sessions.getSessionStatus(project.name).launchBlocker.code, 'trust_required', 'a bare composer cannot clear it while nothing can be read against it');
            assert.equal(sessions.injectCommand(project.name, 'ls').ok, false);
            assert.deepEqual(typed, []);
          });

          it('transient fault: the send that met it is refused; the next one, with the list read, is typed', () => {
            startupDialog.reset();
            let n = 0;
            startupDialog._internal.engineProfiles = () => {
              n += 1;
              if (n === 1) throw new Error('profile-list-read-failed');
              return [VARIANT, { ...CLAUDE, id: 'claude', command: 'claude' }];
            };
            startupDialog._internal.wakeProfiles = () => ({ claude: WAKE });
            const s = start();
            pane = AFTER_MENU;
            const first = sessions.injectCommand(project.name, 'ls');
            assert.equal(first.ok, false);
            assert.equal(first.startupDialog.code, startupDialog.DECLARATION_UNREADABLE);
            assert.deepEqual(typed, []);
            const second = sessions.injectCommand(project.name, 'ls');
            assert.equal(second.ok, true, 'an independent later lookup succeeded');
            assert.deepEqual(typed, [{ text: 'ls' }]);
            assert.ok(paneReads >= 1, 'and that send read the pane as usual');
            assert.equal(store.sessions.get(s.id).launchBlocker, null);
          });

          it('transient fault, then the dialog: once the list reads, the trust dialog is seen and refused under its own name', () => {
            startupDialog.reset();
            let n = 0;
            startupDialog._internal.engineProfiles = () => {
              n += 1;
              if (n === 1) throw new Error('profile-list-read-failed');
              return [VARIANT, { ...CLAUDE, id: 'claude', command: 'claude' }];
            };
            startupDialog._internal.wakeProfiles = () => ({ claude: WAKE });
            start();
            pane = TRUST_DIALOG;
            assert.equal(sessions.injectCommand(project.name, 'ls').startupDialog.code, startupDialog.DECLARATION_UNREADABLE);
            assert.equal(sessions.injectCommand(project.name, 'ls').startupDialog.code, 'trust_required');
            assert.deepEqual(typed, []);
          });

          it('control, own []: a later send is typed during the fault, because that profile does not depend on the lookup', () => {
            startupDialog.reset();
            startupDialog._internal.engineProfiles = broken;
            const optedOut = { ...VARIANT, capabilities: { supportsPrimePrompt: true, startupDialogs: [] } };
            store.engines.get = (id) => (id === 'claude' ? optedOut : realEngineGet.call(store.engines, id));
            const s = start();
            pane = AFTER_MENU;
            assert.equal(tmux._startupDialogOn(s.tmuxSession, 'claude'), null);
            assert.equal(sessions.injectCommand(project.name, 'ls').ok, true);
            assert.deepEqual(typed, [{ text: 'ls' }]);
          });

          it('control, a malformed entry beside a sound one: later sends still read the pane, are typed over a composer and refused at the dialog', () => {
            startupDialog.reset();
            startupDialog._internal.engineProfiles = broken;
            startupDialog._internal.wakeProfiles = () => ({ claude: WAKE });
            const mixed = { ...CASES['one sound entry and one unreadable'], id: 'claude', command: 'claude' };
            store.engines.get = (id) => (id === 'claude' ? mixed : realEngineGet.call(store.engines, id));
            start();
            pane = AFTER_MENU;
            assert.equal(sessions.injectCommand(project.name, 'ls').ok, true, 'a later send over a bare composer is typed');
            assert.ok(paneReads >= 1, 'because the pane WAS read, against the entry that could be');
            typed.length = 0;
            pane = TRUST_DIALOG;
            const atDialog = sessions.injectCommand(project.name, 'ls');
            assert.equal(atDialog.ok, false);
            assert.equal(atDialog.startupDialog.code, 'trust_required');
            assert.deepEqual(typed, []);
          });

          it('a send that names no engine is outside this: it has no profile to resolve, and is refused only while a blocker is stored', () => {
            startupDialog.reset();
            startupDialog._internal.engineProfiles = broken;
            const s = start();
            pane = AFTER_MENU;
            assert.equal(tmux._startupDialogOn(s.tmuxSession, null), null);
          });
        });

        it('control: a profile that says [] for itself does not depend on the list, and types', async () => {
          startupDialog.reset();
          startupDialog._internal.engineProfiles = () => { throw new Error('profile-list-read-failed'); };
          const optedOut = { ...VARIANT, capabilities: { supportsPrimePrompt: true, startupDialogs: [] } };
          assert.deepEqual(startupDialog.unreadable(optedOut), []);
          const s = start();
          pane = AFTER_MENU;
          const { rows } = await launchReal(s, optedOut);
          assert.ok(typed.some((t) => t.text === 'the prime'), 'the prime was pasted');
          assert.ok(!rows.some((r) => r.outcome === 'skipped'));
        });

        it('control: a profile with a sound list of its own does not depend on the list either', () => {
          startupDialog.reset();
          startupDialog._internal.engineProfiles = () => { throw new Error('profile-list-read-failed'); };
          assert.deepEqual(startupDialog.unreadable(CLAUDE), []);
          assert.deepEqual(startupDialog.declared(CLAUDE).map((d) => d.code), ['trust_required']);
        });

        it('control: with the list readable, a command nothing declares for is still simply undeclared', async () => {
          startupDialog.reset();
          startupDialog._internal.engineProfiles = () => [CLAUDE, { id: 'aider', command: 'aider', capabilities: {} }];
          const aider = { id: 'aider', command: 'aider', capabilities: {} };
          assert.deepEqual(startupDialog.unreadable(aider), []);
          assert.equal((await startupDialog.watch({ tmuxName: 't', engineProfile: aider })).outcome, 'undeclared');
        });
      });

      describe('nothing of the declaration readable, or the profile itself not fetchable: every sender is refused (A160 R11)', () => {
        const ALL_BAD = Object.freeze({ ...CASES['every entry unreadable'], id: 'claude', command: 'claude' });
        const MIXED = Object.freeze({ ...CASES['one sound entry and one unreadable'], id: 'claude', command: 'claude' });
        const NOT_A_LIST = Object.freeze({ ...CASES['a value that is not a list'], id: 'claude', command: 'claude' });
        const OPTED_OUT = Object.freeze({ ...WITH_PREKEY, id: 'claude', command: 'claude', capabilities: { ...WITH_PREKEY.capabilities, startupDialogs: [] } });
        let paneReads;
        let realEngineGet;
        /** What `store.engines.get` answers for each profile id in a test; anything else falls through to the real store. */
        let profiles;

        beforeEach(() => {
          paneReads = 0;
          profiles = {};
          tmux.capturePane = () => { paneReads += 1; return served(pane); };
          startupDialog._internal.wakeProfiles = () => ({ claude: WAKE });
          realEngineGet = store.engines.get;
          store.engines.get = (id) => {
            if (!(id in profiles)) return realEngineGet.call(store.engines, id);
            if (profiles[id] instanceof Error) throw profiles[id];
            return profiles[id];
          };
        });

        afterEach(() => { store.engines.get = realEngineGet; });

        const SENDERS = {
          'a command sent over the API': (s) => sessions.injectCommand(project.name, 'ls'),
          'the switchboard wake': (s) => require('../lib/medusa-wake')._internal.injectCommand(project.name, 'you have mail', { sessionId: s.id, controlExempt: 'medusa-wake' }),
          'the unready nudge': () => require('../lib/launch-unready')._internal.inject(project.name, 'run tc start next', {}),
          'the wrap hand-back': () => require('../lib/wrap-handback')._internal.inject(project.name, 'wrap finished', {}),
          'the launch kickoff': (s) => launchKickoff._internal.inject(project.name, 'read your launch context', { sessionId: s.id, launchSend: true })
        };

        /**
         * Assert a sender's answer is the every-sender refusal and that nothing reached, or was read from, the pane.
         * @param {object} sent - The sender's result
         * @param {RegExp} why - What the refusal must say
         * @returns {void}
         */
        const refusedUnread = (sent, why) => {
          assert.equal(sent.ok, false);
          assert.equal(sent.startupDialog.code, startupDialog.DECLARATION_UNREADABLE);
          assert.equal(sent.startupDialog.label, null);
          assert.match(sent.error, why);
          assert.deepEqual(typed, []);
          assert.equal(paneReads, 0, 'the pane is not read: there is nothing to read it against');
        };

        describe('an own declaration with no sound entry', () => {
          for (const [name, send] of Object.entries(SENDERS)) {
            it(`${name}: refused, nothing typed, the pane not read, no blocker recorded`, () => {
              profiles.claude = ALL_BAD;
              const s = start();
              pane = TRUST_DIALOG;
              refusedUnread(send(s), /^startup_dialogs_unreadable: nothing was typed into the session\. The engine profile "claude" declares startup dialogs TangleClaw could not read \(entry 1: /);
              assert.equal(store.sessions.get(s.id).launchBlocker, null);
            });
          }

          it('the pane writer refuses it, with the trust dialog up or a bare composer', () => {
            profiles.claude = ALL_BAD;
            const s = start();
            for (const frame of [TRUST_DIALOG, AFTER_MENU]) {
              pane = frame;
              const refused = tmux._startupDialogOn(s.tmuxSession, 'claude');
              assert.equal(refused.code, startupDialog.DECLARATION_UNREADABLE);
              assert.match(refused.meaning, /Correct the declaration in the engine profile, or set "startupDialogs": \[\] to declare none; sends go through again once the corrected profile is read/);
            }
            assert.equal(paneReads, 0);
          });

          it('a launch on it types nothing, as before', async () => {
            const s = start();
            pane = AFTER_MENU;
            const rows = [];
            const realRecord = store.sessionRuleDeliveries.record;
            store.sessionRuleDeliveries.record = (entry) => { rows.push(entry); return entry; };
            launchKickoff.kickoff = () => Promise.resolve('sent');
            try {
              const done = new Promise((resolve) => { launchFinished = resolve; });
              sessions._deferEngineInit(s.tmuxSession, project.name, 'claude', ALL_BAD, 'the prime', null, false,
                { sessionId: s.id, projectId: project.id, engineId: 'claude', kind: 'startup', ruleIds: [1], digest: 'd' },
                { sessionId: s.id, projectId: project.id, hasSequence: true });
              await done;
              await new Promise((resolve) => setTimeout(resolve, 5));
              await turns();
            } finally {
              store.sessionRuleDeliveries.record = realRecord;
            }
            assert.deepEqual(typed, []);
            assert.match(rows[0].skipReason, /^startup_dialogs_unreadable: /);
          });

          it('it persists send after send, and lifts at the first send after the profile is corrected', () => {
            profiles.claude = ALL_BAD;
            const s = start();
            pane = AFTER_MENU;
            for (let i = 0; i < 3; i++) assert.equal(sessions.injectCommand(project.name, 'ls').ok, false);
            assert.deepEqual(typed, []);
            assert.equal(paneReads, 0);
            profiles.claude = { ...CLAUDE, id: 'claude', command: 'claude' };
            assert.equal(sessions.injectCommand(project.name, 'ls').ok, true, 'the corrected profile is read at the next send');
            assert.deepEqual(typed, [{ text: 'ls' }]);
            assert.ok(paneReads >= 1);
            assert.equal(store.sessions.get(s.id).launchBlocker, null);
          });

          it('once corrected, the dialog it was written for is seen', () => {
            profiles.claude = ALL_BAD;
            start();
            pane = TRUST_DIALOG;
            assert.equal(sessions.injectCommand(project.name, 'ls').startupDialog.code, startupDialog.DECLARATION_UNREADABLE);
            profiles.claude = { ...CLAUDE, id: 'claude', command: 'claude' };
            assert.equal(sessions.injectCommand(project.name, 'ls').startupDialog.code, 'trust_required');
            assert.deepEqual(typed, []);
          });

          it('a value that is not a list, while the lookup of its program\'s dialogs has failed, is the same state', () => {
            startupDialog.reset();
            startupDialog._internal.engineProfiles = () => { throw new Error('profile-list-read-failed'); };
            profiles.claude = NOT_A_LIST;
            const s = start();
            pane = TRUST_DIALOG;
            const seen = startupDialog.check(s.tmuxSession, NOT_A_LIST);
            assert.equal(seen.unresolvedCause, 'declaration');
            refusedUnread(sessions.injectCommand(project.name, 'ls'), /^startup_dialogs_unreadable: /);
            assert.equal(tmux._startupDialogOn(s.tmuxSession, 'claude').code, startupDialog.DECLARATION_UNREADABLE);
          });

          it('control, a value that is not a list with its program\'s dialogs known: the pane IS read, the dialog refused by name, a composer typed into', () => {
            startupDialog.reset();
            startupDialog._internal.engineProfiles = () => [{ ...CLAUDE, id: 'claude-canonical', command: 'claude' }];
            profiles.claude = NOT_A_LIST;
            start();
            pane = TRUST_DIALOG;
            assert.equal(sessions.injectCommand(project.name, 'ls').startupDialog.code, 'trust_required');
            pane = AFTER_MENU;
            typed.length = 0;
            assert.equal(sessions.injectCommand(project.name, 'ls').ok, true);
            assert.ok(paneReads >= 2);
          });

          it('control, one sound entry beside a bad one: later sends still read and judge the pane', () => {
            profiles.claude = MIXED;
            start();
            pane = AFTER_MENU;
            assert.equal(sessions.injectCommand(project.name, 'ls').ok, true);
            assert.ok(paneReads >= 1);
            typed.length = 0;
            pane = TRUST_DIALOG;
            assert.equal(sessions.injectCommand(project.name, 'ls').startupDialog.code, 'trust_required');
            assert.deepEqual(typed, []);
          });

          it('control, a literal []: an ordinary send, the pane not consulted for a dialog', () => {
            profiles.claude = OPTED_OUT;
            const s = start();
            pane = TRUST_DIALOG;
            assert.equal(tmux._startupDialogOn(s.tmuxSession, 'claude'), null);
            assert.equal(sessions.injectCommand(project.name, 'ls').ok, true);
            assert.deepEqual(typed, [{ text: 'ls' }]);
          });
        });

        describe('the session\'s engine profile cannot be fetched', () => {
          const FAULTS = {
            'the read throws': () => new Error('Unexpected token } in JSON at position 41'),
            'there is no such profile': () => null
          };

          for (const [fault, make] of Object.entries(FAULTS)) {
            for (const [name, send] of Object.entries(SENDERS)) {
              it(`${fault}, ${name}: refused, nothing typed, the pane not read`, () => {
                profiles.claude = make();
                const s = start();
                pane = TRUST_DIALOG;
                refusedUnread(send(s), /^startup_dialogs_unreadable: nothing was typed into the session\. The engine profile "claude" could not be fetched: /);
                assert.equal(store.sessions.get(s.id).launchBlocker, null);
              });
            }

            it(`${fault}: the pane writer refuses a send that names the engine, and says what would lift it`, () => {
              profiles.claude = make();
              const s = start();
              pane = AFTER_MENU;
              const refused = tmux._startupDialogOn(s.tmuxSession, 'claude');
              assert.equal(refused.code, startupDialog.DECLARATION_UNREADABLE);
              assert.match(refused.meaning, /Sends go through again as soon as TangleClaw can read its engine profiles\. If this keeps happening, an engine profile file cannot be read and needs repair: the server log names the error/);
              assert.doesNotMatch(startupDialog.refusalText(refused), /clears by itself|nothing .* needs fixing/);
              assert.equal(paneReads, 0);
            });

            it(`${fault}: it lifts at the first send after the profile reads again`, () => {
              profiles.claude = make();
              start();
              pane = AFTER_MENU;
              assert.equal(sessions.injectCommand(project.name, 'ls').ok, false);
              assert.equal(sessions.injectCommand(project.name, 'ls').ok, false, 'and it persists while the fault does');
              profiles.claude = { ...CLAUDE, id: 'claude', command: 'claude' };
              assert.equal(sessions.injectCommand(project.name, 'ls').ok, true);
              assert.deepEqual(typed, [{ text: 'ls' }]);
            });

            it(`${fault}, with a blocker stored: still refused; the blocker is named as recorded and uncleared, not as on screen, and is not touched`, () => {
              profiles.claude = make();
              const s = start();
              store.sessions.setLaunchBlocker(s.id, BLOCKER);
              const before = JSON.stringify(store.sessions.get(s.id).launchBlocker);
              pane = AFTER_MENU;
              const sent = sessions.injectCommand(project.name, 'ls');
              assert.equal(sent.ok, false);
              assert.equal(sent.startupDialog.code, startupDialog.DECLARATION_UNREADABLE);
              assert.match(sent.error, /A launch blocker is also recorded for this session and has not been cleared \(trust_required, the engine's folder trust dialog\); TangleClaw cannot tell from here whether that dialog is still on screen/);
              assert.doesNotMatch(sent.error, /it is on screen/);
              assert.equal(paneReads, 0, 'the send did not read the pane');
              assert.equal(sessions.getSessionStatus(project.name).launchBlocker.code, 'trust_required', 'a status read does not clear it');
              assert.equal(JSON.stringify(store.sessions.get(s.id).launchBlocker), before, 'the record is unchanged');
              assert.deepEqual(typed, []);
            });
          }

          it('control, no engine named: no profile to fetch; refused only while a blocker is stored', () => {
            profiles.claude = new Error('unreadable');
            const s = start();
            pane = AFTER_MENU;
            assert.equal(tmux._startupDialogOn(s.tmuxSession, null), null);
            assert.equal(startupDialog.checkEngine(s.tmuxSession, null).unresolved, null);
            store.sessions.setLaunchBlocker(s.id, BLOCKER);
            assert.equal(tmux._startupDialogOn(s.tmuxSession, null).code, 'trust_required');
          });

          it('control, no store open: a process with no sessions has nothing to consult, and is not refused', () => {
            profiles.ghost = null;
            startupDialog._internal.storeOpen = () => false;
            const seen = startupDialog.checkEngine('t', 'ghost');
            assert.equal(seen.unresolved, null);
            assert.equal(startupDialog.withholdFor(seen, null), null);
            startupDialog._internal.storeOpen = () => true;
            assert.equal(startupDialog.checkEngine('t', 'ghost').unresolvedCause, 'profile');
          });

          it('the cause is a field, not wording: profile, declaration and lookup are told apart by `unresolvedCause`', () => {
            profiles.claude = null;
            assert.equal(startupDialog.checkEngine('t', 'claude').unresolvedCause, 'profile');
            assert.equal(startupDialog.check('t', ALL_BAD).unresolvedCause, 'declaration');
            startupDialog.reset();
            startupDialog._internal.engineProfiles = () => { throw new Error('x'); };
            assert.equal(startupDialog.check('t', { id: 'v', command: 'claude', capabilities: {} }).unresolvedCause, 'lookup');
            assert.equal(startupDialog.check('t', MIXED).unresolvedCause, null);
            assert.equal(startupDialog.check('t', OPTED_OUT).unresolvedCause, null);
          });
        });

        describe('a connection-qualified engine id resolves to its base profile first', () => {
          const OPENCLAW = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'openclaw.json'), 'utf8'));
          const startOpenclaw = () => store.sessions.start({ projectId: project.id, engineId: 'openclaw:conn-7', tmuxSession: `a160-oc-${counter}` });

          it('the mapping is the one a launch makes', () => {
            assert.equal(startupDialog.profileIdOf('openclaw:conn-7'), 'openclaw');
            assert.equal(startupDialog.profileIdOf('claude'), 'claude');
            assert.equal(startupDialog.profileIdOf('claude-sonnet-reviewer'), 'claude-sonnet-reviewer');
            assert.equal(startupDialog.profileIdOf(null), null);
            assert.equal(startupDialog.profileIdOf(''), null);
          });

          it('a healthy OpenClaw session over SSH: its base profile is fetched (never "openclaw:conn-7"), and the send is typed', () => {
            const asked = [];
            const inner = store.engines.get;
            store.engines.get = (id) => { asked.push(id); return inner(id); };
            profiles.openclaw = OPENCLAW;
            const s = startOpenclaw();
            pane = AFTER_MENU;
            assert.equal(tmux._startupDialogOn(s.tmuxSession, 'openclaw:conn-7'), null);
            assert.equal(sessions.injectCommand(project.name, 'ls').ok, true);
            assert.deepEqual(typed, [{ text: 'ls' }]);
            assert.ok(asked.includes('openclaw'));
            assert.ok(!asked.includes('openclaw:conn-7'), 'a connection-qualified id is not looked up as a profile');
          });

          for (const [fault, value] of Object.entries({ 'is missing': null, 'cannot be read': new Error('EACCES: permission denied') })) {
            it(`the base profile ${fault}: that OpenClaw session's sends are refused, naming the base profile and the engine`, () => {
              profiles.openclaw = value;
              const s = startOpenclaw();
              pane = AFTER_MENU;
              const sent = sessions.injectCommand(project.name, 'ls');
              assert.equal(sent.ok, false);
              assert.equal(sent.startupDialog.code, startupDialog.DECLARATION_UNREADABLE);
              assert.match(sent.error, /engine profile "openclaw" \(for engine "openclaw:conn-7"\) could not be fetched/);
              assert.equal(tmux._startupDialogOn(s.tmuxSession, 'openclaw:conn-7').code, startupDialog.DECLARATION_UNREADABLE);
              assert.deepEqual(typed, []);
            });
          }

          it('control, a Web UI session: refused earlier as it always was, for its own reason, with no profile fetched', () => {
            const asked = [];
            const inner = store.engines.get;
            store.engines.get = (id) => { asked.push(id); return inner(id); };
            profiles.openclaw = null;
            store.sessions.start({ projectId: project.id, engineId: 'openclaw:conn-7', tmuxSession: null, sessionMode: 'webui' });
            const sent = sessions.injectCommand(project.name, 'ls');
            assert.equal(sent.ok, false);
            assert.match(sent.error, /not supported for Web UI sessions/);
            assert.equal(sent.startupDialog, undefined);
            assert.deepEqual(asked, []);
          });
        });
      });

      it('a command whose only declaration is unreadable still passes the refusal on', () => {
        const source = { ...CASES['every entry unreadable'], id: 'claude', command: 'claude' };
        startupDialog.reset();
        startupDialog._internal.engineProfiles = () => [source];
        assert.equal(startupDialog.unreadable({ id: 'v', command: 'claude', capabilities: {} }).length, 1);
      });

      it('the shipped profiles all read cleanly', () => {
        const dir = path.join(__dirname, '..', 'data', 'engines');
        for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
          const profile = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
          const own = profile.capabilities && profile.capabilities.startupDialogs;
          if (own !== undefined) assert.deepEqual(startupDialog.unreadable(profile), [], file);
        }
      });
    });

    it('launch, no blocker stored, REAL fresh composer: the pre-key, the prime and the kickoff are all typed', async () => {
      const s = start();
      pane = FRESH;
      const { kicks } = await launchedAfterTimeout(s);
      // Order is not the subject: this stand-in kickoff sends at once, where the real one first waits for the pane to rest.
      assert.deepEqual(typed.map((t) => t.key || t.text).sort(), ['Enter', 'Run `tc start next`', 'the prime']);
      assert.equal(kicks[0].ok, true);
    });

    it('launch, an unrecognised screen with no glyph-led row: the launch still types, as before', async () => {
      const s = start();
      pane = ['  Verifying your account…'];
      await launchedAfterTimeout(s);
      assert.ok(typed.some((t) => t.text === 'the prime'));
    });

    it('a stored blocker IS cleared by the real fresh composer and by the bare one', () => {
      for (const lines of [FRESH, AFTER_MENU, [...TRUST_DIALOG, ...FRESH]]) {
        const s = start();
        store.sessions.setLaunchBlocker(s.id, BLOCKER);
        pane = lines;
        assert.equal(sessions.getSessionStatus(project.name).launchBlocker, null);
        assert.equal(store.sessions.get(s.id).launchBlocker, null);
        store.sessions.markCrashed(s.id, 'test cleanup');
      }
    });

    it('a later injection, no blocker stored, into a composer holding a draft is NOT refused here: the writer keeps and clears the draft', () => {
      const s = start();
      pane = DRAFT;
      assert.equal(tmux._startupDialogOn(s.tmuxSession, 'claude'), null, 'the pane writer goes on to its prompt clear');
      const sent = sessions.injectCommand(project.name, 'ls');
      assert.equal(sent.ok, true);
      assert.deepEqual(typed, [{ text: 'ls' }]);
      assert.equal(store.sessions.get(s.id).launchBlocker, null);
    });

    for (const [name, lines] of Object.entries({ 'option 1': BYPASS_1, 'option 2': BYPASS_2 })) {
      it(`a later injection into the bypass confirmation with ${name} selected, no blocker stored, is refused by the session and by the pane writer`, () => {
        const s = start();
        pane = lines;
        const sent = sessions.injectCommand(project.name, 'ls');
        assert.equal(sent.ok, false);
        assert.equal(sent.startupDialog.code, 'trust_required');
        assert.equal(tmux._startupDialogOn(s.tmuxSession, 'claude').code, 'trust_required');
        assert.deepEqual(typed, []);
        assert.equal(store.sessions.get(s.id).launchBlocker, null, 'a suspect frame records no blocker');
      });
    }

    it('a later injection, no blocker stored, into a draft below quoted dialog text is sent, and no blocker is recorded on the quote', () => {
      const s = start();
      pane = at([...QUOTING_SESSION.slice(0, 5), ...DRAFT], DRAFT_CURSOR);
      assert.equal(tmux._startupDialogOn(s.tmuxSession, 'claude'), null);
      assert.equal(sessions.injectCommand(project.name, 'ls').ok, true);
      assert.deepEqual(typed, [{ text: 'ls' }]);
      assert.equal(sessions.getSessionStatus(project.name).launchBlocker, null);
    });

    it('a send that names no engine is refused only while a blocker is stored', () => {
      const s = start();
      pane = MENU_2;
      assert.equal(tmux._startupDialogOn(s.tmuxSession, null), null);
      store.sessions.setLaunchBlocker(s.id, BLOCKER);
      assert.equal(tmux._startupDialogOn(s.tmuxSession, null).code, 'trust_required');
    });
  });
});
