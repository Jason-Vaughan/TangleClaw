'use strict';

/*
 * #1076 — OpenClaw device-pairing auto-approval.
 *
 * The bug this file exists under: `approve-pending` hardcoded
 * `$HOME/.local/bin/docker` and ran it through `| head -1`. A pipeline's exit
 * status is its LAST command's, so on a host where docker lives elsewhere the
 * failing `docker` (127, "No such file or directory") became a succeeding
 * `head` with empty stdout — and TangleClaw reported "No Docker container
 * found" for a host that was running the container the whole time. That wrong
 * fact sent a full investigation (#1012) after a browser storage bug that did
 * not exist.
 *
 * So the contract under test is not merely "it approves". It is:
 *   - docker is RESOLVED on the remote host, never assumed;
 *   - a command that FAILED is never reported as a thing that is ABSENT;
 *   - every outcome carries a distinct code the UI can act on;
 *   - values crossing into the remote shell are quoted;
 *   - the gateway token never reaches an error string.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const {
  approvePending, resolveDockerBin, findContainer, shellQuote, CODES, DOCKER_FALLBACK_PATHS
} = require('../lib/openclaw-approve.js');

/**
 * Build a runRemote stub from a list of [matcher, response] rules, recording
 * every command it was asked to run.
 * @param {Array<[RegExp, object]>} rules
 * @returns {Function & {calls: string[]}}
 */
function stubRemote(rules) {
  const fn = (command, opts) => {
    fn.calls.push(command);
    if (opts && opts.secret) fn.secrets.push(opts.secret);
    for (const [re, resp] of rules) {
      if (re.test(command)) return Object.assign({ ok: true, stdout: '', stderr: '', code: 0 }, resp);
    }
    return { ok: false, stdout: '', stderr: `unstubbed: ${command}`, code: 127 };
  };
  fn.calls = [];
  fn.secrets = [];
  return fn;
}

const OK_DOCKER = [/command -v docker/, { ok: true, stdout: '/usr/bin/docker\n' }];
const OK_PS = [/docker ps --filter/, { ok: true, stdout: 'openclaw-openclaw-gateway-1\n' }];

describe('#1076 resolveDockerBin — the binary is found, not assumed', () => {
  it('uses the path `command -v docker` reports', () => {
    const run = stubRemote([[/command -v docker/, { ok: true, stdout: '/usr/bin/docker\n' }]]);
    assert.deepEqual(resolveDockerBin(run), { ok: true, bin: '/usr/bin/docker', code: CODES.APPROVED, detail: null });
  });

  it('falls back to known install locations when PATH has nothing', () => {
    // The exact live shape: docker exists, just not where the old code looked.
    const run = stubRemote([[/command -v docker/, { ok: false, stdout: '/usr/bin/docker\n', code: 42 }]]);
    const r = resolveDockerBin(run);
    assert.equal(r.ok, true);
    assert.equal(r.bin, '/usr/bin/docker');
  });

  it('probes the old hardcoded path too, so hosts that DID work keep working', () => {
    const run = stubRemote([[/command -v docker/, { ok: true, stdout: '' }]]);
    resolveDockerBin(run);
    assert.match(run.calls[0], /\$HOME\/\.local\/bin\/docker/,
      'the pre-#1076 location must remain one of the candidates');
    assert.ok(DOCKER_FALLBACK_PATHS.includes('/usr/bin/docker'), 'and the location that was actually in use');
  });

  it('reports DOCKER_NOT_FOUND — never a missing container — when docker is absent', () => {
    // THE regression guard. The old code turned this exact situation into
    // "No Docker container found", which is a claim about a different thing.
    const run = stubRemote([[/command -v docker/, { ok: false, stdout: '', code: 42 }]]);
    const r = resolveDockerBin(run);
    assert.equal(r.ok, false);
    assert.equal(r.code, CODES.DOCKER_NOT_FOUND);
    assert.doesNotMatch(r.detail, /container/i, 'a missing binary must not be described as a missing container');
  });

  it('distinguishes an SSH failure from a missing docker', () => {
    const run = stubRemote([[/command -v docker/, { ok: false, stdout: '', stderr: 'Permission denied (publickey)', code: 255 }]]);
    const r = resolveDockerBin(run);
    assert.equal(r.code, CODES.SSH_FAILED);
    assert.match(r.detail, /publickey/);
  });
});

