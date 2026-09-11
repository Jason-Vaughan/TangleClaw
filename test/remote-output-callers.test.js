'use strict';

/*
 * Every caller that builds operator-facing text from a failed REMOTE `git`/`gh`
 * command redacts it (#870).
 *
 * The family is defined by a PROPERTY — "this string came from a command that
 * talked to a remote" — not by a directory. The first sweep behind this fix
 * enumerated `lib/wrap-steps/` and the guarantee was written as repo-wide, so
 * five callers outside that glob stayed unredacted, two of them logging into
 * `~/.tangleclaw/logs/tangleclaw.log` — the end state the fix existed to close.
 * Three independent reviewers each found the same gap.
 *
 * So the members live in one file rather than beside their own modules: a new
 * holder of the property is meant to be added HERE, where the family is
 * visible, instead of in whichever test file happens to be nearest. The
 * wrap-step members keep their own cases next to their step's behaviour; this
 * file covers the five outside it.
 *
 * Token literals are assembled at runtime — a contiguous secret-shaped literal
 * in a tracked file is blocked by GitHub push protection (#377).
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');

const ci = require('../lib/ci-status');
const prStatus = require('../lib/wrap-pr-status');
const updateChecker = require('../lib/update-checker');
const updateApplier = require('../lib/update-applier');
const behindOrigin = require('../lib/behind-origin');
const { setLevel, setConsoleStream } = require('../lib/logger');

const TOKEN = `gh${'o'}_notarealtokenvalue`;
const REMOTE_ERR = `fatal: unable to access 'https://${TOKEN}@github.com/x/y.git/': 403`;

/**
 * Assert a string carries the host but not the credential.
 * @param {string} text - The operator-facing text under test
 * @param {string} where - Label for the failure message
 */
function assertRedacted(text, where) {
  assert.ok(typeof text === 'string' && text.length > 0, `${where}: expected some text`);
  assert.ok(!text.includes(TOKEN), `${where}: the token must not survive`);
  assert.match(text, /\/\/\*\*\*@github\.com/, `${where}: the host should survive redaction`);
}

/**
 * Capture everything the logger writes while `fn` runs.
 * @param {Function} fn - Body to run
 * @returns {Promise<string>} Captured log output
 */
async function captureLogs(fn) {
  let out = '';
  setConsoleStream({ write: (s) => { out += s; } });
  setLevel('debug');
  try {
    await fn();
  } finally {
    setLevel('error');
    setConsoleStream(null);
  }
  return out;
}

