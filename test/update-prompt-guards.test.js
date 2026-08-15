'use strict';

/*
 * #730 — the update prompt injected into an AI session must go through the same
 * guarded applier as the dashboard button, never raw git.
 *
 * Two halves:
 *
 *  - Behavioral, over `scripts/apply-update.js`: the CLI reports the applier's
 *    verbatim result and its exit code distinguishes applied from refused. The
 *    applier is stubbed — a test that spawned the real script for coverage would
 *    run `git checkout` against the developer's own tree.
 *
 *  - Source-level, over `public/session.js`: the prompt text is a durable
 *    instruction executed verbatim by an agent, so its contract is the words.
 *    Same pattern as test/update-prompt-path.test.js (#183) and
 *    test/ub-self-update-action.test.js.
 *
 * The regression this locks: `git pull origin main` merged into whatever branch
 * was checked out, and from a healthy install (detached at a release tag, which
 * is what `applyUpdate` leaves behind) it moved HEAD to a non-tag commit that
 * `_headState` then refuses — so one prompt-driven update disabled the button.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { main, configureProcessLogging } = require('../scripts/apply-update');
const logger = require('../lib/logger');

/** Collect stdout writes for assertion. */
function capture() {
  const chunks = [];
  return { write: (s) => chunks.push(s), text: () => chunks.join('') };
}

/**
 * Slice a function's body out of source text.
 *
 * The assertions below are about the instructions an agent receives, so they
 * must read the prompt itself — not the file around it. The JSDoc on
 * `buildUpdatePrompt` names the banned command deliberately (it records why the
 * command is banned), and a whole-file grep cannot tell that explanation apart
 * from an instruction to run it.
 *
 * @param {string} src - File source
 * @param {string} name - Function name
 * @returns {string} Source from the declaration to the matching closing brace
 */
