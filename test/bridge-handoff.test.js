'use strict';

// #2031 (ADR 0023 Decision 14): the Master's bridge credential reaches the
// pane through a one-shot FIFO and nowhere else. Driven with a real FIFO and a
// real shell running the real wrapped command: the value arrives in the
// command's environment, is in no argument list, and the FIFO is gone
// afterwards on the success path and on every failure path.

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, execFileSync } = require('node:child_process');

const handoff = require('../lib/bridge-handoff');

let dir = null;

/**
 * Run a wrapped launch command in a real shell and collect what it printed.
 * @param {string} command - Shell command.
 * @returns {{child: object, done: Promise<{code: number, stdout: string}>}}
 */
function runShell(command) {
  const child = spawn('/bin/sh', ['-c', command], { stdio: ['ignore', 'pipe', 'ignore'] });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d; });
  const done = new Promise((resolve) => child.on('close', (code) => resolve({ code, stdout })));
  return { child, done };
}

/**
 * Every `{pid, ppid, args}` row visible in `/proc` — the fallback when `ps`
 * itself is missing, e.g. `node:22-bookworm-slim` without `procps` (#2752).
 * `/proc` is a kernel-provided virtual filesystem, present regardless of
 * which userland utilities are installed.
 * @returns {Array<{pid: number, ppid: number, args: string}>}
 */
function procfsRows() {
  const rows = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const pid = Number(name);
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'latin1');
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/)[1]);
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'latin1').split('\0').filter(Boolean).join(' ');
      rows.push({ pid, ppid, args });
    } catch {
      // exited between readdir and read, or unreadable — not part of the tree we can see
    }
  }
  return rows;
}

/**
 * The argument lists of a process and everything below it.
 * @param {number} pid - Root process id.
 * @returns {string}
 */
function argvOfTree(pid) {
  let rows;
  try {
    const all = execFileSync('ps', ['-axo', 'pid=,ppid=,args='], { encoding: 'utf8' }).split('\n');
    rows = all.map((l) => l.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
      .map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), args: m[3] }));
  } catch (err) {
    if (!(err && err.code === 'ENOENT' && process.platform === 'linux')) throw err;
    rows = procfsRows(); // no procps in this container (#2752) — read the process tree straight from /proc
  }
  const wanted = new Set([pid]);
  for (let grew = true; grew;) {
    grew = false;
    for (const r of rows) if (wanted.has(r.ppid) && !wanted.has(r.pid)) { wanted.add(r.pid); grew = true; }
  }
  return rows.filter((r) => wanted.has(r.pid)).map((r) => r.args).join('\n');
}

describe('bridge credential handoff (#2031)', () => {
  beforeEach(() => {
    dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tc-handoff-')), 'bridge-handoff');
  });

  afterEach(() => {
    fs.rmSync(path.dirname(dir), { recursive: true, force: true });
  });

  it('mints a credential the server can verify from its hash alone', () => {
    const a = handoff.mintCredential();
    const b = handoff.mintCredential();
    assert.notEqual(a.credential, b.credential);
    assert.ok(handoff.looksLikeCredential(a.credential));
    assert.equal(a.hash, handoff.hashCredential(a.credential));
    assert.equal(a.hash.length, 64);
    assert.ok(!a.hash.includes(a.credential.slice(4)));
  });

  it('makes a FIFO only its owner can open, in a directory only its owner can enter', () => {
    const fifo = handoff.prepareFifo(dir);
    assert.ok(fs.statSync(fifo).isFIFO());
    assert.equal(fs.statSync(fifo).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  });

  it('removes what an interrupted launch left behind before making the next FIFO', () => {
    const stale = handoff.prepareFifo(dir);
    const next = handoff.prepareFifo(dir);
    assert.ok(!fs.existsSync(stale));
    assert.deepEqual(fs.readdirSync(dir), [path.basename(next)]);
  });

  it('delivers the credential into the launched command\'s environment, and to no argument list', async () => {
    const { credential } = handoff.mintCredential();
    const fifo = handoff.prepareFifo(dir);
    // The launched command reports the variable, then waits on a gate the test
    // opens, so its argument list is read while it is provably still running.
    const gate = path.join(dir, 'gate');
    execFileSync('mkfifo', [gate]);
    const launch = `printf '%s' "$${handoff.CREDENTIAL_ENV}"; cat '${gate}'`;
    const command = handoff.wrapLaunchCommand(launch, fifo);
    assert.ok(!command.includes(credential), 'the wrapped command names the FIFO, never the value');

    const { child, done } = runShell(command);
    const reported = new Promise((resolve) => child.stdout.once('data', resolve));
    const delivered = await handoff.deliverCredential(fifo, credential);
    assert.deepEqual(delivered, { delivered: true, code: 'delivered' });
    await reported;

    const during = argvOfTree(child.pid);
    assert.ok(during.includes(`cat ${gate}`), 'the launched command was observed running');
    assert.ok(!during.includes(credential), 'no process in the launch tree carries the value as an argument');
    fs.writeFileSync(gate, '');

    const result = await done;
    assert.equal(result.stdout, credential);
    assert.ok(!fs.existsSync(fifo), 'the FIFO is removed once used');
  });

  it('gives up when no pane ever opens the FIFO, and removes it', async () => {
    const { credential } = handoff.mintCredential();
    const fifo = handoff.prepareFifo(dir);
    const result = await handoff.deliverCredential(fifo, credential, { timeoutMs: 150 });
    assert.deepEqual(result, { delivered: false, code: 'no-reader' });
    assert.ok(!fs.existsSync(fifo));
  });

  it('lets the pane launch without a credential when the server never writes, and removes the FIFO', () => {
    const fifo = handoff.prepareFifo(dir);
    const started = Date.now();
    assert.equal(handoff.receiveCredential(fifo, { timeoutMs: 150 }), null);
    assert.ok(Date.now() - started < 3000, 'the wait is bounded');
    assert.ok(!fs.existsSync(fifo));
  });

  it('runs the launched command with an empty variable when the handoff never happens', async () => {
    const fifo = path.join(os.tmpdir(), `tc-handoff-missing-${process.pid}`);
    const command = handoff.wrapLaunchCommand(`printf '[%s]' "$${handoff.CREDENTIAL_ENV}"`, fifo);
    const { done } = runShell(command);
    const result = await done;
    assert.deepEqual(result, { code: 0, stdout: '[]' });
  });

  it('refuses a path that is not a FIFO, and a line that is not a credential', async () => {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'plain');
    fs.writeFileSync(file, `${handoff.mintCredential().credential}\n`);
    assert.equal(handoff.receiveCredential(file, { timeoutMs: 150 }), null);

    const fifo = handoff.prepareFifo(dir);
    const { done } = runShell(handoff.wrapLaunchCommand(`printf '[%s]' "$${handoff.CREDENTIAL_ENV}"`, fifo));
    await handoff.deliverCredential(fifo, 'not-a-credential');
    assert.equal((await done).stdout, '[]');
  });

  it('removing a FIFO twice is not an error', () => {
    const fifo = handoff.prepareFifo(dir);
    handoff.removeFifo(fifo);
    handoff.removeFifo(fifo);
    assert.ok(!fs.existsSync(fifo));
  });
});
