'use strict';

/*
 * #1836 — the loopback-only network profile Codex's Full Auto runs under.
 *
 * The profile is what lets `tc` reach TangleClaw from inside Codex's sandbox,
 * so its contract is about what it must NEVER grant as much as what it does:
 * only the exact loopback hosts, never the sandbox's all-or-nothing network
 * switch, never an enabled network without the proxy that restricts it, and
 * never a workspace with a writable `.git`. The live tier runs the real
 * `codex sandbox` with these exact arguments on a host that has a proven
 * Codex, because the arguments are only as good as the parser that reads them.
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { execFileSync, execFile } = require('node:child_process');
const { promisify } = require('node:util');

const profile = require('../lib/codex-loopback-profile');
const codex = require('../lib/startup-control-codex');
const { initRepo } = require('./_temp-repo');

/**
 * The `-c` overrides as a key → value map, asserting the argv is strictly
 * alternating `-c <override>` pairs.
 * @param {string[]} args - `profileArgs()` output.
 * @returns {Map<string, string>}
 */
function overrides(args) {
  assert.equal(args.length % 2, 0, 'every override is a -c pair');
  const map = new Map();
  for (let i = 0; i < args.length; i += 2) {
    assert.equal(args[i], '-c', `argument ${i} is -c`);
    const eq = args[i + 1].indexOf('=');
    map.set(args[i + 1].slice(0, eq), args[i + 1].slice(eq + 1));
  }
  return map;
}

/**
 * Parse one of the profile's inline tables (`{"a"="b","c"="d"}`).
 * @param {string} table - The inline table text.
 * @returns {object}
 */
function inlineTable(table) {
  return JSON.parse(table.replace(/"=("[^"]*")/g, '":$1'));
}

describe('codex loopback profile (#1836)', () => {
  const p = `permissions.${profile.PROFILE_NAME}`;

  it('selects its own profile, extends the workspace preset, and turns on the proxy that restricts it', () => {
    const o = overrides(profile.profileArgs());
    assert.equal(o.get('default_permissions'), JSON.stringify(profile.PROFILE_NAME));
    assert.equal(o.get(`${p}.extends`), '":workspace"');
    assert.equal(o.get(`${p}.network.enabled`), 'true');
    assert.equal(o.get('features.network_proxy'), 'true', 'an enabled network without the proxy is an unrestricted one');
  });

  it('allowlists exactly 127.0.0.1 and localhost — no wildcard, no port, nothing else', () => {
    const domains = inlineTable(overrides(profile.profileArgs()).get(`${p}.network.domains`));
    assert.deepEqual(domains, { '127.0.0.1': 'allow', localhost: 'allow' });
  });

  it('keeps .git, .agents and .codex read-only inside a writable workspace, as workspace-write does', () => {
    const fsTable = inlineTable(overrides(profile.profileArgs()).get(`${p}.filesystem.:workspace_roots`));
    assert.deepEqual(fsTable, { '.': 'write', '.git': 'read', '.agents': 'read', '.codex': 'read' });
  });

  it('never uses the all-or-nothing network switch, local binding, the legacy sandbox flag, or a bypass', () => {
    const text = profile.profileArgs().join(' ');
    for (const forbidden of ['network_access', 'allow_local_binding', 'sandbox_workspace_write', '--sandbox', 'dangerously', 'allow_unix_sockets']) {
      assert.ok(!text.includes(forbidden), `the profile must not contain ${forbidden}`);
    }
  });

  it('survives a POSIX shell: the quoted command parses back to exactly the profile\'s argv', () => {
    const args = profile.profileArgs();
    const quoted = args.map(profile.shellQuote).join(' ');
    const parsed = execFileSync('/bin/sh', ['-c', `printf '%s\\n' ${quoted}`], { encoding: 'utf8' }).split('\n').slice(0, -1);
    assert.deepEqual(parsed, args);
    assert.equal(profile.shellQuote("it's"), `'it'\\''s'`, 'a single quote inside a token is escaped, not closed');
  });

  it('replaces --sandbox workspace-write in place, keeping what comes before and after it', () => {
    const { command, applied } = profile.applyLoopbackProfile('codex --ask-for-approval never --sandbox workspace-write --no-daemon');
    assert.equal(applied, true);
    assert.ok(command.startsWith('codex --ask-for-approval never -c features.network_proxy=true '), command);
    assert.ok(command.endsWith(' --no-daemon'), command);
    assert.ok(!/--sandbox/.test(command), 'the legacy flag would switch the profile off');
  });

  it('recognises the no-network sandbox only as the exact flag pair', () => {
    assert.equal(profile.hasLegacySandbox('codex --sandbox workspace-write'), true);
    assert.equal(profile.hasLegacySandbox('codex --sandbox  workspace-write --no-daemon'), true);
    for (const cmd of ['codex', 'codex --sandbox read-only', 'codex --sandbox workspace-writer', null]) {
      assert.equal(profile.hasLegacySandbox(cmd), false, String(cmd));
    }
  });

  it('adds no network grant to a command with no workspace-write sandbox to narrow', () => {
    for (const cmd of ['codex', 'codex --dangerously-bypass-approvals-and-sandbox', 'codex --sandbox read-only', 'codex --sandbox workspace-writer']) {
      assert.deepEqual(profile.applyLoopbackProfile(cmd), { command: cmd, applied: false }, cmd);
    }
  });
});

