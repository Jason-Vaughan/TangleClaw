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

const { describe, it, before, after } = require('node:test');
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
    // The launch-mode control is drawn by one function the body calls, over
    // two pure helpers (#2197). Lifted with it, so every assertion below still
    // runs the modal's own code.
    liftFunction(HELPER_SRC, 'function tcHonoredLaunchModes(engine)'),
    liftFunction(HELPER_SRC, 'function tcMasterEngineModes(engines, engineId)'),
    liftFunction(HELPER_SRC, 'function tcMasterLaunchModeView(settings, engines, pin, defaultEngine)'),
    liftFunction(HELPER_SRC, 'function masterLaunchModeMarkup(s, pin, notices)'),
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
    // `send` is how the control says the operator picked this mode (#2197): a
    // mode nobody touched is not sent.
    els.masterLaunchModeSelect = { value: fields.launchMode, dataset: { send: '1' } };
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
    onSaved: () => { status.savedNotifications++; },
    // After a save the component reads the status back and redraws the
    // launch-mode control (#2197); that read is not this file's subject.
    adoptSavedMasterSettings: async () => {}
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

/*
 * #2197 — a launch mode is a choice about one engine.
 *
 * Two engines can define a mode under one key and mean different things by it:
 * `bypassPermissions` skips approvals on Claude Code and skips approvals AND
 * the sandbox on Codex. A mode chosen for one must therefore never start the
 * other, whichever way the Master's engine came to change: its own pin, the
 * default engine it follows, or an installed engine standing in for a
 * configured one that is missing.
 *
 * The server half, exercised on the real functions over the bundled engine
 * profiles in a temporary store. The route's half is in
 * `test/api-config.test.js`.
 */