describe('#1076 findContainer — a failed command is not an absent container', () => {
  it('returns the container name on success', () => {
    const run = stubRemote([OK_PS]);
    assert.equal(findContainer(run, '/usr/bin/docker', 18789).container, 'openclaw-openclaw-gateway-1');
  });

  it('does NOT pipe through head — that is what masked the exit status', () => {
    // The root cause in one assertion: `docker ... | head -1` makes the
    // pipeline's status head's (0), so a failing docker looks like success.
    const run = stubRemote([OK_PS]);
    findContainer(run, '/usr/bin/docker', 18789);
    assert.doesNotMatch(run.calls[0], /\|\s*head/, 'piping to head hides the docker exit status');
  });

  it('reports LIST_FAILED when docker ps itself errors', () => {
    const run = stubRemote([[/docker ps/, { ok: false, stdout: '', stderr: 'Cannot connect to the Docker daemon', code: 1 }]]);
    const r = findContainer(run, '/usr/bin/docker', 18789);
    assert.equal(r.code, CODES.LIST_FAILED);
    assert.match(r.detail, /Docker daemon/);
  });

  it('reports NO_CONTAINER only when the command SUCCEEDED and found nothing', () => {
    const run = stubRemote([[/docker ps/, { ok: true, stdout: '\n' }]]);
    const r = findContainer(run, '/usr/bin/docker', 18789);
    assert.equal(r.code, CODES.NO_CONTAINER);
    assert.match(r.detail, /18789/, 'names the port it looked at');
  });

  it('takes only the first line when several containers publish the port', () => {
    const run = stubRemote([[/docker ps/, { ok: true, stdout: 'first\nsecond\n' }]]);
    assert.equal(findContainer(run, '/usr/bin/docker', 18789).container, 'first');
  });
});