describe('codex adapter gates the loopback profile on a proven version (#1836)', () => {
  const saved = { ...codex._internal._version };
  after(() => Object.assign(codex._internal._version, saved));

  it('applies on 0.156.1 and on nothing else — not the next release, not an unknown version', () => {
    const cmd = 'codex --ask-for-approval never --sandbox workspace-write';
    codex._internal._version.version = '0.156.1';
    const proven = codex.loopbackLaunchCommand(cmd);
    assert.match(proven.command, /default_permissions/);
    assert.equal(proven.blocksLoopback, false);
    for (const v of ['0.157.1', '0.156.0', '0.156.1-beta', null]) {
      codex._internal._version.version = v;
      const declined = codex.loopbackLaunchCommand(cmd);
      assert.equal(declined.command, null, String(v));
      assert.equal(declined.blocksLoopback, true, `${v}: the command kept is the no-network sandbox`);
      assert.match(declined.reason, v ? new RegExp(`codex-cli ${v.replace(/\./g, '\\.')} is not a version`) : /version unknown/);
    }
  });

  it('declines a command with no sandbox flag to replace, and says it blocks nothing', () => {
    codex._internal._version.version = '0.156.1';
    const answer = codex.loopbackLaunchCommand('codex --dangerously-bypass-approvals-and-sandbox');
    assert.equal(answer.command, null);
    assert.equal(answer.blocksLoopback, false, 'no sandbox, so loopback is not refused and the launch must not claim it is');
    assert.match(answer.reason, /no --sandbox workspace-write/);
  });
});

/**
 * The installed codex-cli version, or null when there is none.
 * @returns {string|null}
 */
function installedCodexVersion() {
  try {
    return codex._internal._parseVersion(execFileSync('codex', ['--version'], { encoding: 'utf8', timeout: 10000 }));
  } catch {
    return null;
  }
}

describe('codex loopback profile against the installed CLI (#1836)', () => {
  const version = installedCodexVersion();
  const proven = codex._internal._supportsLoopbackProfile(version);
  const skip = proven ? false : `no proven codex-cli installed (found ${version || 'none'})`;
  let server;
  let port;
  let workspace;
  let codexHome;

  before(async () => {
    if (skip) return;
    server = http.createServer((req, res) => { res.writeHead(204); res.end(); });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = server.address().port;
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-1836-ws-'));
    codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-1836-home-'));
    initRepo(workspace);
  });

  after(() => {
    if (server) server.close();
    for (const dir of [workspace, codexHome]) if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('reaches a loopback server through the proxy, refuses a direct socket, and keeps .git read-only (needs a proven codex-cli installed)', { skip }, async () => {
    const script = [
      'touch inside.txt && echo inside=ok || echo inside=denied',
      'touch .git/tc-probe 2>/dev/null && echo dotgit=ok || echo dotgit=denied',
      `curl -s -m 5 -o /dev/null -w 'proxied=%{http_code}\\n' http://127.0.0.1:${port}/`,
      // Last: Codex may end a command at its first refused connection.
      `curl -s -m 5 --noproxy '*' -o /dev/null -w 'direct=%{http_code}\\n' http://127.0.0.1:${port}/ || true`
    ].join('; ');
    const { stdout } = await promisify(execFile)('codex', ['sandbox', ...profile.profileArgs(), '--', 'sh', '-c', script], {
      cwd: workspace, env: { ...process.env, CODEX_HOME: codexHome }, timeout: 60000, encoding: 'utf8'
    });
    assert.match(stdout, /inside=ok/);
    assert.match(stdout, /dotgit=denied/, 'the workspace-write .git protection must survive the profile');
    assert.match(stdout, /proxied=204/, 'loopback through the proxy is the whole point');
    assert.match(stdout, /direct=000/, 'a socket that bypasses the proxy must be refused');
  });
});
