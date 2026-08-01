'use strict';

const { describe, it, before, after, beforeEach, mock } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { setLevel } = require('../lib/logger');

setLevel('error');

const store = require('../lib/store');
const engines = require('../lib/engines');
const projects = require('../lib/projects');
const sessionOwnership = require('../lib/session-ownership');

/**
 * Read `INSTALL_REFERENCE` out of prawduct's `migrate_plugin.py` by parsing the
 * module as Python source, and return it as JSON text.
 *
 * Python's own `ast` does the parsing because the literal is Python, not JSON:
 * `True` is not `true`, and quoting/formatting are the author's to change.
 * `ast.literal_eval` evaluates only literals, so a hostile or broken module
 * raises rather than executes.
 *
 * Throws on anything short of a clean read — missing symbol, syntax error, no
 * usable `python3`. Every caller must treat a throw as a failure, never as a
 * skip.
 *
 * @param {string} src - Absolute path to the installed plugin's `migrate_plugin.py`
 * @returns {string} The reference as a JSON string
 */
function extractUpstreamInstallReference(src) {
  // Matches both `NAME: ann = {...}` and a bare `NAME = {...}`, so upstream
  // adding or dropping the type annotation is not mistaken for the symbol
  // going away.
  const program = [
    'import ast, json, sys',
    // Explicit utf-8: the real migrate_plugin.py is non-ASCII from line 1, and
    // open()'s locale default would turn a decode error under a non-UTF-8
    // LC_CTYPE into a red "reference has drifted" — a true failure reported as
    // the wrong failure.
    'tree = ast.parse(open(sys.argv[1], encoding="utf-8").read())',
    'for n in ast.walk(tree):',
    '    t = n.target if isinstance(n, ast.AnnAssign) else (n.targets[0] if isinstance(n, ast.Assign) and n.targets else None)',
    '    if getattr(t, "id", "") == "INSTALL_REFERENCE":',
    '        json.dump(ast.literal_eval(n.value), sys.stdout)',
    '        break',
    'else:',
    '    sys.exit("INSTALL_REFERENCE not found in " + sys.argv[1])'
  ].join('\n');
  // Pipe stderr rather than letting it inherit: four of these tests deliberately
  // provoke Python tracebacks, and an inherited stderr prints all four on every
  // GREEN run. Tracebacks scrolling past a passing suite train the reader to
  // ignore tracebacks. `err.message` still carries the child's stderr, so the
  // matchers are unaffected.
  return execFileSync('python3', ['-c', program, src], {
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe']
  });
}

/**
 * Classify the installed plugin's source: is it absent, present, or *moved*?
 *
 * "Not installed" and "installed, but the module I read is gone" are different
 * facts and only the first is a legitimate skip. A marketplace checkout that
 * exists while `plugin/lib/migrate_plugin.py` does not means upstream
 * relocated or renamed it — which is precisely the event this check exists to
 * notice, so collapsing it into "not applicable" would silence the check at the
 * only moment it was ever for. An honest skip reason in a log nobody reads is
 * still a check that stopped checking.
 *
 * @param {string} marketplaceRoot - `~/.claude/plugins/marketplaces/prawduct`
 * @returns {{state: 'absent'|'moved'|'present', src: string}}
 */
function classifyUpstreamSource(marketplaceRoot) {
  const src = path.join(marketplaceRoot, 'plugin', 'lib', 'migrate_plugin.py');
  if (!fs.existsSync(marketplaceRoot)) return { state: 'absent', src };
  if (!fs.existsSync(src)) return { state: 'moved', src };
  return { state: 'present', src };
}

/**
 * Assert TangleClaw's constant matches the upstream reference at `src`.
 *
 * Split out from the test that calls it with the real installed path so this
 * contract — that an unreadable source **fails** rather than skipping — is
 * itself reachable from a test. Inlined, it could only ever run against a
 * readable file under the real `$HOME`, leaving the failure branch asserted by
 * nobody.
 *
 * @param {string} src - Absolute path to the plugin's `migrate_plugin.py`
 * @returns {void} Throws an AssertionError on unreadable source or on drift.
 */
