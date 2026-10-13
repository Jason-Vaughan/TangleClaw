'use strict';

/*
 * #2186 — the pane witness: positive evidence of an empty composer, or no.
 *
 * A native startup fire into a folder the engine's config does not trust may
 * only go when the pane is positively showing its ordinary composer. These
 * tests feed the witness Codex's startup screens as one visible-pane read
 * gives them (rows in place, cursor row and column) and pin that only the
 * usable composer passes, and only with the cursor ON it.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/store');
const paneWitness = require('../lib/pane-witness');
const { CODEX_VISIBLE_PANES: PANES, CODEX_CHANNEL_VERSIONS, CODEX_CHANNEL_FIXTURES } = require('./_codex-visible-pane-fixtures');

const codex = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'codex.json'), 'utf8'));
// What the Codex adapter hands the witness. The two header patterns are the
// profile's own (`capabilities.wake`), as the adapter reads them.
const HEADER_RE = new RegExp(codex.capabilities.wake.headerPattern);
const STARTING_RE = new RegExp(codex.capabilities.wake.startingPattern);
const STATUS_RE = /^ {2}[^\s│╭╰╮╯›>].* · \S/;
const KEY_HINT_RE = /^(enter|return|esc|escape|tab|space|arrows?|[↑↓←→]+)$/i;
const COMPOSER = '\u001b[1m›\u001b[0m \u001b[2mAsk Codex to do anything\u001b[0m';

describe('the pane witness (#2186)', () => {
  let tmpDir;
  let wakeProfile;
  let reads;
  let pins;
  const PANE_ID = '%7';
  /** The tmux server that issued PANE_ID, as a launch records it. */
  const PANE_SERVER = '4242.1790431343';

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-pane-witness-'));
    store._setBasePath(tmpDir);
    store.init();
    wakeProfile = require('../lib/medusa-wake').ENGINE_WAKE_PROFILES.codex;
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * Ask the witness about a scripted pane.
   * @param {Array<object|Error>} frames - One visible-pane read per call; the last repeats.
   * @param {object} [over] - Target overrides.
   * @returns {Promise<object>}
   */
  const ask = (frames, over = {}, seamOver = {}) => {
    let i = 0;
    reads = [];
    pins = [];
    return paneWitness.composerShown({
      tmuxName: 'tc-x', paneId: PANE_ID, paneServer: PANE_SERVER, engineProfile: codex, wakeProfile, headerRe: HEADER_RE, startingRe: STARTING_RE, statusRe: STATUS_RE, maxStatusRows: 1, keyHintRe: KEY_HINT_RE, ...over
    }, {
      gapMs: 0,
      sleep: async () => { i += 1; },
      pin: (name) => { pins.push(name); return PANE_ID; },
      read: (name, paneId) => {
        reads.push(`${name} ${paneId}`);
        const f = frames[Math.min(i, frames.length - 1)];
        if (f instanceof Error) throw f;
        return { paneId: PANE_ID, ...f, rows: [...f.rows] };
      },
      ...seamOver
    });
  };

  /**
   * A pane built row by row, padded to its height, with the cursor placed.
   * @param {string[]} top - The rows from the top.
   * @param {number} y - Cursor row.
   * @param {number} [x=2] - Cursor column.
   * @param {number} [height=14] - Pane height.
   * @returns {{height: number, x: number, y: number, rows: string[]}}
   */
  const pane = (top, y, x = 2, height = 14) => ({ height, x, y, rows: [...top, ...Array(Math.max(0, height - top.length)).fill('')] });

  describe('on Codex\'s live startup screens', () => {
    it('a usable composer, seen twice, is shown', async () => {
      assert.deepEqual(await ask([PANES.composer]), { shown: true });
      assert.deepEqual(await ask([PANES.composerAfterUpdateSkipped]), { shown: true });
      assert.deepEqual(await ask([PANES.composerOperatorStatus]), { shown: true }, 'the operator\'s status line, with its run-state item, is a status row');
    });

    it('a status row that ends with a warning and the key that shows it is still a status row', async () => {
      const status = PANES.composerWarningStatus.rows[PANES.composerWarningStatus.y + 2];
      assert.match(status, /⚠ 1 warning · f2 to view$/);
      assert.ok(status.split(/[\s·]+/).includes('f2'), 'the row names a key as a whole token');
      assert.ok(!KEY_HINT_RE.test('f2'), 'and that key is not one a dialog footer offers');
      assert.deepEqual(await ask([PANES.composerWarningStatus]), { shown: true });
      // The same pane read with function keys counted as footer keys is refused,
      // which is what widening the list would do to every session showing a warning.
      const widened = await ask([PANES.composerWarningStatus], { keyHintRe: /^(enter|esc|f\d+)$/i });
      assert.equal(widened.shown, false);
    });

    it('pins the session\'s pane once, then reads THAT pane exactly twice, each read one call for rows and cursor together', async () => {
      await ask([PANES.composer]);
      assert.deepEqual(pins, ['tc-x']);
      assert.deepEqual(reads, ['tc-x %7', 'tc-x %7']);
    });

    it('the folder-trust prompt is named as a dialog, although the opening composer is drawn above it', async () => {
      const r = await ask([PANES.trustPrompt]);
      assert.equal(r.shown, false);
      assert.equal(r.dialog.id, 'folder-trust');
    });

    it('the update prompt is named as a dialog', async () => {
      const r = await ask([PANES.updatePrompt]);
      assert.equal(r.shown, false);
      assert.equal(r.dialog.id, 'update');
    });

    it('the opening screen is not shown: its composer is empty and under the cursor, but the header still reads loading', async () => {
      assert.deepEqual(await ask([PANES.openingScreen]), { shown: false, dialog: null, why: 'the engine is still starting' });
    });

    it('with two headers on the pane, only the newest one is judged', async () => {
      const top = ['│ model:     loading   /model to change │', '', '│ model:     GPT-6-Astra   /model to change │', '', COMPOSER, '', '  GPT-6-Astra default · /p'];
      assert.deepEqual(await ask([pane(top, 4)]), { shown: true });
      const stillStarting = ['│ model:     GPT-6-Astra   /model to change │', '', '│ model:     loading   /model to change │', '', COMPOSER, '', '  GPT-6-Astra default · /p'];
      assert.deepEqual(await ask([pane(stillStarting, 4)]), { shown: false, dialog: null, why: 'the engine is still starting' });
    });
  });

  describe('the cursor is bound to the last composer row by position', () => {
    it('an identical older composer row higher up, with the cursor parked on IT, is refused', async () => {
      // Codex leaves a superseded composer above the live one (after a skipped
      // prompt, for one). Whether it is still on the visible pane depends on
      // the pane's height; this frame keeps it visible.
      const top = [COMPOSER, '', '│ model:     GPT-6-Astra   /model to change │', '', '› Ask Codex to do anything', '', '  GPT-6-Astra default · /p'];
      assert.equal(require('../lib/medusa-wake')._composerEmpty({ x: 2, y: 0, line: top[0] }, wakeProfile), true, 'by its text alone the older row is an empty composer under the cursor');
      assert.deepEqual(await ask([pane(top, 0)]), { shown: false, dialog: null, why: 'the cursor is not on the composer row' });
      const live = [...top];
      live[0] = '› Ask Codex to do anything';
      live[4] = COMPOSER;
      assert.deepEqual(await ask([pane(live, 4)]), { shown: true }, 'the same pane with the cursor on the last composer row');
    });

    it('a cursor one row off the composer is refused, whatever that row holds', async () => {
      for (const dy of [-1, 1, 2]) {
        const r = await ask([{ ...PANES.composer, y: PANES.composer.y + dy }]);
        assert.equal(r.shown, false, String(dy));
      }
    });

    it('a pane with leading blank rows keeps its rows in place: the composer is found where the cursor says', async () => {
      const top = ['', '', '', COMPOSER, '', '  GPT-6-Astra default · /p'];
      assert.deepEqual(await ask([pane(top, 3)]), { shown: true });
      assert.equal((await ask([pane(top, 0)])).shown, false, 'the cursor on a blank row above is not on the composer');
    });

    it('a composer holding typed text is not shown', async () => {
      const r = await ask([pane(['\u001b[1m›\u001b[0m hello', '', '  GPT-6-Astra default · /p'], 0, 7)]);
      assert.equal(r.shown, false);
    });
  });

  describe('what may be drawn below the composer', () => {
    const STATUS = '  GPT-6-Astra default · /p';

    it('a boxed menu below a stale composer that still holds the cursor is refused: no row starts with the glyph, and it is still not a status row', async () => {
      const top = [COMPOSER, '', '╭──────────────╮', '│ › Careful    │', '│   Fast       │', '╰──────────────╯'];
      const r = await ask([pane(top, 0)]);
      assert.deepEqual(r, { shown: false, dialog: null, why: 'something other than a status row is drawn below the composer' });
    });

    it('a menu with a faint glyph-led selected row is refused, with the cursor on it or on the stale composer', async () => {
      const top = [COMPOSER, '', '  Choose a mode', '\u001b[1m›\u001b[0m \u001b[2mCareful\u001b[0m', '  Fast', '', '  enter select'];
      assert.equal(require('../lib/medusa-wake')._composerEmpty({ x: 2, y: 3, line: top[3] }, wakeProfile), true, 'the emptiness check alone is fooled by the selected row');
      assert.equal((await ask([pane(top, 3)])).shown, false);
      assert.equal((await ask([pane(top, 0)])).why, 'a selector row is drawn below the composer');
    });

    it('any unrecognised text below the composer is refused, marked or not', async () => {
      for (const extra of ['  Press enter to continue', 'Continue? [y/N]', '  1. Yes   2. No', '  ? for shortcuts']) {
        const r = await ask([pane([COMPOSER, '', extra], 0)]);
        assert.equal(r.shown, false, extra);
      }
    });

    it('a stale composer holding the cursor above one Codex dialog footer is refused: the footer has a status row\'s shape and names keys', async () => {
      const footerOnly = pane([COMPOSER, '', '  enter continue · esc skip'], 0);
      assert.ok(STATUS_RE.test('  enter continue · esc skip'), 'by shape alone the footer is a status row');
      assert.deepEqual(await ask([footerOnly]), { shown: false, dialog: null, why: 'a row below the composer names keys, as a dialog footer does' });
      for (const footer of ['  enter continue · esc quit', '  Tab to switch · Enter to confirm', '  ↑↓ move · space select', '  arrows move · return accept', '  ESC cancel · x']) {
        assert.equal((await ask([pane([COMPOSER, '', footer], 0)])).shown, false, footer);
      }
    });

    it('the measured status rows still pass: a key word inside a model name or a path is not a key, and "left" is not an arrow', async () => {
      for (const status of [
        '  GPT-6-Astra default · /private/tmp/b4cs-8d6DW4',
        '  GPT-6-Astra default · Ready · never · Context 100% left',
        '  GPT-6-Astra default · Ready · Ask for approval · Context 100% left',
        '  Enterprise-1 default · /Users/someone/space/tab-project/escape',
        '  gpt-enter default · /srv/esc'
      ]) {
        assert.deepEqual(await ask([pane([COMPOSER, '', status], 0)]), { shown: true }, status);
      }
    });

    it('KNOWN LIMIT: the status row is still recognised by shape, so a middle-dot row that names no key passes', async () => {
      // Not positive status-row evidence. Stated so that closing it (by
      // binding the row to the model the pane's header names, once a signed-in
      // pane has been measured) is a deliberate change.
      assert.deepEqual(await ask([pane([COMPOSER, '', '  Yes · No · Cancel'], 0)]), { shown: true });
      assert.equal((await ask([pane([COMPOSER, '', '  Pick one', '  Yes · No · Cancel'], 0)])).shown, false, 'refused as soon as anything else is drawn with it');
    });

    it('one status row is allowed, a second is not', async () => {
      assert.deepEqual(await ask([pane([COMPOSER, '', STATUS], 0)]), { shown: true });
      assert.equal((await ask([pane([COMPOSER, '', STATUS, '  ← for agents · ? for shortcuts'], 0)])).shown, false);
    });

    it('a composer with nothing at all below it is shown', async () => {
      assert.deepEqual(await ask([pane(['  an earlier answer', '', COMPOSER], 2)]), { shown: true });
    });

    it('an adapter that names no status row allows nothing below the composer', async () => {
      const r = await ask([pane([COMPOSER, '', STATUS], 0)], { statusRe: null });
      assert.equal(r.why, 'something other than a status row is drawn below the composer');
    });
  });

  describe('two reads a second apart', () => {
    it('a pane that changes between them is not shown', async () => {
      const a = pane(['  one line', '', COMPOSER, '', '  GPT-6-Astra default · /p'], 2);
      const b = pane(['  another line', '', COMPOSER, '', '  GPT-6-Astra default · /p'], 2);
      assert.deepEqual(await ask([a, b]), { shown: false, dialog: null, why: 'the pane changed between two reads a second apart' });
    });

    it('a dialog that appears between them is named', async () => {
      const r = await ask([PANES.composer, PANES.updatePrompt]);
      assert.equal(r.shown, false);
      assert.equal(r.dialog.id, 'update');
    });

    it('a cursor that moves between them is a changed pane', async () => {
      const a = pane([COMPOSER, '', '  GPT-6-Astra default · /p'], 0, 2);
      const b = pane([COMPOSER, '', '  GPT-6-Astra default · /p'], 0, 2);
      b.rows[0] = COMPOSER;
      assert.deepEqual(await ask([a, b]), { shown: true });
      assert.equal((await ask([a, { ...a, y: 1 }])).shown, false);
    });

    it('the engine\'s own animated decoration moving between them is not a change', async () => {
      const a = pane(['  history ⠁', '', COMPOSER, '', '  GPT-6-Astra default · /p'], 2);
      const b = pane(['  history ⡁', '', COMPOSER, '', '  GPT-6-Astra default · /p'], 2);
      assert.deepEqual(await ask([a, b]), { shown: true });
    });

    it('a busy pane is not shown', async () => {
      const r = await ask([pane(['• Working (3s • esc to interrupt)', '', COMPOSER, '', '  GPT-6-Astra default · /p'], 2)]);
      assert.deepEqual(r, { shown: false, dialog: null, why: 'a turn is running' });
    });
  });

  describe('the witness reads one pinned pane, and no other', () => {
    const good = () => pane([COMPOSER, '', '  GPT-6-Astra default · /p'], 0);

    it('a session that does not have exactly one pane is refused before anything is read', async () => {
      const r = await ask([good()], {}, { pin: () => { throw new Error('tmux session "tc-x" does not have exactly one pane'); } });
      assert.deepEqual(r, { shown: false, dialog: null, why: 'the session does not have exactly one pane to read' });
      assert.deepEqual(reads, []);
    });

    it('a pin that is not a pane id is refused before anything is read', async () => {
      for (const bad of [null, undefined, '', 7]) {
        const r = await ask([good()], {}, { pin: () => bad });
        assert.equal(r.shown, false, String(bad));
        assert.deepEqual(reads, []);
      }
    });

    it('the active pane switching between the two reads cannot move the witness: a frame from another pane is refused', async () => {
      let n = 0;
      const r = await ask([good()], {}, { read: () => { n += 1; return { paneId: n === 1 ? PANE_ID : '%8', ...good() }; } });
      assert.deepEqual(r, { shown: false, dialog: null, why: 'the pane that was read is not the pane that was pinned' });
    });

    it('a first read that already comes from another pane is refused', async () => {
      const r = await ask([good()], {}, { read: () => ({ paneId: '%8', ...good() }) });
      assert.equal(r.why, 'the pane that was read is not the pane that was pinned');
    });

    it('a read that names no pane at all is refused', async () => {
      const r = await ask([good()], {}, { read: () => good() });
      assert.equal(r.why, 'the pane that was read is not the pane that was pinned');
    });

    it('a second pane appearing between the reads is refused: the read itself throws for it', async () => {
      let n = 0;
      const r = await ask([good()], {}, { read: () => { n += 1; if (n === 2) throw new Error('the session no longer has exactly one pane'); return { paneId: PANE_ID, ...good() }; } });
      assert.deepEqual(r, { shown: false, dialog: null, why: 'the pane could not be read' });
    });

    it('REPLACEMENT BEFORE THE FIRE: the launch\'s pane was killed and another is now the session\'s only pane, with a usable composer: refused, and never read', async () => {
      // Split the session, kill the pane the launch created, and the session
      // again has exactly one pane: a different process, with a composer of its
      // own. It passes every check a pane can pass. It is not the launch's.
      const r = await ask([good()], {}, { pin: () => '%9', read: (name, id) => ({ paneId: id, ...good() }) });
      assert.deepEqual(r, { shown: false, dialog: null, why: 'the session\'s pane is not the pane this launch created', lasting: true });
      assert.deepEqual(reads, [], 'the replacement pane is not even read');
    });

    it('a launch with no pane on record cannot be vouched for', async () => {
      for (const missing of [undefined, null, '']) {
        const r = await ask([good()], { paneId: missing });
        assert.deepEqual(r, { shown: false, dialog: null, why: 'the pane this launch created is not on record', lasting: true });
        assert.deepEqual(reads, []);
      }
    });

    it('a launch with no tmux server on record beside its pane cannot be vouched for either', async () => {
      for (const missing of [undefined, null, '']) {
        const r = await ask([good()], { paneServer: missing });
        assert.deepEqual(r, { shown: false, dialog: null, why: 'the pane this launch created is not on record', lasting: true });
        assert.deepEqual(reads, []);
      }
    });

    it('every read is told which tmux server the launch\'s pane was created in', async () => {
      const told = [];
      await ask([good()], {}, { read: (name, id, server) => { told.push(server); return { paneId: id, ...good() }; } });
      assert.deepEqual(told, [PANE_SERVER, PANE_SERVER]);
    });

    it('TMUX SERVER RESTARTED: a new server has a session of the same name whose one pane has the same id and a usable composer: refused, and it does not clear by waiting', async () => {
      // Pane ids start again at %0 in a new server, so the pin passes. Only
      // the read, which asks the server who it is, can tell.
      const other = () => { throw Object.assign(new Error('tmux answered from a different server'), { tcOtherServer: true }); };
      const r = await ask([good()], {}, { pin: () => PANE_ID, read: other });
      assert.deepEqual(r, { shown: false, dialog: null, why: 'the tmux server is not the one this launch\'s pane was created in', lasting: true });
      let n = 0;
      const second = await ask([good()], {}, { read: (name, id) => { n += 1; if (n === 2) other(); return { paneId: id, ...good() }; } });
      assert.equal(second.shown, false, 'on the second read too');
      assert.equal(second.lasting, true);
    });

    it('both reads are aimed at the id pinned at the start, not re-resolved', async () => {
      let pinned = 0;
      const asked = [];
      await ask([good()], {}, { pin: () => { pinned += 1; return PANE_ID; }, read: (name, id) => { asked.push(id); return { paneId: id, ...good() }; } });
      assert.equal(pinned, 1);
      assert.deepEqual(asked, [PANE_ID, PANE_ID]);
    });
  });

  describe('a read that cannot be trusted row for row', () => {
    it('a thrown read is refused with a fixed sentence; the fault\'s own text is for the server log', async () => {
      assert.equal((await ask([new Error('no server running: /private/secret/sock')])).why, 'the pane could not be read');
    });

    it('rows that do not number the pane\'s height, a cursor outside them, or a missing field are refused', async () => {
      const good = pane([COMPOSER, '', '  GPT-6-Astra default · /p'], 0);
      const bad = [
        { ...good, rows: good.rows.slice(1) },
        { ...good, rows: [...good.rows, ''] },
        { ...good, height: 0, rows: [] },
        { ...good, y: good.height },
        { ...good, y: -1 },
        { ...good, y: undefined },
        { ...good, x: undefined },
        { height: good.height, x: 2, y: 0, rows: null }
      ];
      for (const frame of bad) {
        const r = await paneWitness.composerShown({ tmuxName: 'tc-x', paneId: PANE_ID, paneServer: PANE_SERVER, engineProfile: codex, wakeProfile, headerRe: HEADER_RE, startingRe: STARTING_RE, statusRe: STATUS_RE }, { gapMs: 0, sleep: async () => {}, pin: () => PANE_ID, read: () => ({ paneId: PANE_ID, ...frame }) });
        assert.deepEqual(r, { shown: false, dialog: null, why: 'the pane and its cursor could not be read row for row' });
      }
    });

    it('a profile whose guarded dialogs cannot be read proves nothing', async () => {
      const broken = { ...codex, launch: { ...codex.launch, guardedDialogs: [{ id: 'update', match: '(' }] } };
      const r = await ask([PANES.composer], { engineProfile: broken });
      assert.match(r.why, /could not be read, so a dialog could not be ruled out/);
    });

    it('no pane, or no composer pattern, is not shown and nothing is read', async () => {
      assert.equal((await ask([PANES.composer], { tmuxName: null })).shown, false);
      assert.equal((await ask([PANES.composer], { wakeProfile: null })).shown, false);
      assert.deepEqual(reads, []);
    });

    it('a session whose header has scrolled away is shown: the composer, cursor and status evidence stand without it', async () => {
      const r = await ask([pane(['  an earlier answer', '', COMPOSER, '', '  GPT-6-Astra default · /p'], 2)]);
      assert.deepEqual(r, { shown: true });
    });
  });

  describe('the one-read entry point (#2059)', () => {
    /**
     * Ask `composerShownOnce` about a scripted pane, counting its tmux calls.
     * @param {Array<object|Error>} frames - One visible-pane read per call; the last repeats.
     * @param {object} [over] - Target overrides.
     * @param {object} [seamOver] - Seam overrides.
     * @returns {Promise<object>}
     */
    const askOnce = (frames, over = {}, seamOver = {}) => {
      let i = 0;
      reads = [];
      pins = [];
      return paneWitness.composerShownOnce({
        tmuxName: 'tc-x', paneId: PANE_ID, paneServer: PANE_SERVER, engineProfile: codex, wakeProfile, headerRe: HEADER_RE, startingRe: STARTING_RE, statusRe: STATUS_RE, maxStatusRows: 1, keyHintRe: KEY_HINT_RE, ...over
      }, {
        pin: (name) => { pins.push(name); return PANE_ID; },
        read: (name, paneId) => {
          reads.push(`${name} ${paneId}`);
          const f = frames[Math.min(i, frames.length - 1)];
          i += 1;
          if (f instanceof Error) throw f;
          return { paneId: PANE_ID, ...f, rows: [...f.rows] };
        },
        ...seamOver
      });
    };

    it('answers every live capture exactly as the two-read witness answers that capture held still', async () => {
      for (const name of Object.keys(PANES)) {
        const twice = await ask([PANES[name]]);
        const once = await askOnce([PANES[name]]);
        assert.deepEqual(once, twice, name);
      }
      assert.deepEqual(await askOnce([PANES.composer]), { shown: true });
    });

    it('pins the pane once and reads it exactly once', async () => {
      await askOnce([PANES.composer]);
      assert.deepEqual(pins, ['tc-x']);
      assert.deepEqual(reads, ['tc-x %7']);
    });

    it('judges the one frame it took: a second, different frame is never asked for', async () => {
      const typed = pane(['\u001b[1m›\u001b[0m hello', '', '  GPT-6-Astra default · /p'], 0, 7);
      const refused = await ask([typed]);
      assert.equal(refused.shown, false, 'the frame the two-read witness refuses');
      assert.deepEqual(await askOnce([PANES.composer, typed]), { shown: true });
      assert.deepEqual(await askOnce([typed, PANES.composer]), refused);
      assert.equal(reads.length, 1);
    });

    it('refuses on one frame what the two-read witness refuses on one frame', async () => {
      const cases = [
        [pane([COMPOSER, '', '  GPT-6-Astra default · /p', '  a second row · here'], 0), 'something other than a status row is drawn below the composer'],
        [pane([COMPOSER, '', '  enter continue · esc skip'], 0), 'a row below the composer names keys, as a dialog footer does'],
        [pane(['  an answer', COMPOSER], 0), 'the cursor is not on the composer row'],
        [pane(['  nothing here'], 0), 'no empty composer row is on screen'],
        [new Error('no server running'), 'the pane could not be read']
      ];
      for (const [frame, why] of cases) {
        const once = await askOnce([frame]);
        assert.deepEqual(once, await ask([frame]), why);
        assert.equal(once.why, why);
      }
      assert.equal((await askOnce([PANES.trustPrompt])).dialog.id, 'folder-trust');
      assert.equal((await askOnce([PANES.updatePrompt])).dialog.id, 'update');
      assert.equal((await askOnce([PANES.openingScreen])).why, 'the engine is still starting');
    });

    it('keeps the pinning rules: another pane, no pane on record, another tmux server', async () => {
      assert.deepEqual(await askOnce([PANES.composer], {}, { pin: () => '%40' }),
        { shown: false, dialog: null, why: 'the session\'s pane is not the pane this launch created', lasting: true });
      assert.deepEqual(reads, [], 'the other pane is never read');
      assert.equal((await askOnce([PANES.composer], { paneServer: '' })).why, 'the pane this launch created is not on record');
      const other = Object.assign(new Error('other server'), { tcOtherServer: true });
      assert.deepEqual(await askOnce([other]),
        { shown: false, dialog: null, why: 'the tmux server is not the one this launch\'s pane was created in', lasting: true });
      assert.equal((await askOnce([PANES.composer], {}, { pin: () => { throw new Error('two panes'); } })).why, 'the session does not have exactly one pane to read');
    });

    it('a read that throws is asked once, not twice', async () => {
      await askOnce([new Error('gone'), PANES.composer]);
      assert.equal(reads.length, 1);
    });
  });
  // #2059. Codex 0.161.0 and 0.162.0 draw a footer row beneath the status row
  // at rest, and that footer ALONE on the screen they open and resume with.
  // Every frame here is that version's own capture over the launch path
  // TangleClaw uses, or that capture with the named rows changed.
  describe('a declared footer row, per captured version (#2059)', () => {
    /** The usable composers of a version, by fixture name. */
    const AT_REST = ['idleDefaultLayout', 'idleThreeItemStatus', 'idleAfterTurn', 'idleAfterUpdateSkipped', 'idleAfterResume'];
    const NOT_OPENING = 'something other than one status row and then the declared footer row is drawn below the composer';
    const OPENING = 'the footer row is drawn with no status row above it, as on a screen that is still opening or resuming';
    /** A captured row as the witness reads it: no styling, no trailing space. */
    const text = (row) => row.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '').replace(/\s+$/, '');
    /** The non-blank rows a capture draws below its cursor row, as text. */
    const drawnBelow = (frame) => frame.rows.slice(frame.y + 1).map(text).filter((row) => row !== '');

    for (const version of CODEX_CHANNEL_VERSIONS) {
      describe(`codex-cli ${version}`, () => {
        const fx = CODEX_CHANNEL_FIXTURES[version];
        const footerRe = new RegExp(codex.capabilities.wake.restRows[version].footerPattern);
        const model = fx.threads.userBeforeFirstTurn.model;
        /** The status pattern the adapter builds for a thread whose model it read. */
        const modelRe = new RegExp(`${STATUS_RE.source}|^ {2}${model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
        /** Under this version's declaration: the footer option in place of a row count. */
        const declared = (over = {}) => ({ footerRe, maxStatusRows: undefined, ...over });
        /** One fresh read, as the send-time look takes it. */
        const once = (frame, over = {}) => paneWitness.composerShownOnce({
          tmuxName: 'tc-x', paneId: PANE_ID, paneServer: PANE_SERVER, engineProfile: codex, wakeProfile, headerRe: HEADER_RE, startingRe: STARTING_RE, statusRe: STATUS_RE, keyHintRe: KEY_HINT_RE, ...over
        }, { pin: () => PANE_ID, read: () => ({ paneId: PANE_ID, ...frame, rows: [...frame.rows] }) });
        /**
         * A capture with the non-blank rows below its composer replaced.
         * @param {object} frame - A captured pane.
         * @param {string[]} below - The rows to draw there, top down.
         * @returns {object}
         */
        const withBelow = (frame, below) => {
          const rows = [...frame.rows];
          for (let i = frame.y + 1; i < rows.length; i++) rows[i] = '';
          below.forEach((row, n) => { rows[rows.length - below.length + n] = row; });
          return { ...frame, rows };
        };
        const statusRow = drawnBelow(fx.panes.idleDefaultLayout)[0];
        const FOOTER = '  ? for shortcuts';

        it('the captures are this version\'s own and draw what the declaration says', () => {
          assert.equal(fx.version, version);
          for (const name of [...AT_REST, 'idleSingleItemStatus']) {
            const drawn = drawnBelow(fx.panes[name]);
            assert.equal(drawn.length, 2, `${name}: two rows below the composer`);
            assert.match(drawn[1], footerRe, `${name}: the second is the declared footer`);
          }
          assert.match(statusRow, STATUS_RE);
          assert.equal(drawnBelow(fx.panes.idleSingleItemStatus)[0].trim().toLowerCase(), model.toLowerCase(), 'the single-item row is the thread\'s model');
        });

        for (const name of AT_REST) {
          it(`${name}: shown on two reads and on one under the declaration, refused under the one-row rule`, async () => {
            assert.deepEqual(await ask([fx.panes[name]], declared()), { shown: true });
            assert.deepEqual(await once(fx.panes[name], { footerRe }), { shown: true });
            assert.deepEqual(await ask([fx.panes[name]]), { shown: false, dialog: null, why: 'something other than a status row is drawn below the composer' });
            assert.equal((await ask([fx.panes[name]], { maxStatusRows: 2 })).shown, false, 'a count of two is not this rule, and does not pass it either');
          });
        }

        it('the single-item status row is recognised only as the thread\'s own model, alone, without case', async () => {
          const frame = fx.panes.idleSingleItemStatus;
          assert.deepEqual(await ask([frame], declared({ statusRe: modelRe })), { shown: true });
          assert.deepEqual(await once(frame, { footerRe, statusRe: modelRe }), { shown: true });
          assert.deepEqual(await ask([frame], declared()), { shown: false, dialog: null, why: NOT_OPENING }, 'with no model to check it against it is refused');
          assert.equal((await ask([frame])).shown, false, 'and under the one-row rule');
          for (const other of ['  some-other-model', `  ${model} extra`, '  /private/tmp/cx2059/proj', `   ${model}`, `  ${model}x`]) {
            assert.deepEqual(await ask([withBelow(frame, [other, FOOTER])], declared({ statusRe: modelRe })), { shown: false, dialog: null, why: NOT_OPENING }, other);
          }
          assert.deepEqual(await ask([withBelow(frame, [`  ${model.toUpperCase()}`, FOOTER])], declared({ statusRe: modelRe })), { shown: true }, 'case is not compared');
        });

        for (const name of ['startScreen', 'resumingScreen']) {
          it(`${name}: refused as a screen still opening or resuming, by the footer's position and by nothing else`, async () => {
            const frame = fx.panes[name];
            assert.equal(frame.rows[frame.y].includes('Ask Codex to do anything'), true, 'an empty composer holds the cursor');
            assert.deepEqual(await ask([frame], declared()), { shown: false, dialog: null, why: OPENING });
            assert.deepEqual(await once(frame, { footerRe }), { shown: false, dialog: null, why: OPENING });
            // Not the header rule: no header pattern is given at all.
            assert.deepEqual(await ask([frame], declared({ headerRe: null, startingRe: null })), { shown: false, dialog: null, why: OPENING });
            // Not the footer failing the status pattern: a pattern that takes the footer for a status row changes nothing.
            assert.match(FOOTER, /^ {2}\S/);
            assert.deepEqual(await ask([frame], declared({ statusRe: /^ {2}\S/ })), { shown: false, dialog: null, why: OPENING });
          });
        }

        it('the empty status line at rest is refused: its one row is the footer with a context item beside it', async () => {
          const drawn = drawnBelow(fx.panes.idleEmptyStatus);
          assert.equal(drawn.length, 1);
          assert.match(drawn[0], /^ {2}\? for shortcuts {2,}100% context left$/);
          assert.deepEqual(await ask([fx.panes.idleEmptyStatus], declared()), { shown: false, dialog: null, why: NOT_OPENING });
          assert.equal((await ask([fx.panes.idleEmptyStatus])).shown, false);
        });

        it('the startup dialogs are still named, and typed text and a drawn busy row still refuse', async () => {
          assert.equal((await ask([fx.panes.trustDialog], declared())).dialog.id, 'folder-trust');
          assert.equal((await ask([fx.panes.updateDialog], declared())).dialog.id, 'update');
          assert.deepEqual(await ask([fx.panes.typing], declared()), { shown: false, dialog: null, why: 'no empty composer row is on screen' });
          assert.match(fx.panes.busyDefaultLayout.rows.map(text).join('\n'), /esc to interrupt/);
          assert.deepEqual(await ask([fx.panes.busyDefaultLayout], declared()), { shown: false, dialog: null, why: 'a turn is running' });
        });

        it('every other arrangement of rows below the composer is refused', async () => {
          const rest = fx.panes.idleDefaultLayout;
          const cases = [
            ['the status row alone', [statusRow], NOT_OPENING],
            ['the two rows in the other order', [FOOTER, statusRow], OPENING],
            ['two footers', [FOOTER, FOOTER], OPENING],
            ['a third row', [statusRow, FOOTER, FOOTER], NOT_OPENING],
            ['a third row above', [statusRow, statusRow, FOOTER], NOT_OPENING],
            ['a footer one character longer', [statusRow, `${FOOTER}s`], NOT_OPENING],
            ['a footer one character shorter', [statusRow, FOOTER.slice(0, -1)], NOT_OPENING],
            ['a footer indented by one more column', [statusRow, ` ${FOOTER}`], NOT_OPENING],
            ['the other launch path\'s footer', [statusRow, '  ← for agents · ? for shortcuts'], NOT_OPENING],
            ['a status row that is not one', ['  not a status row', FOOTER], NOT_OPENING],
            ['a status-shaped row that names keys', ['  enter continue · esc skip', FOOTER], 'a row below the composer names keys, as a dialog footer does']
          ];
          for (const [name, below, why] of cases) {
            assert.deepEqual(await ask([withBelow(rest, below)], declared()), { shown: false, dialog: null, why }, name);
            assert.deepEqual(await once(withBelow(rest, below), { footerRe }), { shown: false, dialog: null, why }, `${name}, on one read`);
          }
        });

        it('a stale composer above a selector row is refused, whatever is drawn below it', async () => {
          const rest = fx.panes.idleDefaultLayout;
          const rows = [...rest.rows];
          rows[rest.y + 1] = '› 1. Trust and continue';
          assert.deepEqual(await ask([{ ...rest, rows }], declared()), { shown: false, dialog: null, why: 'a selector row is drawn below the composer' });
        });

        it('a footer that changes between the two reads, or is gone at the single read, is refused', async () => {
          const rest = fx.panes.idleDefaultLayout;
          const opening = withBelow(rest, [FOOTER]);
          assert.deepEqual(await ask([rest, opening], declared()), { shown: false, dialog: null, why: OPENING });
          assert.deepEqual(await ask([opening, rest], declared()), { shown: false, dialog: null, why: OPENING });
          assert.deepEqual(await ask([rest, withBelow(rest, [statusRow, `${FOOTER}!`])], declared()), { shown: false, dialog: null, why: NOT_OPENING });
          assert.deepEqual(await once(rest, { footerRe }), { shown: true }, 'seen at rest');
          assert.deepEqual(await once(withBelow(rest, [statusRow]), { footerRe }), { shown: false, dialog: null, why: NOT_OPENING }, 'and not a moment later');
        });

        it('a streaming turn draws no busy row: one read cannot tell it from rest, two reads see the transcript move', async () => {
          const { streamingFirst, streamingNext } = fx.turnFrames;
          for (const frame of [streamingFirst, streamingNext]) {
            assert.doesNotMatch(frame.rows.map(text).join('\n'), /esc to interrupt/, 'no busy marker is drawn while the answer streams');
            assert.equal(frame.rows[frame.y].includes('Ask Codex to do anything'), true, 'the composer is empty and holds the cursor');
          }
          // The limit, stated: this frame alone has the shape of a composer at
          // rest. The thread read that follows the pane is what refuses it, and
          // that is pinned with the adapter.
          assert.deepEqual(await once(streamingFirst, { footerRe }), { shown: true });
          assert.deepEqual(await ask([streamingFirst, streamingNext], declared()), { shown: false, dialog: null, why: 'the pane changed between two reads a second apart' });
        });

        it('without the option the witness is the one-row rule, for this version\'s panes as for any other', async () => {
          for (const name of Object.keys(fx.panes)) {
            const plain = await ask([fx.panes[name]]);
            if (name === 'typing') continue;
            assert.equal(plain.shown, false, `${name} is not shown under the one-row rule`);
          }
          const typing = fx.panes.typing;
          assert.equal((await ask([typing])).shown, false);
        });
      });
    }

    it('0.162.0 drew the status row with no footer for one frame as typing began: the one-row rule passes it, the declaration refuses it', async () => {
      const frame = CODEX_CHANNEL_FIXTURES['0.162.0'].turnFrames.statusRowAlone;
      const footerRe = new RegExp(codex.capabilities.wake.restRows['0.162.0'].footerPattern);
      assert.deepEqual(await ask([frame]), { shown: true });
      assert.deepEqual(await ask([frame], { footerRe, maxStatusRows: undefined }), { shown: false, dialog: null, why: NOT_OPENING });
    });

    it('the option changes nothing for 0.156.1\'s panes when it is not given', async () => {
      for (const name of ['composer', 'composerAfterUpdateSkipped', 'composerOperatorStatus', 'composerWarningStatus']) {
        assert.deepEqual(await ask([PANES[name]]), { shown: true }, name);
        assert.deepEqual(await ask([PANES[name]], { footerRe: undefined }), { shown: true }, name);
        assert.deepEqual(await ask([PANES[name]], { footerRe: null }), { shown: true }, name);
      }
    });

    it('0.156.1\'s one-row composer is refused under a footer declaration: it draws no footer', async () => {
      const footerRe = new RegExp(codex.capabilities.wake.restRows['0.161.0'].footerPattern);
      assert.deepEqual(await ask([PANES.composer], { footerRe, maxStatusRows: undefined }), { shown: false, dialog: null, why: NOT_OPENING });
    });
  });
});
