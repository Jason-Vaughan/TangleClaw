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

// The reader's one typed failure: the symbol was found but its value is not a
// literal. Exit status and error code are the contract between the embedded
// Python and the Node caller — see extractUpstreamInstallReference.
const REFUSAL_EXIT = 3;
const REFUSAL_CODE = 'NON_LITERAL_INSTALL_REFERENCE';

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
 * skip. One failure is typed: a value that is not a literal throws an Error
 * whose `code` is `NON_LITERAL_INSTALL_REFERENCE`, because refusing to
 * evaluate a computed reference is the property the reader exists for and
 * its guard must be able to name it.
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
    // A non-literal is REFUSED with its own exit status and a fixed prefix,
    // so the caller can tell "this value is computed, I will not evaluate it"
    // from every other way the read can fail (syntax error, missing symbol,
    // no python). literal_eval raises ValueError for exactly that case.
    '        try:',
    '            value = ast.literal_eval(n.value)',
    '        except ValueError as err:',
    `            sys.stderr.write("${REFUSAL_CODE}: " + str(err) + "\\n")`,
    `            sys.exit(${REFUSAL_EXIT})`,
    '        json.dump(value, sys.stdout)',
    '        break',
    'else:',
    '    sys.exit("INSTALL_REFERENCE not found in " + sys.argv[1])'
  ].join('\n');
  // Pipe stderr rather than letting it inherit: several tests below deliberately
  // provoke Python failures — three raise tracebacks, one exits via sys.exit
  // with a plain message — and an inherited stderr prints every one of them on a
  // GREEN run. Failure output scrolling past a passing suite trains the reader
  // to ignore failure output. `err.message` still carries the child's stderr, so
  // the matchers are unaffected.
  try {
    return execFileSync('python3', ['-c', program, src], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (err) {
    // The refusal is typed on THIS side of the process boundary, so a test can
    // assert on `err.code` rather than on Python's wording or on whether Node
    // happened to append the child's stderr to the message (#969 — it did on
    // CI and not on a developer machine, so the old guard passed or failed on
    // host plumbing). The status is read from the child's exit code, which
    // every Node build reports the same way.
    if (err && err.status === REFUSAL_EXIT) {
      const refused = new Error(
        `refused to read INSTALL_REFERENCE from ${src}: it is not a literal `
        + `(${String(err.stderr || '').trim() || 'no detail from the reader'})`
      );
      refused.code = REFUSAL_CODE;
      throw refused;
    }
    throw err;
  }
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

/**
 * The upstream cross-check's decision, separated from where it looks so a test
 * can aim it at a chosen root.
 *
 * Three states, three dispositions. `present` compares. `moved` — the
 * marketplace exists but the module does not — fails: upstream relocated the
 * file, which is the event the check exists to notice. `absent` skips on a
 * developer machine, because "prawduct is not installed here" is a fact about
 * the host and not about the reference — EXCEPT when `TANGLECLAW_REQUIRE_UPSTREAM`
 * is set, which the scheduled drift workflow does (#835): that run exists to
 * compare against upstream, so a missing checkout there is a broken run, and a
 * broken run must not report green by skipping.
 *
 * @param {string} root - Marketplace checkout to inspect
 * @param {object} env - Environment to consult for the require flag
 * @param {function(string): void} skip - Called with the reason when skipping is legitimate
 * @returns {void} Throws an AssertionError on moved, on required-but-absent, or on drift.
 */
function crossCheckUpstream(root, env, skip) {
  const { state, src } = classifyUpstreamSource(root);
  if (state === 'absent') {
    if (env.TANGLECLAW_REQUIRE_UPSTREAM) {
      assert.fail(
        `prawduct is not installed at ${root}, and TANGLECLAW_REQUIRE_UPSTREAM is set: this run `
        + 'exists to compare against upstream, so absence is a failure here, not a skip (#835)'
      );
    }
    skip('prawduct plugin not installed on this machine');
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
      crossCheckUpstream(root, process.env, (why) => t.skip(why));
    });

    // The decision above, aimed at roots a test can build. The real test can
    // only ever see whatever is under $HOME; these reach every branch.
    describe('crossCheckUpstream — the decision, aimable (#835)', () => {
      /**
       * A Python module carrying `ref` as INSTALL_REFERENCE.
       * @param {string} root - Marketplace root to populate
       * @param {object} ref - The reference to write
       * @returns {void}
       */
      function installPlugin(root, ref) {
        fs.mkdirSync(path.join(root, 'plugin', 'lib'), { recursive: true });
        const py = JSON.stringify(ref, null, 1).replace(/\btrue\b/g, 'True').replace(/\bfalse\b/g, 'False');
        fs.writeFileSync(path.join(root, 'plugin', 'lib', 'migrate_plugin.py'), `INSTALL_REFERENCE = ${py}\n`);
      }

      it('absent, flag unset: skips with the reason, and does not throw', () => {
        const root = path.join(tmpDir, 'absent-dev');
        const skips = [];
        crossCheckUpstream(root, {}, (why) => skips.push(why));
        assert.deepEqual(skips, ['prawduct plugin not installed on this machine']);
      });

      it('absent, TANGLECLAW_REQUIRE_UPSTREAM set: FAILS — the scheduled run cannot be green by absence', () => {
        const root = path.join(tmpDir, 'absent-ci');
        const skips = [];
        assert.throws(
          () => crossCheckUpstream(root, { TANGLECLAW_REQUIRE_UPSTREAM: '1' }, (why) => skips.push(why)),
          /TANGLECLAW_REQUIRE_UPSTREAM is set.*absence is a failure/
        );
        assert.deepEqual(skips, [], 'must not also skip');
      });

      it('an empty flag is unset — an `env: FLAG:` with no value must not silently require', () => {
        const root = path.join(tmpDir, 'absent-empty');
        const skips = [];
        crossCheckUpstream(root, { TANGLECLAW_REQUIRE_UPSTREAM: '' }, (why) => skips.push(why));
        assert.equal(skips.length, 1);
      });

      it('moved: FAILS whether or not the flag is set', () => {
        const root = path.join(tmpDir, 'moved');
        fs.mkdirSync(root, { recursive: true });
        for (const env of [{}, { TANGLECLAW_REQUIRE_UPSTREAM: '1' }]) {
          assert.throws(() => crossCheckUpstream(root, env, () => assert.fail('must not skip')),
            /moved or was renamed/);
        }
      });

      it('present and matching: passes without skipping', () => {
        const root = path.join(tmpDir, 'present-ok');
        installPlugin(root, engines.PRAWDUCT_INSTALL_REFERENCE);
        crossCheckUpstream(root, { TANGLECLAW_REQUIRE_UPSTREAM: '1' }, () => assert.fail('must not skip'));
      });

      it('present and drifted: FAILS naming the drift', () => {
        const root = path.join(tmpDir, 'present-drift');
        installPlugin(root, { ...engines.PRAWDUCT_INSTALL_REFERENCE, extra: 'key' });
        assert.throws(() => crossCheckUpstream(root, {}, () => assert.fail('must not skip')),
          /has drifted/);
      });
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
    // unexamined error. The matchers read `err.stderr` — piped and decoded
    // on every Node build — never `err.message`: whether the child's stderr
    // is folded into the message depends on the Node build (#969: it is on
    // the build this was written against, it was not on the one the issue
    // was filed from), so a matcher over the message passes or fails on host
    // plumbing, and a mutation back to it cannot be shown red on a folding
    // build. Reading stderr is the same assertion on every build.
    it('THROWS when the symbol is gone — never returns a default', () => {
      const f = write('gone.py', 'SOMETHING_ELSE = {"a": 1}\n');
      // Anchored on the interpolated PATH, not the bare sentence: the embedded
      // program's own `sys.exit("INSTALL_REFERENCE not found in " + …)` source
      // line is in the argv, and on builds that fold argv into the message an
      // unanchored match would match its own source text on ANY nonzero
      // exit. Only the interpolated filename proves the program reached that
      // exit for this file.
      assert.throws(
        () => extractUpstreamInstallReference(f),
        (err) => /INSTALL_REFERENCE not found in \S*gone\.py/.test(String(err.stderr || ''))
      );
    });

    it('THROWS on a syntax error rather than reporting no drift', () => {
      const f = write('broken.py', 'INSTALL_REFERENCE = {"a": \n');
      assert.throws(
        () => extractUpstreamInstallReference(f),
        (err) => /SyntaxError/.test(String(err.stderr || ''))
      );
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

    it('REFUSES a non-literal value with a typed error — not a subprocess error that escaped', () => {
      // literal_eval, not eval: a computed reference is unreadable BY DESIGN,
      // and unreadable must surface as a failure rather than run.
      //
      // Asserted on `err.code`, which the reader sets from the child's exit
      // status. The previous shape matched Python's `ValueError: malformed
      // node` in the thrown message, which only reached the assertion when
      // the Node build appended the child's stderr — it failed on a developer
      // machine while passing in CI (#969), and a guard pinned to host
      // plumbing can equally go GREEN while the refusal it names is gone.
      //
      // Two mutations this catches, both measured: a LENIENT reader (catch
      // the ValueError, emit `{}`) returns instead of throwing; and
      // `literal_eval` swapped for `eval` raises TypeError on an AST node,
      // which is not the typed refusal, so the code is absent. What no shape
      // can assert is "it did not execute" — eval on a node does not run it —
      // so the property pinned here is the refusal itself, by name.
      const f = write('computed.py', 'import os\nINSTALL_REFERENCE = os.environ.copy()\n');
      assert.throws(
        () => extractUpstreamInstallReference(f),
        (err) => err.code === 'NON_LITERAL_INSTALL_REFERENCE' && /not a literal/.test(err.message)
      );
    });

    it('the typed refusal is specific: a syntax error is NOT reported as a refusal', () => {
      // Every other failure keeps its own shape. If a broken file also
      // carried the refusal code, "refused a computed value" would mean
      // nothing.
      const f = write('broken-not-refused.py', 'INSTALL_REFERENCE = {"a": \n');
      assert.throws(
        () => extractUpstreamInstallReference(f),
        (err) => err.code !== 'NON_LITERAL_INSTALL_REFERENCE'
      );
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

    it('Cohort C (non-Claude) — not-applicable, no settings mutation', async () => {
      const p = mkProjectDir('cohortC');
      store.projects.create({ name: 'c1-gemini', path: p, engine: 'gemini' });
      const r = await projects.migrateProjectToPlugin('c1-gemini');
      assert.equal(r.status, 'not-applicable');
      assert.equal(r.migrated, false);
      assert.ok(!fs.existsSync(path.join(p, '.claude', 'settings.json')), 'no settings written for a non-Claude project');
      assert.equal(store.projects.getByName('c1-gemini').migrationStatus, 'not-applicable');
    });

    it('defers on a CONFIRMED-live session — no mutation, status unchanged', async () => {
      const p = mkProjectDir('live');
      store.projects.create({ name: 'c1-live', path: p, engine: 'claude' });
      mock.method(sessionOwnership, 'resolveByProject', () => ({ sessionId: 1, project: 'c1-live', live: true }));
      const r = await projects.migrateProjectToPlugin('c1-live');
      assert.equal(r.deferred, true);
      assert.equal(r.migrated, false);
      assert.ok(!fs.existsSync(path.join(p, '.claude', 'settings.json')), 'no settings written while a session is live');
      assert.equal(store.projects.getByName('c1-live').migrationStatus, null);
    });

    it('does NOT defer on a stale ownership row whose pane is gone (live:false) — isolates the .live gate', async () => {
      const p = mkProjectDir('stalerow');
      store.projects.create({ name: 'c1-stale', path: p, engine: 'claude' });
      // resolveByProject returns an object for any active/wrapping DB row; a
      // dead pane has live:false and must migrate, not falsely defer.
      mock.method(sessionOwnership, 'resolveByProject', () => ({ sessionId: 2, project: 'c1-stale', live: false }));
      const r = await projects.migrateProjectToPlugin('c1-stale');
      assert.equal(r.deferred || false, false, 'a stale (dead-pane) row must not defer');
      assert.equal(r.migrated, true);
      assert.equal(engines.isPluginGoverned(p), true);
    });

    it('DEFERS when liveness could not be established (#937) — this caller is about to act', async () => {
      // The read-only consumers keep what they cannot disprove; this one is
      // the mirror. It is about to rewrite governance config, and doing that
      // under a running agent is real damage while deferring costs a retry —
      // so an unknown takes the same branch as a confirmed-live session.
      const p = mkProjectDir('unknownlive');
      store.projects.create({ name: 'c1-unknown', path: p, engine: 'claude' });
      mock.method(sessionOwnership, 'resolveByProject', () => ({
        sessionId: 3, project: 'c1-unknown', live: null,
        incomplete: ['live'], livenessCause: 'read-timed-out'
      }));
      const r = await projects.migrateProjectToPlugin('c1-unknown');
      assert.equal(r.deferred, true, 'a wedged tmux must not green-light a governance rewrite');
      assert.equal(r.migrated, false);
      assert.match(r.reason, /could not establish/,
        'the refusal must say it is an unknown, not claim a live session it never saw');
      assert.match(r.reason, /read-timed-out/, 'and must carry the cause');
      assert.ok(!fs.existsSync(path.join(p, '.claude', 'settings.json')),
        'no settings written while liveness is unknown');
      assert.equal(store.projects.getByName('c1-unknown').migrationStatus, null);
    });

    it('says in the LOG why it deferred on an unknown, not only in the response', async () => {
      // `migration_status` is deliberately left untouched on a defer, so the
      // reason otherwise survives only in an HTTP body a caller may discard —
      // an operator would see a migration that silently never happened. This
      // guard exists because the log line is the kind of fix that mutates
      // green: delete it and every other assertion here still passes.
      const logger = require('../lib/logger');
      const lines = [];
      logger.setLevel('warn');
      logger.setConsoleStream({ write: (s) => lines.push(String(s)) });
      try {
        const p = mkProjectDir('unknownlog');
        store.projects.create({ name: 'c1-unknown-log', path: p, engine: 'claude' });
        mock.method(sessionOwnership, 'resolveByProject', () => ({
          sessionId: 4, project: 'c1-unknown-log', live: null,
          incomplete: ['live'], livenessCause: 'read-timed-out'
        }));
        await projects.migrateProjectToPlugin('c1-unknown-log');
      } finally {
        logger.setConsoleStream(null);
        logger.setLevel('error');
      }
      const warned = lines.join('');
      assert.match(warned, /could not establish/i,
        'the defer-on-unknown must be visible in the log');
      assert.match(warned, /read-timed-out/, 'and must carry the cause');
    });

    it('happy path — migrates a Claude project, status migrated, ref written', async () => {
      const p = mkProjectDir('happy');
      store.projects.create({ name: 'c1-happy', path: p, engine: 'claude' });
      const r = await projects.migrateProjectToPlugin('c1-happy');
      assert.equal(r.migrated, true);
      assert.equal(r.status, 'migrated');
      assert.equal(engines.isPluginGoverned(p), true);
      assert.equal(store.projects.getByName('c1-happy').migrationStatus, 'migrated');
    });

    it('records pending-activation when the plugin is not installed on this machine', async () => {
      engines._internal.pluginsHome = () => pluginsHomeEmpty;
      const p = mkProjectDir('pending');
      store.projects.create({ name: 'c1-pending', path: p, engine: 'claude' });
      const r = await projects.migrateProjectToPlugin('c1-pending');
      assert.equal(r.migrated, true);
      assert.equal(r.status, 'pending-activation');
      assert.equal(store.projects.getByName('c1-pending').migrationStatus, 'pending-activation');
      engines._internal.pluginsHome = () => pluginsHomeInstalled;
    });

    it('is idempotent — an already-governed project reports migrated, alreadyGoverned', async () => {
      const p = mkProjectDir('already', { enabledPlugins: { 'prawduct@prawduct': true } });
      store.projects.create({ name: 'c1-already', path: p, engine: 'claude' });
      const r = await projects.migrateProjectToPlugin('c1-already');
      assert.equal(r.alreadyGoverned, true);
      assert.equal(r.migrated, false);
      assert.equal(r.status, 'migrated');
    });

    it('returns an error for an unknown project', async () => {
      const r = await projects.migrateProjectToPlugin('c1-does-not-exist');
      assert.match(r.error, /not found/);
      assert.equal(r.migrated, false);
    });

    it('surfaces migrationStatus through the enriched project object', async () => {
      const p = mkProjectDir('enrich');
      store.projects.create({ name: 'c1-enrich', path: p, engine: 'claude' });
      await projects.migrateProjectToPlugin('c1-enrich');
      const enriched = await projects.getProject('c1-enrich');
      assert.equal(enriched.migrationStatus, 'migrated');
    });

    it('migration flips governanceState ungoverned → governed-plugin (C2 #353 badge self-clears)', async () => {
      const p = mkProjectDir('govflip');
      store.projects.create({ name: 'c1-govflip', path: p, engine: 'claude' });
      // Before: Claude, no plugin, no vendored hook → ungoverned.
      assert.equal((await projects.getProject('c1-govflip')).governanceState, 'ungoverned');
      await projects.migrateProjectToPlugin('c1-govflip');
      // After: the migration wrote the plugin ref, so the derived state clears.
      assert.equal((await projects.getProject('c1-govflip')).governanceState, 'governed-plugin');
    });
  });
});