describe('#2197 — the Master\'s launch mode belongs to the engine it was chosen for', () => {
  const os = require('node:os');
  const store = require('../lib/store');
  const master = require('../lib/master');
  const realEngines = require('../lib/engines');
  const sessions = require('../lib/sessions');
  const { setLevel } = require('../lib/logger');

  let tmpDir;

  before(() => {
    setLevel('error');
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-master-mode-'));
    store._setBasePath(tmpDir);
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /**
   * A config holding only what the launch-mode rule reads.
   * @param {object} masterBlock - The stored `master` object.
   * @param {string|null} [defaultEngine] - The install's default engine.
   * @returns {object}
   */
  function configWith(masterBlock, defaultEngine = 'claude') {
    return { defaultEngine, master: { accessLevel: 'read-only', engine: null, scope: 'all', autoStart: false, ...masterBlock } };
  }

  /**
   * An engines stub that resolves by the real precedence over a stated set of
   * installed engines, so no case here depends on which CLIs the host has.
   * @param {string[]} installed - Engine ids present on the imagined machine.
   * @returns {object}
   */
  function enginesInstalling(installed) {
    const list = ['claude', 'codex', 'aider'].map((id) => ({ id, available: installed.includes(id) }));
    return { resolveDefaultEngine: (config) => realEngines.resolveDefaultEngine(config, list) };
  }

  const BYPASS_ON_CLAUDE = { engine: 'claude', launchMode: 'bypassPermissions', launchModeEngine: 'claude' };

  describe('a save that changes the pinned engine', () => {
    it('returns the mode to default and reports what it reset, when the save names no mode', () => {
      const before_ = configWith(BYPASS_ON_CLAUDE);
      const after_ = configWith({ ...BYPASS_ON_CLAUDE, engine: 'codex' });
      const out = master.masterLaunchModeAfterPatch(before_, after_, { engine: 'codex' });
      assert.equal(out.error, null);
      assert.equal(out.launchMode, 'default');
      assert.equal(out.launchModeEngine, null);
      assert.deepEqual(out.reset, { mode: 'bypassPermissions', fromEngine: 'claude', toEngine: 'codex' });
    });

    it('keeps a mode the same save chooses, as a choice for the NEW engine, with nothing to report', () => {
      const out = master.masterLaunchModeAfterPatch(
        configWith(BYPASS_ON_CLAUDE),
        configWith({ ...BYPASS_ON_CLAUDE, engine: 'codex' }),
        { engine: 'codex', launchMode: 'fullAuto' }
      );
      assert.equal(out.error, null);
      assert.equal(out.launchMode, 'fullAuto');
      assert.equal(out.launchModeEngine, 'codex');
      assert.equal(out.reset, null);
    });

    it('reads the stored key sent again with a new engine as a choice for that engine', () => {
      // Both engines define `bypassPermissions`. Naming it in the save that
      // moves the Master to Codex is choosing Codex's, and it is recorded so.
      const out = master.masterLaunchModeAfterPatch(
        configWith(BYPASS_ON_CLAUDE),
        configWith({ ...BYPASS_ON_CLAUDE, engine: 'codex' }),
        { engine: 'codex', launchMode: 'bypassPermissions' }
      );
      assert.equal(out.launchMode, 'bypassPermissions');
      assert.equal(out.launchModeEngine, 'codex');
      assert.equal(out.reset, null);
    });

    it('refuses a mode the new engine does not define, naming the engine and what it offers', () => {
      const out = master.masterLaunchModeAfterPatch(
        configWith(BYPASS_ON_CLAUDE),
        configWith({ ...BYPASS_ON_CLAUDE, engine: 'codex' }),
        { engine: 'codex', launchMode: 'acceptEdits' }
      );
      assert.match(out.error, /"acceptEdits" is not a launch mode of Codex/);
      assert.match(out.error, /fullAuto/, 'the refusal says what could be chosen instead');
      assert.equal(out.reset, null);
    });

    it('lets the operator choose default for the new engine without calling it a reset', () => {
      const out = master.masterLaunchModeAfterPatch(
        configWith(BYPASS_ON_CLAUDE),
        configWith({ ...BYPASS_ON_CLAUDE, engine: 'codex' }),
        { engine: 'codex', launchMode: 'default' }
      );
      assert.equal(out.launchMode, 'default');
      assert.equal(out.launchModeEngine, null);
      assert.equal(out.reset, null, 'a mode the operator chose is not a setting changed behind them');
    });

    it('has nothing to reset when the mode is already default', () => {
      const out = master.masterLaunchModeAfterPatch(
        configWith({ engine: 'claude' }), configWith({ engine: 'codex' }), { engine: 'codex' }
      );
      assert.equal(out.launchMode, 'default');
      assert.equal(out.reset, null);
    });
  });

  describe('a save that does not change the engine', () => {
    it('leaves the mode and its engine alone when the patch names neither', () => {
      const config = configWith(BYPASS_ON_CLAUDE);
      const out = master.masterLaunchModeAfterPatch(config, config, { autoStart: true });
      assert.deepEqual(out, { launchMode: 'bypassPermissions', launchModeEngine: 'claude', reset: null, unused: null, error: null });
    });

    it('leaves them alone when the patch names the engine already set', () => {
      const config = configWith(BYPASS_ON_CLAUDE);
      const out = master.masterLaunchModeAfterPatch(config, config, { engine: 'claude' });
      assert.deepEqual(out, { launchMode: 'bypassPermissions', launchModeEngine: 'claude', reset: null, unused: null, error: null });
    });

    it('treats the stored mode sent back unchanged as no choice at all', () => {
      // A settings form sends every field on every save. A stored mode the
      // engine has since stopped defining must not turn every such save into a
      // refusal over a setting nobody touched.
      const config = configWith({ engine: 'claude', launchMode: 'mode-of-a-removed-engine', launchModeEngine: 'claude' });
      const out = master.masterLaunchModeAfterPatch(config, config, { launchMode: 'mode-of-a-removed-engine', autoStart: true });
      assert.equal(out.error, null);
      assert.equal(out.launchMode, 'mode-of-a-removed-engine');
      assert.equal(out.launchModeEngine, 'claude');
    });

    it('records a newly chosen mode for the engine the Master is set to', () => {
      const config = configWith({ engine: 'codex' });
      const out = master.masterLaunchModeAfterPatch(config, config, { launchMode: 'fullAuto' });
      assert.equal(out.launchMode, 'fullAuto');
      assert.equal(out.launchModeEngine, 'codex');
    });

    it('refuses a newly chosen mode the engine does not define', () => {
      const config = configWith({ engine: 'aider' });
      const out = master.masterLaunchModeAfterPatch(config, config, { launchMode: 'acceptEdits' });
      assert.match(out.error, /"acceptEdits" is not a launch mode of Aider/);
    });

    it('refuses a mode when no engine is set for it to belong to', () => {
      const config = configWith({ engine: null }, null);
      const out = master.masterLaunchModeAfterPatch(config, config, { launchMode: 'acceptEdits' });
      assert.match(out.error, /no engine is set for the Master/);
    });

    it('does not read a pin that only restates the default engine as a change', () => {
      const out = master.masterLaunchModeAfterPatch(
        configWith({ engine: null, launchMode: 'acceptEdits', launchModeEngine: 'claude' }, 'claude'),
        configWith({ engine: 'claude', launchMode: 'acceptEdits', launchModeEngine: 'claude' }, 'claude'),
        { engine: 'claude' }
      );
      assert.equal(out.launchMode, 'acceptEdits');
      assert.equal(out.reset, null);
    });
  });

  describe('a Master that follows the default engine', () => {
    it('is reset when the default engine changes, with no master field in the save', () => {
      const stored = { engine: null, launchMode: 'bypassPermissions', launchModeEngine: 'claude' };
      const out = master.masterLaunchModeAfterPatch(configWith(stored, 'claude'), configWith(stored, 'codex'), undefined);
      assert.equal(out.launchMode, 'default');
      assert.deepEqual(out.reset, { mode: 'bypassPermissions', fromEngine: 'claude', toEngine: 'codex' });
    });

    it('is untouched by a default-engine change while it is pinned', () => {
      const out = master.masterLaunchModeAfterPatch(
        configWith(BYPASS_ON_CLAUDE, 'claude'), configWith(BYPASS_ON_CLAUDE, 'codex'), undefined
      );
      assert.equal(out.launchMode, 'bypassPermissions');
      assert.equal(out.launchModeEngine, 'claude');
      assert.equal(out.reset, null);
    });

    it('is reset when the pin is removed and the default engine is a different one', () => {
      const out = master.masterLaunchModeAfterPatch(
        configWith(BYPASS_ON_CLAUDE, 'codex'),
        configWith({ ...BYPASS_ON_CLAUDE, engine: null }, 'codex'),
        { engine: null }
      );
      assert.equal(out.launchMode, 'default');
      assert.deepEqual(out.reset, { mode: 'bypassPermissions', fromEngine: 'claude', toEngine: 'codex' });
    });
  });

  describe('a mode stored before its engine was recorded', () => {
    const UNRECORDED = { engine: 'claude', launchMode: 'acceptEdits' };

    it('is read as chosen for the engine configured now, and still runs', () => {
      const config = configWith(UNRECORDED);
      assert.equal(master.masterLaunchModeOwner(config), 'claude');
      const rt = master._masterRuntime(config, enginesInstalling(['claude']));
      assert.equal(rt.launchMode, 'acceptEdits', 'an upgrade must not change how a running install starts');
    });

    it('has its engine recorded by the next save, whatever that save was for', () => {
      const config = configWith(UNRECORDED);
      const out = master.masterLaunchModeAfterPatch(config, config, { autoStart: true });
      assert.equal(out.launchMode, 'acceptEdits');
      assert.equal(out.launchModeEngine, 'claude');
      assert.equal(out.reset, null);
    });

    it('stops carrying at the next engine change, like any other mode', () => {
      const out = master.masterLaunchModeAfterPatch(
        configWith(UNRECORDED), configWith({ ...UNRECORDED, engine: 'aider' }), { engine: 'aider' }
      );
      assert.equal(out.launchMode, 'default');
      assert.deepEqual(out.reset, { mode: 'acceptEdits', fromEngine: 'claude', toEngine: 'aider' });
    });
  });

  it('keeps a mode already recorded for the engine being switched to', () => {
    // Reachable when the engine was changed where no save could see it (a
    // hand-edited config file) and is now being set back.
    const stored = { engine: 'codex', launchMode: 'acceptEdits', launchModeEngine: 'claude' };
    const out = master.masterLaunchModeAfterPatch(
      configWith(stored), configWith({ ...stored, engine: 'claude' }), { engine: 'claude' }
    );
    assert.equal(out.launchMode, 'acceptEdits');
    assert.equal(out.launchModeEngine, 'claude');
    assert.equal(out.reset, null);
  });

  describe('a stored mode that belongs to another engine than the one set, sent back by a save', () => {
    // The engine was changed where no save saw it: the mode is recorded for
    // Claude Code and the Master is set to Codex, which defines the same key.
    const stored = { engine: 'codex', launchMode: 'bypassPermissions', launchModeEngine: 'claude' };

    it('is not attached to the engine set now, and the answer says it will not run', () => {
      const config = configWith(stored);
      const out = master.masterLaunchModeAfterPatch(config, config, { launchMode: 'bypassPermissions', autoStart: true });
      assert.equal(out.error, null);
      assert.equal(out.launchMode, 'bypassPermissions');
      assert.equal(out.launchModeEngine, 'claude', 'a resent key must never move a mode onto another engine');
      assert.deepEqual(out.unused, { mode: 'bypassPermissions', chosenFor: 'claude', engine: 'codex' });
    });

    it('says nothing on a save that does not send the mode', () => {
      const config = configWith(stored);
      const out = master.masterLaunchModeAfterPatch(config, config, { autoStart: true });
      assert.equal(out.unused, null);
      assert.equal(out.launchModeEngine, 'claude');
    });

    it('can be left by choosing default, and then a mode for the engine set now', () => {
      const config = configWith(stored);
      const cleared = master.masterLaunchModeAfterPatch(config, config, { launchMode: 'default' });
      assert.equal(cleared.launchMode, 'default');
      const fresh = configWith({ engine: 'codex' });
      const chosen = master.masterLaunchModeAfterPatch(fresh, fresh, { launchMode: 'bypassPermissions' });
      assert.equal(chosen.launchMode, 'bypassPermissions');
      assert.equal(chosen.launchModeEngine, 'codex');
      assert.equal(chosen.unused, null);
    });

    it('the notice names the mode, both engines, what will run and the way out', () => {
      const text = master.masterLaunchModeUnusedWarning({ mode: 'bypassPermissions', chosenFor: 'claude', engine: 'codex' });
      assert.match(text, /still Bypass, chosen for Claude Code/);
      assert.match(text, /not used on Codex/);
      assert.match(text, /starts in Interactive/);
      assert.match(text, /save Interactive first, then choose the mode/);
    });
  });

  describe('masterSettings', () => {
    it('reads the recorded engine, and null when there is none or it is not a string', () => {
      assert.equal(master.masterSettings({}).launchModeEngine, null);
      assert.equal(master.masterSettings({ master: { launchModeEngine: 'codex' } }).launchModeEngine, 'codex');
      assert.equal(master.masterSettings({ master: { launchModeEngine: 7 } }).launchModeEngine, null);
      assert.equal(master.masterSettings({ master: { launchModeEngine: '' } }).launchModeEngine, null);
    });

    it('answers no owner for the default mode, whatever is recorded beside it', () => {
      assert.equal(master.masterLaunchModeOwner(configWith({ launchMode: 'default', launchModeEngine: 'codex' })), null);
    });
  });

  describe('the reset notice', () => {
    it('names both engines and both modes by their labels', () => {
      const text = master.masterLaunchModeResetWarning({ mode: 'bypassPermissions', fromEngine: 'claude', toEngine: 'codex' });
      assert.match(text, /reset to Interactive/);
      assert.match(text, /Bypass was chosen for Claude Code/);
      assert.match(text, /does not carry to Codex/);
      assert.match(text, /Choose a launch mode for Codex/);
    });

    it('still names an engine it has no profile for, by its id', () => {
      const text = master.masterLaunchModeResetWarning({ mode: 'acceptEdits', fromEngine: 'claude', toEngine: 'no-such-engine' });
      assert.match(text, /Accept Edits was chosen for Claude Code/);
      assert.match(text, /does not carry to no-such-engine/);
      assert.match(text, /reset to default/, 'with no profile there is no label, so the key is shown');
    });
  });

  describe('at launch, when the engine that starts is not the one the mode was chosen for', () => {
    // Claude Code is configured and not installed; Codex stands in for it. No
    // save ever saw that change, so only the launch can refuse the carry.
    const SUBSTITUTED = enginesInstalling(['codex']);
    const config = configWith({ engine: 'claude', launchMode: 'bypassPermissions', launchModeEngine: 'claude' });

    it('starts in default and leaves the stored choice as it was', () => {
      const rt = master._masterRuntime(config, SUBSTITUTED);
      assert.equal(rt.engineId, 'codex', 'this fixture must substitute, or it proves nothing');
      assert.equal(rt.launchMode, 'default');
      assert.equal(rt.launchModeEngine, 'claude');
      assert.equal(rt.settings.launchMode, 'bypassPermissions', 'the stored choice is still the operator\'s, for Claude Code');
      assert.equal(config.master.launchMode, 'bypassPermissions', 'and nothing rewrote the config it was read from');
    });

    it('puts no flag of the old engine\'s mode into the command that starts the new engine', () => {
      const rt = master._masterRuntime(config, SUBSTITUTED);
      const profile = store.engines.get(rt.engineId);
      const command = sessions._buildLaunchCommand(profile, null, rt.launchMode);
      const carried = sessions._buildLaunchCommand(profile, null, 'bypassPermissions');
      assert.match(carried, /--dangerously-bypass-approvals-and-sandbox/,
        'this is what the carried mode would have started Codex with');
      assert.doesNotMatch(command, /--dangerously/);
      assert.equal(command, sessions._buildLaunchCommand(profile, null, 'default'));
    });

    it('still runs the mode on the engine it was chosen for', () => {
      const rt = master._masterRuntime(config, enginesInstalling(['claude', 'codex']));
      assert.equal(rt.engineId, 'claude');
      assert.equal(rt.launchMode, 'bypassPermissions');
    });

    it('does the same for a mode with no engine recorded: it belongs to the configured engine, not the stand-in', () => {
      const unrecorded = configWith({ engine: 'claude', launchMode: 'bypassPermissions' });
      const rt = master._masterRuntime(unrecorded, SUBSTITUTED);
      assert.equal(rt.engineId, 'codex');
      assert.equal(rt.launchMode, 'default');
      assert.equal(rt.launchModeEngine, 'claude');
    });

    it('a mode with no engine recorded and none configured is nobody\'s choice for the engine that starts', () => {
      const orphan = configWith({ engine: null, launchMode: 'bypassPermissions' }, null);
      const rt = master._masterRuntime(orphan, enginesInstalling(['codex']));
      assert.equal(rt.engineId, 'codex', 'this fixture must resolve an engine, or it proves nothing');
      assert.equal(rt.launchModeEngine, null);
      assert.equal(rt.launchMode, 'default');
    });

    it('the status payload shows the stored mode, the engine it belongs to, and what will run', () => {
      const saved = store.config.load();
      const home = fs.mkdtempSync(path.join(tmpDir, 'home-'));
      const tmuxLib = {
        probeSession: () => ({ live: false, answered: true, cause: null }),
        sessionCreatedAt: () => ({ createdAt: null, answered: true, cause: null }),
        hasSession: () => false
      };
      try {
        store.config.save({ ...saved, defaultEngine: 'claude', master: config.master });
        const st = master.getMasterStatus({ home, tmuxLib, enginesLib: SUBSTITUTED });
        assert.equal(st.settings.launchMode, 'bypassPermissions');
        assert.equal(st.settings.launchModeEngine, 'claude');
        assert.equal(st.settings.resolvedEngine, 'codex');
        assert.equal(st.settings.resolvedLaunchMode, 'default');
      } finally {
        store.config.save(saved);
      }
    });

    it('the status payload carries null for the default mode', () => {
      const home = fs.mkdtempSync(path.join(tmpDir, 'home-'));
      const tmuxLib = {
        probeSession: () => ({ live: false, answered: true, cause: null }),
        sessionCreatedAt: () => ({ createdAt: null, answered: true, cause: null }),
        hasSession: () => false
      };
      const st = master.getMasterStatus({ home, tmuxLib, enginesLib: enginesInstalling(['claude']) });
      assert.equal(st.settings.launchMode, 'default');
      assert.equal(st.settings.launchModeEngine, null);
    });
  });
});
