'use strict';

/*
 * #756 — the Master settings modal's launch-mode picker, at the frontend.
 *
 * The Master had no launch mode at any layer; `lib/master.js` hardcoded `null`
 * into its launch command. The backend half is covered in `test/master.test.js`.
 * This covers the surface, and specifically the two ways a mode picker lies:
 *
 *  1. Re-deriving which modes exist instead of rendering what the server said
 *     this engine offers — the third-source-of-truth failure #768 names.
 *  2. Dropping a stored mode the current engine cannot honor, so the modal
 *     shows `default` while config still holds the operator's real choice. That
 *     is the silent-ignore failure #741 documents.
 *
 * These LIFT the real functions out of public/api-helper.js and RUN them, rather
 * than regex-matching the source: the existing master-settings suite is
 * source-pinned (see backlog TST-6L2P), and a source pin cannot tell a rendered
 * option from a string that merely appears in the file.
 *
 * The functions moved from public/ui.js into the shared `tcCreateMasterSettings`
 * component so the modal could mount on the session page too. Only the file
 * these lift FROM changed — every assertion below is the one that guarded the
 * dashboard's behaviour before the move, which is what makes this suite the
 * regression net for it.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HELPER_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'api-helper.js'), 'utf8');
// `esc` is defined in landing.js and shared globally with ui.js — both scripts
// load on the dashboard. Lifting the REAL one keeps escaping behaviour honest
// rather than stubbing it into something more forgiving than production.
const LANDING_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'landing.js'), 'utf8');

/**
 * Slice a top-level function (declaration + body) out of source text.
 * @param {string} src - File source text.
 * @param {string} decl - Declaration to find.
 * @returns {string} The declaration plus its balanced body.
 */
function liftFunction(src, decl) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`${decl} body must close`);
}

/** The settings shape `GET /api/master/status` returns, with overrides. */
function status(over = {}) {
  return {
    accessLevel: 'read-only',
    accessLevels: ['read-only', 'suggest', 'write'],
    // Kept in step with what `getMasterStatus` actually emits: all three tiers
    // are enabled since #755, and `levelAppliesAt` is the field the tier hints
    // read to decide whether to promise per-tool-call immediacy. A fixture
    // missing it would exercise only the cautious fallback and report the
    // structural copy as untested.
    enabledAccessLevels: ['read-only', 'suggest', 'write'],
    levelAppliesAt: 'next-tool-call',
    engine: 'claude',
    resolvedEngine: 'claude',
    launchMode: 'default',
    resolvedLaunchMode: 'default',
    // The real shape `getMasterStatus` emits, verified against the module:
    // `{id, label}`, so the picker can render "Accept Edits" like its sibling
    // rather than the raw id.
    launchModes: [
      { id: 'default', label: 'Interactive' },
      { id: 'acceptEdits', label: 'Accept Edits' },
      { id: 'plan', label: 'Plan Only' },
      { id: 'bypassPermissions', label: 'Bypass' }
    ],
    scope: 'all',
    autoStart: false,
    enforcement: 'structural',
    ...over
  };
}

/**
 * Render the settings body with the real function and return its HTML.
 * @param {object} settings - `status.settings` payload.
 * @returns {string} Rendered innerHTML.
 */
