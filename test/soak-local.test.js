'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const local = require('../lib/soak/local');
const driver = require('../lib/soak/driver');
const sched = require('../lib/soak/schedule');

/**
 * A schedule with the given classes.
 * @param {string[]} classes - Classes to include
 * @param {string} [phase] - Phase
 * @returns {object} Schedule
 */
function schedule(classes, phase = 'certifying') {
  return sched.buildSchedule({ seed: 'local-guard', phase, durationMs: 6 * 60 * 60 * 1000, classes });
}

/**
 * A `runCommand` stand-in answering `sysctl` with the given value.
 * @param {string} vmm - What `kern.hv_vmm_present` prints
 * @returns {Function} Runner
 */
function sysctl(vmm) {
  return async (file, args) => {
    assert.equal(file, 'sysctl');
    assert.deepEqual(args, ['-n', 'kern.hv_vmm_present']);
    return { code: 0, stdout: `${vmm}\n`, stderr: '', error: null };
  };
}

describe('soak local control — which kinds need it', () => {
  it('counts every fault and browser kind as local, and no api or engine kind', () => {
    for (const k of [...sched.TASKS, ...sched.FAULTS]) {
      assert.equal(local.isLocalKind(k.kind), k.class === 'fault' || k.class === 'browser', k.kind);
    }
  });

  it('accepts only loopback IP literals', () => {
    for (const ok of ['http://127.0.0.1:3102', 'http://127.9.9.9:1', 'http://[::1]:3102', 'http://[::ffff:127.0.0.1]:3102']) assert.equal(local.isLoopbackLiteral(ok), true, ok);
    for (const bad of ['http://localhost:3102', 'http://10.0.0.1:3102', 'http://soak.localhost:1', 'http://[::2]:1', 'not a url']) assert.equal(local.isLoopbackLiteral(bad), false, bad);
  });
});

