'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const engines = require('../lib/engines');
const portScanner = require('../lib/port-scanner');
const porthub = require('../lib/porthub');

// See the note in test/master.test.js: the injected base URL derives its port
// from TANGLECLAW_PORT before config (#654), and a TangleClaw-launched dev
// session inherits that variable, so the ambient value has to go or config-driven
// assertions depend on how the runner was started.
delete process.env.TANGLECLAW_PORT;

describe('engines', () => {
  let tempDir;
  let tempRulesPath;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-engines-test-'));
    store._setBasePath(tempDir);
    store.init();
    // #240 — redirect canonical global-rules to tmp and seed so the
    // engine config generators have realistic rules content to inject.
    tempRulesPath = path.join(tempDir, 'global-rules.md');
    fs.writeFileSync(tempRulesPath, '# Global Rules\n\nThese rules apply to all projects managed by TangleClaw.\n\n- Test seed for engine config generation\n');
    store.globalRules._setBundledGlobalRulesPath(tempRulesPath);
  });

  after(() => {
    store.globalRules._resetBundledGlobalRulesPath();
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  describe('detect', () => {
    it('should return an array of detection results', () => {
      const results = engines.detect();
      assert.ok(Array.isArray(results));
      for (const result of results) {
        assert.ok(typeof result.id === 'string');
        assert.ok(typeof result.available === 'boolean');
      }
    });

    it('should detect engines with "which" strategy', () => {
      const results = engines.detect();
      // At least the bundled profiles should be checked
      assert.ok(results.length > 0);
    });
  });

  // The server runs under launchd, whose PATH is /usr/bin:/bin:/usr/sbin:/sbin
  // and nothing else — while every common way to install an engine CLI (npm
  // -g, nvm, volta, Homebrew, pipx) puts it somewhere that list does not
  // contain. So `which` in the server's own environment reported "not
  // installed" about binaries the operator runs by name every day (#346).
  // Setup now REFUSES to finish with no engine, which turns that wrong answer
  // from a cosmetic label into a door the operator cannot open.
  describe('detection PATH — looking where the operator actually installed it (#346)', () => {
    afterEach(() => engines.resetDetectionCache());

    /** Write an executable fake shell that evaluates the command it is given. */
    function fakeShell(body) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-shell-'));
      const file = path.join(dir, 'shell');
      fs.writeFileSync(file, body);
      fs.chmodSync(file, 0o755);
      return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
    }

    it('never loses a directory the server could already see', async () => {
      // The safety property. A login shell that answers with a NARROWER path
      // than launchd's — or fails outright — may only add candidates. Without
      // this, "fixing" detection could un-detect an engine that worked.
      const saved = process.env.PATH;
      process.env.PATH = '/tc-sentinel-one:/tc-sentinel-two';
      engines.resetDetectionCache();
      try {
        const entries = (await engines.refreshDetectionPath()).path.split(':');
        assert.ok(entries.includes('/tc-sentinel-one'), 'the server PATH must survive the merge');
        assert.ok(entries.includes('/tc-sentinel-two'), 'every entry of it, not just the first');
      } finally {
        process.env.PATH = saved;
        engines.resetDetectionCache();
      }
    });

    it('de-duplicates without reordering', async () => {
      const saved = process.env.PATH;
      process.env.PATH = '/tc-dup:/tc-dup:/tc-other';
      engines.resetDetectionCache();
      try {
        const entries = (await engines.refreshDetectionPath()).path.split(':');
        assert.equal(entries.filter((e) => e === '/tc-dup').length, 1,
          'a repeated entry is searched once');
        assert.ok(entries.indexOf('/tc-dup') < entries.indexOf('/tc-other'), 'order is preserved');
      } finally {
        process.env.PATH = saved;
        engines.resetDetectionCache();
      }
    });

    it('never spawns a shell from the synchronous accessor', async () => {
      // The split that matters. `_detectionPath` is read inside request
      // handlers, and resolving the login PATH means starting the operator's
      // shell and running their profile — unbounded work someone else wrote.
      // Before anything has resolved it, the accessor answers with what this
      // process can see rather than blocking to find out. If it ever probes,
      // this shell makes that unmissable.
      const shell = fakeShell('#!/bin/bash\nsleep 30\n');
      const savedShell = process.env.SHELL;
      const savedPath = process.env.PATH;
      process.env.SHELL = shell.file;
      process.env.PATH = '/tc-sentinel-sync';
      engines.resetDetectionCache();
      try {
        const started = Date.now();
        const answer = engines._detectionPath();
        assert.ok(Date.now() - started < 500, 'the accessor must answer immediately');
        assert.equal(answer, '/tc-sentinel-sync', 'with the PATH this process already has');
      } finally {
        process.env.SHELL = savedShell;
        process.env.PATH = savedPath;
        engines.resetDetectionCache();
        shell.cleanup();
      }
    });

    it('reuses the resolved PATH until something asks it not to', async () => {
      await engines.refreshDetectionPath();
      const first = engines._detectionPath();
      const saved = process.env.PATH;
      process.env.PATH = '/tc-changed-underneath';
      try {
        assert.equal(engines._detectionPath(), first, 'the cached answer is reused');
        const refreshed = await engines.refreshDetectionPath();
        assert.ok(refreshed.path.split(':').includes('/tc-changed-underneath'),
          'and a refresh — what "Check again" asks for — re-reads it');
      } finally {
        process.env.PATH = saved;
        engines.resetDetectionCache();
      }
    });

    it('survives a shell that prints a banner before answering', async () => {
      // The probe runs the operator's INTERACTIVE rc, because ~/.zshrc is where
      // most PATH edits live and zsh reads it only for interactive shells.
      // Interactive rc files also greet you — version notices, prompt
      // frameworks, "you have mail". Taking all of stdout as the answer yields
      // a PATH with a banner glued to the front of it.
      const shell = fakeShell(
        '#!/bin/bash\n'
        + 'echo "Welcome to your shell! 3 updates available."\n'
        + 'PATH=/tc-from-profile:$PATH\n'
        + 'eval "$2"\n'
      );
      const savedShell = process.env.SHELL;
      process.env.SHELL = shell.file;
      engines.resetDetectionCache();
      try {
        const probe = await engines.refreshDetectionPath();
        assert.equal(probe.probed, true, 'a shell that answered counts as a real look');
        const entries = probe.path.split(':');
        assert.ok(entries.includes('/tc-from-profile'),
          'the PATH the profile set must be picked up');
        for (const entry of entries) {
          assert.doesNotMatch(entry, /Welcome|updates available/,
            'the banner must not become a PATH entry (got "' + entry + '")');
        }
      } finally {
        process.env.SHELL = savedShell;
        engines.resetDetectionCache();
        shell.cleanup();
      }
    });

    it('reports that it could NOT look when no shell answers', async () => {
      // The difference between "not installed" and "we could not look" now
      // decides whether an operator can finish setup at all, so the probe has
      // to say which one happened rather than returning a bare PATH.
      const shell = fakeShell('#!/bin/bash\nexit 1\n');
      const savedShell = process.env.SHELL;
      const savedPath = process.env.PATH;
      process.env.SHELL = shell.file;
      process.env.PATH = '/tc-sentinel-fallback';
      engines.resetDetectionCache();
      try {
        const probe = await engines.refreshDetectionPath();
        assert.equal(probe.probed, false, 'a shell that refused to answer is not a look');
        assert.deepEqual(probe.path.split(':'), ['/tc-sentinel-fallback'],
          'and detection is left exactly where it already was');
      } finally {
        process.env.SHELL = savedShell;
        process.env.PATH = savedPath;
        engines.resetDetectionCache();
        shell.cleanup();
      }
    });

    it('refuses a detection target that is not a plain command name', () => {
      // The target is interpolated into a shell command, and engine profiles
      // are operator-authored through the API. A name is [A-Za-z0-9._-]; a
      // semicolon is not part of any binary's name.
      const probe = engines.detectEngine({
        id: 'malicious',
        detection: { strategy: 'which', target: 'node; touch /tmp/tc-detect-injection' }
      });
      assert.equal(probe.available, false);
      assert.equal(fs.existsSync('/tmp/tc-detect-injection'), false,
        'the interpolated command must never have run');
    });
  });

  // The gate that refuses to finish setup is only as good as the detection
  // behind it, and #346 is a standing report that this detection returns the
  // wrong answer on a perfectly normal machine. A wrong "no engine" behind a
  // hard gate is a first-run install with no way out: a Check again button that
  // keeps saying no because the check is broken, not the machine.
  describe('anyEngineInstalled — the gate must not lock on an answer it is unsure of', () => {
    afterEach(() => engines.resetDetectionCache());

    /** Write an executable fake shell. */
    function fakeShell(body) {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-shell-'));
      const file = path.join(dir, 'shell');
      fs.writeFileSync(file, body);
      fs.chmodSync(file, 0o755);
      return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
    }

    it('reports uncertainty rather than deciding it either way', async () => {
      // The distinction the wizard needs. Answering "installed" would drop a
      // stated requirement; answering "not installed" would wall in an operator
      // whose engine is present. Neither is the server's call to make alone.
      const shell = fakeShell('#!/bin/bash\nexit 1\n');
      const savedShell = process.env.SHELL;
      const savedPath = process.env.PATH;
      process.env.SHELL = shell.file;
      process.env.PATH = '/tc-nothing-here';
      engines.resetDetectionCache();
      try {
        const readiness = await engines.engineReadiness();
        assert.equal(readiness.installed, false, 'it found nothing, and says so');
        assert.equal(readiness.certain, false, 'but it could not look, and says that too');
        assert.equal(engines.detectionWasProbed(), false);
      } finally {
        process.env.SHELL = savedShell;
        process.env.PATH = savedPath;
        engines.resetDetectionCache();
        shell.cleanup();
      }
    });

    it('fails OPEN when the login shell could not be read', async () => {
      const shell = fakeShell('#!/bin/bash\nexit 1\n');
      const savedShell = process.env.SHELL;
      const savedPath = process.env.PATH;
      process.env.SHELL = shell.file;
      // Nothing on the PATH, so no engine can possibly be detected.
      process.env.PATH = '/tc-nothing-here';
      engines.resetDetectionCache();
      try {
        assert.equal(await engines.anyEngineInstalled(), true,
          'an uncertain answer must not become a locked door');
      } finally {
        process.env.SHELL = savedShell;
        process.env.PATH = savedPath;
        engines.resetDetectionCache();
        shell.cleanup();
      }
    });

    it('says no when it genuinely looked and found nothing', async () => {
      // Fail-open must not mean "always open" — otherwise the gate is
      // decoration. A shell that ANSWERS, with nothing installed on it, is a
      // trustworthy no.
      const shell = fakeShell('#!/bin/bash\nPATH=/tc-empty\neval "$2"\n');
      const savedShell = process.env.SHELL;
      const savedPath = process.env.PATH;
      process.env.SHELL = shell.file;
      process.env.PATH = '/tc-empty';
      engines.resetDetectionCache();
      try {
        assert.equal(await engines.anyEngineInstalled(), false,
          'a real look that found nothing is a real no');
      } finally {
        process.env.SHELL = savedShell;
        process.env.PATH = savedPath;
        engines.resetDetectionCache();
        shell.cleanup();
      }
    });
  });

  // Detection ran once per project on the ten-second poll — `command -v claude`
  // asked separately for every project using Claude, synchronously on the event
  // loop, to learn a fact about the MACHINE (#890). These pin that it is asked
  // once instead, and — the part that is easy to get wrong — that the answers
  // which must NOT be remembered still are not.
  describe('detection is answered once, not once per asker (#890)', () => {
    let binDir;
    let savedPath;

    /** The fixture engine profile, pointed at a binary this test controls. */
    const profile = { id: 'tc-probe-engine', detection: { strategy: 'which', target: 'tc-probe-bin' } };

    /** Put the fake binary back on disk. */
    function installBinary() {
      fs.writeFileSync(path.join(binDir, 'tc-probe-bin'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    }

    /** Take it away, so the NEXT real probe would answer differently. */
    function removeBinary() {
      fs.rmSync(path.join(binDir, 'tc-probe-bin'), { force: true });
    }

    beforeEach(() => {
      binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-detect-'));
      savedPath = process.env.PATH;
      process.env.PATH = `${binDir}:${savedPath}`;
      installBinary();
      // Drops the login-PATH cache too, so `_detectionPath()` falls through to
      // the PATH set above rather than to whatever this machine's shell reports.
      engines.resetDetectionCache();
    });

    afterEach(() => {
      process.env.PATH = savedPath;
      fs.rmSync(binDir, { recursive: true, force: true });
      engines.resetDetectionCache();
    });

    it('answers a second asker without probing again', () => {
      assert.equal(engines.detectEngine(profile).available, true);
      // Changing the world under the cache is how "did it probe again?" is
      // asked without intercepting the spawn: a re-probe would now say false.
      removeBinary();

      // THE MUTATION THIS CATCHES: dropping the cache read. Correct either way —
      // and back to one subprocess per project per poll.
      assert.equal(engines.detectEngine(profile).available, true,
        'the second ask must be answered from the first, not from a new probe');
    });

    it('shares one probe between the async and the synchronous form', async () => {
      assert.equal((await engines.detectEngineAsync(profile)).available, true);
      removeBinary();
      // THE MUTATION THIS CATCHES: giving the async variant its own cache. Two
      // caches means two policies, and the one nobody looked at goes wrong
      // quietly — `enrichProject` uses the async form, everything else the sync.
      assert.equal(engines.detectEngine(profile).available, true,
        'one cache, or the launch paths keep paying for what the poll just learned');
    });

    it('collapses concurrent cold-cache asks into a single probe', async () => {
      const inflight = engines._internal.detectionInflight;
      // Fired without awaiting, so this reads the state while they are running.
      const asks = [
        engines.detectEngineAsync(profile),
        engines.detectEngineAsync(profile),
        engines.detectEngineAsync(profile)
      ];

      // THE MUTATION THIS CATCHES: dropping the in-flight map and probing on
      // every miss. Enrichment runs under `Promise.all`, so a cold cache would
      // spawn once per project — the multiplication this whole change removes,
      // behind a cache that passes every sequential test.
      assert.equal(inflight.size, 1, 'three askers, one probe');

      for (const result of await Promise.all(asks)) assert.equal(result.available, true);
      assert.equal(inflight.size, 0, 'and the probe is not left in the map once it settles');
    });

    it('re-probes once the result is older than its TTL', () => {
      assert.equal(engines.detectEngine(profile).available, true);
      removeBinary();

      // Age the real entry and let the real comparison decide, rather than
      // asserting against a test-only helper.
      for (const entry of engines._internal.detectionResults.values()) entry.at = 0;

      // THE MUTATION THIS CATCHES: caching forever. An engine installed
      // mid-session would stay invisible until the operator restarted the server
      // or found the wizard's "Check again" — and the operator who just
      // installed one is the least likely to know that button exists.
      assert.equal(engines.detectEngine(profile).available, false,
        'a stale answer must be re-asked, not served');
    });

    it('remembers a real "not installed", because that one IS an answer', () => {
      const cache = engines._internal.detectionResults;
      cache.clear();
      const missing = { id: 'tc-missing', detection: { strategy: 'which', target: '__tc_absent__' } };

      assert.equal(engines.detectEngine(missing).available, false);
      // The other half of the pair below: a non-zero exit from `command -v` is
      // the finding "it is not on the PATH", so caching it is correct — the TTL
      // is what keeps a later install from being hidden forever.
      assert.equal(cache.size, 1, 'a real "not installed" is worth keeping for the TTL');
    });

    it('does NOT remember a probe its own timeout killed', async () => {
      // "We could not look" is not the finding "not installed". Storing it would
      // publish a guess as an answer for the next full minute, for an engine
      // that may well be installed — the same false-fact #891 removed from git
      // reads.
      //
      // Driven by a REAL process that outlives its cap, not a stubbed error
      // object: this repo has written three hand-rolled timeout checks and all
      // three were dead, because each asserted its author's model of the error
      // shape rather than the shape a kill actually produces (#891, #894).
      const { execFile } = require('node:child_process');
      const cache = engines._internal.detectionResults;
      cache.clear();

      const stalls = (_file, _args, opts, cb) => execFile('/bin/sh', ['-c', 'sleep 30'], opts, cb);
      const result = await engines.detectEngineAsync(profile, { execFn: stalls, timeout: 300 });

      assert.equal(result.available, false, 'a probe we could not finish reports nothing found');
      // THE MUTATION THIS CATCHES: treating the timeout as an ordinary failure
      // and caching it — one line, and correct-looking, since both paths produce
      // `available: false`. The difference only shows a minute later, when the
      // engine that WAS installed is still reported missing.
      assert.equal(cache.size, 0, 'but it must not be remembered as one');

      // And the proof it was not remembered: the very next ask probes for real.
      assert.equal(engines.detectEngine(profile).available, true);
    });

    it('a probe still running when the cache is dropped does not refill it', async () => {
      // The case clearing a map cannot reach. A probe that STARTED under the old
      // PATH can settle after Check again has cleared everything, and would then
      // write the stale finding straight back into the fresh cache — so the
      // operator presses the button, the cache empties, and a moment later the
      // answer they pressed it to be rid of is back, now looking freshly probed.
      const { execFile } = require('node:child_process');
      const cache = engines._internal.detectionResults;

      // A probe slow enough to still be running when the cache is dropped.
      const slow = (_file, _args, opts, cb) => execFile('/bin/sh', ['-c', 'sleep 0.4; echo /stale/path'], opts, cb);
      const inFlight = engines.detectEngineAsync(profile, { execFn: slow, timeout: 5000 });

      engines.resetDetectionCache();

      const result = await inFlight;
      // The caller that asked still gets its answer — it is only unfit to be
      // handed to anyone else.
      assert.equal(result.available, true);
      // THE MUTATION THIS CATCHES: dropping the generation check in
      // `_rememberDetection`. Every sequential test still passes; only a probe
      // racing a clear tells the difference, and that race is exactly what the
      // Check again button creates.
      assert.equal(cache.size, 0,
        'an answer probed before the drop must not survive it');
    });

    it('probes now when the caller asks for fresh, and still shares what it learns', () => {
      assert.equal(engines.detectEngine(profile).available, true);
      removeBinary();
      assert.equal(engines.detectEngine(profile).available, true, 'cached, as the poll wants');

      // THE MUTATION THIS CATCHES: letting the launch gates read the cache.
      // `lib/sessions.js` and `lib/master.js` refuse to start a session when
      // this says unavailable — so a stale `false` tells an operator who just
      // installed the engine that it is not installed, and no amount of
      // retrying the button helps until the TTL lapses.
      assert.equal(engines.detectEngine(profile, { fresh: true }).available, false,
        'a gate must look, not remember');

      // And what it looked up replaces the stale entry, so the poll behind it
      // is corrected too rather than each holding a different answer.
      assert.equal(engines.detectEngine(profile).available, false);
    });

    it('honours fresh in the async form too, so the flag is never a silent no-op', async () => {
      assert.equal((await engines.detectEngineAsync(profile)).available, true);
      removeBinary();
      assert.equal((await engines.detectEngineAsync(profile)).available, true, 'cached');

      // THE MUTATION THIS CATCHES: supporting `fresh` on the sync path only.
      // Both forms take the same options object, so a flag the async one quietly
      // drops is worse than one it never accepted — the call site reads as
      // asking for a fresh probe and gets a cached answer.
      assert.equal((await engines.detectEngineAsync(profile, { fresh: true })).available, false);
    });

    it('does NOT remember a probe that never started', async () => {
      // A spawn failure is not a finding. `EMFILE` / `EAGAIN` mean no process
      // ran, so nothing looked for the binary — but the error arrives looking
      // much like an ordinary non-zero exit, and treating it as one caches
      // "not installed".
      //
      // This install's known failure mode is process exhaustion (#94/#144/#380,
      // leaked `tmux attach` children filling the PTY pool), where EVERY spawn
      // fails at once. Caching that would report every engine as uninstalled
      // simultaneously, for a minute, on the machine least able to recover.
      const cache = engines._internal.detectionResults;
      cache.clear();

      // The shape Node produces when the fork fails: a STRING errno in `code`,
      // and no numeric exit status, because there was no process to exit.
      const cannotFork = (_file, _args, _opts, cb) => setImmediate(() => cb(
        Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN', errno: -35, syscall: 'spawn' })));

      const result = await engines.detectEngineAsync(profile, { execFn: cannotFork });

      assert.equal(result.available, false, 'nothing was established, so nothing is claimed');
      // THE MUTATION THIS CATCHES: keeping the old `if (wasTimedOut) skip; else
      // remember` split, which treats every non-timeout failure as an answer.
      assert.equal(cache.size, 0, 'a probe that never ran must not be remembered');

      // And the binary really is there — proof the cached "false" would have lied.
      assert.equal(engines.detectEngine(profile).available, true);
    });

    it('does NOT remember a spawn that really failed, driven by a real failed spawn', async () => {
      // The companion to the fabricated-error test above, and the one that
      // actually earns the claim. `lib/exec-timeout.js` records why: three
      // hand-written versions of a child-process predicate in this repo were all
      // dead, because each asserted its author's MODEL of the error shape rather
      // than the shape. A stub cannot catch that; a real failure can.
      //
      // Executing a path that does not exist produces a genuine ENOENT — no
      // process, so no numeric status — which is the same class as the EMFILE a
      // machine out of process slots produces, and reachable without exhausting
      // this one.
      const { execFile } = require('node:child_process');
      const cache = engines._internal.detectionResults;
      cache.clear();

      const missingBinary = path.join(binDir, 'no-such-shell-at-all');
      const cannotSpawn = (_file, _args, opts, cb) => execFile(missingBinary, [], opts, cb);
      const result = await engines.detectEngineAsync(profile, { execFn: cannotSpawn });

      assert.equal(result.available, false);
      assert.equal(cache.size, 0,
        'a spawn that genuinely never happened must not be remembered as an answer');
    });

    it('tells a real non-zero exit apart from a failed spawn', () => {
      // The other side of the pair: a shell that RAN and exited non-zero reports
      // a numeric status, and that is an answer worth keeping. If the guard above
      // were written as "never cache any failure", this would regress to probing
      // on every poll for every engine the operator does not have installed.
      const cache = engines._internal.detectionResults;
      cache.clear();
      const missing = { id: 'tc-gone', detection: { strategy: 'which', target: '__tc_absent__' } };

      assert.equal(engines.detectEngine(missing).available, false);
      assert.equal(cache.size, 1, 'a shell that ran and said no is an answer');
    });

    it('a probe that finishes after a clear does not evict the probe that replaced it', async () => {
      // `_clearDetectionResults` empties the in-flight map, so a later caller can
      // install its own promise under the same key while the first is still
      // running. When the first one lands, its cleanup must not delete the
      // SECOND caller's entry.
      //
      // THE MUTATION THIS CATCHES: an unconditional
      // `_detectionInflight.delete(key)` in the `finally`. The visible symptom is
      // subtle — the map empties while a probe is still running, so the caller
      // after it starts a third — which is why the assertion is on the map's
      // identity rather than on the answers, which stay correct throughout.
      const { execFile } = require('node:child_process');
      const inflight = engines._internal.detectionInflight;

      const slow = (_f, _a, opts, cb) => execFile('/bin/sh', ['-c', 'sleep 0.35; echo /a'], opts, cb);
      const first = engines.detectEngineAsync(profile, { execFn: slow, timeout: 5000 });

      engines.resetDetectionCache();

      // Outlasts the first deliberately, so the first one's cleanup runs while
      // this is still registered — that ordering is the whole point.
      const slower = (_f, _a, opts, cb) => execFile('/bin/sh', ['-c', 'sleep 0.6; echo /b'], opts, cb);
      const second = engines.detectEngineAsync(profile, { execFn: slower, timeout: 5000 });
      const secondEntry = inflight.get(engines._internal.detectionKeyFor('which', 'tc-probe-bin'));
      assert.ok(secondEntry, 'the second caller registered its own probe');

      await first;
      assert.equal(inflight.get(engines._internal.detectionKeyFor('which', 'tc-probe-bin')), secondEntry,
        'the first probe finishing must leave the second one registered');

      await second;
      await first;
    });

    it('the setup gate looks too — a remembered yes cannot hold the door open', async () => {
      // `engineReadiness` is the third gate, behind the setup check and the
      // wizard's engine step, and its own JSDoc says a "no" must not be stale
      // "because it is the one that stops them". The cache arrived after that
      // sentence was written, which is exactly how a rule gets applied to two of
      // three call sites.
      //
      // The registered engine list is pinned to this fixture: unpinned, the real
      // engines installed on the developer's machine answer first and the
      // assertion means nothing on one box and something else on CI.
      const realList = store.engines.list;
      store.engines.list = () => [{ ...profile, name: 'Probe Engine', pickerHidden: false }];
      try {
        assert.equal(engines.detectEngine(profile).available, true, 'primed as installed');
        removeBinary();

        const readiness = await engines.engineReadiness();

        // THE MUTATION THIS CATCHES: dropping `{ fresh: true }` from the first
        // check. The cache still says the binary is there, so the gate opens for
        // an engine that is gone — and every later failure happens somewhere
        // less able to explain itself than the gate would have been.
        assert.equal(readiness.installed, false,
          'a gate must re-look, not replay a minute-old yes');
      } finally {
        store.engines.list = realList;
      }
    });

    it('honours fresh on the path strategy as well, on both call forms', async () => {
      // The `path` strategy is not used by any shipped profile, which is exactly
      // why it is the arm that gets forgotten — this branch has now applied a
      // rule to a proper subset of its call sites three separate times.
      const probeFile = path.join(binDir, 'engine-at-a-path');
      fs.writeFileSync(probeFile, 'x');
      const byPath = { id: 'tc-by-path', detection: { strategy: 'path', target: probeFile } };

      assert.equal(engines.detectEngine(byPath).available, true);
      fs.rmSync(probeFile);
      assert.equal(engines.detectEngine(byPath).available, true, 'cached, as the poll wants');

      // THE MUTATION THIS CATCHES: `case 'path': return _detectPath(id, target)`
      // without forwarding options — on either form. An option a function accepts
      // and silently drops reads at the call site as though it took effect.
      assert.equal(engines.detectEngine(byPath, { fresh: true }).available, false,
        'sync form must re-check the path');

      fs.writeFileSync(probeFile, 'x');
      assert.equal((await engines.detectEngineAsync(byPath)).available, false, 'cached again');
      assert.equal((await engines.detectEngineAsync(byPath, { fresh: true })).available, true,
        'async form must re-check it too');
    });

    it('forgets everything when the operator presses Check again', async () => {
      assert.equal(engines.detectEngine(profile).available, true);
      removeBinary();
      assert.equal(engines.detectEngine(profile).available, true, 'still cached');

      // THE MUTATION THIS CATCHES: hooking only `resetDetectionCache`.
      // `GET /api/engines?refresh=1` — the Check again button — goes through
      // `refreshDetectionPath`, which does NOT call it. Miss this and the one
      // button whose entire purpose is "my engine IS installed" answers out of
      // the stale cache that hid it.
      await engines.refreshDetectionPath();

      assert.equal(engines.detectEngine(profile).available, false,
        'a re-resolved PATH must re-ask, not replay');
    });
  });

  describe('detectEngine', () => {
    it('should detect an available binary', () => {
      // "node" should be available
      const result = engines.detectEngine({
        id: 'test-node',
        detection: { strategy: 'which', target: 'node' }
      });
      assert.equal(result.id, 'test-node');
      assert.equal(result.available, true);
      assert.ok(result.path);
    });

    it('should handle unavailable binary', () => {
      const result = engines.detectEngine({
        id: 'test-missing',
        detection: { strategy: 'which', target: '__nonexistent_binary_12345__' }
      });
      assert.equal(result.id, 'test-missing');
      assert.equal(result.available, false);
      assert.equal(result.path, null);
    });

    it('should detect by path', () => {
      const result = engines.detectEngine({
        id: 'test-path',
        detection: { strategy: 'path', target: '/usr/bin/env' }
      });
      assert.equal(result.available, true);
      assert.equal(result.path, '/usr/bin/env');
    });

    it('should handle missing path', () => {
      const result = engines.detectEngine({
        id: 'test-path-missing',
        detection: { strategy: 'path', target: '/nonexistent/binary' }
      });
      assert.equal(result.available, false);
      assert.equal(result.path, null);
    });

    it('should handle unknown strategy', () => {
      const result = engines.detectEngine({
        id: 'test-unknown',
        detection: { strategy: 'magic', target: 'foo' }
      });
      assert.equal(result.available, false);
    });

    it('should handle profile with no detection', () => {
      const result = engines.detectEngine({ id: 'no-detect' });
      assert.equal(result.available, false);
    });
  });

  describe('validateProfile', () => {
    it('should validate a complete profile', () => {
      const profile = {
        id: 'test',
        name: 'Test Engine',
        command: 'test',
        interactionModel: 'session',
        configFormat: { filename: 'test.md', syntax: 'markdown', generator: 'test-md' },
        detection: { strategy: 'which', target: 'test' },
        launch: { shellCommand: 'test', args: [], env: {} }
      };
      const result = engines.validateProfile(profile);
      assert.equal(result.valid, true);
      assert.equal(result.errors.length, 0);
    });

    it('should catch missing required fields', () => {
      const result = engines.validateProfile({});
      assert.equal(result.valid, false);
      assert.ok(result.errors.length > 0);
      assert.ok(result.errors.some((e) => e.includes('id')));
    });

    it('should catch invalid interactionModel', () => {
      const profile = {
        id: 'test',
        name: 'Test',
        command: 'test',
        interactionModel: 'invalid',
        configFormat: { filename: 'f', syntax: 's', generator: 'g' },
        detection: { strategy: 'which', target: 't' }
      };
      const result = engines.validateProfile(profile);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('interactionModel')));
    });

    it('should require launch for session engines', () => {
      const profile = {
        id: 'test',
        name: 'Test',
        command: 'test',
        interactionModel: 'session',
        configFormat: { filename: 'f', syntax: 's', generator: 'g' },
        detection: { strategy: 'which', target: 't' }
      };
      const result = engines.validateProfile(profile);
      assert.equal(result.valid, false);
      assert.ok(result.errors.some((e) => e.includes('launch')));
    });

    it('should not require launch for persistent engines', () => {
      const profile = {
        id: 'test',
        name: 'Test',
        command: 'test',
        interactionModel: 'persistent',
        configFormat: { filename: 'f', syntax: 's', generator: 'g' },
        detection: { strategy: 'which', target: 't' }
      };
      const result = engines.validateProfile(profile);
      assert.equal(result.valid, true);
    });

    // #261 — errorPatterns is optional, but once declared the regex must
    // compile and the parser must be a strategy TangleClaw ships by name.
    describe('errorPatterns (#261)', () => {
      /** A complete session profile with the given errorPatterns value. */
      function withPatterns(errorPatterns) {
        return {
          id: 'test',
          name: 'Test',
          command: 'test',
          interactionModel: 'session',
          configFormat: { filename: 'f', syntax: 's', generator: 'g' },
          detection: { strategy: 'which', target: 't' },
          launch: { shellCommand: 'test', args: [], env: {} },
          errorPatterns
        };
      }

      it('accepts a compiling regex with a known parser', () => {
        const result = engines.validateProfile(withPatterns([
          { regex: '^\\{"type":"error"', parser: 'codex-json' }
        ]));
        assert.deepEqual(result.errors, []);
        assert.equal(result.valid, true);
      });

      it('rejects a regex that does not compile', () => {
        const result = engines.validateProfile(withPatterns([{ regex: '(unclosed', parser: 'codex-json' }]));
        assert.equal(result.valid, false);
        assert.ok(result.errors.some((e) => /errorPatterns\[0\]\.regex does not compile/.test(e)), result.errors.join('; '));
      });

      it('rejects a parser name the engine-errors module does not know — a profile selects a parser, never supplies one', () => {
        const result = engines.validateProfile(withPatterns([{ regex: 'x', parser: 'eval-this' }]));
        assert.equal(result.valid, false);
        assert.ok(result.errors.some((e) => /errorPatterns\[0\]\.parser must be one of/.test(e)), result.errors.join('; '));
      });

      it('rejects a non-array declaration and a non-object entry', () => {
        assert.equal(engines.validateProfile(withPatterns({ regex: 'x', parser: 'codex-json' })).valid, false);
        assert.equal(engines.validateProfile(withPatterns(['^x'])).valid, false);
      });

      it('the bundled Codex profile declares a codex-json pattern and validates', () => {
        const codex = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'engines', 'codex.json'), 'utf8'));
        assert.ok(Array.isArray(codex.errorPatterns) && codex.errorPatterns.length > 0, 'codex.json must declare errorPatterns');
        assert.equal(codex.errorPatterns[0].parser, 'codex-json');
        assert.ok(new RegExp(codex.errorPatterns[0].regex).test('{"type":"error","status":400,"error":{}}'),
          'the bundled regex must select the structured error line');
        const result = engines.validateProfile(codex);
        assert.deepEqual(result.errors, []);
      });
    });
  });

  describe('resolveDefaultEngine (#707)', () => {
    // The engine list is injected so these don't depend on which CLIs happen to
    // be installed on the machine running the suite — the resolution rule is
    // what's under test, not this machine's roster.
    const CODEX_ONLY = [
      { id: 'claude', name: 'Claude Code', available: false },
      { id: 'codex', name: 'Codex CLI', available: true },
      { id: 'aider', name: 'Aider', available: false }
    ];

    it('honors config.defaultEngine when that engine is installed', () => {
      assert.equal(engines.resolveDefaultEngine({ defaultEngine: 'codex' }, CODEX_ONLY), 'codex');
    });

    it('ignores config.defaultEngine when that engine is NOT installed', () => {
      // The exact first-install case: shipped default is 'claude', the machine
      // has only Codex. Honoring config here is what made the Project Master
      // refuse to launch with "binary not found".
      assert.equal(engines.resolveDefaultEngine({ defaultEngine: 'claude' }, CODEX_ONLY), 'codex');
    });

    it('falls to the first installed engine when config names nothing', () => {
      assert.equal(engines.resolveDefaultEngine({}, CODEX_ONLY), 'codex');
      assert.equal(engines.resolveDefaultEngine(null, CODEX_ONLY), 'codex');
    });

    it('returns null when nothing is installed — never a guess', () => {
      // A guess moves the failure away from its cause; callers surface the null.
      const none = CODEX_ONLY.map((e) => ({ ...e, available: false }));
      assert.equal(engines.resolveDefaultEngine({ defaultEngine: 'claude' }, none), null);
      assert.equal(engines.resolveDefaultEngine({}, none), null);
      assert.equal(engines.resolveDefaultEngine({}, []), null);
    });

    it('passes an unrecognized engine id straight through, so callers can name it', () => {
      // An id matching no profile is a misconfiguration (a typo in config.json),
      // not an availability problem. Substituting an installed engine here would
      // silently paper over it; the caller reports `"<id>" not found` instead.
      assert.equal(
        engines.resolveDefaultEngine({ defaultEngine: 'ghost-engine' }, CODEX_ONLY),
        'ghost-engine'
      );
    });

    it('tolerates a degenerate list without throwing', () => {
      assert.equal(engines.resolveDefaultEngine({}, [null, undefined]), null);
    });

    it('resolves against live detection when no list is passed', () => {
      // Contract check for the call shape the production sites use. With no
      // configured engine there is no pass-through case, so the result must be
      // an id live detection reports as available — or null on a bare machine.
      const live = engines.listWithAvailability();
      const resolved = engines.resolveDefaultEngine({});
      if (live.some((e) => e.available)) {
        assert.ok(live.find((e) => e.id === resolved && e.available),
          'must resolve to an engine detection reports as available');
      } else {
        assert.equal(resolved, null);
      }
    });
  });

  describe('listWithAvailability', () => {
    it('should return profiles with availability info', () => {
      const list = engines.listWithAvailability();
      assert.ok(Array.isArray(list));
      for (const engine of list) {
        assert.ok(typeof engine.id === 'string');
        assert.ok(typeof engine.name === 'string');
        assert.ok(typeof engine.available === 'boolean');
      }
    });

    it('should include launchModes for engines that define them', () => {
      const list = engines.listWithAvailability();
      const claude = list.find(e => e.id === 'claude');
      assert.ok(claude, 'Claude should be in the list');
      assert.ok(claude.launchModes, 'Claude should have launchModes');
      assert.ok(claude.launchModes.auto, 'Claude should have auto mode');
      assert.ok(Array.isArray(claude.launchModes.auto.args), 'Auto mode should have args array');
      assert.equal(claude.defaultLaunchMode, 'default');
    });

    // #209 — YOLO mode parity across engines. Each non-Claude engine that supports
    // an unattended/skip-permissions equivalent gets a `launchModes` block so the
    // session-launch modal renders and the flag flows through `_buildLaunchCommand`.
    // These tests pin (a) the YOLO key exists, (b) the flag args match the upstream
    // CLI's documented flag — a future flag rename in any of these CLIs will fail
    // here loudly rather than silently routing users into the wrong mode.
    describe('launchModes parity across engines (#209)', () => {
      // gemini's yolo-parity test retired with the engine (#457) — Antigravity's
      // launch-mode flag pins live in test/antigravity-engine.test.js.

      it('aider exposes yolo via --yes-always', () => {
        const aider = engines.listWithAvailability().find(e => e.id === 'aider');
        assert.ok(aider.launchModes, 'aider should have launchModes');
        assert.equal(aider.defaultLaunchMode, 'default');
        assert.deepEqual(aider.launchModes.yesAlways.args, ['--yes-always']);
        assert.ok(aider.launchModes.yesAlways.warning, 'YOLO mode must carry a warning');
        assert.deepEqual(aider.launchModes.default.args, []);
      });

      it('codex exposes fullAuto (sandboxed) and bypass (not sandboxed)', () => {
        // This test previously asserted `--full-auto`, which codex-cli has
        // since removed — `codex --full-auto` exits 2 with "unexpected
        // argument", so the mode could not start a session at all (#731). The
        // assertion held because both sides of it were this repo's own JSON;
        // test/engine-launch-flags.test.js now probes the installed binary,
        // which is the check that can actually catch a flag removal.
        const codex = engines.listWithAvailability().find(e => e.id === 'codex');
        assert.ok(codex.launchModes, 'codex should have launchModes');
        assert.equal(codex.defaultLaunchMode, 'default');

        assert.deepEqual(
          codex.launchModes.fullAuto.args,
          ['--ask-for-approval', 'never', '--sandbox', 'workspace-write']
        );
        assert.ok(codex.launchModes.fullAuto.warning, 'fullAuto must carry a warning even though sandboxed');
        assert.equal(codex.launchModes.fullAuto.label, 'Full Auto');

        // The distinction fullAuto's old label carried in prose is now a real
        // second mode: fullAuto keeps the sandbox, bypass drops it.
        assert.deepEqual(
          codex.launchModes.bypassPermissions.args,
          ['--dangerously-bypass-approvals-and-sandbox']
        );
        assert.ok(codex.launchModes.bypassPermissions.warning, 'bypass must carry a warning');
      });

      it('codex does not advertise supportsSilentPrime (#990 review regression)', () => {
        // `_buildBaselineHooks` is only ever invoked with the 'claude' engine's
        // own profile — `syncEngineHooks` clears .claude/settings.json hooks
        // for every other engine instead of populating them. A non-claude
        // profile declaring `supportsSilentPrime: true` was previously a live
        // lie: `public/ui.js`/`lib/projects.js` read the flag generically to
        // enable a "Silent Prime" UI toggle, so an operator could turn it on
        // for a Codex project and nothing would ever happen — no hooks, no
        // honest skip reason. This pins the fix (capability turned off) and,
        // in-depth, that the gate inside `_buildBaselineHooks` itself would
        // also refuse to emit hooks for a profile shaped like codex's.
        const codex = engines.listWithAvailability().find(e => e.id === 'codex');
        assert.equal(codex.capabilities.supportsSilentPrime, false);

        const hooks = engines._buildBaselineHooks({ silentPrime: true }, codex, 0);
        assert.deepEqual(hooks, {}, 'a profile without supportsSilentPrime must never emit the prime/rules hooks');
      });

      it('every engine with launchModes has a default key that matches defaultLaunchMode', () => {
        const list = engines.listWithAvailability();
        const withModes = list.filter(e => e.launchModes);
        assert.ok(withModes.length >= 4, `expected ≥4 engines with launchModes, got ${withModes.length}`);
        for (const engine of withModes) {
          assert.ok(
            engine.launchModes[engine.defaultLaunchMode],
            `engine "${engine.id}" defaultLaunchMode="${engine.defaultLaunchMode}" must exist in launchModes`
          );
        }
      });

      it('every engine with launchModes has >1 mode so the modal renders', () => {
        // public/landing.js:470 renders the modal only when Object.keys(launchModes).length > 1.
        // A single-entry launchModes block would silently skip the picker.
        const list = engines.listWithAvailability();
        for (const engine of list.filter(e => e.launchModes)) {
          assert.ok(
            Object.keys(engine.launchModes).length > 1,
            `engine "${engine.id}" must have >1 launchMode or the picker won't render`
          );
        }
      });

      it('openclaw launchModes mirror ClawBridge permissionMode values (#210 Phase 2 — picker active end-to-end)', () => {
        // Phase 2 of #210: ClawBridge v1.7.0 shipped `attachIfExists` on
        // /v2/session/start. TC now pre-creates the bridge session with
        // the picked permissionMode inside launchWebuiSession (via the
        // new lib/clawbridge.js HTTP helper); the chat UI then attaches
        // to the existing session via the bridge's idempotent attach.
        // Every openclaw mode flips disabled: false here so the picker
        // renders end-to-end for OpenClaw connections that carry a
        // bridgePort.
        //
        // History: Phase 1 (PR #249) shipped the engine-profile scaffold
        // with disabled: true; the assertion below was `=== true` then.
        // Phase 2 flips the flags and adds the HTTP helper.
        // #459: openclaw is pickerHidden, so it no longer appears in
        // listWithAvailability — resolve it directly. The launch-mode ↔
        // ClawBridge contract below is unchanged: launchWebuiSession reads
        // engineProfile.launchModes server-side to propagate the picked
        // permissionMode to the bridge. Only the PROJECT engine picker
        // dropped openclaw.
        const openclaw = engines.getWithAvailability('openclaw');
        assert.ok(openclaw, 'openclaw engine should exist');
        assert.ok(openclaw.launchModes, 'openclaw must declare launchModes');
        const BRIDGE_ACCEPTS = new Set(['default', 'acceptEdits', 'bypassPermissions', 'auto', 'plan', 'dontAsk']);
        for (const [key, mode] of Object.entries(openclaw.launchModes)) {
          assert.ok(BRIDGE_ACCEPTS.has(key),
            `openclaw mode key "${key}" must be one of ClawBridge's accepted permissionMode values: ${[...BRIDGE_ACCEPTS].join(', ')}`);
          assert.equal(typeof mode.bridgePermissionMode, 'string',
            `openclaw mode "${key}" must declare a string bridgePermissionMode for clawbridge.startSession to read`);
          assert.ok(BRIDGE_ACCEPTS.has(mode.bridgePermissionMode),
            `openclaw mode "${key}".bridgePermissionMode "${mode.bridgePermissionMode}" must be one of ClawBridge's accepted enum`);
          // Phase 2 contract: every openclaw mode is enabled now that
          // propagation is wired. If this regresses to true, the picker
          // would silently swallow the choice — surface loudly.
          assert.equal(mode.disabled, false,
            `openclaw mode "${key}" must declare disabled: false now that #210 Phase 2 has shipped`);
        }
      });
    });
  });

  describe('getWithAvailability', () => {
    it('should return null for non-existent engine', () => {
      const result = engines.getWithAvailability('__nonexistent__');
      assert.equal(result, null);
    });

    it('should return profile with availability for existing engine', () => {
      const result = engines.getWithAvailability('claude');
      assert.ok(result !== null);
      assert.equal(result.id, 'claude');
      assert.ok(typeof result.available === 'boolean');
    });
  });

  describe('generateConfig', () => {
    it('should generate CLAUDE.md content', () => {
      const projectConfig = {
        rules: {
          core: {
            changelogPerChange: true,
            jsdocAllFunctions: true,
            unitTestRequirements: true,
            sessionWrapProtocol: true,
            porthubRegistration: true
          },
          extensions: {
            identitySentry: true,
            docsParity: false
          }
        }
      };
      const content = engines.generateConfig('claude', projectConfig);
      assert.ok(content);
      assert.ok(content.includes('CLAUDE.md'));
      assert.ok(content.includes('Core Rules'));
      assert.ok(content.includes('JSDoc'));
      assert.ok(content.includes('identitySentry') || content.includes('identity'));
    });

    it('should return null for non-existent engine', () => {
      const result = engines.generateConfig('__nonexistent__', {});
      assert.equal(result, null);
    });

    it('should generate codex yaml with instructions containing rules', () => {
      const content = engines._generateCodexYaml(
        { rules: { extensions: { loggingLevel: 'debug' } } },
        { id: 'prawduct', name: 'Prawduct', description: 'Test methodology' }
      );
      assert.ok(content.includes('logging_level: debug'));
      assert.ok(content.includes('instructions: |'), 'Should have instructions block');
      assert.ok(content.includes('Core Rules'), 'Instructions should contain core rules');
      assert.ok(content.includes('PortHub'), 'Instructions should mention PortHub');
    });


    it('should produce valid YAML block scalar indentation in codex instructions', () => {
      const content = engines._generateCodexYaml(
        { rules: { core: { porthubRegistration: true } } },
        { id: 'test', name: 'Test', description: 'Test methodology' }
      );
      const instrStart = content.indexOf('instructions: |');
      assert.ok(instrStart >= 0, 'Should have instructions block');
      // Every line after "instructions: |" that is part of the block scalar
      // must start with exactly 2 spaces (or be blank)
      const afterInstr = content.slice(instrStart + 'instructions: |\n'.length);
      const instrLines = afterInstr.split('\n');
      for (let i = 0; i < instrLines.length; i++) {
        const line = instrLines[i];
        if (line.length === 0 || line.trim() === '') continue;
        assert.ok(line.startsWith('  '),
          `Line ${i + 1} of instructions block must start with 2-space indent, got: "${line.slice(0, 40)}..."`);
      }
    });

    it('should generate aider conf with rules as comments', () => {
      const content = engines._generateAiderConf(
        { rules: { extensions: { loggingLevel: 'debug' } } },
        null
      );
      assert.ok(content.includes('verbose: true'));
      assert.ok(content.includes('# Core Rules'), 'Should have core rules as comments');
      assert.ok(content.includes('PortHub'), 'Should mention PortHub');
    });

    it('should generate aider config via public API (regression: generator name mismatch)', () => {
      const content = engines.generateConfig('aider', {
        rules: { core: {}, extensions: {} }
      });
      assert.ok(content !== null, 'generateConfig("aider") must not return null — check profile generator matches switch case');
      assert.ok(typeof content === 'string');
      assert.ok(content.length > 0);
    });
  });

  describe('_getRulesContent', () => {
    it('should return core rules by default', () => {
      const rules = engines._getRulesContent({});
      assert.ok(rules.coreRulesLines.length > 0, 'Should have default core rules');
      assert.ok(rules.coreRulesLines.some(r => r.includes('CHANGELOG')));
      assert.ok(rules.coreRulesLines.some(r => r.includes('PortHub')));
    });

    it('should respect disabled core rules', () => {
      const rules = engines._getRulesContent({
        rules: { core: { changelogPerChange: false, porthubRegistration: false } }
      });
      assert.ok(!rules.coreRulesLines.some(r => r.includes('CHANGELOG')));
      assert.ok(!rules.coreRulesLines.some(r => r.includes('PortHub')));
      assert.equal(rules.porthubGuide, null, 'PortHub guide should be null when disabled');
    });

    it('should include extension rules', () => {
      const rules = engines._getRulesContent({
        rules: { extensions: { identitySentry: true, docsParity: true, decisionFramework: false } }
      });
      assert.equal(rules.extensionRulesLines.length, 2);
    });

    it('should include PortHub guide when porthubRegistration is active', () => {
      const rules = engines._getRulesContent({
        rules: { core: { porthubRegistration: true } }
      });
      assert.ok(rules.porthubGuide !== null, 'Should include PortHub guide');
      assert.ok(rules.porthubGuide.includes('Port Management'));
    });

    it('should include global rules content', () => {
      const rules = engines._getRulesContent({});
      assert.ok(rules.globalRules !== null, 'Should include global rules');
      assert.ok(typeof rules.globalRules === 'string');
      assert.ok(rules.globalRules.includes('Global Rules'));
    });

    it('should include shared docs guide', () => {
      const rules = engines._getRulesContent({});
      assert.ok(rules.sharedDocsGuide !== null, 'Should include shared docs guide');
      assert.ok(typeof rules.sharedDocsGuide === 'string');
      assert.ok(rules.sharedDocsGuide.includes('Shared Documents'));
    });

    it('should include session memory guide', () => {
      const rules = engines._getRulesContent({});
      assert.ok(rules.sessionMemoryGuide !== null, 'Should include session memory guide');
      assert.ok(typeof rules.sessionMemoryGuide === 'string');
      assert.ok(rules.sessionMemoryGuide.includes('Session Memory'));
    });

    it('does not load a project version recording guide (#101 — TC owns the writer)', () => {
      const rules = engines._getRulesContent({});
      assert.equal(rules.projectVersionGuide, undefined, 'projectVersionGuide field is no longer surfaced');
    });
  });

  describe('#904 — the switchboard reaches the generated config, on every engine', () => {
    const fs = require('node:fs');
    const os = require('node:os');
    const path = require('node:path');
    let projPath;
    let projName;

    before(() => {
      // A REAL registered project: the section is route-scoped, and the name
      // comes from the store rather than the folder basename because a project
      // may be named differently from its directory.
      projPath = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-medusa-guide-'));
      projName = `Switchboard Guide ${Date.now() % 100000}`;
      store.projects.create({ name: projName, path: projPath, engine: 'claude' });
    });

    const on = { medusaEnabled: true, rules: { core: { porthubRegistration: true } } };
    const off = { medusaEnabled: false, rules: { core: { porthubRegistration: true } } };

    it('reaches ALL FOUR generators, not just the markdown one', () => {
      // PortHub gets ~30 lines with runnable examples in this same file and
      // Medusa got none, so a real capability was unreachable in practice. A
      // section added to one generator would be an engine-specific capability,
      // which this project does not ship.
      const generated = {
        claude: engines._generateClaudeMd(on, projPath),
        gemini: engines._generateGeminiMd(on, undefined, projPath),
        codex: engines._generateCodexYaml(on, projPath),
        aider: engines._generateAiderConf(on, projPath)
      };
      for (const [name, content] of Object.entries(generated)) {
        assert.ok(/medusa/i.test(content), `${name} config must mention the switchboard`);
        assert.ok(content.includes(`/medusa/send`), `${name} config must name the send endpoint`);
      }
    });

    it('states a reachable origin, not a pointer to a guide', () => {
      const content = engines._generateClaudeMd(on, projPath);
      assert.match(content, /https?:\/\/localhost:\d+\/api\/sessions\//);
    });

    it('scopes the endpoints to the project NAME, not its folder', () => {
      const content = engines._generateClaudeMd(on, projPath);
      assert.ok(content.includes(encodeURIComponent(projName)),
        'the routes are name-scoped; a folder-derived guess would hand the session a 404');
      assert.ok(!content.includes(`/api/sessions/${path.basename(projPath)}/medusa`),
        'must not address the project by its directory basename');
    });

    it('says nothing to a project that has not opted in', () => {
      // #820 made the same flag gate the UI surface. Teaching a session to use a
      // channel its project has turned off is an instruction it cannot follow.
      for (const [name, content] of Object.entries({
        claude: engines._generateClaudeMd(off, projPath),
        gemini: engines._generateGeminiMd(off, undefined, projPath),
        codex: engines._generateCodexYaml(off, projPath),
        aider: engines._generateAiderConf(off, projPath)
      })) {
        assert.ok(!/medusa/i.test(content), `${name} config must stay silent when the flag is off`);
      }
    });

    it('drops the section rather than guessing when no path is given', () => {
      const content = engines._generateClaudeMd(on);
      assert.ok(!/medusa/i.test(content), 'no project path means no resolvable name — omit, never guess');
    });

    it('renders the aider form as comments so the config stays parseable', () => {
      const lines = engines._medusaSwitchboardLines(
        { medusaEnabled: true, medusaProjectName: 'p', serverProtocol: 'http', serverPort: 3102 }, 'comment'
      );
      assert.ok(lines.length > 0 && lines.every((l) => l.startsWith('#')), 'comment form must be all #-prefixed');
    });
  });

  describe('AUTH-4b — service-token injection', () => {
    // Shape-only token, assembled at runtime so it doesn't trip GH push protection.
    const TOKEN = 'tcsk_' + 'A'.repeat(43);
    const proj = { rules: { core: { porthubRegistration: true } } };

    function enableGate() {
      const c = store.config.load();
      c.serviceTokenEnabled = true;
      c.serviceToken = TOKEN;
      store.config.save(c);
    }

    afterEach(() => {
      // Restore default gate state so it doesn't leak into other tests.
      const c = store.config.load();
      c.serviceTokenEnabled = false;
      c.serviceToken = null;
      store.config.save(c);
    });

    it('_getRulesContent surfaces the raw token only when the gate is enabled', () => {
      assert.equal(engines._getRulesContent(proj).serviceToken, null);
      assert.equal(engines._getRulesContent(proj).serviceTokenEnabled, false);
      enableGate();
      const rules = engines._getRulesContent(proj);
      assert.equal(rules.serviceTokenEnabled, true);
      assert.equal(rules.serviceToken, TOKEN);
    });

    it('_serviceTokenAuthLines: [] when off/null, an Authorization block when on', () => {
      assert.deepEqual(engines._serviceTokenAuthLines({ serviceTokenEnabled: false, serviceToken: null }), []);
      assert.deepEqual(engines._serviceTokenAuthLines({ serviceTokenEnabled: true, serviceToken: null }), []);
      const md = engines._serviceTokenAuthLines({ serviceTokenEnabled: true, serviceToken: TOKEN });
      assert.ok(md.some((l) => l.includes(`Authorization: Bearer ${TOKEN}`)));
      const comment = engines._serviceTokenAuthLines({ serviceTokenEnabled: true, serviceToken: TOKEN }, 'comment');
      assert.ok(comment.length > 0 && comment.every((l) => l.startsWith('#')), 'comment form must be all #-prefixed');
      assert.ok(comment.some((l) => l.includes(`Authorization: Bearer ${TOKEN}`)));
    });

    it('injects the bearer header into the engine-private configs when enabled', () => {
      enableGate();
      // Contract narrowed deliberately 2026-08-31, not weakened: these three
      // carriers are engine-private files that TangleClaw gitignores, so the
      // live token may be inlined. The gemini/antigravity carrier is not —
      // see the test below.
      const generated = {
        claude: engines._generateClaudeMd(proj),
        codex: engines._generateCodexYaml(proj),
        aider: engines._generateAiderConf(proj)
      };
      for (const [name, content] of Object.entries(generated)) {
        assert.ok(content.includes(`Authorization: Bearer ${TOKEN}`), `${name} config must carry the bearer header`);
      }
    });

    it('never writes the live token into the committed AGENTS.md carrier', () => {
      enableGate();
      const content = engines._generateGeminiMd(proj);
      // `AGENTS.md` is tracked in git in every antigravity project here, unlike
      // the gitignored `.antigravity.md` it replaced. Inlining the bearer would
      // publish it to the repo and anywhere that repo is pushed. Mutation this
      // catches: dropping the `committedCarrier` flag at the call site.
      assert.ok(!content.includes(TOKEN), 'the live token must not appear in a committed carrier');
      assert.ok(!content.includes(`Authorization: Bearer ${TOKEN}`));
      assert.ok(content.includes('/api/service-token'), 'it names where to fetch the token instead');
      assert.ok(content.includes('tracked in git'), 'and says why it is absent');
    });

    it('injects nothing when the gate is off (no raw token, no injected auth block)', () => {
      // The static PortHub/shared-docs guides mention `Authorization: Bearer
      // $TANGLECLAW_SERVICE_TOKEN` as documentation; the DYNAMIC injection is
      // distinguished by the bold marker + the real token value, both absent here.
      const claudeOff = engines._generateClaudeMd(proj);
      assert.ok(!claudeOff.includes('**TangleClaw API authentication**'), 'no injected auth block when gate off');
      assert.ok(!claudeOff.includes(TOKEN), 'no raw token value when gate off');
    });

    it('static guides document the service-token Authentication requirement', () => {
      const porthubGuide = fs.readFileSync(path.join(__dirname, '..', 'data', 'porthub-guide.md'), 'utf8');
      const sharedGuide = fs.readFileSync(path.join(__dirname, '..', 'data', 'shared-docs-guide.md'), 'utf8');
      assert.match(porthubGuide, /### Authentication/);
      assert.ok(porthubGuide.includes('Authorization: Bearer'));
      assert.match(sharedGuide, /### Authentication/);
      assert.ok(sharedGuide.includes('Authorization: Bearer'));
    });
  });

  describe('ENG-5R2W — injected API base URL matches the served protocol', () => {
    const proj = { rules: { core: { porthubRegistration: true } } };
    let origConfig;

    beforeEach(() => {
      origConfig = store.config.load();
    });

    afterEach(() => {
      store.config.save(origConfig);
    });

    function patchConfig(patch) {
      store.config.save(Object.assign(store.config.load(), patch));
    }

    it('injects http:// in caddy ingress mode even with full HTTPS config', () => {
      patchConfig({
        ingressMode: 'caddy', httpsEnabled: true,
        httpsCertPath: '/c.pem', httpsKeyPath: '/k.pem', serverPort: 3102
      });
      assert.equal(engines._getRulesContent(proj).serverProtocol, 'http');
      const content = engines._generateClaudeMd(proj);
      // Assert on the injected line itself — the static guide prose may mention
      // https://localhost:3102 as documentation, only the injected URL is live.
      assert.ok(
        content.includes('**TangleClaw API base URL**: `http://localhost:3102`'),
        'injected base URL must be http in caddy mode'
      );
      assert.ok(
        !content.includes('**TangleClaw API base URL**: `https://'),
        'must not inject an https base URL nothing serves'
      );
    });

    it('injects the port the server actually binds, not config.serverPort (#654)', () => {
      // The standard install: plist binds TANGLECLAW_PORT=3102 while config keeps
      // the shipped 3101 default. Injecting the config port told every agent on
      // the machine that PortHub lived on a port nothing was listening on, so
      // every lease/heartbeat call failed with no error surfaced anywhere.
      patchConfig({
        ingressMode: 'direct', httpsEnabled: false,
        httpsCertPath: null, httpsKeyPath: null, serverPort: 3101
      });
      const had = Object.prototype.hasOwnProperty.call(process.env, 'TANGLECLAW_PORT');
      const prev = process.env.TANGLECLAW_PORT;
      try {
        process.env.TANGLECLAW_PORT = '3102';
        const content = engines._generateClaudeMd(proj);
        assert.ok(
          content.includes('**TangleClaw API base URL**: `http://localhost:3102`'),
          'injected base URL must name the bound port'
        );
        assert.ok(
          !content.includes('localhost:3101'),
          'must not inject the config port when the environment overrides it'
        );
      } finally {
        if (had) process.env.TANGLECLAW_PORT = prev;
        else delete process.env.TANGLECLAW_PORT;
      }
    });

    it('injects https:// in direct mode only with the full willServeHttps conjunction', () => {
      patchConfig({
        ingressMode: 'direct', httpsEnabled: true,
        httpsCertPath: '/c.pem', httpsKeyPath: '/k.pem', serverPort: 3102
      });
      assert.ok(engines._generateClaudeMd(proj).includes('https://localhost:3102'));
      // httpsEnabled defaults to true — a no-cert install serves HTTP.
      patchConfig({ httpsCertPath: null, httpsKeyPath: null });
      assert.ok(engines._generateClaudeMd(proj).includes('http://localhost:3102'));
    });
  });

  describe('session rules NOT injected into config files (#595)', () => {
    let project;

    beforeEach(() => {
      const projPath = path.join(tempDir, 'sr-proj');
      fs.mkdirSync(projPath, { recursive: true });
      project = store.projects.create({ name: 'sr-proj', path: projPath, engine: 'claude' });
    });

    afterEach(() => {
      // Clear rules so other generator tests in this shared-store suite
      // don't see leaked content.
      for (const rule of store.sessionRules.list()) {
        store.sessionRules.delete(rule.id);
      }
      if (project) store.projects.delete(project.id);
    });

    // These assertions are INVERTED from their original form on purpose (#595).
    // Config-file injection was this tier's only delivery path, and it is
    // skipped wholesale for plugin-governed projects — so it delivered nothing
    // on all 13 of them while looking healthy. Delivery moved to the session
    // prime (see sessions.buildStartupRulesSection, covered in sessions.test.js).
    // Re-adding injection here would restore a second path for one tier, which
    // is what let the broken one hide; these tests fail if that happens.

    it('_getRulesContent no longer carries session rules at all', () => {
      store.sessionRules.create({ content: 'Prefer composition over inheritance', projectId: project.id });
      const rules = engines._getRulesContent({ id: project.id });
      assert.equal(rules.sessionRulesLines, undefined);
      assert.doesNotMatch(JSON.stringify(rules), /Prefer composition over inheritance/);
    });

    it('CLAUDE.md carries no Session Rules section even when rules exist', () => {
      store.sessionRules.create({ content: 'Always run lint', projectId: project.id });
      const content = engines._generateClaudeMd({ id: project.id });
      assert.doesNotMatch(content, /## Session Rules/);
      assert.doesNotMatch(content, /Always run lint/);
    });

    it('GEMINI.md carries no Session Rules section even when rules exist', () => {
      store.sessionRules.create({ content: 'Gemini must not see this', projectId: project.id });
      const content = engines._generateGeminiMd({ id: project.id });
      assert.doesNotMatch(content, /## Session Rules/);
      assert.doesNotMatch(content, /Gemini must not see this/);
    });

    it('.codex.yaml carries no Session Rules section even when rules exist', () => {
      store.sessionRules.create({ content: 'Codex must not see this', projectId: project.id });
      const content = engines._generateCodexYaml({ id: project.id });
      assert.doesNotMatch(content, /## Session Rules/);
      assert.doesNotMatch(content, /Codex must not see this/);
    });

    it('.aider.conf.yml carries no Session Rules comments even when rules exist', () => {
      store.sessionRules.create({ content: 'Aider must not see this', projectId: project.id });
      const content = engines._generateAiderConf({ id: project.id });
      assert.doesNotMatch(content, /# Session Rules:/);
      assert.doesNotMatch(content, /Aider must not see this/);
    });

    it('renders NOTHING when there are no active session rules', () => {
      const claude = engines._generateClaudeMd({ id: project.id });
      const gemini = engines._generateGeminiMd({ id: project.id });
      const codex = engines._generateCodexYaml({ id: project.id });
      const aider = engines._generateAiderConf({ id: project.id });
      assert.doesNotMatch(claude, /## Session Rules/);
      assert.doesNotMatch(gemini, /## Session Rules/);
      assert.doesNotMatch(codex, /## Session Rules/);
      assert.doesNotMatch(aider, /# Session Rules:/);
    });
  });

  describe('tc bootstrap line rides every carrier (ambient-awareness Chunk 04)', () => {
    // The 2026-09-01 live probe proved PATH presence alone creates zero
    // discovery intent, so the instruction must be in every channel each
    // engine actually reads. The guard runs the FAMILY the dispatcher emits,
    // not a sampled member — a guard for a class must exercise every member
    // the producer emits.
    const projectConfig = {
      rules: { core: { porthubRegistration: true } }
    };

    it('every generator with supportsConfigFile ships the line with its stated consequence', () => {
      const profiles = store.engines.list().filter(p =>
        p.capabilities && p.capabilities.supportsConfigFile
      );
      assert.ok(profiles.length >= 4, `Expected at least 4 config-supporting engines, got ${profiles.length}`);

      for (const profile of profiles) {
        const content = engines.generateConfig(profile.id, projectConfig);
        assert.ok(content !== null, `${profile.id}: generateConfig returned null`);
        assert.match(content, /tc capabilities/,
          `${profile.id}: carrier is missing the tc bootstrap line`);
        assert.match(content, /fabricate/,
          `${profile.id}: the line must carry its stated consequence, not just name the verb`);
        // Wrap-tolerant: the comment form may break the phrase across
        // #-prefixed lines.
        assert.match(content, /not launched by\s+(# )?TangleClaw/,
          `${profile.id}: the honest-absence case must ride every carrier`);
      }
    });

    it('the line is unconditional — a config with every optional section off still ships it', () => {
      const bare = {
        rules: {
          core: {
            changelogPerChange: false,
            jsdocAllFunctions: false,
            unitTestRequirements: false,
            sessionWrapProtocol: false,
            porthubRegistration: false
          }
        }
      };
      const profiles = store.engines.list().filter(p =>
        p.capabilities && p.capabilities.supportsConfigFile
      );
      for (const profile of profiles) {
        const content = engines.generateConfig(profile.id, bare);
        assert.ok(content !== null, `${profile.id}: generateConfig returned null`);
        assert.match(content, /tc capabilities/,
          `${profile.id}: the bootstrap line must not hide behind an optional section's gate`);
      }
    });

    it('the gemini-md generator ships it under its default header too', () => {
      // The shipped profiles exercise the antigravity-md header path of
      // _generateGeminiMd; this pins the default-header (GEMINI.md) case the
      // dispatcher can also emit.
      const content = engines._generateGeminiMd(projectConfig, undefined, '/tmp/x');
      assert.match(content, /tc capabilities/);
    });

    it('the served-plans sentence rides every carrier beside it, whatever sections are off (#542)', () => {
      // Same family, same reason: a non-Claude session has no other way to
      // learn the link exists. Kept out of the prime (budget-capped), so the
      // config carriers are the ONLY channel — every one of them must ship it.
      const bare = { rules: { core: { porthubRegistration: false } } };
      const profiles = store.engines.list().filter(p =>
        p.capabilities && p.capabilities.supportsConfigFile
      );
      assert.ok(profiles.length >= 4);
      for (const profile of profiles) {
        for (const cfg of [projectConfig, bare]) {
          const content = engines.generateConfig(profile.id, cfg);
          // Wrap-tolerant: the comment form may break the phrase across
          // #-prefixed lines.
          assert.match(content, /GET\s+(# )?\/api\/projects\/<projectId>\/plans/,
            `${profile.id}: carrier is missing the served-plans endpoint`);
          assert.match(content, /never a local file\s+(# )?path/,
            `${profile.id}: the sentence must say what to hand back instead`);
        }
      }
      const gemini = engines._generateGeminiMd(projectConfig, undefined, '/tmp/x');
      assert.match(gemini, /\/api\/projects\/<projectId>\/plans/);
    });
  });

  describe('project version recording NOT injected (#101)', () => {
    const projectConfig = {
      rules: {
        core: {
          changelogPerChange: true,
          jsdocAllFunctions: true,
          unitTestRequirements: true,
          sessionWrapProtocol: true,
          porthubRegistration: true
        }
      }
    };

    it('no generator with supportsConfigFile includes a Project Version Recording section anymore', () => {
      const profiles = store.engines.list().filter(p =>
        p.capabilities && p.capabilities.supportsConfigFile
      );
      assert.ok(profiles.length >= 4, `Expected at least 4 config-supporting engines, got ${profiles.length}`);

      for (const profile of profiles) {
        const content = engines.generateConfig(profile.id, projectConfig);
        assert.ok(content !== null, `${profile.id}: generateConfig returned null`);
        assert.equal(
          content.includes('Project Version Recording'),
          false,
          `${profile.id}: should not contain Project Version Recording section (TC writes the cache file directly)`
        );
        assert.equal(
          content.includes('project-version.txt'),
          false,
          `${profile.id}: should not reference the cache file path`
        );
      }
    });
  });

  describe('rule injection parity', () => {
    const fullProjectConfig = {
      rules: {
        core: {
          changelogPerChange: true,
          jsdocAllFunctions: true,
          unitTestRequirements: true,
          sessionWrapProtocol: true,
          porthubRegistration: true
        },
        extensions: {
          identitySentry: true
        }
      }
    };

    it('all generators with supportsConfigFile should include core rules', () => {
      const profiles = store.engines.list().filter(p =>
        p.capabilities && p.capabilities.supportsConfigFile
      );
      assert.ok(profiles.length >= 4, `Expected at least 4 config-supporting engines, got ${profiles.length}`);

      for (const profile of profiles) {
        const content = engines.generateConfig(profile.id, fullProjectConfig);
        assert.ok(content !== null, `${profile.id}: generateConfig returned null`);
        assert.ok(content.includes('CHANGELOG') || content.includes('changelog'),
          `${profile.id}: missing CHANGELOG rule`);
        assert.ok(content.includes('PortHub') || content.includes('porthub') || content.includes('port'),
          `${profile.id}: missing PortHub reference`);
        assert.ok(content.includes('test') || content.includes('Test'),
          `${profile.id}: missing test rule`);
      }
    });

    it('all generators should include PortHub guide or reference when enabled', () => {
      const profiles = store.engines.list().filter(p =>
        p.capabilities && p.capabilities.supportsConfigFile
      );

      for (const profile of profiles) {
        const content = engines.generateConfig(profile.id, fullProjectConfig);
        assert.ok(content !== null, `${profile.id}: generateConfig returned null`);
        // Claude gets full guide, Codex gets it in instructions, Aider gets comment reference
        assert.ok(
          content.includes('Port Management') || content.includes('TangleClaw API'),
          `${profile.id}: missing PortHub guide or API reference`
        );
      }
    });

    it('all generators should include global rules', () => {
      const profiles = store.engines.list().filter(p =>
        p.capabilities && p.capabilities.supportsConfigFile
      );

      for (const profile of profiles) {
        const content = engines.generateConfig(profile.id, fullProjectConfig);
        assert.ok(content !== null, `${profile.id}: generateConfig returned null`);
        assert.ok(
          content.includes('Global Rules') || content.includes('global') || content.includes('Global'),
          `${profile.id}: missing global rules`
        );
      }
    });



    it('all generators should include shared docs guide', () => {
      const profiles = store.engines.list().filter(p =>
        p.capabilities && p.capabilities.supportsConfigFile
      );

      for (const profile of profiles) {
        const content = engines.generateConfig(profile.id, fullProjectConfig);
        assert.ok(content !== null, `${profile.id}: generateConfig returned null`);
        assert.ok(
          content.includes('Shared Documents') || content.includes('Shared Docs Guide'),
          `${profile.id}: missing shared docs guide`
        );
      }
    });

    it('all generators should include session memory guide', () => {
      const profiles = store.engines.list().filter(p =>
        p.capabilities && p.capabilities.supportsConfigFile
      );

      for (const profile of profiles) {
        const content = engines.generateConfig(profile.id, fullProjectConfig);
        assert.ok(content !== null, `${profile.id}: generateConfig returned null`);
        assert.ok(
          content.includes('Session Memory') || content.includes('session memory'),
          `${profile.id}: missing session memory guide`
        );
      }
    });
  });

  describe('_generateGeminiMd', () => {
    it('should include GEMINI.md header', () => {
      const content = engines._generateGeminiMd({});
      assert.ok(content.includes('GEMINI.md'));
      assert.ok(content.includes('Generated by TangleClaw'));
    });

    it('should include all core rules by default', () => {
      const content = engines._generateGeminiMd({});
      assert.ok(content.includes('CHANGELOG'));
      assert.ok(content.includes('JSDoc'));
      assert.ok(content.includes('tests'));
      assert.ok(content.includes('session wrap'));
      assert.ok(content.includes('PortHub'));
    });




    it('should include active extension rules', () => {
      const config = {
        rules: {
          extensions: {
            identitySentry: true,
            docsParity: true,
            decisionFramework: false
          }
        }
      };
      const content = engines._generateGeminiMd(config);
      assert.ok(content.includes('Extension Rules'));
      assert.ok(content.includes('identity') || content.includes('sentry'));
      assert.ok(content.includes('docs'));
    });

    it('should include PortHub guide when porthubRegistration is active', () => {
      const config = {
        rules: { core: { porthubRegistration: true } }
      };
      const content = engines._generateGeminiMd(config);
      assert.ok(content.includes('Port Management'), 'Should include PortHub guide header');
      assert.ok(content.includes('TangleClaw API'), 'Should include API base URL');
    });

    it('should exclude PortHub guide when porthubRegistration is disabled', () => {
      const config = {
        rules: { core: { porthubRegistration: false } }
      };
      const content = engines._generateGeminiMd(config);
      assert.ok(!content.includes('Port Management'));
    });

    it('should generate via public API with antigravity engine id (shared generator)', () => {
      const content = engines.generateConfig('antigravity', {
        rules: { core: {}, extensions: {} }
      });
      assert.ok(content !== null, 'generateConfig("antigravity") must not return null');
      assert.ok(typeof content === 'string');
      assert.ok(content.includes('TangleClaw'), 'the generated block identifies itself');
    });

    it('should include global rules', () => {
      const content = engines._generateGeminiMd({});
      assert.ok(content.includes('Global Rules'), 'GEMINI.md should include global rules');
    });

    // The `.gemini/GEMINI.md` subdirectory-filename test retired with the
    // gemini profile (#457). No bundled engine writes into a subdirectory now;
    // writeEngineConfig's mkdir path still supports it for custom profiles.
  });

  describe('_generateClaudeMd', () => {
    it('should include all core rules by default', () => {
      const content = engines._generateClaudeMd({});
      assert.ok(content.includes('CHANGELOG'));
      assert.ok(content.includes('JSDoc'));
      assert.ok(content.includes('tests'));
      assert.ok(content.includes('session wrap'));
      assert.ok(content.includes('PortHub'));
    });

    it('should include global rules', () => {
      const content = engines._generateClaudeMd({});
      assert.ok(content.includes('Global Rules'), 'CLAUDE.md should include global rules');
    });




    it('should include active extension rules', () => {
      const config = {
        rules: {
          extensions: {
            identitySentry: true,
            docsParity: true,
            decisionFramework: false
          }
        }
      };
      const content = engines._generateClaudeMd(config);
      assert.ok(content.includes('Extension Rules'));
      assert.ok(content.includes('identity') || content.includes('sentry'));
      assert.ok(content.includes('docs'));
    });

    it('should include PortHub guide when porthubRegistration rule is active', () => {
      const config = {
        rules: {
          core: { porthubRegistration: true }
        }
      };
      const content = engines._generateClaudeMd(config);
      assert.ok(content.includes('Port Management'), 'Should include PortHub guide header');
      assert.ok(content.includes('Never hardcode ports'), 'Should include guide rules');
      assert.ok(content.includes('Port Ranges Convention'), 'Should include port ranges');
    });

    it('should exclude PortHub guide when porthubRegistration rule is disabled', () => {
      const config = {
        rules: {
          core: { porthubRegistration: false }
        }
      };
      const content = engines._generateClaudeMd(config);
      assert.ok(!content.includes('Port Management'), 'Should not include PortHub guide');
      assert.ok(!content.includes('Never hardcode ports'), 'Should not include guide rules');
    });
  });

  describe('writeEngineConfig (#240 drift detection)', () => {
    // Captures log.warn calls via the logger module's internal sink so
    // we can assert drift warnings fire without sprinkling spies.
    let writeDir;
    let claudeProfile;
    const minimalProjConfig = {
      rules: { core: { changelogPerChange: true, jsdocAllFunctions: true, unitTestRequirements: true, sessionWrapProtocol: true, porthubRegistration: true }, extensions: {} }
    };

    before(() => {
      writeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-write-engine-config-'));
      claudeProfile = store.engines.get('claude');
      assert.ok(claudeProfile && claudeProfile.configFormat, 'claude profile must have configFormat for these tests');
    });

    after(() => {
      fs.rmSync(writeDir, { recursive: true, force: true });
    });

    it('writes the file when it does not exist (no drift)', () => {
      const projectPath = fs.mkdtempSync(path.join(writeDir, 'fresh-'));
      const result = engines.writeEngineConfig('claude', projectPath, minimalProjConfig, claudeProfile);
      assert.equal(result.written, true);
      assert.equal(result.drifted, false, 'no drift when target file did not exist');
      assert.equal(result.error, null);
      assert.ok(fs.existsSync(result.configFilePath), 'file written at the helper-reported path');
      assert.ok(fs.readFileSync(result.configFilePath, 'utf8').includes('Generated by TangleClaw'));
    });

    it('writes the file when it exists and matches (no drift, idempotent)', () => {
      const projectPath = fs.mkdtempSync(path.join(writeDir, 'match-'));
      const first = engines.writeEngineConfig('claude', projectPath, minimalProjConfig, claudeProfile);
      assert.equal(first.drifted, false);
      const second = engines.writeEngineConfig('claude', projectPath, minimalProjConfig, claudeProfile);
      assert.equal(second.written, true);
      assert.equal(second.drifted, false, 'unchanged content must not register as drift');
    });

    it('detects drift when the existing on-disk file differs (the #240 surface)', () => {
      const projectPath = fs.mkdtempSync(path.join(writeDir, 'drift-'));
      // Seed the target file with content that would never match the
      // regenerated output — a hand-edit a contributor might have committed.
      const configFilePath = path.join(projectPath, claudeProfile.configFormat.filename);
      fs.writeFileSync(configFilePath, '# CLAUDE.md\n\n## Manually Added Rule\n\n- This was hand-edited\n');
      const result = engines.writeEngineConfig('claude', projectPath, minimalProjConfig, claudeProfile);
      assert.equal(result.written, true, 'still writes the regenerated content (warn is informational, not blocking)');
      assert.equal(result.drifted, true, 'drift must be reported');
      assert.equal(result.error, null);
      // Overwrite happened — the hand-edited content is gone (this IS
      // the silent-clobber failure mode; the warning is what's new).
      const after = fs.readFileSync(configFilePath, 'utf8');
      assert.ok(!after.includes('Manually Added Rule'), 'hand-edit was overwritten as expected');
      assert.ok(after.includes('Generated by TangleClaw'), 'replacement content is the regenerated CLAUDE.md');
    });

    it('treats trailing-whitespace-only differences as non-drift (tolerant comparator)', () => {
      const projectPath = fs.mkdtempSync(path.join(writeDir, 'whitespace-'));
      const first = engines.writeEngineConfig('claude', projectPath, minimalProjConfig, claudeProfile);
      // Append/prepend extra newlines to the existing file — semantically
      // identical, should not trigger a drift warning on next write.
      const configFilePath = first.configFilePath;
      const existing = fs.readFileSync(configFilePath, 'utf8');
      fs.writeFileSync(configFilePath, '\n\n' + existing + '\n\n\n');
      const result = engines.writeEngineConfig('claude', projectPath, minimalProjConfig, claudeProfile);
      assert.equal(result.drifted, false, 'pure whitespace differences must not register as drift');
    });

    it('returns skipped (not error) when engineProfile has no configFormat — openclaw / genesis path', () => {
      // Pre-Critic this returned an error string for what is intentional
      // behavior (engines without config files: openclaw, genesis). The
      // 4 call sites would surface that as "Failed to write engine
      // config" on every createProject / launchSession for such engines.
      // The helper now returns `{skipped: true, skipReason, error: null}`
      // and callers gate on `!skipped` before pushing errors.
      const projectPath = fs.mkdtempSync(path.join(writeDir, 'noformat-'));
      const fakeProfile = { id: 'phantom' };
      const result = engines.writeEngineConfig('claude', projectPath, minimalProjConfig, fakeProfile);
      assert.equal(result.written, false);
      assert.equal(result.skipped, true);
      assert.equal(result.error, null, 'skipped must NOT surface as an error');
      assert.match(result.skipReason, /configFormat/i);
    });

    it("returns skipped when configFormat exists but filename is null (real openclaw / genesis shape)", () => {
      // Pin: openclaw's actual shape is `configFormat: {filename: null, ...}`
      // — truthy as an object, but no usable filename. Earlier guard
      // `if (engineProfile.configFormat)` would pass and the helper
      // would emit an error. Fixed by checking `configFormat.filename`
      // directly.
      const projectPath = fs.mkdtempSync(path.join(writeDir, 'nullfilename-'));
      const openclawShape = { id: 'fake-openclaw', configFormat: { filename: null, syntax: null, generator: null } };
      const result = engines.writeEngineConfig('fake-openclaw', projectPath, minimalProjConfig, openclawShape);
      assert.equal(result.written, false);
      assert.equal(result.skipped, true);
      assert.equal(result.error, null);
    });

    it('returns skipped when generateConfig produces empty content (no error)', () => {
      // For engines with `supportsConfigFile: false` the generator
      // returns null/empty even though configFormat may exist. Helper
      // must treat this as a deliberate skip, not an error.
      const projectPath = fs.mkdtempSync(path.join(writeDir, 'emptygen-'));
      // Synthesize an engineId that has no registered generator —
      // generateConfig returns null. Profile-shape is borrowed from
      // claude so the configFormat.filename check passes first.
      const fakeProfile = { id: 'no-such-engine', configFormat: claudeProfile.configFormat };
      const result = engines.writeEngineConfig('no-such-engine', projectPath, minimalProjConfig, fakeProfile);
      assert.equal(result.written, false);
      assert.equal(result.skipped, true);
      assert.equal(result.error, null);
      assert.match(result.skipReason, /generateConfig|empty/i);
    });

    it('CRLF line endings in the on-disk file do NOT register as drift (#240 Critic n1)', () => {
      // Windows editors save with CRLF; the regenerator emits LF.
      // Without normalization, every session launch on a Windows-saved
      // file would emit a drift warning that doesn't represent a real
      // semantic change.
      const projectPath = fs.mkdtempSync(path.join(writeDir, 'crlf-'));
      const first = engines.writeEngineConfig('claude', projectPath, minimalProjConfig, claudeProfile);
      const configFilePath = first.configFilePath;
      // Convert the file's line endings to CRLF in-place, semantically
      // identical content.
      const lf = fs.readFileSync(configFilePath, 'utf8');
      fs.writeFileSync(configFilePath, lf.replace(/\n/g, '\r\n'));
      const second = engines.writeEngineConfig('claude', projectPath, minimalProjConfig, claudeProfile);
      assert.equal(second.drifted, false, 'CRLF-vs-LF must not register as drift');
    });
  });

  describe('Prawduct V2 plugin-governed deferral (#330)', () => {
    let govDir;
    let claudeProfile;
    const minimalProjConfig = {
      rules: { core: { changelogPerChange: true, jsdocAllFunctions: true, unitTestRequirements: true, sessionWrapProtocol: true, porthubRegistration: true }, extensions: {} }
    };

    before(() => {
      govDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-plugin-governed-'));
      claudeProfile = store.engines.get('claude');
    });

    after(() => {
      fs.rmSync(govDir, { recursive: true, force: true });
    });

    /**
     * Make a fresh project dir, optionally seeding .claude/settings.json and
     * .tangleclaw/project.json.
     * @param {object|null} settings - settings.json contents, or null to omit.
     * @param {object} [projConfig] - .tangleclaw/project.json contents (e.g. to
     *   pin engine + silentPrime so baseline-hook behavior is deterministic).
     * @returns {string} the project path
     */
    function mkProject(settings, projConfig) {
      const p = fs.mkdtempSync(path.join(govDir, 'proj-'));
      if (settings !== null) {
        fs.mkdirSync(path.join(p, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(p, '.claude', 'settings.json'), JSON.stringify(settings, null, 2) + '\n');
      }
      if (projConfig) {
        fs.mkdirSync(path.join(p, '.tangleclaw'), { recursive: true });
        fs.writeFileSync(path.join(p, '.tangleclaw', 'project.json'), JSON.stringify(projConfig, null, 2) + '\n');
      }
      return p;
    }

    describe('isPluginGoverned', () => {
      it('is true when enabledPlugins has a truthy prawduct@<marketplace> key', () => {
        const p = mkProject({ enabledPlugins: { 'prawduct@prawduct': true } });
        assert.equal(engines.isPluginGoverned(p), true);
      });

      it('is false when the prawduct plugin is present but disabled', () => {
        const p = mkProject({ enabledPlugins: { 'prawduct@prawduct': false } });
        assert.equal(engines.isPluginGoverned(p), false);
      });

      it('is false when there is no settings.json at all', () => {
        const p = mkProject(null);
        assert.equal(engines.isPluginGoverned(p), false);
      });

      it('is false when enabledPlugins is absent or unrelated', () => {
        assert.equal(engines.isPluginGoverned(mkProject({})), false);
        assert.equal(engines.isPluginGoverned(mkProject({ enabledPlugins: { 'swift-lsp@claude-plugins-official': true } })), false);
      });

      it('fails closed (false) on malformed JSON rather than throwing', () => {
        const p = fs.mkdtempSync(path.join(govDir, 'badjson-'));
        fs.mkdirSync(path.join(p, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(p, '.claude', 'settings.json'), '{ not valid json');
        assert.equal(engines.isPluginGoverned(p), false);
      });
    });

    describe('governanceState (#353)', () => {
      const claudeMeta = { engineId: 'claude' };

      /** Drop a vendored governance hook file into a project (Cohort A shape). */
      function addVendoredHook(p) {
        fs.mkdirSync(path.join(p, 'tools'), { recursive: true });
        fs.writeFileSync(path.join(p, 'tools', 'product-hook'), '#!/usr/bin/env python3\n');
      }

      it('is governed-plugin when the V2 plugin is enabled', () => {
        const p = mkProject({ enabledPlugins: { 'prawduct@prawduct': true } });
        assert.equal(engines.governanceState(p, claudeMeta), 'governed-plugin');
      });

      it('is governed-vendored when a vendored product-hook is present (no plugin)', () => {
        const p = mkProject({});
        addVendoredHook(p);
        assert.equal(engines.governanceState(p, claudeMeta), 'governed-vendored');
      });

      it('is ungoverned for a Claude project with neither plugin nor vendored hook', () => {
        const p = mkProject({});
        assert.equal(engines.governanceState(p, claudeMeta), 'ungoverned');
      });

      it('prefers plugin over vendored when both are present (no double-governance ambiguity)', () => {
        const p = mkProject({ enabledPlugins: { 'prawduct@prawduct': true } });
        addVendoredHook(p);
        assert.equal(engines.governanceState(p, claudeMeta), 'governed-plugin');
      });

      it('is not-applicable for a non-Claude engine regardless of files', () => {
        const p = mkProject({ enabledPlugins: { 'prawduct@prawduct': true } });
        addVendoredHook(p);
        assert.equal(engines.governanceState(p, { engineId: 'gemini' }), 'not-applicable');
      });

      it('is not-applicable when meta is missing the engine', () => {
        const p = mkProject({});
        assert.equal(engines.governanceState(p, {}), 'not-applicable');
        assert.equal(engines.governanceState(p), 'not-applicable');
      });

      it('fails closed to ungoverned on malformed settings (no throw)', () => {
        const p = fs.mkdtempSync(path.join(govDir, 'gov-badjson-'));
        fs.mkdirSync(path.join(p, '.claude'), { recursive: true });
        fs.writeFileSync(path.join(p, '.claude', 'settings.json'), '{ not valid json');
        // isPluginGoverned fails closed (false) + no vendored hook → ungoverned, not a throw.
        assert.equal(engines.governanceState(p, claudeMeta), 'ungoverned');
      });

      it('never reports an alarming state for an ordinary un-onboarded project (#538)', () => {
        // The vocabulary deliberately has no fault state: with the methodology
        // label gone there is nothing for the filesystem to contradict, so a
        // project that simply is not governed must read as neutral.
        const p = mkProject(null);
        const state = engines.governanceState(p, claudeMeta);
        assert.equal(state, 'ungoverned');
        assert.ok(!/drift/.test(state), 'ungoverned must not be reported as drift');
      });
    });

    describe('writeEngineConfig defers governance, splices the operational block (#1021)', () => {
      it('writes ONLY the operational block into a governed CLAUDE.md; the anchor content is byte-identical', () => {
        const p = mkProject({ enabledPlugins: { 'prawduct@prawduct': true } });
        const anchor = '# CLAUDE.md\n\n<!-- PRAWDUCT:ANCHOR -->\nGoverned by the Prawduct V2 plugin.\n';
        const claudeMd = path.join(p, claudeProfile.configFormat.filename);
        fs.writeFileSync(claudeMd, anchor);

        const result = engines.writeEngineConfig('claude', p, minimalProjConfig, claudeProfile);

        assert.equal(result.written, true, 'the governed write lands the operational block');
        assert.equal(result.error, null);
        const after = fs.readFileSync(claudeMd, 'utf8');
        // The plan's Done-when: governance content byte-identical before/after.
        // The merge trims the base's trailing whitespace before appending, so
        // the plugin's content is everything before the block separator.
        assert.equal(after.split('<!-- BEGIN:tangleclaw -->')[0], anchor.replace(/\s+$/, '') + '\n\n',
          'the plugin-owned anchor content outside the markers is byte-identical');
        assert.match(after, /<!-- END:tangleclaw -->/);
        assert.match(after, /TangleClaw API base URL/, 'the #1020 dangling pointer is fixed: the base URL is present');
        // Governance stays the plugin's: none of the rules tiers may ride this block.
        assert.doesNotMatch(after, /## Core Rules/, 'core rules are governance — not spliced');
        assert.doesNotMatch(after, /## Extension Rules/, 'extension rules are governance — not spliced');
      });

      it('a second governed write is idempotent — exactly one block, anchor still byte-identical', () => {
        const p = mkProject({ enabledPlugins: { 'prawduct@prawduct': true } });
        const anchor = '# CLAUDE.md\n\n<!-- PRAWDUCT:ANCHOR -->\nGoverned.\n';
        const claudeMd = path.join(p, claudeProfile.configFormat.filename);
        fs.writeFileSync(claudeMd, anchor);

        engines.writeEngineConfig('claude', p, minimalProjConfig, claudeProfile);
        const result2 = engines.writeEngineConfig('claude', p, minimalProjConfig, claudeProfile);

        assert.equal(result2.written, true);
        const after = fs.readFileSync(claudeMd, 'utf8');
        assert.equal(after.split('<!-- BEGIN:tangleclaw -->').length - 1, 1, 'exactly one begin marker');
        assert.equal(after.split('<!-- END:tangleclaw -->').length - 1, 1, 'exactly one end marker');
        assert.equal(after.split('<!-- BEGIN:tangleclaw -->')[0], anchor.replace(/\s+$/, '') + '\n\n');
      });

      it('the governed operational block carries the tc bootstrap line inside the markers (ambient-awareness Chunk 04)', () => {
        // A governed session reads only what is between the markers — a line
        // outside them, or absent, leaves the plugin-governed fleet (this repo
        // included) as unaware as the probe found Antigravity.
        const p = mkProject({ enabledPlugins: { 'prawduct@prawduct': true } });
        const anchor = '# CLAUDE.md\n\n<!-- PRAWDUCT:ANCHOR -->\nGoverned.\n';
        const claudeMd = path.join(p, claudeProfile.configFormat.filename);
        fs.writeFileSync(claudeMd, anchor);

        engines.writeEngineConfig('claude', p, minimalProjConfig, claudeProfile);
        const after = fs.readFileSync(claudeMd, 'utf8');
        const block = (after.split('<!-- BEGIN:tangleclaw -->')[1] || '').split('<!-- END:tangleclaw -->')[0];
        assert.match(block, /tc capabilities/,
          'the bootstrap line must land inside the managed region the governed session reads');
        assert.match(block, /fabricate/, 'with its stated consequence');
      });

      it('a governed project on a NON-claude-md carrier keeps the skip (bounded decision)', () => {
        // Writing e.g. .codex.yaml on a governed project would whole-file
        // overwrite a file TC has never owned there; the skip stays until that
        // is decided (plan: ambient-awareness Chunk 01b).
        const p = mkProject({ enabledPlugins: { 'prawduct@prawduct': true } });
        const codexProfile = store.engines.get('codex');
        const result = engines.writeEngineConfig('codex', p, minimalProjConfig, codexProfile);
        assert.equal(result.written, false);
        assert.equal(result.skipped, true);
        assert.match(result.skipReason, /governed by the Prawduct V2 plugin/);
        assert.equal(fs.existsSync(path.join(p, '.codex.yaml')), false, 'no file appears');
      });

      it('the governed block carries the Medusa switchboard section when the project opted in (#904 reach)', () => {
        // #904's fix added the switchboard to the generated template; the
        // wholesale skip meant that fix never reached a governed project —
        // including TangleClaw itself (#1020's dangling pointer). The
        // operational block is what closes that reach gap.
        const p = mkProject({ enabledPlugins: { 'prawduct@prawduct': true } });
        fs.writeFileSync(path.join(p, claudeProfile.configFormat.filename), '# CLAUDE.md\n<!-- PRAWDUCT:ANCHOR -->\n');
        const project = store.projects.create({ name: `governed-medusa-${Date.now()}`, path: p, engine: 'claude' });
        try {
          const result = engines.writeEngineConfig(
            'claude', p, { ...minimalProjConfig, medusaEnabled: true }, claudeProfile
          );
          assert.equal(result.written, true);
          const after = fs.readFileSync(result.configFilePath, 'utf8');
          assert.match(after, /## Medusa Switchboard/,
            'an opted-in governed project learns the switchboard exists');
          assert.match(after, /\/medusa\/send/, 'and where to send');
        } finally {
          store.projects.delete(project.id);
        }
      });

      it('the governed block NEVER inlines the live service token — pointer only (committed carrier)', () => {
        // A governed CLAUDE.md is a committed anchor file by construction; an
        // inline bearer token here would be committed to the repo — the exact
        // AGENTS.md hazard from the carrier chunk, decided the same way.
        const p = mkProject({ enabledPlugins: { 'prawduct@prawduct': true } });
        fs.writeFileSync(path.join(p, claudeProfile.configFormat.filename), '# CLAUDE.md\n<!-- PRAWDUCT:ANCHOR -->\n');
        const config = store.config.load();
        const prevEnabled = config.serviceTokenEnabled;
        const prevToken = config.serviceToken;
        config.serviceTokenEnabled = true;
        config.serviceToken = 'tc_live_secret_055577';
        store.config.save(config);
        try {
          const result = engines.writeEngineConfig('claude', p, minimalProjConfig, claudeProfile);
          assert.equal(result.written, true);
          const after = fs.readFileSync(result.configFilePath, 'utf8');
          assert.ok(!after.includes('tc_live_secret_055577'),
            'the live token must not appear in a committed governed carrier');
          assert.match(after, /service-token/, 'the block points at the fetch endpoint instead');
        } finally {
          const restore = store.config.load();
          restore.serviceTokenEnabled = prevEnabled;
          restore.serviceToken = prevToken;
          store.config.save(restore);
        }
      });

      it('still writes CLAUDE.md normally when NOT plugin-governed (regression)', () => {
        const p = mkProject(null);
        const result = engines.writeEngineConfig('claude', p, minimalProjConfig, claudeProfile);
        assert.equal(result.written, true);
        assert.ok(fs.readFileSync(result.configFilePath, 'utf8').includes('Generated by TangleClaw'));
      });
    });

    // A hook as TangleClaw actually emits it. Fixtures that used `echo stale` or a
    // bare `Old` event were standing in for "TangleClaw's own entry" with something
    // indistinguishable from an operator's hook — so once hooks are MERGED rather
    // than replaced (#752) they no longer discriminate anything. Ownership is the
    // whole question now, so the fixture has to carry it.
    const tcOwnedHook = (script = 'sessionstart-prime-claude.sh') => ({
      matcher: 'startup',
      hooks: [{ type: 'command', command: `"/Users/x/TangleClaw/data/hooks/${script}"` }]
    });

    describe('syncEngineHooks defers GOVERNANCE but keeps TC L1 prime (#330)', () => {
      const staleGovHook = { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" stop' }] }] };

      it('silentPrime OFF: drops the governance hook entirely, preserves the install reference', () => {
        const p = mkProject({
          extraKnownMarketplaces: { prawduct: { source: { source: 'github', repo: 'brookstalley/prawduct' }, autoUpdate: false } },
          enabledPlugins: { 'prawduct@prawduct': true },
          hooks: staleGovHook
        }, { engine: 'claude', methodology: 'prawduct', silentPrime: false });

        engines.syncEngineHooks(p);

        const settings = JSON.parse(fs.readFileSync(path.join(p, '.claude', 'settings.json'), 'utf8'));
        assert.equal(settings.hooks, undefined, 'no governance hook and no L1 prime → hooks block removed');
        assert.equal(settings.enabledPlugins['prawduct@prawduct'], true, 'the plugin enablement must be preserved');
        assert.ok(settings.extraKnownMarketplaces && settings.extraKnownMarketplaces.prawduct, 'the marketplace reference must be preserved');
      });

      it('silentPrime ON: keeps TC\'s L1 prime hook but drops the governance Stop hook', () => {
        const p = mkProject({
          enabledPlugins: { 'prawduct@prawduct': true },
          hooks: staleGovHook
        }, { engine: 'claude', methodology: 'prawduct', silentPrime: true });

        engines.syncEngineHooks(p);

        const settings = JSON.parse(fs.readFileSync(path.join(p, '.claude', 'settings.json'), 'utf8'));
        assert.ok(settings.hooks, 'the L1 prime hook block must remain');
        assert.ok(settings.hooks.SessionStart, 'TC L1 silent-prime SessionStart hook must survive on a governed project');
        assert.equal(settings.hooks.Stop, undefined, 'the governance Stop hook must be dropped (delegated to the plugin)');
        // No surviving hook may reference the vendored governance script.
        const allCommands = JSON.stringify(settings.hooks);
        assert.ok(!allCommands.includes('product-hook'), 'no surviving hook may reference the removed vendored governance script');
        assert.equal(settings.enabledPlugins['prawduct@prawduct'], true, 'the plugin enablement must be preserved');
      });

      it('does not inject methodology/governance hooks for a governed project (no stale block)', () => {
        const p = mkProject({ enabledPlugins: { 'prawduct@prawduct': true } }, { engine: 'claude', methodology: 'prawduct', silentPrime: false });
        engines.syncEngineHooks(p);
        const settings = JSON.parse(fs.readFileSync(path.join(p, '.claude', 'settings.json'), 'utf8'));
        assert.equal(settings.hooks, undefined, 'governed + no L1 → no hooks block');
        assert.equal(settings.enabledPlugins['prawduct@prawduct'], true);
      });

      it('drops a pre-existing governance Stop hook whatever the governance state (#538)', () => {
        // TC emits only its own L1 baseline now — it has no governance hooks of
        // its own to suppress. So the contract is unconditional: a Stop hook
        // left behind by a pre-V2 install is cleared on the next sync whether or
        // not the plugin is enabled. Ungoverned is the case that would regress
        // silently if this became conditional again, since that project has no
        // plugin to own the gate in TC's place.
        // NARROWED by #752, deliberately: the rule is no longer "drop any Stop hook"
        // but "drop the retired VENDORED gate", identified by the `tools/product-hook`
        // script the V1 methodology layer emitted — the same marker `governanceState`
        // uses for `governed-vendored`. The unconditional version could not tell that
        // gate from a Stop hook the operator wrote in the committable settings file,
        // and destroyed both on every session launch.
        const legacy = {
          Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'python3 "$CLAUDE_PROJECT_DIR/tools/product-hook" stop' }] }]
        };

        for (const [label, settings] of [
          ['ungoverned', {}],
          ['governed', { enabledPlugins: { 'prawduct@prawduct': true } }]
        ]) {
          const p = mkProject({ ...settings, hooks: legacy }, { engine: 'claude', silentPrime: false });
          engines.syncEngineHooks(p);
          const written = JSON.parse(fs.readFileSync(path.join(p, '.claude', 'settings.json'), 'utf8'));
          assert.equal(written.hooks, undefined, `${label}: the legacy governance Stop hook must be cleared`);
        }
      });

      it('does NOT clear a Stop hook the operator wrote (#752)', () => {
        // The other half of the narrowing above, and the reason for it. A Stop hook
        // that is not the retired vendored gate belongs to whoever put it in the
        // committable settings file, and this function runs on every session launch.
        const own = { Stop: [{ matcher: '', hooks: [{ type: 'command', command: 'make verify' }] }] };
        const p = mkProject({ hooks: own }, { engine: 'claude', silentPrime: false });
        engines.syncEngineHooks(p);
        const written = JSON.parse(fs.readFileSync(path.join(p, '.claude', 'settings.json'), 'utf8'));
        assert.deepEqual(written.hooks.Stop, own.Stop, 'an operator Stop hook was destroyed');
      });
    });

    describe('syncEngineHooks retires PRE-RENAME SessionStart entries (#1007)', () => {
      // Train 5 (#982) renamed the SessionStart scripts per engine. Ownership is
      // decided by basename, so every entry written before that rename stopped
      // matching and `_mergeBaselineHooks` filed TangleClaw's own hooks as foreign
      // — preserving a path that no longer exists, on every regen, forever. 25 dead
      // entries across 24 projects, each one a hook error at every session start.
      const staleEntry = (script, installPath = '/Users/x/TangleClaw') => ({
        matcher: 'startup',
        hooks: [{ type: 'command', command: `"${installPath}/data/hooks/${script}"` }]
      });

      it('removes the pre-rename prime and rules entries instead of preserving them', () => {
        const p = mkProject(
          { hooks: { SessionStart: [staleEntry('sessionstart-prime.sh'), staleEntry('sessionstart-rules.sh')] } },
          { engine: 'claude', silentPrime: false }
        );

        engines.syncEngineHooks(p);

        const written = JSON.parse(fs.readFileSync(path.join(p, '.claude', 'settings.json'), 'utf8'));
        assert.equal(written.hooks, undefined,
          'the pre-rename entries must be retired, not preserved as foreign operator hooks');
      });

      it('retires a pre-rename entry naming a PRE-MOVE install path', () => {
        // The older orphans (`TangleClaw-v3/...`) are unrecognised twice over: wrong
        // basename AND wrong install path. Ownership is by basename precisely so the
        // path cannot matter, so retiring these needs no separate rule — but it does
        // need a guard, because it is the case a path-scoped fix would silently miss.
        const p = mkProject(
          { hooks: { SessionStart: [staleEntry('sessionstart-prime.sh', '/Users/x/TangleClaw-v3')] } },
          { engine: 'claude', silentPrime: false }
        );

        engines.syncEngineHooks(p);

        const written = JSON.parse(fs.readFileSync(path.join(p, '.claude', 'settings.json'), 'utf8'));
        assert.equal(written.hooks, undefined, 'a pre-move orphan must be retired regardless of its install path');
      });

      it('replaces rather than accumulates: a stale entry beside a live one leaves only the live one', () => {
        // The exact on-disk shape this bug produced — four SessionStart entries where
        // two name deleted scripts. Reproduced here so a regression is caught as the
        // duplication it is, not just as a leftover.
        const p = mkProject(
          { hooks: { SessionStart: [staleEntry('sessionstart-prime.sh'), tcOwnedHook()] } },
          { engine: 'claude', silentPrime: true }
        );

        engines.syncEngineHooks(p);

        const written = JSON.parse(fs.readFileSync(path.join(p, '.claude', 'settings.json'), 'utf8'));
        const commands = written.hooks.SessionStart.flatMap((e) => e.hooks.map((h) => h.command));
        assert.ok(!commands.some((c) => /data\/hooks\/sessionstart-(prime|rules)\.sh"/.test(c)),
          `a pre-rename entry survived beside the live one: ${JSON.stringify(commands)}`);
        assert.ok(commands.some((c) => c.includes('sessionstart-prime-claude.sh')),
          'the current prime entry must still be emitted');
      });

      it('no retirement marker matches a script TangleClaw currently emits', () => {
        // The markers are matched as substrings, so an unscoped `sessionstart-prime.sh`
        // is the obvious shape of this fix and is wrong in the worst way — it would
        // retire the very hook the fix exists to keep. Read off the two REAL lists so
        // widening a marker, or adding an emitted script a marker happens to cover,
        // goes red here rather than in a silent session-start regression.
        for (const marker of engines._TC_LEGACY_HOOK_MARKERS) {
          for (const script of engines._TC_HOOK_SCRIPTS) {
            assert.ok(!`data/hooks/${script}`.includes(marker),
              `retirement marker "${marker}" matches currently-emitted "${script}" — `
              + 'syncing a project would delete its live hook');
          }
        }
      });

      it('every retired basename stays retired — a rename must not drop its predecessor', () => {
        // The class, not the instance. This bug was one line of omission: a rename
        // that updated the emitted names and forgot the retirement list. Nothing
        // structurally prevents the next rename from repeating it, so the names TC
        // has ever emitted are pinned here.
        const retired = ['data/hooks/sessionstart-prime.sh', 'data/hooks/sessionstart-rules.sh'];
        for (const marker of retired) {
          assert.ok(engines._TC_LEGACY_HOOK_MARKERS.includes(marker),
            `${marker} was emitted by a past TangleClaw and must stay in the retirement list `
            + 'or every settings.json written before the rename keeps a dead hook');
        }
      });
    });

    describe('syncEngineHooks resolves the engine from the DB, projConfig only as fallback', () => {
      it('registered non-claude project with no projConfig engine key takes the cleanup branch', () => {
        // Sibling of the boot-sync engine fix: a registered codex project whose
        // legacy project.json lacks the `engine` key must NOT resolve as claude
        // here — that wrote baseline hooks into .claude/settings.json for a
        // project whose runtime never reads them, and skipped the stale-hooks
        // cleanup the non-claude branch exists for.
        // silentPrime true is the discriminator: resolved-as-claude writes the
        // L1 SessionStart baseline hook; resolved-as-codex takes the cleanup
        // branch and removes the hooks block entirely.
        const p = mkProject(
          { hooks: { SessionStart: [tcOwnedHook()] } },
          { methodology: 'minimal', silentPrime: true } // no engine key
        );
        store.projects.create({ name: `db-hooks-${path.basename(p)}`, path: p, engine: 'codex' });

        engines.syncEngineHooks(p);

        const settings = JSON.parse(fs.readFileSync(path.join(p, '.claude', 'settings.json'), 'utf8'));
        assert.equal(settings.hooks, undefined,
          'DB says codex → stale hooks cleared, no baseline hooks written');
      });

      it('unregistered path still falls back to projConfig.engine', () => {
        const p = mkProject(
          { hooks: { SessionStart: [tcOwnedHook()] } },
          { engine: 'codex', methodology: 'minimal', silentPrime: false }
        );
        engines.syncEngineHooks(p);
        const settings = JSON.parse(fs.readFileSync(path.join(p, '.claude', 'settings.json'), 'utf8'));
        assert.equal(settings.hooks, undefined,
          'projConfig engine=codex honored for a path the DB does not know');
      });
    });
  });

  describe('validateParity', () => {
    it('should return valid when all engines pass parity checks', () => {
      const result = engines.validateParity();
      assert.equal(result.valid, true, `Parity failed: ${JSON.stringify(result.engines.filter(e => !e.valid))}`);
      assert.ok(result.engines.length >= 4, `Expected at least 4 config-supporting engines, got ${result.engines.length}`);
    });

    it('should return per-engine results with id and valid flag', () => {
      const result = engines.validateParity();
      for (const engine of result.engines) {
        assert.ok(typeof engine.id === 'string');
        assert.ok(typeof engine.valid === 'boolean');
        assert.ok(Array.isArray(engine.errors));
      }
    });

    it('should include all config-supporting engines', () => {
      const result = engines.validateParity();
      const ids = result.engines.map(e => e.id);
      assert.ok(ids.includes('claude'), 'Missing claude');
      assert.ok(ids.includes('codex'), 'Missing codex');
      assert.ok(ids.includes('aider'), 'Missing aider');
      assert.ok(ids.includes('antigravity'), 'Missing antigravity');
      assert.ok(!ids.includes('gemini'), 'gemini retired (#457) — must not resurface');
    });

    it('should report no errors for any engine', () => {
      const result = engines.validateParity();
      for (const engine of result.engines) {
        assert.deepEqual(engine.errors, [], `${engine.id} has parity errors: ${engine.errors.join(', ')}`);
      }
    });
  });

  describe('validateStatusParity', () => {
    it('should return valid when all engines have statusPage field', () => {
      const result = engines.validateStatusParity();
      assert.equal(result.valid, true, `Status parity failed: ${JSON.stringify(result.engines.filter(e => !e.valid))}`);
    });

    it('should include all engines (not just config-supporting)', () => {
      const result = engines.validateStatusParity();
      const ids = result.engines.map(e => e.id);
      assert.ok(ids.includes('claude'), 'Missing claude');
      assert.ok(ids.includes('codex'), 'Missing codex');
      assert.ok(ids.includes('aider'), 'Missing aider');
      assert.ok(ids.includes('antigravity'), 'Missing antigravity');
      assert.ok(!ids.includes('gemini'), 'gemini retired (#457) — must not resurface');
      assert.ok(!ids.includes('genesis'), 'genesis retired (#458) — must not resurface');
    });

    it('known providers should have adapter and url', () => {
      const result = engines.validateStatusParity();
      const knownProviders = ['claude', 'codex', 'antigravity'];
      for (const id of knownProviders) {
        const engine = result.engines.find(e => e.id === id);
        assert.ok(engine, `${id} not found in parity results`);
        assert.equal(engine.valid, true, `${id} status parity failed: ${engine.errors.join(', ')}`);
      }
    });

    it('engines without status pages should have null statusPage', () => {
      const result = engines.validateStatusParity();
      const noStatus = ['aider'];
      for (const id of noStatus) {
        const engine = result.engines.find(e => e.id === id);
        assert.ok(engine, `${id} not found`);
        assert.equal(engine.valid, true, `${id} should be valid with null statusPage`);
      }
    });
  });

  describe('cross-feature integration', () => {
    it('Gemini config contains all required sections', () => {
      const projectConfig = {
        rules: {
          core: {
            changelogPerChange: true,
            jsdocAllFunctions: true,
            unitTestRequirements: true,
            sessionWrapProtocol: true,
            porthubRegistration: true
          },
          extensions: { docsParity: true, independentCritic: true }
        }
      };
      const content = engines.generateConfig('antigravity', projectConfig);
      assert.ok(content !== null, 'Antigravity config should not be null');
      assert.ok(content.startsWith('## TangleClaw'), 'Should open with the managed-block heading');
      assert.ok(content.includes('Core Rules'), 'Should have core rules section');
      assert.ok(content.includes('Extension Rules'), 'Should have extension rules section');
      assert.ok(content.includes('docs'), 'Should include docsParity extension');
      assert.ok(content.includes('Critic') || content.includes('critic'), 'Should include independentCritic extension');
      assert.ok(content.includes('Port Management'), 'Should include PortHub guide');
      assert.ok(content.includes('TangleClaw API'), 'Should include API base URL');
      assert.ok(content.includes('Global Rules'), 'Should include global rules');
    });

    it('global rules changes are reflected in regenerated config', () => {
      // Save current global rules
      const original = store.globalRules.load();

      try {
        // Write custom global rules
        store.globalRules.save('## Global Rules\n\n- Custom integration test rule alpha\n- Custom rule beta\n');

        // Generate config — should include the new rules
        const content = engines.generateConfig('claude', { rules: { core: {} } });
        assert.ok(content.includes('Custom integration test rule alpha'),
          'Regenerated config should include updated global rules');
        assert.ok(content.includes('Custom rule beta'),
          'Regenerated config should include all updated global rules');

        // Also verify Antigravity picks them up
        const agyContent = engines.generateConfig('antigravity', { rules: { core: {} } });
        assert.ok(agyContent.includes('Custom integration test rule alpha'),
          'Antigravity config should also reflect updated global rules');
      } finally {
        // Restore original global rules
        store.globalRules.save(original);
      }
    });

    it('port scanner conflict detection works with checkPort', () => {
      // Run a scan to populate cache
      portScanner.scan();

      // A port that's unlikely to be in use should be available
      const freeResult = porthub.checkPort(59999);
      assert.equal(freeResult.systemDetected, false, 'Port 59999 should not be system-detected');

      // If any ports were detected by the scanner, verify checkPort reflects it
      const systemPorts = portScanner.getSystemPorts();
      if (systemPorts.length > 0) {
        // Find a system port that is NOT in our lease DB
        const unleased = systemPorts.find(sp => {
          const leaseCheck = store.portLeases.checkConflict(sp.port);
          return !leaseCheck;
        });
        if (unleased) {
          const result = porthub.checkPort(unleased.port);
          assert.equal(result.available, false, `Port ${unleased.port} should be unavailable (in use by ${unleased.command})`);
          assert.equal(result.systemDetected, true, `Port ${unleased.port} should be flagged as system-detected`);
          assert.ok(result.process, 'Should include process name');
        }
      }
    });

    it('all engines produce parity-equivalent output for same input', () => {
      const projectConfig = {
        rules: {
          core: {
            changelogPerChange: true,
            porthubRegistration: true
          },
          extensions: { identitySentry: true }
        }
      };
      const profiles = store.engines.list().filter(p =>
        p.capabilities && p.capabilities.supportsConfigFile
      );

      const configs = {};
      for (const profile of profiles) {
        configs[profile.id] = engines.generateConfig(profile.id, projectConfig);
        assert.ok(configs[profile.id] !== null, `${profile.id} returned null`);
      }

      // All configs should mention CHANGELOG, PortHub, TestMethod, and identity/sentry
      for (const [id, content] of Object.entries(configs)) {
        assert.ok(content.includes('CHANGELOG') || content.includes('changelog'), `${id}: missing CHANGELOG`);
        assert.ok(content.includes('PortHub') || content.includes('Port Management') || content.includes('TangleClaw API'), `${id}: missing PortHub`);
        assert.ok(content.includes('identity') || content.includes('sentry') || content.includes('Identity'), `${id}: missing identitySentry`);
      }
    });
  });

  describe('shared docs injection', () => {
    let groupId;
    let projectId;
    let sharedDocFile;

    before(() => {
      // Create a temp file for inline injection
      sharedDocFile = path.join(tempDir, 'shared-api-spec.md');
      fs.writeFileSync(sharedDocFile, '# API Spec\n\nGET /api/health → 200\nPOST /api/data → 201\n');

      // Create a project
      const projPath = path.join(tempDir, 'test-shared-proj');
      fs.mkdirSync(projPath, { recursive: true });
      const project = store.projects.create({
        name: 'test-shared-proj',
        path: projPath,
        engineId: 'claude'
      });
      projectId = project.id;

      // Create a group and add the project
      const group = store.projectGroups.create({ name: 'SharedDocsTestGroup' });
      groupId = group.id;
      store.projectGroups.addMember(groupId, projectId);
    });

    it('should include reference mode shared docs in generated config', () => {
      const doc = store.sharedDocs.create({
        groupId,
        name: 'API Reference',
        filePath: '/docs/api-ref.md',
        injectIntoConfig: true,
        injectMode: 'reference',
        description: 'REST API reference'
      });

      const content = engines._generateClaudeMd({ id: projectId, rules: { core: {} } }, null);
      assert.ok(content.includes('Shared Documents'), 'Should include Shared Documents section');
      assert.ok(content.includes('API Reference'), 'Should include doc name');
      assert.ok(content.includes('/docs/api-ref.md'), 'Should include file path');
      assert.ok(content.includes('REST API reference'), 'Should include description');

      // Clean up
      store.sharedDocs.delete(doc.id);
    });

    it('should include inline mode shared docs with file content', () => {
      const doc = store.sharedDocs.create({
        groupId,
        name: 'Inline API Spec',
        filePath: sharedDocFile,
        injectIntoConfig: true,
        injectMode: 'inline',
        description: 'Full API specification'
      });

      const content = engines._generateClaudeMd({ id: projectId, rules: { core: {} } }, null);
      assert.ok(content.includes('Inline API Spec'), 'Should include doc name');
      assert.ok(content.includes('GET /api/health'), 'Should include inlined file content');
      assert.ok(content.includes('POST /api/data'), 'Should include all file content');

      store.sharedDocs.delete(doc.id);
    });

    it('should warn about missing files in reference mode', () => {
      const doc = store.sharedDocs.create({
        groupId,
        name: 'Missing Doc',
        filePath: '/nonexistent/path/doc.md',
        injectIntoConfig: true,
        injectMode: 'reference'
      });

      const content = engines._generateClaudeMd({ id: projectId, rules: { core: {} } }, null);
      assert.ok(content.includes('file not found'), 'Should warn about missing file');

      store.sharedDocs.delete(doc.id);
    });

    it('should warn about missing files in inline mode', () => {
      const doc = store.sharedDocs.create({
        groupId,
        name: 'Missing Inline',
        filePath: '/nonexistent/inline.md',
        injectIntoConfig: true,
        injectMode: 'inline'
      });

      const content = engines._generateClaudeMd({ id: projectId, rules: { core: {} } }, null);
      assert.ok(content.includes('File not found'), 'Should warn about missing inline file');

      store.sharedDocs.delete(doc.id);
    });

    it('should include lock warnings for locked documents', () => {
      const doc = store.sharedDocs.create({
        groupId,
        name: 'Locked Doc',
        filePath: '/docs/locked.md',
        injectIntoConfig: true,
        injectMode: 'reference'
      });

      // Acquire a lock
      store.documentLocks.acquire(doc.id, 999, 'other-project');

      const content = engines._generateClaudeMd({ id: projectId, rules: { core: {} } }, null);
      assert.ok(content.includes('LOCKED'), 'Should show lock warning');
      assert.ok(content.includes('other-project'), 'Should show who locked it');

      // Clean up
      store.documentLocks.release(doc.id);
      store.sharedDocs.delete(doc.id);
    });

    it('should not include docs when inject_into_config is false', () => {
      const doc = store.sharedDocs.create({
        groupId,
        name: 'Non-Injectable',
        filePath: '/docs/private.md',
        injectIntoConfig: false,
        injectMode: 'reference'
      });

      const content = engines._generateClaudeMd({ id: projectId, rules: { core: {} } }, null);
      assert.ok(!content.includes('Non-Injectable'), 'Should not include non-injectable docs');

      store.sharedDocs.delete(doc.id);
    });

    it('should inject shared docs into all 4 engine generators', () => {
      const doc = store.sharedDocs.create({
        groupId,
        name: 'Parity Doc',
        filePath: '/docs/parity.md',
        injectIntoConfig: true,
        injectMode: 'reference',
        description: 'Parity test doc'
      });

      const projectConfig = { id: projectId, rules: { core: {} } };

      const claude = engines._generateClaudeMd(projectConfig);
      assert.ok(claude.includes('Parity Doc'), 'Claude should include shared doc');

      const gemini = engines._generateGeminiMd(projectConfig);
      assert.ok(gemini.includes('Parity Doc'), 'Gemini should include shared doc');

      const codex = engines._generateCodexYaml(projectConfig);
      assert.ok(codex.includes('Parity Doc'), 'Codex should include shared doc');

      const aider = engines._generateAiderConf(projectConfig);
      assert.ok(aider.includes('Parity Doc'), 'Aider should include shared doc');

      store.sharedDocs.delete(doc.id);
    });

    it('should deduplicate shared docs across multiple groups', () => {
      // Create second group with same project
      const group2 = store.projectGroups.create({ name: 'SecondGroup' });
      store.projectGroups.addMember(group2.id, projectId);

      // Add same file path to both groups
      const doc1 = store.sharedDocs.create({
        groupId,
        name: 'Shared File',
        filePath: '/docs/shared.md',
        injectIntoConfig: true,
        injectMode: 'reference'
      });
      const doc2 = store.sharedDocs.create({
        groupId: group2.id,
        name: 'Shared File Copy',
        filePath: '/docs/shared.md',
        injectIntoConfig: true,
        injectMode: 'reference'
      });

      const content = engines._generateClaudeMd({ id: projectId, rules: { core: {} } }, null);
      // Should only appear once (deduplicated by file path)
      const occurrences = content.split('/docs/shared.md').length - 1;
      assert.equal(occurrences, 1, 'Should deduplicate shared docs by file path');

      // Clean up
      store.sharedDocs.delete(doc1.id);
      store.sharedDocs.delete(doc2.id);
      store.projectGroups.delete(group2.id);
    });
  });

  describe('syncEngineHooks', () => {
    let projectDir;

    // Each test gets a fresh project dir: with baseline-hook writing in play
    // (#103), shared dir state would let a leftover .tangleclaw/project.json
    // silently change what gets written.
    beforeEach(() => {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-hooks-test-'));
      const tcDir = path.join(projectDir, '.tangleclaw');
      fs.mkdirSync(tcDir, { recursive: true });
      fs.writeFileSync(path.join(tcDir, 'project.json'), JSON.stringify({
        engine: 'claude',
        silentPrime: true
      }));
    });

    afterEach(() => {
      fs.rmSync(projectDir, { recursive: true, force: true });
    });

    /**
     * Helper to read .claude/settings.json from the test project dir.
     * @returns {object}
     */
    function readSettings() {
      return JSON.parse(fs.readFileSync(path.join(projectDir, '.claude', 'settings.json'), 'utf8'));
    }

    it('writes the baseline SessionStart hook when silentPrime is on', () => {
      engines.syncEngineHooks(projectDir);

      const settings = readSettings();
      assert.ok(settings.hooks, 'hooks key should exist');
      assert.ok(settings.hooks.SessionStart, 'SessionStart hooks should exist');
      assert.equal(settings.hooks.SessionStart.length, 1);
    });

    it('resolves the {{TANGLECLAW_DIR}} placeholder in the hooks it writes', () => {
      engines.syncEngineHooks(projectDir);

      const cmd = readSettings().hooks.SessionStart[0].hooks[0].command;
      assert.ok(!cmd.includes('{{TANGLECLAW_DIR}}'), 'placeholder should be resolved');
      assert.ok(path.isAbsolute(cmd.split(' ')[0].replace(/^"/, '')) || cmd.includes('/'),
        'resolved command should carry a real path');
    });

    it('preserves existing non-hook settings AND foreign hooks, reconciling only its own', () => {
      // Was "replaces the hooks block wholesale". That is the #752 defect stated as a
      // contract: `.claude/settings.json` is the committable, shareable hooks location,
      // and a wholesale replacement discarded whatever the operator put there on every
      // session launch. TangleClaw reconciles only the entries it emits.
      const claudeDir = path.join(projectDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      const operatorHook = { matcher: 'Bash', hooks: [{ type: 'command', command: 'npm run lint' }] };
      fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
        permissions: { allow: ['Bash(git status:*)'] },
        companyAnnouncements: ['Test announcement'],
        hooks: { PreToolUse: [operatorHook] }
      }, null, 2));

      engines.syncEngineHooks(projectDir);

      const settings = readSettings();
      assert.deepStrictEqual(settings.permissions, { allow: ['Bash(git status:*)'] });
      assert.deepStrictEqual(settings.companyAnnouncements, ['Test announcement']);
      assert.deepStrictEqual(settings.hooks.PreToolUse, [operatorHook],
        'a foreign hook event must survive TangleClaw\'s sync');
      assert.ok(settings.hooks.SessionStart, 'new hooks should be present');
    });

    it('removes the hooks block when nothing of its own is left to hold', () => {
      // The fixture has to be a hook TangleClaw OWNS. It used to be a bare `Stop`
      // entry, which under merge semantics (#752) is a hook belonging to whoever put
      // it in the committable settings file — preserved, so the key correctly stays.
      const claudeDir = path.join(projectDir, '.claude');
      fs.mkdirSync(claudeDir, { recursive: true });
      fs.writeFileSync(path.join(claudeDir, 'settings.json'), JSON.stringify({
        permissions: { allow: [] },
        hooks: { SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: '"/Users/x/TangleClaw/data/hooks/sessionstart-prime-claude.sh"' }] }] }
      }, null, 2));
      fs.writeFileSync(path.join(projectDir, '.tangleclaw', 'project.json'), JSON.stringify({
        engine: 'claude',
        silentPrime: false
      }));

      engines.syncEngineHooks(projectDir);

      const settings = readSettings();
      assert.ok(!settings.hooks, 'hooks key should be removed');
      assert.ok(settings.permissions, 'permissions should be preserved');
    });

    it('should create .claude directory if missing', () => {
      const freshDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-hooks-fresh-'));
      try {
        fs.mkdirSync(path.join(freshDir, '.tangleclaw'), { recursive: true });
        fs.writeFileSync(path.join(freshDir, '.tangleclaw', 'project.json'), JSON.stringify({
          engine: 'claude',
          silentPrime: true
        }));

        engines.syncEngineHooks(freshDir);

        assert.ok(fs.existsSync(path.join(freshDir, '.claude', 'settings.json')));
        const settings = JSON.parse(fs.readFileSync(path.join(freshDir, '.claude', 'settings.json'), 'utf8'));
        assert.ok(settings.hooks.SessionStart);
      } finally {
        fs.rmSync(freshDir, { recursive: true, force: true });
      }
    });
  });

  describe('_buildBaselineHooks (#103)', () => {
    const supportingProfile = { capabilities: { supportsSilentPrime: true } };

    it('returns empty object when silentPrime is false', () => {
      const result = engines._buildBaselineHooks({ silentPrime: false }, supportingProfile);
      assert.deepStrictEqual(result, {});
    });

    it('returns empty object when silentPrime is missing (default off)', () => {
      const result = engines._buildBaselineHooks({}, supportingProfile);
      assert.deepStrictEqual(result, {});
    });

    it('returns empty object when projConfig is null', () => {
      const result = engines._buildBaselineHooks(null, supportingProfile);
      assert.deepStrictEqual(result, {});
    });

    it('returns SessionStart entry when silentPrime is true and engine supports it', () => {
      const result = engines._buildBaselineHooks({ silentPrime: true }, supportingProfile);
      assert.ok(result.SessionStart, 'SessionStart should be present');
      assert.equal(result.SessionStart.length, 1);
      assert.equal(result.SessionStart[0].matcher, 'startup');
    });

    it('registers one rules hook per shard, beside the prime hook (#749)', () => {
      const result = engines._buildBaselineHooks({ silentPrime: true }, supportingProfile, 3);
      assert.equal(result.SessionStart.length, 4, 'one prime entry plus one per shard');
      const commands = result.SessionStart.map((e) => e.hooks[0].command);
      assert.match(commands[0], /"[^"]*\/data\/hooks\/sessionstart-prime-claude\.sh"$/);
      // Each shard gets its OWN entry: the engine caps each hook's output
      // separately, so one hook emitting every shard would be capped as one.
      assert.match(commands[1], /sessionstart-rules-claude\.sh" 1$/);
      assert.match(commands[2], /sessionstart-rules-claude\.sh" 2$/);
      assert.match(commands[3], /sessionstart-rules-claude\.sh" 3$/);
    });

    it('registers no rules hook when the project has no rules', () => {
      const result = engines._buildBaselineHooks({ silentPrime: true }, supportingProfile, 0);
      assert.equal(result.SessionStart.length, 1, 'only the prime hook');
      assert.match(result.SessionStart[0].hooks[0].command, /"[^"]*\/data\/hooks\/sessionstart-prime-claude\.sh"$/);
    });

    it('registers no rules hook for an engine that cannot take a silent prime', () => {
      // The rules channel IS a startup hook, so an engine without that channel
      // must get no entry — the rules ride the prime inline for those engines.
      const result = engines._buildBaselineHooks(
        { silentPrime: true }, { capabilities: { supportsSilentPrime: false } }, 2);
      assert.deepStrictEqual(result, {});
    });

    it('returns empty object when silentPrime is true but engine lacks supportsSilentPrime (Critic M1)', () => {
      const profileWithout = { capabilities: { supportsSilentPrime: false } };
      const result = engines._buildBaselineHooks({ silentPrime: true }, profileWithout);
      assert.deepStrictEqual(result, {}, 'baseline must gate on engine capability, not just projConfig');
    });

    it('returns empty object when engineProfile is omitted entirely (Critic M1)', () => {
      const result = engines._buildBaselineHooks({ silentPrime: true });
      assert.deepStrictEqual(result, {}, 'absent engine profile cannot satisfy the capability gate');
    });

    it('SessionStart entry references {{TANGLECLAW_DIR}} placeholder', () => {
      const result = engines._buildBaselineHooks({ silentPrime: true }, supportingProfile);
      const cmd = result.SessionStart[0].hooks[0].command;
      assert.ok(cmd.includes('{{TANGLECLAW_DIR}}'), 'should use placeholder for portability');
      assert.match(cmd, /"[^"]*\/data\/hooks\/sessionstart-prime-claude\.sh"$/,
        'the command must be a QUOTED absolute path — an unquoted one breaks the moment the install path contains a space (#759)')
    });

    it('SessionStart entry has command type and a status message', () => {
      const result = engines._buildBaselineHooks({ silentPrime: true }, supportingProfile);
      const hook = result.SessionStart[0].hooks[0];
      assert.equal(hook.type, 'command');
      assert.ok(hook.statusMessage, 'should set a statusMessage so the UI shows what is loading');
    });
  });


  describe('syncEngineHooks silentPrime integration (#103)', () => {
    let projectDir;

    beforeEach(() => {
      projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-silentprime-'));
    });

    afterEach(() => {
      fs.rmSync(projectDir, { recursive: true, force: true });
    });

    function readSettings() {
      return JSON.parse(fs.readFileSync(path.join(projectDir, '.claude', 'settings.json'), 'utf8'));
    }

    function writeProjConfig(config) {
      const dir = path.join(projectDir, '.tangleclaw');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'project.json'), JSON.stringify(config));
    }


    it('writes only the baseline entry', () => {
      writeProjConfig({ engine: 'claude', silentPrime: true });
      engines.syncEngineHooks(projectDir);

      const settings = readSettings();
      assert.equal(settings.hooks.SessionStart.length, 1);
      assert.equal(settings.hooks.SessionStart[0].matcher, 'startup');
      assert.match(settings.hooks.SessionStart[0].hooks[0].command, /"[^"]*\/data\/hooks\/sessionstart-prime-claude\.sh"$/,
        'the command must be a QUOTED absolute path — an unquoted one breaks the moment the install path contains a space (#759)')
    });


    it('writes a rules hook per shard into a real project\'s settings.json (#749)', () => {
      // The integration the unit tests cannot reach: only this path derives the
      // shard count from the store and puts the rules hook where the engine will
      // actually read it. Without a REGISTERED project the derivation silently
      // yields zero, which is why the sibling tests above still see one entry.
      const project = store.projects.create({ name: `hookint-${Date.now()}`, path: projectDir });
      store.projectConfig.save(projectDir, { engine: 'claude', silentPrime: true });
      store.sessionRules.create({ content: 'a rule that must reach the session', projectId: project.id });
      try {
        engines.syncEngineHooks(projectDir);

        const entries = readSettings().hooks.SessionStart;
        assert.equal(entries.length, 2, 'prime hook plus one rules hook');
        const rulesCmd = entries[1].hooks[0].command;
        assert.match(rulesCmd, /sessionstart-rules-claude\.sh" 1$/);
        assert.match(rulesCmd, /^"/, 'the path is quoted, so an install directory with a space still runs');
        assert.equal(rulesCmd.includes('{{TANGLECLAW_DIR}}'), false,
          'the placeholder must be resolved before the engine reads it');
      } finally {
        for (const r of store.sessionRules.list({ projectId: project.id })) store.sessionRules.delete(r.id);
        store.projects.delete(project.id);
      }
    });

    it('is idempotent — re-syncing does not accumulate rules hooks', () => {
      const project = store.projects.create({ name: `hookidem-${Date.now()}`, path: projectDir });
      store.projectConfig.save(projectDir, { engine: 'claude', silentPrime: true });
      store.sessionRules.create({ content: 'stable rule', projectId: project.id });
      try {
        engines.syncEngineHooks(projectDir);
        const first = readSettings().hooks.SessionStart;
        engines.syncEngineHooks(projectDir);
        const second = readSettings().hooks.SessionStart;
        assert.deepEqual(second, first,
          'every launch re-syncs, so a non-idempotent write would grow the block without bound');
      } finally {
        for (const r of store.sessionRules.list({ projectId: project.id })) store.sessionRules.delete(r.id);
        store.projects.delete(project.id);
      }
    });

    it('registers exactly as many rules hooks as there are shards to read', () => {
      // The hook count and the shard count are derived in different modules.
      // If they disagree, either a shard is never read or a hook reads a file
      // that was never written — both silent.
      const rulesChannel = require('../lib/session-rules-channel');
      const project = store.projects.create({ name: `hookcount-${Date.now()}`, path: projectDir });
      store.projectConfig.save(projectDir, { engine: 'claude', silentPrime: true });
      for (let i = 0; i < 6; i += 1) {
        store.sessionRules.create({ content: `rule ${i} ` + 'y'.repeat(3000), projectId: project.id });
      }
      try {
        engines.syncEngineHooks(projectDir);
        const hookEntries = readSettings().hooks.SessionStart.length - 1; // minus the prime hook
        const shards = rulesChannel.buildShards(
          store.sessionRules.listActiveForProject(project.id),
          rulesChannel.resolveChannelBudget(store.engines.get('claude'))
        );
        assert.ok(shards.length > 1, 'precondition: this rule set must actually shard');
        assert.equal(hookEntries, shards.length, 'one hook per shard, no more and no fewer');
      } finally {
        for (const r of store.sessionRules.list({ projectId: project.id })) store.sessionRules.delete(r.id);
        store.projects.delete(project.id);
      }
    });

    it('still writes the prime hook when the rules query fails', () => {
      const project = store.projects.create({ name: `hookfail-${Date.now()}`, path: projectDir });
      store.projectConfig.save(projectDir, { engine: 'claude', silentPrime: true });
      const real = store.sessionRules.listActiveForProject;
      store.sessionRules.listActiveForProject = () => { throw new Error('db exploded'); };
      try {
        engines.syncEngineHooks(projectDir);
        const entries = readSettings().hooks.SessionStart;
        assert.equal(entries.length, 1, 'a rules-query failure must not cost the session its prime');
        assert.match(entries[0].hooks[0].command, /"[^"]*\/data\/hooks\/sessionstart-prime-claude\.sh"$/);
      } finally {
        store.sessionRules.listActiveForProject = real;
        store.projects.delete(project.id);
      }
    });

    it('writes no rules hook for a registered project with no rules', () => {
      const project = store.projects.create({ name: `hooknone-${Date.now()}`, path: projectDir });
      store.projectConfig.save(projectDir, { engine: 'claude', silentPrime: true });
      try {
        engines.syncEngineHooks(projectDir);
        assert.equal(readSettings().hooks.SessionStart.length, 1,
          'no rules means no rules hook — an entry reading a file that was never written');
      } finally {
        store.projects.delete(project.id);
      }
    });

    it('resolves {{TANGLECLAW_DIR}} in the baseline entry on disk', () => {
      writeProjConfig({ engine: 'claude', silentPrime: true });
      engines.syncEngineHooks(projectDir);

      const settings = readSettings();
      const cmd = settings.hooks.SessionStart[0].hooks[0].command;
      assert.ok(!cmd.includes('{{TANGLECLAW_DIR}}'), 'placeholder should be resolved before write');
      // The command is a quoted path, so assert on what is INSIDE the quotes —
      // testing the raw command string as if it were a bare path is the shape
      // of assertion that let the unquoted form ship (#759).
      const quoted = /^"(.+)"$/.exec(cmd);
      assert.ok(quoted, 'the command must be a QUOTED path — unquoted breaks on a space (#759)');
      assert.ok(path.isAbsolute(quoted[1]), 'resolved path should be absolute');
      assert.match(quoted[1], /\/data\/hooks\/sessionstart-prime-claude\.sh$/)
    });

    it('does not run for non-claude engines even with silentPrime enabled', () => {
      writeProjConfig({ engine: 'codex', silentPrime: true });
      engines.syncEngineHooks(projectDir);

      assert.equal(fs.existsSync(path.join(projectDir, '.claude', 'settings.json')), false,
        'should not write .claude/settings.json for non-claude engine');
    });
  });

  // The generated CLAUDE.md is committed by managed projects and routinely
  // pushed to public remotes, so an absolute shared-doc path publishes the
  // operator's OS username. The project-map renderer was fixed first and this
  // one was missed — a second call site writing the same data class — so these
  // pin BOTH the reference and inline-error paths.
  describe('_buildSharedDocsSection — home paths never reach a committed file', () => {
    const home = os.homedir();

    it('renders a reference-mode doc path ~-relative', () => {
      const md = engines._buildSharedDocsSection([
        { name: 'NETWORK', groupName: 'infra', injectMode: 'reference',
          filePath: path.join(home, 'Documents/Shared/NETWORK.md') }
      ]);
      assert.ok(md.includes('`~/Documents/Shared/NETWORK.md`'), md);
      assert.ok(!md.includes(home), 'must not contain the absolute home path');
    });

    it('renders the inline-mode file-not-found path ~-relative', () => {
      const missing = path.join(home, 'Documents/Shared/GONE.md');
      const md = engines._buildSharedDocsSection([
        { name: 'GONE', groupName: 'infra', injectMode: 'inline', filePath: missing }
      ]);
      assert.match(md, /File not found/);
      assert.ok(!md.includes(home), 'the error branch must not leak the absolute path either');
    });

    it('leaves a path outside $HOME untouched', () => {
      const md = engines._buildSharedDocsSection([
        { name: 'OPS', groupName: 'infra', injectMode: 'reference', filePath: '/opt/shared/OPS.md' }
      ]);
      assert.ok(md.includes('`/opt/shared/OPS.md`'), md);
    });
  });

});
