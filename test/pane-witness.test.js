'use strict';

/*
 * #2186 — the pane witness: positive evidence of an empty composer, or no.
 *
 * A native startup fire into a folder the engine's config does not trust may
 * only go when the pane is positively showing its ordinary composer. These
 * tests feed the witness whole live captures of Codex's startup screens with
 * the cursor each one had, and pin that only the usable composer passes.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../lib/store');
const paneWitness = require('../lib/pane-witness');
const { CODEX_STARTUP_PANES: PANES } = require('./_codex-startup-fixtures');
const { CODEX_STARTUP_CURSORS: CURSORS } = require('./_codex-startup-cursor-fixtures');

const codex = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'codex.json'), 'utf8'));
const HEADER_RE = /\bmodel:\s+\S/;
const STARTING_RE = /\bmodel:\s+loading\b/;

describe('the pane witness (#2186)', () => {
  let tmpDir;
  let wakeProfile;
  let tmuxCalls;

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
   * @param {Array<{lines: string[], cursor: (object|null)}|Error>} frames - One per read; the last repeats.
   * @param {object} [over] - Target overrides.
   * @returns {Promise<object>}
   */
  const ask = (frames, over = {}) => {
    let i = 0;
    tmuxCalls = [];
    const frame = () => frames[Math.min(i, frames.length - 1)];
    return paneWitness.composerShown({
      tmuxName: 'tc-x', engineProfile: codex, wakeProfile, headerRe: HEADER_RE, startingRe: STARTING_RE, ...over
    }, {
      gapMs: 0,
      sleep: async () => { i += 1; },
      capture: (name) => { tmuxCalls.push(['capture', name]); const f = frame(); if (f instanceof Error) throw f; return { lines: [...f.lines] }; },
      cursorInfo: (name) => { tmuxCalls.push(['cursor', name]); const f = frame(); if (f instanceof Error) throw f; return f.cursor; }
    });
  };
  const live = (name) => ({ lines: PANES[name].lines, cursor: CURSORS[name] });

  it('a usable composer, seen twice, is shown', async () => {
    assert.deepEqual(await ask([live('composer')]), { shown: true });
    assert.deepEqual(await ask([live('composerAfterUpdateSkipped')]), { shown: true });
  });

  it('reads the pane exactly twice, text and cursor from the same session each time', async () => {
    await ask([live('composer')]);
    assert.deepEqual(tmuxCalls, [['capture', 'tc-x'], ['cursor', 'tc-x'], ['capture', 'tc-x'], ['cursor', 'tc-x']]);
  });

  it('the folder-trust prompt is named as a dialog, although the opening composer is drawn above it', async () => {
    const r = await ask([live('trustPrompt')]);
    assert.equal(r.shown, false);
    assert.equal(r.dialog.id, 'folder-trust');
    assert.match(r.why, /folder-trust prompt/);
  });

  it('the update prompt is named as a dialog', async () => {
    const r = await ask([live('updatePrompt')]);
    assert.equal(r.shown, false);
    assert.equal(r.dialog.id, 'update');
  });

  it('a dialog wins even if the cursor were reported on the stale composer row above it', async () => {
    const r = await ask([{ lines: PANES.trustPrompt.lines, cursor: CURSORS.openingScreen }]);
    assert.equal(r.shown, false);
    assert.equal(r.dialog.id, 'folder-trust');
  });

  it('the opening screen is not shown: its composer is empty and under the cursor, but the header still reads loading', async () => {
    const r = await ask([live('openingScreen')]);
    assert.deepEqual(r, { shown: false, dialog: null, why: 'the engine is still starting' });
  });

  it('a session whose header has scrolled away is shown: the composer and cursor evidence stand without it', async () => {
    const at = PANES.composer.lines.map((l) => l.startsWith('› Ask Codex')).lastIndexOf(true);
    const scrolled = ['  an earlier answer', '', ...PANES.composer.lines.slice(at)];
    assert.ok(!scrolled.some((l) => HEADER_RE.test(l)), 'no header row is left in the capture');
    assert.deepEqual(await ask([{ lines: scrolled, cursor: CURSORS.composer }]), { shown: true });
  });

  it('with two headers in the capture, only the newest one is judged', async () => {
    // The live composer fixture holds the superseded `model: loading` box above the current one.
    assert.ok(PANES.composer.lines.some((l) => STARTING_RE.test(l)), 'the older header still reads loading');
    assert.deepEqual(await ask([live('composer')]), { shown: true });
  });

  it('a composer under a cursor that is somewhere else is not shown', async () => {
    const r = await ask([{ lines: PANES.composer.lines, cursor: CURSORS.trustPrompt }]);
    assert.deepEqual(r, { shown: false, dialog: null, why: 'the cursor is not on the composer row' });
  });

  it('a composer holding typed text is not shown', async () => {
    // Derived from the live composer: the placeholder replaced by typed text, the cursor after it.
    const typed = { x: 7, y: CURSORS.composer.y, line: '\u001b[1m›\u001b[0m hello' };
    const lines = PANES.composer.lines.map((l) => (l === '› Ask Codex to do anything' ? '› hello' : l));
    const r = await ask([{ lines, cursor: typed }]);
    assert.equal(r.shown, false);
    assert.equal(r.dialog, null);
  });

  it('a busy pane is not shown', async () => {
    const lines = [...PANES.composer.lines.slice(0, -3), '• Working (3s • esc to interrupt)', ...PANES.composer.lines.slice(-3)];
    const r = await ask([{ lines, cursor: CURSORS.composer }]);
    assert.deepEqual(r, { shown: false, dialog: null, why: 'a turn is running' });
  });

  it('a pane that changes between the two reads is not shown', async () => {
    const moved = { lines: [...PANES.composer.lines.slice(0, -3), '  a new transcript row', ...PANES.composer.lines.slice(-3)], cursor: CURSORS.composer };
    const r = await ask([live('composer'), moved]);
    assert.deepEqual(r, { shown: false, dialog: null, why: 'the pane changed between two reads a second apart' });
  });

  it('a dialog that appears between the two reads is named', async () => {
    const r = await ask([live('composer'), live('updatePrompt')]);
    assert.equal(r.shown, false);
    assert.equal(r.dialog.id, 'update');
  });

  it('a cursor that moves between the two reads is a changed pane', async () => {
    const r = await ask([live('composer'), { lines: PANES.composer.lines, cursor: { ...CURSORS.composer, y: CURSORS.composer.y + 1 } }]);
    assert.equal(r.shown, false);
    assert.match(r.why, /changed between two reads/);
  });

  it('an unreadable pane is not shown: empty capture, thrown read, no cursor', async () => {
    assert.match((await ask([{ lines: [], cursor: CURSORS.composer }])).why, /could not be read \(the capture came back empty\)/);
    assert.equal((await ask([new Error('no server running: /private/secret/sock')])).why, 'the pane could not be read', 'the fault\'s own text is for the server log, not the fire row');
    assert.deepEqual(await ask([{ lines: PANES.composer.lines, cursor: null }]), { shown: false, dialog: null, why: 'the cursor position could not be read' });
  });

  it('a profile whose guarded dialogs cannot be read proves nothing', async () => {
    const broken = { ...codex, launch: { ...codex.launch, guardedDialogs: [{ id: 'update', match: '(' }] } };
    const r = await ask([live('composer')], { engineProfile: broken });
    assert.equal(r.shown, false);
    assert.match(r.why, /could not be read, so a dialog could not be ruled out/);
  });

  it('no pane, or no composer pattern, is not shown and nothing is read', async () => {
    assert.equal((await ask([live('composer')], { tmuxName: null })).shown, false);
    assert.equal((await ask([live('composer')], { wakeProfile: null })).shown, false);
    assert.deepEqual(tmuxCalls, []);
  });
});