describe('soak local control — admission', () => {
  let home;
  beforeEach(() => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'soak-local-')));
    fs.writeFileSync(path.join(home, 'tangleclaw.db'), '');
  });
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

  const base = (over = {}) => ({ schedule: schedule(['api', 'fault']), noLiveInstall: true, apiBase: 'http://127.0.0.1:3102/', home, webdriver: undefined, ...over });

  it('needs nothing for a schedule with no local kind', async () => {
    const r = await local.requireLocalControl({ ...base(), schedule: schedule(['api', 'engine']), home: undefined }, { run: sysctl('0') });
    assert.equal(r, null);
  });

  it('refuses --home or --webdriver given for a schedule with no local kind', async () => {
    await assert.rejects(local.requireLocalControl({ ...base(), schedule: schedule(['api']) }, { run: sysctl('1') }), (e) => e.code === driver.REFUSAL.LOCAL_CONTROL_REFUSED);
  });

  it('admits a fault schedule in a VM with an owned home, and returns its context', async () => {
    const r = await local.requireLocalControl(base(), { run: sysctl('1') });
    assert.equal(r.home, home);
    assert.equal(r.dbPath, path.join(home, 'tangleclaw.db'));
    assert.equal(r.phase, 'certifying');
    assert.equal(r.webdriver, null);
    assert.equal(r.uid, process.getuid());
  });

  it('carries the destructive phase to the executors', async () => {
    const r = await local.requireLocalControl(base({ schedule: schedule(['api', 'fault'], 'destructive') }), { run: sysctl('1') });
    assert.equal(r.phase, 'destructive');
  });

  it('refuses outside a VM, naming it', async () => {
    await assert.rejects(local.requireLocalControl(base(), { run: sysctl('0') }), (e) => e.code === driver.REFUSAL.LOCAL_CONTROL_REFUSED && e.details.problems.some((p) => p.includes('not a virtual machine')));
  });

  it('refuses where sysctl cannot answer', async () => {
    const run = async () => ({ code: 1, stdout: '', stderr: 'unknown oid', error: '1' });
    await assert.rejects(local.requireLocalControl(base(), { run }), (e) => e.code === driver.REFUSAL.LOCAL_CONTROL_REFUSED);
  });

  it('refuses without --no-live-install', async () => {
    await assert.rejects(local.requireLocalControl(base({ noLiveInstall: false }), { run: sysctl('1') }), (e) => e.details.problems.some((p) => p.includes('--no-live-install')));
  });

  it('refuses a non-loopback or named --api', async () => {
    for (const apiBase of ['http://192.168.64.5:3102/', 'http://localhost:3102/']) {
      await assert.rejects(local.requireLocalControl(base({ apiBase }), { run: sysctl('1') }), (e) => e.details.problems.some((p) => p.includes('--api')), apiBase);
    }
  });

  it('refuses a missing, relative, or database-less --home', async () => {
    for (const h of [undefined, 'relative/home', path.join(home, 'nope')]) {
      await assert.rejects(local.requireLocalControl(base({ home: h }), { run: sysctl('1') }), (e) => e.details.problems.some((p) => p.includes('--home')), String(h));
    }
    fs.rmSync(path.join(home, 'tangleclaw.db'));
    await assert.rejects(local.requireLocalControl(base(), { run: sysctl('1') }), (e) => e.details.problems.some((p) => p.includes('tangleclaw.db')));
  });

  it('refuses a --home reached through a symlink, or whose database is a symlink', async () => {
    const link = `${home}-link`;
    fs.symlinkSync(home, link);
    try {
      await assert.rejects(local.requireLocalControl(base({ home: link }), { run: sysctl('1') }), (e) => e.details.problems.some((p) => p.includes('symlink')));
    } finally {
      fs.unlinkSync(link);
    }
    fs.renameSync(path.join(home, 'tangleclaw.db'), path.join(home, 'real.db'));
    fs.symlinkSync(path.join(home, 'real.db'), path.join(home, 'tangleclaw.db'));
    await assert.rejects(local.requireLocalControl(base(), { run: sysctl('1') }), (e) => e.details.problems.some((p) => p.includes('symlink')));
  });

  it('refuses a --home owned by another user', async () => {
    await assert.rejects(local.requireLocalControl(base(), { run: sysctl('1'), uid: process.getuid() + 1 }), (e) => e.details.problems.some((p) => p.includes('owned by uid')));
  });

  it('needs a loopback --webdriver for browser kinds, and refuses one without them', async () => {
    const withBrowser = schedule(['api', 'browser']);
    await assert.rejects(local.requireLocalControl(base({ schedule: withBrowser }), { run: sysctl('1') }), (e) => e.details.problems.some((p) => p.includes('--webdriver')));
    await assert.rejects(local.requireLocalControl(base({ schedule: withBrowser, webdriver: 'http://localhost:4444' }), { run: sysctl('1') }), (e) => e.details.problems.some((p) => p.includes('--webdriver')));
    const ok = await local.requireLocalControl(base({ schedule: withBrowser, webdriver: 'http://127.0.0.1:4444/' }), { run: sysctl('1') });
    assert.equal(ok.webdriver, 'http://127.0.0.1:4444');
    await assert.rejects(local.requireLocalControl(base({ webdriver: 'http://127.0.0.1:4444' }), { run: sysctl('1') }), (e) => e.details.problems.some((p) => p.includes('only for a schedule with browser')));
  });

  it('names every unmet condition at once', async () => {
    await assert.rejects(local.requireLocalControl(base({ noLiveInstall: false, apiBase: 'http://10.0.0.1/', home: undefined }), { run: sysctl('0') }), (e) => e.details.problems.length === 4);
  });
});

describe('soak local control — runCommand', () => {
  it('reports success, failure and a missing executable without throwing', async () => {
    const ok = await local.runCommand(process.execPath, ['-e', 'process.stdout.write("hi")']);
    assert.deepEqual([ok.code, ok.stdout, ok.error], [0, 'hi', null]);
    const bad = await local.runCommand(process.execPath, ['-e', 'process.exit(3)']);
    assert.equal(bad.code, 3);
    const missing = await local.runCommand('/nonexistent/soak-binary', []);
    assert.equal(missing.code, null);
    assert.equal(missing.error, 'ENOENT');
  });

  it('kills a command past its timeout and says so', async () => {
    const r = await local.runCommand(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 200 });
    assert.equal(r.error, 'timeout');
  });
});
