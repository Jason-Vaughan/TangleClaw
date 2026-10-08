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
const { CODEX_VISIBLE_PANES: PANES } = require('./_codex-visible-pane-fixtures');

const codex = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'codex.json'), 'utf8'));
// What the Codex adapter hands the witness.
const HEADER_RE = /\bmodel:\s+\S/;
const STARTING_RE = /\bmodel:\s+loading\b/;
const STATUS_RE = /^ {2}[^\s│╭╰╮╯›>].* · \S/;
const KEY_HINT_RE = /^(enter|return|esc|escape|tab|space|arrows?|[↑↓←→]+)$/i;
const COMPOSER = '\u001b[1m›\u001b[0m \u001b[2mAsk Codex to do anything\u001b[0m';

describe('the pane witness (#2186)', () => {
  let tmpDir;
  let wakeProfile;
  let reads;
  let pins;
  const PANE_ID = '%7';

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
      tmuxName: 'tc-x', paneId: PANE_ID, engineProfile: codex, wakeProfile, headerRe: HEADER_RE, startingRe: STARTING_RE, statusRe: STATUS_RE, maxStatusRows: 1, keyHintRe: KEY_HINT_RE, ...over
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
      assert.deepEqual(r, { shown: false, dialog: null, why: 'the session\'s pane is not the pane this launch created' });
      assert.deepEqual(reads, [], 'the replacement pane is not even read');
    });

    it('a launch with no pane on record cannot be vouched for', async () => {
      for (const missing of [undefined, null, '']) {
        const r = await ask([good()], { paneId: missing });
        assert.deepEqual(r, { shown: false, dialog: null, why: 'the pane this launch created is not on record' });
        assert.deepEqual(reads, []);
      }
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
        const r = await paneWitness.composerShown({ tmuxName: 'tc-x', paneId: PANE_ID, engineProfile: codex, wakeProfile, headerRe: HEADER_RE, startingRe: STARTING_RE, statusRe: STATUS_RE }, { gapMs: 0, sleep: async () => {}, pin: () => PANE_ID, read: () => ({ paneId: PANE_ID, ...frame }) });
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
});