describe('#1076 approvePending — end to end over the remote seam', () => {
  const listing = (pending) => [/devices list --json/, { ok: true, stdout: JSON.stringify({ pending }) }];

  it('approves the NEWEST pending request', () => {
    const run = stubRemote([
      OK_DOCKER, OK_PS,
      listing([{ requestId: 'old-1', ts: 100 }, { requestId: 'new-2', ts: 900 }]),
      [/devices approve/, { ok: true, stdout: '{"ok":true}' }]
    ]);
    const r = approvePending({ runRemote: run, port: 18789, gatewayToken: 'tok' });
    assert.equal(r.approved, true);
    assert.equal(r.code, CODES.APPROVED);
    assert.equal(r.requestId, 'new-2');
    assert.equal(r.count, 2);
    assert.match(run.calls[run.calls.length - 1], /devices approve 'new-2'/);
  });

  it('passes the requestId positionally, not via --latest (which only previews)', () => {
    const run = stubRemote([
      OK_DOCKER, OK_PS, listing([{ requestId: 'r-1', ts: 1 }]),
      [/devices approve/, { ok: true, stdout: '{}' }]
    ]);
    approvePending({ runRemote: run, port: 18789, gatewayToken: 'tok' });
    const cmd = run.calls[run.calls.length - 1];
    assert.doesNotMatch(cmd, /--latest/, '--latest is a preview and approves nothing');
    assert.match(cmd, /devices approve 'r-1'/);
  });

  it('surfaces DOCKER_NOT_FOUND end to end, and never says "container"', () => {
    // The live failure, reproduced through the whole path.
    const run = stubRemote([[/command -v docker/, { ok: false, stdout: '', code: 42 }]]);
    const r = approvePending({ runRemote: run, port: 18789, gatewayToken: 'tok' });
    assert.equal(r.approved, false);
    assert.equal(r.code, CODES.DOCKER_NOT_FOUND);
    assert.doesNotMatch(r.reason, /No Docker container found/);
    assert.doesNotMatch(r.reason, /container/i);
  });

  it('reports NO_PENDING distinctly from every failure', () => {
    const run = stubRemote([OK_DOCKER, OK_PS, listing([])]);
    const r = approvePending({ runRemote: run, port: 18789, gatewayToken: 'tok' });
    assert.equal(r.code, CODES.NO_PENDING);
    assert.equal(r.approved, false);
  });

  it('reports LIST_FAILED on unparseable JSON rather than pretending nothing is pending', () => {
    const run = stubRemote([OK_DOCKER, OK_PS, [/devices list --json/, { ok: true, stdout: 'not json' }]]);
    const r = approvePending({ runRemote: run, port: 18789, gatewayToken: 'tok' });
    assert.equal(r.code, CODES.LIST_FAILED);
    assert.notEqual(r.code, CODES.NO_PENDING);
  });

  it('reports MISSING_REQUEST_ID when the newest entry has none', () => {
    const run = stubRemote([OK_DOCKER, OK_PS, listing([{ ts: 5 }])]);
    assert.equal(approvePending({ runRemote: run, port: 18789, gatewayToken: 'tok' }).code, CODES.MISSING_REQUEST_ID);
  });

  it('reports APPROVE_FAILED with the gateway stderr', () => {
    const run = stubRemote([
      OK_DOCKER, OK_PS, listing([{ requestId: 'r-1', ts: 1 }]),
      [/devices approve/, { ok: false, stdout: '', stderr: 'scope upgrade pending approval', code: 1 }]
    ]);
    const r = approvePending({ runRemote: run, port: 18789, gatewayToken: 'tok' });
    assert.equal(r.code, CODES.APPROVE_FAILED);
    assert.match(r.reason, /scope upgrade/);
  });

  it('marks the approve call as carrying a secret so the caller can redact it', () => {
    const run = stubRemote([
      OK_DOCKER, OK_PS, listing([{ requestId: 'r-1', ts: 1 }]),
      [/devices approve/, { ok: true, stdout: '{}' }]
    ]);
    approvePending({ runRemote: run, port: 18789, gatewayToken: 'super-secret-token' });
    assert.deepEqual(run.secrets, ['super-secret-token'],
      'the token must be flagged to the runner, which redacts it from captured stderr');
  });

  it('never issues a second redundant container lookup', () => {
    // The pre-#1076 handler ran `docker ps` twice for one approval.
    const run = stubRemote([
      OK_DOCKER, OK_PS, listing([{ requestId: 'r-1', ts: 1 }]),
      [/devices approve/, { ok: true, stdout: '{}' }]
    ]);
    approvePending({ runRemote: run, port: 18789, gatewayToken: 'tok' });
    assert.equal(run.calls.filter((c) => /docker ps --filter/.test(c)).length, 1);
  });
});