describe('remote-output redaction reaches every caller outside lib/wrap-steps (#870)', () => {
  describe('ci-status', () => {
    let saved;
    beforeEach(() => { saved = ci._internal.exec; ci.clearCache(); });
    afterEach(() => { ci._internal.exec = saved; ci.clearCache(); });

    it('keeps the command and exit code when the whole message is redacted', async () => {
      // A wholesale replacement is truthy, so `safe || <fallback>` returns a
      // bare `[redacted — …]` and takes the command name and exit code away
      // with the secret. The operator is then told nothing failed in
      // particular. Assembled at runtime (#377).
      const flagged = `remote: rejected, token gh${'p'}_${'a'.repeat(36)}`;
      ci._internal.exec = async (file) => (file === 'git'
        ? { exitCode: 0, stdout: 'https://github.com/x/y.git\n', stderr: '', error: null }
        : { exitCode: 4, stdout: '', stderr: flagged, error: null });
      const result = await ci.refresh('/tmp/nonexistent-flagged', { force: true });

      assert.ok(!result.reason.includes('gh' + 'p_'), 'the secret is still replaced wholesale');
      assert.match(result.reason, /\(exit 4\)/, 'and the exit code still says what happened');
      assert.match(result.reason, /gh/, 'and which command it was');
    });

    it('redacts the reason a failed `gh run list` produces', async () => {
      // The origin probe must SUCCEED or the flow short-circuits on "no origin
      // remote" and never reaches the `gh` failure this case is about — a
      // fixture that cannot reach its subject passes forever.
      ci._internal.exec = async (file) => (file === 'git'
        ? { exitCode: 0, stdout: 'https://github.com/x/y.git\n', stderr: '', error: null }
        : { exitCode: 1, stdout: '', stderr: REMOTE_ERR, error: null });
      const result = await ci.refresh('/tmp/nonexistent-project', { force: true });
      assertRedacted(result.reason, 'ci-status reason');
    });
  });

  describe('wrap-pr-status', () => {
    let saved;
    beforeEach(() => { saved = { ...prStatus._internal }; });
    afterEach(() => { Object.assign(prStatus._internal, saved); });

    it('redacts the reason a failed `gh pr view` produces', async () => {
      prStatus._internal.exec = async () => ({ exitCode: 1, stdout: '', stderr: REMOTE_ERR });
      const result = await prStatus.resolve('/tmp', '1');
      assert.equal(result.outcome, 'unknown', 'the verdict is unchanged — only the text is');
      assertRedacted(result.reason, 'wrap-pr-status reason');
    });
  });

  describe('update-checker', () => {
    let saved;
    beforeEach(() => { saved = { ...updateChecker._internal }; updateChecker._reset(); });
    afterEach(() => { Object.assign(updateChecker._internal, saved); updateChecker._reset(); });

    it('redacts the failure it writes to the log file', async () => {
      // This one LOGS, which is the sink `observability-strategy.md` § Direction
      // names: "no log line at any level may contain an API key/token."
      updateChecker._internal.lsRemote = (cb) => cb(new Error(REMOTE_ERR));
      updateChecker._internal.currentVersion = () => '1.0.0';
      const logged = await captureLogs(() => new Promise((res) => {
        updateChecker.checkForUpdateAsync(() => res());
      }));
      assert.ok(!logged.includes(TOKEN), 'the token must not reach the log file');
      assert.ok(logged.includes('***@github.com'), 'and the host should still be there to debug with');
    });
  });

  describe('update-applier', () => {
    let saved;
    beforeEach(() => { saved = { ...updateApplier._internal }; });
    afterEach(() => { Object.assign(updateApplier._internal, saved); });

    it('redacts the git error it both logs and returns', async () => {
      // Two sinks from one string: the log file and the API response body.
      updateApplier._internal.checkForUpdate = () => ({
        updateAvailable: true, currentVersion: '1.0.0', latestVersion: '1.0.1', latestTag: 'v1.0.1'
      });
      // The early guards (`rev-parse HEAD`, `status --porcelain`) are local git
      // and must SUCCEED, or the flow returns `no-git`/`dirty-tree` and never
      // reaches the remote-touching step this case is about.
      updateApplier._internal.git = (args) => {
        if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'main';
        if (args[0] === 'rev-parse') return 'a'.repeat(40);
        if (args[0] === 'status') return '';
        throw new Error(REMOTE_ERR);
      };

      let result;
      const logged = await captureLogs(async () => { result = await updateApplier.applyUpdate(); });

      assert.equal(result.ok, false);
      assert.equal(result.code, 'git-error', 'the throw must reach the git-error branch, or this case tested nothing');
      assert.ok(!logged.includes(TOKEN), 'the token must not reach the log file');
      assertRedacted(result.error, 'update-applier returned error');
    });
  });

  describe('behind-origin', () => {
    let saved;
    beforeEach(() => { saved = { ...behindOrigin._internal }; });
    afterEach(() => { Object.assign(behindOrigin._internal, saved); });

    it('redacts the fetch failure it logs — the one call here that reaches origin', async () => {
      // Enumerated, not sampled: this file builds three reasons from a failure,
      // and only `gitFetch` talks to a remote. A guard on the `git threw` path
      // alone would leave the one that actually carries a URL unredacted.
      behindOrigin._internal.gitSymbolicRef = (cb) => cb(null, 'refs/heads/main\n');
      behindOrigin._internal.gitFetch = (cb) => cb(new Error(REMOTE_ERR));

      const logged = await captureLogs(async () => {
        const result = await behindOrigin.measure('/tmp');
        assert.equal(result.commitsAhead, 0, 'a failed fetch still resolves to 0, unchanged');
      });

      assert.ok(logged.includes('fetch failed'), 'the fetch path must be the one that ran');
      assert.ok(!logged.includes(TOKEN), 'the token must not reach the log file');
      assert.ok(logged.includes('***@github.com'), 'the host should still be there to debug with');
    });
  });
});