function functionBody(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} not found`);
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`unbalanced braces in ${name}`);
}

/**
 * Strip comments so a source sweep sees instructions, not prose about them.
 * @param {string} src - File source
 * @returns {string}
 */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/**
 * Every stable refusal code the applier can return, read from its source.
 *
 * Reading them rather than listing them is the point: the prompt tells an agent
 * these are the codes it may have to report, so a code added to the applier and
 * not to the prompt is a contract break the test must fail on, not one a
 * hand-maintained list would quietly track.
 *
 * @returns {string[]}
 */
function applierCodes() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'update-applier.js'), 'utf8');
  // Guard paths call _fail('<code>', …); the catch-all builds its result literal
  // directly, as `code: 'git-error'`. Both forms are read — hand-copying either
  // one back in would reintroduce the drift this function exists to stop.
  const codes = [
    ...[...src.matchAll(/_fail\('([a-z-]+)'/g)].map((m) => m[1]),
    ...[...src.matchAll(/\bcode: '([a-z-]+)'/g)].map((m) => m[1])
  ];
  const unique = [...new Set(codes)];
  // Floor asserted on what was actually extracted. An earlier version counted
  // after appending a hand-written code, so the guard passed while `no-tag` was
  // missing — the exact drift it was supposed to catch.
  assert.ok(
    unique.length >= 6,
    `expected at least 6 refusal codes in update-applier.js, extracted ${unique.length} (${unique}) — the regexes have drifted`
  );
  return unique;
}

describe('apply-update CLI (#730)', () => {
  it('exits 0 and prints the applier result when the update applied', () => {
    const out = capture();
    const result = { ok: true, code: null, error: null, fromSha: 'abc1234', toRef: 'v9.9.9', toSha: 'def5678' };
    const code = main({ applyUpdate: () => result }, out);

    assert.equal(code, 0);
    assert.deepEqual(JSON.parse(out.text()), result);
  });

  it('exits 1 on a refused guard, preserving the stable code for the caller', () => {
    const out = capture();
    const result = {
      ok: false,
      code: 'dirty-tree',
      error: 'local changes present — commit or stash before updating',
      fromSha: 'abc1234',
      toRef: null,
      toSha: null
    };
    const code = main({ applyUpdate: () => result }, out);

    assert.equal(code, 1);
    const printed = JSON.parse(out.text());
    assert.equal(printed.code, 'dirty-tree');
    assert.equal(printed.error, result.error);
  });

  it('exits 1 on a git failure and keeps fromSha so recovery is one line', () => {
    const out = capture();
    const code = main({
      applyUpdate: () => ({ ok: false, code: 'git-error', error: 'boom', fromSha: 'abc1234', toRef: null, toSha: null })
    }, out);

    assert.equal(code, 1);
    assert.equal(JSON.parse(out.text()).fromSha, 'abc1234');
  });

  it('keeps stdout parseable when the applier logs — the refusal case', () => {
    // The regression this exists for: the applier logs on EVERY terminal path,
    // and the logger's default routing puts anything below ERROR on stdout. A
    // stubbed applier returning a plain object never logs, so the original
    // tests passed while a real invocation emitted a log line ahead of the
    // payload — breaking exactly the refusal case a caller is told to parse.
    const err = capture();
    logger.setConsoleStream(err);
    try {
      const out = capture();
      const log = logger.createLogger('update-applier');
      const code = main({
        applyUpdate: () => {
          log.info('Update apply refused', { code: 'dirty-tree' });
          return { ok: false, code: 'dirty-tree', error: 'local changes present', fromSha: 'abc', toRef: null, toSha: null };
        }
      }, out);

      assert.equal(code, 1);
      // The whole of stdout must parse — not "the last line of it".
      assert.deepEqual(JSON.parse(out.text()).code, 'dirty-tree');
      assert.match(err.text(), /Update apply refused/);
    } finally {
      logger.setConsoleStream(null);
    }
  });

  it('pins console output to stderr and initializes the server-side log', () => {
    const calls = { stream: undefined, dir: undefined, opts: undefined };
    const err = capture();
    const ok = configureProcessLogging({
      loggerLib: {
        setConsoleStream: (s) => { calls.stream = s; },
        initFileLogging: (dir, opts) => { calls.dir = dir; calls.opts = opts; }
      },
      storeLib: { _getBasePath: () => '/base' },
      stderr: err
    });

    assert.equal(ok, true);
    assert.equal(calls.stream, err, 'diagnostics must leave stdout free for the payload');
    assert.equal(calls.dir, path.join('/base', 'logs'));
    // The server holds an open fd on this file; rotating from a short-lived
    // process renames it out from under that fd.
    assert.equal(calls.opts.rotate, false);
  });

  it('still applies the update when the log directory is unwritable', () => {
    const err = capture();
    const ok = configureProcessLogging({
      loggerLib: {
        setConsoleStream: () => {},
        initFileLogging: () => { throw new Error('EACCES'); }
      },
      storeLib: { _getBasePath: () => '/base' },
      stderr: err
    });

    assert.equal(ok, false, 'a logging failure must not abort the update');
    assert.match(err.text(), /file logging unavailable: EACCES/);
  });

  it('actually calls the wiring from the entry point, and does not exit before stdout flushes', () => {
    const src = stripComments(fs.readFileSync(path.join(__dirname, '..', 'scripts', 'apply-update.js'), 'utf8'));
    // Extracting the wiring made it testable but left the call site unasserted:
    // dropping this one line passes every other test in the suite while stdout
    // goes back to carrying a log line ahead of the JSON — the original defect.
    assert.match(src, /configureProcessLogging\(\)/);
    assert.match(src, /process\.exitCode = main\(\)/);
    // process.exit() truncates an async (piped) stdout mid-write — and piped is
    // exactly how a caller parsing this JSON invokes it.
    assert.doesNotMatch(src, /process\.exit\(/);
  });

  it('does not restart the server — staging and restarting stay separate acts', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'apply-update.js'), 'utf8');
    assert.doesNotMatch(src, /launchctl|server\/restart/);
  });

  it('runs the same applier the dashboard button calls — one guarded path', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'apply-update.js'), 'utf8');
    assert.match(src, /require\('\.\.\/lib\/update-applier'\)/);
  });
});

describe('injected update prompt (#730)', () => {
  let prompt;

  before(() => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.js'), 'utf8');
    prompt = functionBody(js, 'buildUpdatePrompt');
  });

  it('drives the guarded updater instead of raw git', () => {
    assert.match(prompt, /node scripts\/apply-update\.js/);
  });

  it('never tells the agent to pull, and never names a branch to update from', () => {
    // The specific regression: `git pull origin main` shipped unreleased commits
    // and stranded a tag-detached install off the applier.
    assert.doesNotMatch(prompt, /git pull/);
    assert.doesNotMatch(prompt, /git checkout/);
    assert.doesNotMatch(prompt, /origin main/);
  });

  it('forbids working around a refused guard rather than leaving it ambiguous', () => {
    // An agent told only "report the error" will often try to satisfy the guard
    // by stashing or switching branches — which destroys exactly what the guard
    // was protecting.
    assert.match(prompt, /Do NOT use git directly/);
    assert.match(prompt, /Do not try to satisfy the guard/);
    assert.match(prompt, /STOP/);
  });

  it("passes --discard-tc-files through as the applier's discardDirty opt-in", () => {
    // The flagged, deliberate form of the dashboard's confirm dialog (#711
    // chunk 03). The applier only honors it when no real work is dirty, but
    // the WIRE must carry the operator's choice faithfully in both directions.
    let seen = 'unset';
    const out = { write() {} };
    main({ applyUpdate: (opts) => { seen = opts && opts.discardDirty; return { ok: true }; } },
      out, ['--discard-tc-files']);
    assert.equal(seen, true, 'the flag must reach the applier');
    main({ applyUpdate: (opts) => { seen = opts && opts.discardDirty; return { ok: true }; } },
      out, []);
    assert.equal(seen, false, 'no flag, no discard — never a default');
  });

  it('names every applier code the agent could have to report', () => {
    // Derived from the applier's own source, not a hand-copied list — the first
    // version of this test pinned five codes and silently blessed the omission
    // of `no-tag`, so an agent hitting it would hold a code the instructions
    // said did not exist.
    for (const code of applierCodes()) {
      assert.match(prompt, new RegExp(code), `prompt omits the "${code}" refusal code`);
    }
  });

  it('states the restart cost rather than issuing it silently', () => {
    assert.match(prompt, /drops the dashboard/);
  });

  it('names the half-applied window so a failed test run is not reported as "no change"', () => {
    // Between a successful apply and the restart the checkout is on the new
    // release while the server still runs the old code — and version.json on
    // disk already reads the new version, so an agent inferring state from it
    // would report the update as complete.
    assert.match(prompt, /still running the previous version/);
  });

  it('no public script hands an agent a bare git mutation of the install', () => {
    const publicDir = path.join(__dirname, '..', 'public');
    for (const file of fs.readdirSync(publicDir)) {
      if (!file.endsWith('.js')) continue;
      const src = stripComments(fs.readFileSync(path.join(publicDir, file), 'utf8'));
      assert.doesNotMatch(
        src,
        /git (pull|reset|stash)/,
        `${file} instructs a raw git mutation of the checkout`
      );
    }
  });
});
