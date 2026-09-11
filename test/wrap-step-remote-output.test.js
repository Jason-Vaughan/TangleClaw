'use strict';

/*
 * Tests for `lib/wrap-steps/_remote-output.js` — the shared redaction every
 * wrap step applies to the text a failed REMOTE `git`/`gh` command prints.
 *
 * Most of these assertions were written against `commit.js`'s private
 * `_truncateForRecord` and moved here with the function. They are the same
 * contract; what changed is who owns it. The move is the point of the change:
 * the redaction used to live beside ONE recorder, and the log line thirty-five
 * lines above that recorder passed the identical string through unredacted to
 * `~/.tangleclaw/logs/tangleclaw.log`. `observability-strategy.md` § Direction
 * forbids that ("no log line at any level may contain an API key/token"), and
 * its #821 amendment names the remedy this module implements — the producer of
 * text that can embed a secret owns the redaction.
 *
 * Every token-shaped literal below is ASSEMBLED AT RUNTIME from split parts.
 * A contiguous secret-shaped literal in a tracked file is blocked by GitHub
 * push protection (#377), and recovering from that costs a history rewrite.
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { redactRemoteOutput, detailFromFailure, reasonFromFailure, MAX_CHARS } = require('../lib/wrap-steps/_remote-output');

// Assembled, never written contiguously — see the header note.
const GH_CLASSIC = `gh${'p'}_${'a'.repeat(36)}`;
const GH_OAUTH = `gh${'o'}_notarealtokenvalue`;

test('_remote-output: bounding', async (t) => {
  await t.test('caps over-long text and marks that it was cut', () => {
    const long = 'x'.repeat(500);
    assert.equal(redactRemoteOutput(long).length, MAX_CHARS + 1, 'the cap plus the ellipsis');
    assert.match(redactRemoteOutput(long), /…$/);
  });

  await t.test('leaves text under the cap exactly as it was', () => {
    assert.equal(redactRemoteOutput('short'), 'short');
  });

  await t.test('returns null for anything that is not a string', () => {
    assert.equal(redactRemoteOutput(null), null);
    assert.equal(redactRemoteOutput(undefined), null);
    assert.equal(redactRemoteOutput(42), null);
  });
});

test('_remote-output: credential stripping', async (t) => {
  await t.test('strips a credential embedded in a remote URL', () => {
    // A failed `git push` echoes the remote. A bare `user:password@` matches
    // none of secret-scan's patterns, so the structural strip — not the
    // scanner — is what catches this one.
    const out = redactRemoteOutput(
      "fatal: could not read from 'https://jason:hunter2@github.com/x/y.git'"
    );
    assert.doesNotMatch(out, /hunter2/, 'the password must not survive');
    assert.match(out, /\/\/\*\*\*@github\.com/);
    assert.match(out, /could not read from/, 'the diagnostic value must survive redaction');
  });

  await t.test('strips the password-LESS token form GitHub tells people to use', () => {
    // `https://<token>@host` carries no colon. A strip requiring one missed the
    // single most likely credential in a push error, and secret-scan knows only
    // ghp_/github_pat_ — not gho_/ghs_/ghu_/ghr_, and nothing at all for
    // GitLab, Bitbucket or self-hosted forges.
    const out = redactRemoteOutput(
      `remote: error\nfatal: unable to access 'https://${GH_OAUTH}@gitlab.example.com/x/y.git/'`
    );
    assert.doesNotMatch(out, new RegExp(GH_OAUTH), 'the token must not survive');
    assert.match(out, /\/\/\*\*\*@gitlab\.example\.com/);
  });

  await t.test('leaves a credential-free URL alone — the strip cannot over-match', () => {
    const url = "fatal: could not read from 'https://github.com/x/y.git'";
    assert.equal(redactRemoteOutput(url), url);
  });

  await t.test('erases a harmless userinfo too, and that is the deliberate trade', () => {
    const out = redactRemoteOutput("fatal: 'ssh://git@github.com/x/y.git' not found");
    assert.match(out, /\/\/\*\*\*@github\.com/);
    assert.match(out, /not found/, 'the diagnostic text still survives');
  });

  await t.test('replaces — never truncates — text still matching a known secret pattern', () => {
    const out = redactRemoteOutput(`remote: rejected, token ${GH_CLASSIC}`);
    assert.match(out, /^\[redacted — github-token detected/,
      'a truncated secret is still a secret, so the text is replaced wholesale');
    assert.doesNotMatch(out, /gh[p]_/);
  });

  await t.test('the cap runs AFTER the scan, so a secret past the cap still redacts', () => {
    // Capping first would slice the token out of the scanner's view and leave
    // the 200 chars before it — which is how a "bounded" string leaks.
    const out = redactRemoteOutput(`${'x'.repeat(300)} ${GH_CLASSIC}`);
    assert.match(out, /^\[redacted — github-token detected/);
  });
});

test('_remote-output: reasonFromFailure assembles and redacts together', async (t) => {
  await t.test('prefers stderr, falls back to stdout, then to the exit code', () => {
    assert.equal(reasonFromFailure({ stderr: 'e', stdout: 'o', exitCode: 1 }), 'e');
    assert.equal(reasonFromFailure({ stderr: '', stdout: 'o', exitCode: 1 }), 'o');
    assert.equal(reasonFromFailure({ stderr: '', stdout: '', exitCode: 7 }), 'exit 7');
  });

  await t.test('redacts whichever stream it took', () => {
    const viaStderr = reasonFromFailure({
      stderr: `fatal: unable to access 'https://${GH_OAUTH}@github.com/x/y.git/'`,
      stdout: '',
      exitCode: 128
    });
    assert.doesNotMatch(viaStderr, new RegExp(GH_OAUTH));

    const viaStdout = reasonFromFailure({
      stderr: '',
      stdout: `fatal: unable to access 'https://${GH_OAUTH}@github.com/x/y.git/'`,
      exitCode: 128
    });
    assert.doesNotMatch(viaStdout, new RegExp(GH_OAUTH),
      'the stdout fallback is the same class of text and gets the same treatment');
  });

  await t.test('trims, so a trailing newline does not eat a character of the cap', () => {
    assert.equal(reasonFromFailure({ stderr: '  boom  \n', stdout: '', exitCode: 1 }), 'boom');
  });

  await t.test('trims BEFORE choosing, so a blank stderr does not discard stdout', () => {
    // A command that writes a bare newline to stderr and its real message to
    // stdout has said nothing on stderr. Choosing the untrimmed stderr — truthy
    // because it is a newline — would throw the message away.
    assert.equal(reasonFromFailure({ stderr: '\n', stdout: 'the real message', exitCode: 1 }),
      'the real message');
  });
});

test('_remote-output: detailFromFailure is the same text without the fallback', async (t) => {
  await t.test('returns empty when the command printed nothing', () => {
    // Its callers compose `<outcome>: <detail>` and omit the separator on an
    // empty detail. An `exit N` fallback here would print the exit code twice,
    // because the outcome half already names it.
    assert.equal(detailFromFailure({ stderr: '', stdout: '', exitCode: 1 }), '');
    assert.equal(detailFromFailure({ stderr: '  \n', stdout: '', exitCode: 1 }), '');
  });

  await t.test('otherwise matches reasonFromFailure exactly', () => {
    const res = { stderr: 'boom', stdout: 'ignored', exitCode: 1 };
    assert.equal(detailFromFailure(res), reasonFromFailure(res));
  });

  await t.test('redacts the same way', () => {
    const out = detailFromFailure({
      stderr: `fatal: unable to access 'https://${GH_OAUTH}@github.com/x/y.git/'`,
      stdout: '',
      exitCode: 128
    });
    assert.doesNotMatch(out, new RegExp(GH_OAUTH));
  });
});