function assertMatchesUpstreamReference(src) {
  let upstream;
  try {
    upstream = JSON.parse(extractUpstreamInstallReference(src));
  } catch (err) {
    // Deliberately NOT a skip. "I could not read it" folded into "not
    // applicable" is how a detector dies quietly and keeps reporting green —
    // and the likeliest cause of an unreadable literal is upstream
    // restructuring it, which is exactly the event this exists to catch.
    assert.fail(`could not read upstream INSTALL_REFERENCE: ${err.message}`);
  }
  // Whole-reference comparison, not field-by-field: an upstream key we stopped
  // writing, or one they added, is drift too, and naming three fields
  // explicitly would wave both through.
  assert.deepEqual(
    engines.PRAWDUCT_INSTALL_REFERENCE,
    upstream,
    'TangleClaw’s install reference has drifted from the installed plugin’s INSTALL_REFERENCE'
  );
}

describe('C1 — per-project plugin migration (#262)', () => {
  let tmpDir;
  let pluginsHomeInstalled; // installed_plugins.json names prawduct
  let pluginsHomeEmpty; // no install marker
  const origHome = engines._internal.pluginsHome;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-c1-'));
    store._setBasePath(tmpDir);
    store.init();

    pluginsHomeInstalled = path.join(tmpDir, 'plugins-installed');
    fs.mkdirSync(pluginsHomeInstalled, { recursive: true });
    fs.writeFileSync(
      path.join(pluginsHomeInstalled, 'installed_plugins.json'),
      JSON.stringify({ version: 2, plugins: { 'prawduct@prawduct': [{ scope: 'user' }] } }, null, 2)
    );
    pluginsHomeEmpty = path.join(tmpDir, 'plugins-empty');
    fs.mkdirSync(pluginsHomeEmpty, { recursive: true });

    // Default seam: the plugin is installed on this machine.
    engines._internal.pluginsHome = () => pluginsHomeInstalled;
  });

  after(() => {
    engines._internal.pluginsHome = origHome;
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  /** Fresh project dir, optionally seeding .claude/settings.json. */
  function mkProjectDir(label, settings) {
    const p = fs.mkdtempSync(path.join(tmpDir, `${label}-`));
    if (settings) {
      fs.mkdirSync(path.join(p, '.claude'), { recursive: true });
      fs.writeFileSync(path.join(p, '.claude', 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
    }
    return p;
  }

  function readSettings(projectPath) {
    return JSON.parse(fs.readFileSync(path.join(projectPath, '.claude', 'settings.json'), 'utf8'));
  }

  describe('store — migration_status round-trip', () => {
    it('a fresh project has migrationStatus null and it persists when set', () => {
      const p = mkProjectDir('store');
      const proj = store.projects.create({ name: 'c1-store-rt', path: p });
      assert.equal(proj.migrationStatus, null);

      store.projects.update(proj.id, { migration_status: 'migrated' });
      assert.equal(store.projects.get(proj.id).migrationStatus, 'migrated');
    });
  });

  describe('engines.PRAWDUCT_INSTALL_REFERENCE', () => {
    // The literal is duplicated here on purpose, and this assertion catches
    // exactly ONE direction: TangleClaw's side changing. Both operands live in
    // this repo, so it can say nothing about upstream — the upstream half is
    // the separate test below that reads the installed plugin's source.
    // Upstream marks autoUpdate provisional, so a future change here is
    // legitimate; it must be a deliberate edit, never a silent drift.
    it('matches prawduct’s published install reference verbatim', () => {
      assert.deepEqual(engines.PRAWDUCT_INSTALL_REFERENCE, {
        enabledPlugins: { 'prawduct@prawduct': true },
        extraKnownMarketplaces: {
          prawduct: {
            source: { source: 'github', repo: 'brookstalley/prawduct', ref: 'main' },
            autoUpdate: true
          }
        }
      });
    });

    it('is frozen all the way down, not just at the top level', () => {
      // Load-bearing: migrateToPlugin spreads the nested object into the
      // caller's settings BY REFERENCE, so one mutation would ride into every
      // subsequent migration. A shallow Object.freeze leaves this writable, so
      // a refactor back to it must fail here rather than pass quietly.
      const ref = engines.PRAWDUCT_INSTALL_REFERENCE;
      assert.throws(() => { 'use strict'; ref.extraKnownMarketplaces.prawduct.source.ref = 'hacked'; });
      assert.throws(() => { 'use strict'; ref.extraKnownMarketplaces.prawduct.autoUpdate = false; });
      assert.equal(ref.extraKnownMarketplaces.prawduct.source.ref, 'main');
      assert.equal(ref.extraKnownMarketplaces.prawduct.autoUpdate, true);
    });

    it('pins ref to a branch, never a version tag', () => {
      // A version-pinned ref stranded 11 repos on a months-old release; the
      // whole point of `main` is that consumers track the current one.
      const { ref } = engines.PRAWDUCT_INSTALL_REFERENCE.extraKnownMarketplaces.prawduct.source;
      assert.equal(ref, 'main');
      assert.doesNotMatch(ref, /^v?\d+\.\d+\.\d+$/);
    });

    // The assertion above compares TC's constant against a literal in TC's own
    // repo, so it only catches OUR side moving. Upstream drifting is the other
    // half — and it is the half #807 actually got bitten by, since upstream
    // marks autoUpdate provisional. This reads the installed plugin's own
    // source. It is a TEST-only read: the production path deliberately does not
    // read this file, because migrations run on machines where it is absent.
    it('matches the installed plugin’s INSTALL_REFERENCE (skipped when not installed)', (t) => {
      // The marketplace checkout, deliberately not the versioned cache dirs:
      // several cache versions can coexist, so picking one would compare
      // against whichever release happened to sort first rather than the
      // installed contract.
      const root = path.join(os.homedir(), '.claude', 'plugins', 'marketplaces', 'prawduct');
      const { state, src } = classifyUpstreamSource(root);
      if (state === 'absent') {
        t.skip('prawduct plugin not installed on this machine');
        return;
      }
      // Installed, but the module is gone: upstream moved or renamed it. Only
      // "not installed at all" earns a skip — see classifyUpstreamSource.
      assert.notEqual(
        state, 'moved',
        `prawduct is installed at ${root} but ${src} is missing — the module moved or was renamed. `
        + 'Retarget this check at its new home rather than letting it skip.'
      );
      // Parsed as an AST, never scraped as text. A text window has to guess
      // where the literal ends, and a guess that lands wrong does not fail —
      // it silently matches keys from a NEIGHBOURING literal and compares
      // against values that were never the install reference. Wrong-and-quiet
      // is the failure mode this whole constant exists to prevent, so the
      // check that guards it must not reintroduce it one level up.
      assertMatchesUpstreamReference(src);
    });
  });

  // The cross-check above resolves its source path itself, so no test can AIM
  // it at a chosen file. On a real machine it does take the failure branch —
  // that is the point of it — but only when upstream actually restructures the
  // literal, which is not something a test can arrange. These aim the reader at
  // crafted sources instead: the point is not that it parses valid Python, it
  // is that every unreadable shape THROWS. A reader that returned a default, or
  // an empty object, would let the cross-check pass while comparing against
  // nothing.
  //
  // `an unreadable source FAILS the cross-check` below covers the branch that
  // decides between failing and skipping, by calling
  // `assertMatchesUpstreamReference` directly. That is the contract the whole
  // design rests on — do not delete it as redundant with the reader tests; they
  // prove the reader raises, and only that one proves the raise is not
  // swallowed into a skip.
  describe('upstream INSTALL_REFERENCE reader', () => {
    // Nested under the suite's own tmpDir so the existing teardown reclaims it;
    // a second mkdtemp would leak a directory per run.
    let pyDir;
    before(() => {
      pyDir = path.join(tmpDir, 'upstream-py');
      fs.mkdirSync(pyDir, { recursive: true });
    });

    const write = (name, body) => {
      const f = path.join(pyDir, name);
      fs.writeFileSync(f, body);
      return f;
    };

    it('reads an annotated assignment, the shape upstream ships today', () => {
      const f = write('ann.py', 'INSTALL_REFERENCE: dict[str, dict] = {"a": {"b": True}}\n');
      assert.deepEqual(JSON.parse(extractUpstreamInstallReference(f)), { a: { b: true } });
    });

    it('reads a bare assignment too — dropping the annotation is not the symbol vanishing', () => {
      const f = write('bare.py', 'INSTALL_REFERENCE = {"a": {"b": False}}\n');
      assert.deepEqual(JSON.parse(extractUpstreamInstallReference(f)), { a: { b: false } });
    });

    it('is not fooled by a name that merely contains the symbol', () => {
      // `py.indexOf('INSTALL_REFERENCE')` matched this; an AST target compare
      // does not. This is the substring class of bug that made text-scraping
      // wrong, pinned so a revert to scraping fails here.
      const f = write('near.py', 'OLD_INSTALL_REFERENCE = {"wrong": 1}\nINSTALL_REFERENCE = {"right": 2}\n');
      assert.deepEqual(JSON.parse(extractUpstreamInstallReference(f)), { right: 2 });
    });

    // Each THROWS case below matches the SPECIFIC failure it is about. A bare
    // `assert.throws(fn)` accepts any error — including `python3: not found`
    // or a typo in the argv index — so unmatched, they would report green over
    // a reader that parsed nothing at all. Tests whose whole subject is
    // "unreadable must not be tolerated" are the last place to accept an
    // unexamined error. execFileSync folds the child's stderr into
    // err.message, so matching costs nothing.
    it('THROWS when the symbol is gone — never returns a default', () => {
      const f = write('gone.py', 'SOMETHING_ELSE = {"a": 1}\n');
      // Anchored on the interpolated PATH, not the bare sentence. execFileSync
      // builds err.message from the argv it ran, and that argv contains the
      // embedded program — including its own `sys.exit("INSTALL_REFERENCE not
      // found in " + …)` source line. So the unanchored form matches its own
      // source text on ANY nonzero exit, which is the identical hole this
      // matcher was added to close, one layer deeper. Only the interpolated
      // filename proves the program reached that exit for this file.
      assert.throws(
        () => extractUpstreamInstallReference(f),
        /INSTALL_REFERENCE not found in \S*gone\.py/
      );
    });

    it('THROWS on a syntax error rather than reporting no drift', () => {
      const f = write('broken.py', 'INSTALL_REFERENCE = {"a": \n');
      assert.throws(() => extractUpstreamInstallReference(f), /SyntaxError/);
    });

    it('distinguishes "not installed" from "installed but the module moved"', () => {
      // The only legitimate skip is "prawduct is not here". A marketplace
      // checkout that exists while the module does not means upstream
      // relocated it — a finding, not a non-applicability. Collapsing the two
      // would make this check go quiet precisely when upstream changes, which
      // is the only time it has ever had anything to say.
      const absent = path.join(pyDir, 'no-such-marketplace');
      assert.equal(classifyUpstreamSource(absent).state, 'absent');

      const moved = path.join(pyDir, 'installed-but-moved');
      fs.mkdirSync(moved, { recursive: true });
      assert.equal(classifyUpstreamSource(moved).state, 'moved');

      const present = path.join(pyDir, 'installed-intact');
      fs.mkdirSync(path.join(present, 'plugin', 'lib'), { recursive: true });
      fs.writeFileSync(path.join(present, 'plugin', 'lib', 'migrate_plugin.py'), 'INSTALL_REFERENCE = {}\n');
      assert.equal(classifyUpstreamSource(present).state, 'present');
    });

    it('an unreadable source FAILS the cross-check — it does not skip it', () => {
      // The contract the whole design rests on, and until this it was asserted
      // by nobody: the cross-check reads a fixed path under $HOME, so its
      // failure branch is unreachable when called the way the real test calls
      // it. Pointed at a source it cannot parse, it must raise — a skip here
      // would mean upstream restructuring the literal reads as "not
      // applicable" and the check goes quiet exactly when it matters.
      const f = write('unreadable.py', 'INSTALL_REFERENCE = {"a": \n');
      assert.throws(
        () => assertMatchesUpstreamReference(f),
        /could not read upstream INSTALL_REFERENCE/
      );
    });

    it('THROWS rather than executing a non-literal value', () => {
      // literal_eval, not eval: a computed reference is unreadable BY DESIGN,
      // and unreadable must surface as a failure rather than run.
      const f = write('computed.py', 'import os\nINSTALL_REFERENCE = os.environ.copy()\n');
      assert.throws(() => extractUpstreamInstallReference(f), /ValueError: malformed node/);
    });
  });

  describe('engines._isCompletePluginRef', () => {
    it('accepts a reference carrying both halves', () => {
      assert.equal(engines._isCompletePluginRef(engines.PRAWDUCT_INSTALL_REFERENCE), true);
    });

    it('rejects enabledPlugins with no marketplace to resolve it', () => {
      assert.equal(engines._isCompletePluginRef({ enabledPlugins: { 'prawduct@prawduct': true } }), false);
      assert.equal(
        engines._isCompletePluginRef({ enabledPlugins: { 'prawduct@prawduct': true }, extraKnownMarketplaces: {} }),
        false
      );
    });

    it('rejects a marketplace with no enabled plugin, and junk input', () => {
      assert.equal(
        engines._isCompletePluginRef({ extraKnownMarketplaces: { prawduct: { source: {} } } }),
        false
      );
      assert.equal(engines._isCompletePluginRef(null), false);
      assert.equal(engines._isCompletePluginRef({}), false);
      assert.equal(engines._isCompletePluginRef({ enabledPlugins: { 'other@x': true } }), false);
    });

    // The marketplace name is derived from each `plugin@marketplace` key rather
    // than assumed to be "prawduct". Only prawduct@prawduct ships today, so
    // without these two cases the derivation and a hardcoded `markets.prawduct`
    // lookup are indistinguishable — every other case in this block passes
    // under both.
    it('resolves each plugin against its OWN marketplace, not a hardcoded one', () => {
      // Marketplace present but not the one this key names → unresolvable.
      assert.equal(
        engines._isCompletePluginRef({
          enabledPlugins: { 'prawduct@other': true },
          extraKnownMarketplaces: { prawduct: { source: {} } }
        }),
        false
      );
      // Marketplace matching the key's suffix → resolvable.
      assert.equal(
        engines._isCompletePluginRef({
          enabledPlugins: { 'prawduct@other': true },
          extraKnownMarketplaces: { other: { source: {} } }
        }),
        true
      );
    });

    it('requires EVERY enabled plugin to resolve, not merely one', () => {
      assert.equal(
        engines._isCompletePluginRef({
          enabledPlugins: { 'prawduct@prawduct': true, 'prawduct@other': true },
          extraKnownMarketplaces: { prawduct: { source: {} } } // `other` unresolvable
        }),
        false
      );
    });
  });

  describe('engines.pluginInstalledAtMachineScope', () => {
    it('is true when installed_plugins.json names a prawduct plugin', () => {
      assert.equal(engines.pluginInstalledAtMachineScope(), true);
    });

    it('is false (fails closed) when no install marker exists', () => {
      engines._internal.pluginsHome = () => pluginsHomeEmpty;
      assert.equal(engines.pluginInstalledAtMachineScope(), false);
      engines._internal.pluginsHome = () => pluginsHomeInstalled;
    });
  });

  describe('engines.migrateToPlugin', () => {
    it('writes the plugin ref into a fresh project and reads as governed', () => {
      const p = mkProjectDir('fresh');
      const r = engines.migrateToPlugin(p);
      assert.equal(r.written, true);
      assert.equal(r.alreadyGoverned, false);
      assert.equal(engines.isPluginGoverned(p), true);
      assert.deepEqual(readSettings(p).enabledPlugins, { 'prawduct@prawduct': true });
    });

    it('is non-destructive — preserves pre-existing settings keys', () => {
      const p = mkProjectDir('preserve', { permissions: { allow: ['Bash'] }, env: { FOO: '1' } });
      engines.migrateToPlugin(p);
      const s = readSettings(p);
      assert.deepEqual(s.permissions, { allow: ['Bash'] });
      assert.deepEqual(s.env, { FOO: '1' });
      assert.equal(s.enabledPlugins['prawduct@prawduct'], true);
    });

    it('is idempotent — an already-governed project is a no-op', () => {
      const p = mkProjectDir('idem', { enabledPlugins: { 'prawduct@prawduct': true }, marker: 'keep' });
      const r = engines.migrateToPlugin(p);
      assert.equal(r.alreadyGoverned, true);
      assert.equal(r.written, false);
      assert.equal(readSettings(p).marker, 'keep');
    });

    it('refuses to clobber a malformed settings.json', () => {
      const p = fs.mkdtempSync(path.join(tmpDir, 'malformed-'));
      fs.mkdirSync(path.join(p, '.claude'), { recursive: true });
      const bad = path.join(p, '.claude', 'settings.json');
      fs.writeFileSync(bad, '{ not valid json');
      const r = engines.migrateToPlugin(p);
      assert.equal(r.written, false);
      assert.match(r.error, /unparseable/);
      assert.equal(fs.readFileSync(bad, 'utf8'), '{ not valid json'); // untouched
    });

    it('always writes the marketplace entry alongside enabledPlugins', () => {
      // The defect this guards: a project told to enable a plugin it has no
      // way to resolve loads nothing, silently, on any machine where prawduct
      // is not already registered — and looks fine on one where it is.
      const p = mkProjectDir('resolvable');
      engines.migrateToPlugin(p);
      const s = readSettings(p);
      assert.equal(s.enabledPlugins['prawduct@prawduct'], true);
      assert.equal(s.extraKnownMarketplaces.prawduct.source.ref, 'main');
      assert.equal(s.extraKnownMarketplaces.prawduct.autoUpdate, true);
    });

    it('refuses an incomplete reference and writes nothing at all', () => {
      const p = mkProjectDir('halfref');
      const r = engines.migrateToPlugin(p, {
        pluginRef: { enabledPlugins: { 'prawduct@prawduct': true } } // no marketplace
      });
      assert.equal(r.written, false);
      assert.match(r.error, /incomplete plugin reference/);
      // Nothing half-written: the project must not read as governed afterwards.
      assert.equal(engines.isPluginGoverned(p), false);
      assert.equal(fs.existsSync(path.join(p, '.claude', 'settings.json')), false);
    });

    it('neutralizes the vendored governance hook — no product-hook command survives in settings', () => {
      const p = mkProjectDir('neutralize');
      engines.migrateToPlugin(p);
      const hooks = readSettings(p).hooks || {};
      const all = JSON.stringify(hooks);
      assert.ok(!all.includes('product-hook'), 'governed project must not retain the vendored product-hook reference');
    });
  });

  describe('projects.migrateProjectToPlugin (orchestrator)', () => {
    beforeEach(() => {
      // Default: no live session. Individual tests override.
      mock.method(sessionOwnership, 'resolveByProject', () => null);
    });

    it('Cohort C (non-Claude) — not-applicable, no settings mutation', () => {
      const p = mkProjectDir('cohortC');
      store.projects.create({ name: 'c1-gemini', path: p, engine: 'gemini' });
      const r = projects.migrateProjectToPlugin('c1-gemini');
      assert.equal(r.status, 'not-applicable');
      assert.equal(r.migrated, false);
      assert.ok(!fs.existsSync(path.join(p, '.claude', 'settings.json')), 'no settings written for a non-Claude project');
      assert.equal(store.projects.getByName('c1-gemini').migrationStatus, 'not-applicable');
    });

    it('defers on a CONFIRMED-live session — no mutation, status unchanged', () => {
      const p = mkProjectDir('live');
      store.projects.create({ name: 'c1-live', path: p, engine: 'claude' });
      mock.method(sessionOwnership, 'resolveByProject', () => ({ sessionId: 1, project: 'c1-live', live: true }));
      const r = projects.migrateProjectToPlugin('c1-live');
      assert.equal(r.deferred, true);
      assert.equal(r.migrated, false);
      assert.ok(!fs.existsSync(path.join(p, '.claude', 'settings.json')), 'no settings written while a session is live');
      assert.equal(store.projects.getByName('c1-live').migrationStatus, null);
    });

    it('does NOT defer on a stale ownership row whose pane is gone (live:false) — isolates the .live gate', () => {
      const p = mkProjectDir('stalerow');
      store.projects.create({ name: 'c1-stale', path: p, engine: 'claude' });
      // resolveByProject returns an object for any active/wrapping DB row; a
      // dead pane has live:false and must migrate, not falsely defer.
      mock.method(sessionOwnership, 'resolveByProject', () => ({ sessionId: 2, project: 'c1-stale', live: false }));
      const r = projects.migrateProjectToPlugin('c1-stale');
      assert.equal(r.deferred || false, false, 'a stale (dead-pane) row must not defer');
      assert.equal(r.migrated, true);
      assert.equal(engines.isPluginGoverned(p), true);
    });

    it('happy path — migrates a Claude project, status migrated, ref written', () => {
      const p = mkProjectDir('happy');
      store.projects.create({ name: 'c1-happy', path: p, engine: 'claude' });
      const r = projects.migrateProjectToPlugin('c1-happy');
      assert.equal(r.migrated, true);
      assert.equal(r.status, 'migrated');
      assert.equal(engines.isPluginGoverned(p), true);
      assert.equal(store.projects.getByName('c1-happy').migrationStatus, 'migrated');
    });

    it('records pending-activation when the plugin is not installed on this machine', () => {
      engines._internal.pluginsHome = () => pluginsHomeEmpty;
      const p = mkProjectDir('pending');
      store.projects.create({ name: 'c1-pending', path: p, engine: 'claude' });
      const r = projects.migrateProjectToPlugin('c1-pending');
      assert.equal(r.migrated, true);
      assert.equal(r.status, 'pending-activation');
      assert.equal(store.projects.getByName('c1-pending').migrationStatus, 'pending-activation');
      engines._internal.pluginsHome = () => pluginsHomeInstalled;
    });

    it('is idempotent — an already-governed project reports migrated, alreadyGoverned', () => {
      const p = mkProjectDir('already', { enabledPlugins: { 'prawduct@prawduct': true } });
      store.projects.create({ name: 'c1-already', path: p, engine: 'claude' });
      const r = projects.migrateProjectToPlugin('c1-already');
      assert.equal(r.alreadyGoverned, true);
      assert.equal(r.migrated, false);
      assert.equal(r.status, 'migrated');
    });

    it('returns an error for an unknown project', () => {
      const r = projects.migrateProjectToPlugin('c1-does-not-exist');
      assert.match(r.error, /not found/);
      assert.equal(r.migrated, false);
    });

    it('surfaces migrationStatus through the enriched project object', () => {
      const p = mkProjectDir('enrich');
      store.projects.create({ name: 'c1-enrich', path: p, engine: 'claude' });
      projects.migrateProjectToPlugin('c1-enrich');
      const enriched = projects.getProject('c1-enrich');
      assert.equal(enriched.migrationStatus, 'migrated');
    });

    it('migration flips governanceState ungoverned → governed-plugin (C2 #353 badge self-clears)', () => {
      const p = mkProjectDir('govflip');
      store.projects.create({ name: 'c1-govflip', path: p, engine: 'claude' });
      // Before: Claude, no plugin, no vendored hook → ungoverned.
      assert.equal(projects.getProject('c1-govflip').governanceState, 'ungoverned');
      projects.migrateProjectToPlugin('c1-govflip');
      // After: the migration wrote the plugin ref, so the derived state clears.
      assert.equal(projects.getProject('c1-govflip').governanceState, 'governed-plugin');
    });
  });
});