function render(settings) {
  const bodyEl = { innerHTML: '' };
  const sandbox = {
    console,
    state: { engines: [] },
    document: { getElementById: (id) => (id === 'masterSettingsBody' ? bodyEl : null) },
    // Not under test here; the engine picker has its own coverage (#707).
    buildEngineOptions: () => '<option value="claude">Claude</option>'
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext([
    liftFunction(LANDING_SRC, 'function esc(str)'),
    liftFunction(HELPER_SRC, 'function renderMasterSettingsBody(s, groups)'),
    'globalThis.renderMasterSettingsBody = renderMasterSettingsBody;'
  ].join('\n'), sandbox);
  sandbox.renderMasterSettingsBody(settings, []);
  return bodyEl.innerHTML;
}

/**
 * Run the real save handler against a fake form and capture the PATCH body.
 * @param {object} fields - Values the form controls report.
 * @returns {Promise<object|null>} The `master` patch that would be sent.
 */
async function save(fields) {
  let sent = null;
  // The toast text is part of the contract, not decoration: it is what tells
  // the operator the change is deferred to the next master start. Discarding
  // it here is what let that half of the fix ship unguarded.
  const status = { saveMessage: null, savedNotifications: 0 };
  const els = {
    masterEngineSelect: { value: fields.engine || '' },
    masterScopeSelect: { value: fields.scope || '' },
    masterAutoStart: { checked: !!fields.autoStart }
  };
  if (fields.launchMode !== undefined) {
    els.masterLaunchModeSelect = { value: fields.launchMode };
  }
  const sandbox = {
    console,
    document: {
      getElementById: (id) => els[id] || null,
      querySelector: () => ({ value: fields.accessLevel || 'read-only' })
    },
    apiMutate: async (_p, _m, body) => { sent = body; return { ok: true }; },
    api: { lastError: null },
    _setMasterRulesStatus: (msg) => { status.saveMessage = msg; },
    // The factory hoists every dep to a bare local, so this sandbox has to model
    // that scope. `onSaved` joined it in #755 chunk 3 — the bar repaints when the
    // gear saves. Recorded rather than a bare no-op so the count is available to
    // whoever needs it here later; this file's own subject is launch mode.
    onSaved: () => { status.savedNotifications++; }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext([
    liftFunction(HELPER_SRC, 'async function saveMasterSettings()'),
    'globalThis.saveMasterSettings = saveMasterSettings;'
  ].join('\n'), sandbox);
  await sandbox.saveMasterSettings();
  return { patch: sent && sent.master, message: status.saveMessage };
}

describe('#756 — the Master settings modal offers a launch mode', () => {
  it('renders exactly the modes the server said this engine offers', () => {
    const html = render(status({
      launchModes: [{ id: 'default', label: 'Interactive' }, { id: 'acceptEdits', label: 'Accept Edits' }]
    }));
    assert.match(html, /id="masterLaunchModeSelect"/);
    assert.match(html, /<option value="acceptEdits"/);
    assert.match(html, />Accept Edits</,
      'the picker must render the human label, like the project-settings picker does');
    assert.doesNotMatch(html, />acceptEdits</,
      'a raw mode id in the option text is the visibly-poorer-sibling failure');
    // Claude defines these, but this payload did not offer them. Rendering them
    // anyway would mean the modal derived the list itself.
    assert.doesNotMatch(html, /<option value="plan"/);
    assert.doesNotMatch(html, /<option value="bypassPermissions"/);
  });

  it('selects the stored mode', () => {
    const html = render(status({ launchMode: 'acceptEdits' }));
    assert.match(html, /<option value="acceptEdits" selected>/);
  });

  it('keeps a stranded mode visible, selected, and named as unavailable', () => {
    // The operator picked acceptEdits on Claude, then switched to an engine
    // that cannot honor it. Config still holds acceptEdits, so showing
    // "default" would misreport what is saved.
    const html = render(status({
      engine: 'aider', resolvedEngine: 'aider',
      launchMode: 'acceptEdits', resolvedLaunchMode: 'default',
      launchModes: [{ id: 'default', label: 'Interactive' }, { id: 'yesAlways', label: 'Yes To All' }]
    }));
    assert.match(html, /<option value="acceptEdits" selected>/,
      'the saved choice must still be the selected one');
    assert.match(html, /not available on this engine/i);
    assert.match(html, /will start in <code>default<\/code>/,
      'and it must say what will actually run instead');
  });

  it('says there are no modes rather than rendering an empty picker', () => {
    const html = render(status({ resolvedEngine: null, launchModes: [] }));
    assert.doesNotMatch(html, /id="masterLaunchModeSelect"/);
    assert.match(html, /no launch modes to choose from/i);
    // With no engine there is nothing to strand the stored mode against. The
    // previous version of this test asserted only the picker's absence, so it
    // passed while the output also said "saved as default, which this engine
    // cannot honor" — directly under "there are no modes to choose from".
    assert.doesNotMatch(html, /cannot honor/i,
      'an install with no engine must not also claim the mode is unhonorable');
    assert.doesNotMatch(html, /not available on this engine/i);
  });

  it('names the two axes as separate, so neither implies the other', () => {
    const html = render(status());
    assert.match(html, /separate from/i);
    assert.match(html, /Access level/);
  });

  it('the read-only tier no longer promises what the launch mode can remove', () => {
    // The tier hint used to read "everything else needs your approval in the
    // master terminal" — the exact property a bypassPermissions launch mode
    // takes away. The assertions above match the LAUNCH-MODE hint and pass
    // unchanged if the tier hint reverts, so this is its own guard.
    const html = render(status());
    assert.doesNotMatch(html, /everything else needs your approval/i,
      'the access tier must not promise a prompt the launch mode governs');
    assert.match(html, /bounds what the master may touch, not how often it prompts/i);
  });

  it('carries a warned mode\'s ⚠ through to the option, like the sibling picker', () => {
    // data/engines/claude.json marks bypassPermissions with a warning, and the
    // project-settings picker renders ⚠ for it. Dropping it here would make the
    // Master picker silently the less safe of two controls doing one job.
    const html = render(status({
      launchModes: [
        { id: 'default', label: 'Interactive', warning: null },
        { id: 'bypassPermissions', label: 'Bypass', warning: 'Only use in isolated environments' }
      ]
    }));
    assert.match(html, /Bypass ⚠/, 'a warned mode must carry its glyph');
    assert.doesNotMatch(html, /Interactive ⚠/, 'and an unwarned one must not');
  });

  it('says when the choice takes effect, in the launch-mode hint itself', () => {
    // Scoped to the launch-mode form-group on purpose. The ENGINE control's
    // hint has always said "Applies the next time the master session starts",
    // so an unscoped match passes with this hint carrying no such line at all.
    const html = render(status());
    const start = html.indexOf("How the master's own session prompts");
    assert.notEqual(start, -1, 'the launch-mode hint must exist');
    const hint = html.slice(start, html.indexOf('</div>', start));
    assert.match(hint, /next time the master session starts/i,
      'the launch-mode hint must state its own deferral, not rely on a neighbour');
  });

  it('calls out write + bypassPermissions rather than letting it pass unremarked', () => {
    // #756: that combination is legitimate and selectable, but must not be
    // reachable without the operator seeing what they picked.
    const loud = render(status({ accessLevel: 'write', resolvedLaunchMode: 'bypassPermissions' }));
    assert.match(loud, /no confirmation at any layer/i);
    const quiet = render(status({ accessLevel: 'read-only', resolvedLaunchMode: 'bypassPermissions' }));
    assert.doesNotMatch(quiet, /no confirmation at any layer/i,
      'a read-only master in bypass is coherent — it must not be flagged as dangerous');
  });

  it('the tier hints say WHEN a change binds, from the payload rather than by assertion (#755 R-4)', () => {
    // THE MUTATION THIS CATCHES: hardcoding "next tool call" back into the
    // hints. That is true only where a write guard exists; on an instructional
    // master the level rides the regenerated identity, so promising immediacy
    // there tells the operator their flip has landed when it has not.
    const structural = render(status({ levelAppliesAt: 'next-tool-call' }));
    assert.match(structural, /next tool call/i);
    assert.doesNotMatch(structural, /carries the level in its instructions/i);

    const instructional = render(status({ levelAppliesAt: 'next-ensure' }));
    assert.match(instructional, /carries the level in its instructions/i);
    assert.doesNotMatch(instructional, /next tool call/i);
  });

  it('an absent levelAppliesAt is cautious about WHEN and silent about WHY', () => {
    // Older server, or a payload shape that moved. Over-promising immediacy is
    // the direction that misleads, so absence must not read as "immediate".
    //
    // It must ALSO not read as "this engine has no write guard" (#755 chunk 3,
    // R-6). The fallback used to share the instructional sentence, which states
    // a mechanism — and a Claude master hitting this skew has a write guard, so
    // that sentence is simply false there. This test previously PINNED the false
    // half; it now pins the boundary between the two claims.
    const s = status();
    delete s.levelAppliesAt;
    const md = render(s);
    assert.doesNotMatch(md, /next tool call/i, 'absence must not promise immediacy');
    assert.doesNotMatch(md, /carries the level in its instructions/i,
      'nor assert a mechanism the payload did not state');
    assert.match(md, /next time the master session starts/i, 'the cautious WHEN still ships');
  });

  it('a stated instructional binding DOES explain the mechanism', () => {
    // The positive control for the test above: without it, deleting the
    // instructional sentence entirely would pass both assertions there while
    // losing the explanation an operator on that engine actually needs.
    const md = render(status({ levelAppliesAt: 'next-ensure' }));
    assert.match(md, /carries the level in its instructions/i);
  });
});

describe('#756 — saving the launch mode', () => {
  it('sends the picked mode in the master patch', async () => {
    const { patch } = await save({ launchMode: 'acceptEdits', engine: 'claude' });
    assert.equal(patch.launchMode, 'acceptEdits');
  });

  it('omits launchMode entirely when the engine offered no picker', async () => {
    // Sending a guess here would overwrite the operator's stored choice with
    // whatever the modal happened to default to. PATCH merges, so omitting
    // leaves it intact.
    const { patch } = await save({ engine: 'claude' });
    assert.ok(!('launchMode' in patch),
      'no picker means no opinion — the stored mode must survive the save');
    assert.equal(patch.accessLevel, 'read-only', 'the rest of the form still saves');
  });

  it('the save confirmation names launch mode among the deferred settings', () => {
    // The toast said "engine/scope apply on next master start" and omitted the
    // launch mode, which defers identically. An operator reading it would
    // reasonably expect the mode to have taken effect already.
    return save({ launchMode: 'acceptEdits', engine: 'claude' }).then(({ message }) => {
      assert.match(message, /launch mode/i,
        'the confirmation must not list only the settings it used to defer');
      assert.match(message, /next master start/i);
    });
  });
});