describe('#1076 shellQuote — remote-shell injection', () => {
  it('quotes plain values', () => {
    assert.equal(shellQuote('abc'), `'abc'`);
  });

  it('neutralizes an embedded single quote', () => {
    assert.equal(shellQuote(`a'b`), `'a'\\''b'`);
  });

  it('a hostile container name cannot break out and run a second command', () => {
    // Asserted by running it through a REAL shell, not by pattern-matching the
    // string: correct quoting leaves `; rm -rf /` present as literal text
    // INSIDE the quotes, so a regex looking for that text fails on working code.
    // The property is "the shell sees exactly one argument, unchanged".
    const hostile = `evil'; rm -rf /; echo '`;
    const out = execFileSync('sh', ['-c', `printf '%s' ${shellQuote(hostile)}`], { encoding: 'utf8' });
    assert.equal(out, hostile, 'the shell must reproduce the value verbatim, executing none of it');
  });

  it('a quoted value cannot introduce a second shell word', () => {
    const sneaky = `a b'; echo PWNED; echo '`;
    const argc = execFileSync('sh', ['-c', `set -- ${shellQuote(sneaky)}; echo $#`], { encoding: 'utf8' }).trim();
    assert.equal(argc, '1', 'must stay a single argument, not split into a command');
    // NOTE: do NOT assert the payload text is absent from the output. Correct
    // quoting leaves `echo PWNED` present *as literal data* — asserting its
    // absence fails on working code (it did, twice, while writing this file).
    // The property is exact round-trip: the shell reproduces it and runs none of it.
    const arg1 = execFileSync('sh', ['-c', `set -- ${shellQuote(sneaky)}; printf '%s' "$1"`], { encoding: 'utf8' });
    assert.equal(arg1, sneaky, 'the single argument must equal the input byte for byte');
  });

  it('quotes the requestId, which arrives from the gateway rather than from us', () => {
    const hostileId = `r'; whoami; echo '`;
    const run = stubRemote([
      OK_DOCKER, OK_PS,
      [/devices list --json/, { ok: true, stdout: JSON.stringify({ pending: [{ requestId: hostileId, ts: 1 }] }) }],
      [/devices approve/, { ok: true, stdout: '{}' }]
    ]);
    approvePending({ runRemote: run, port: 18789, gatewayToken: 'tok' });
    const cmd = run.calls[run.calls.length - 1];
    // Round-trip the whole built command through a shell's tokenizer: the
    // hostile id must survive as one argument to `devices approve`.
    const echoed = execFileSync('sh', ['-c', `set -- ${cmd.slice(cmd.indexOf('devices approve ') + 16)}; printf '%s' "$1"`], { encoding: 'utf8' });
    assert.equal(echoed, hostileId, 'the requestId must reach the CLI intact, not as extra commands');
  });

  it('quotes the gateway token so it cannot terminate its own quoting', () => {
    const run = stubRemote([
      OK_DOCKER, OK_PS,
      [/devices list --json/, { ok: true, stdout: JSON.stringify({ pending: [{ requestId: 'r-1', ts: 1 }] }) }],
      [/devices approve/, { ok: true, stdout: '{}' }]
    ]);
    approvePending({ runRemote: run, port: 18789, gatewayToken: `t'; id; echo '` });
    const cmd = run.calls[run.calls.length - 1];
    const tokenArg = cmd.slice(cmd.indexOf('--token ') + 8).replace(/ --json$/, '');
    const echoed = execFileSync('sh', ['-c', `printf '%s' ${tokenArg}`], { encoding: 'utf8' });
    assert.equal(echoed, `t'; id; echo '`);
  });
});

describe('#1076 wiring — server.js and the viewer actually use this', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const viewSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'openclaw-view.js'), 'utf8');

  it('server.js no longer hardcodes the docker path anywhere', () => {
    assert.doesNotMatch(serverSrc, /\$HOME\/\.local\/bin\/docker/,
      'the hardcoded path is the bug; it belongs only in the module’s candidate list');
  });

  it('server.js routes approve-pending through the module', () => {
    assert.match(serverSrc, /openclawApprove\.approvePending/);
  });

  it('the route returns the code alongside the reason', () => {
    const route = serverSrc.slice(serverSrc.indexOf("route('POST', '/api/openclaw/connections/:id/approve-pending'"));
    assert.match(route.slice(0, 2500), /code: result\.code/);
    assert.match(route.slice(0, 2500), /reason: result\.reason/);
  });

  it('the remote runner captures stderr separately from stdout', () => {
    assert.match(serverSrc, /function _runOnGatewayHost/);
    assert.match(serverSrc, /stderr: redact\(/, 'stderr must be captured AND redacted, not swallowed');
  });

  it('the viewer surfaces the reason instead of returning silently', () => {
    assert.match(viewSrc, /function reportAutoApproveGaveUp/);
    assert.match(viewSrc, /reportAutoApproveGaveUp\(lastOutcome\)/,
      'exhausting the attempts must report, not bare-return');
  });

  it('the viewer stops early on outcomes retrying cannot fix', () => {
    assert.match(viewSrc, /TERMINAL_APPROVE_CODES/);
    for (const code of ['DOCKER_NOT_FOUND', 'NO_CONTAINER', 'SSH_FAILED', 'APPROVE_FAILED']) {
      assert.match(viewSrc, new RegExp(code), `${code} should end the poll loop`);
    }
  });

  it('the viewer stays quiet when there is simply nothing pending', () => {
    assert.match(viewSrc, /NO_PENDING'\) return/, 'an already-paired connection is not a failure to report');
  });
});
