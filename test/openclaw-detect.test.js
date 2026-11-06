'use strict';

// Tests for #306-followup (PR B) — auto-detect an OpenClaw connection's
// instanceDir over SSH. Covers the pure helpers (shape guards, output parsing,
// command build) with a mocked exec, the handler's error/empty/success paths,
// and the frontend wiring (Detect button + handler) via source assertions.

const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const detect = require('../lib/openclaw-detect');

const GOOD = { host: '192.0.2.10', sshUser: 'deploy-user', sshKeyPath: '~/.ssh/openclaw_key' };

describe('openclaw-detect (#306-followup)', () => {
  describe('unsafeReason', () => {
    it('accepts a well-formed target', () => {
      assert.equal(detect.unsafeReason(GOOD), null);
    });
    it('requires host, sshUser, and sshKeyPath', () => {
      assert.match(detect.unsafeReason({ host: 'h', sshUser: 'u' }), /required/);
      assert.match(detect.unsafeReason(null), /required/);
    });
    it('rejects shell-metacharacter injection in each field', () => {
      assert.match(detect.unsafeReason({ ...GOOD, host: '10.0.0.1; rm -rf /' }), /host/);
      assert.match(detect.unsafeReason({ ...GOOD, sshUser: 'a$(whoami)' }), /sshUser/);
      assert.match(detect.unsafeReason({ ...GOOD, sshKeyPath: '~/.ssh/k`id`' }), /sshKeyPath/);
    });
    it('accepts IPv6 hosts and tailscale names', () => {
      assert.equal(detect.unsafeReason({ ...GOOD, host: 'fd7a::1' }), null);
      assert.equal(detect.unsafeReason({ ...GOOD, host: 'example-host.tailnet-name.ts.net' }), null);
    });
  });

  describe('parseDirs', () => {
    it('keeps absolute paths, trims, and dedups', () => {
      const out = '/home/dev/workspace/openclaw\n/home/dev/workspace/openclaw\n  /Users/deploy-user/openclaw  \n';
      assert.deepEqual(detect.parseDirs(out), ['/home/dev/workspace/openclaw', '/Users/deploy-user/openclaw']);
    });
    it('drops non-absolute noise lines and handles empty/bad input', () => {
      assert.deepEqual(detect.parseDirs('docker not accessible\nopenclaw-* \n'), []);
      assert.deepEqual(detect.parseDirs(''), []);
      assert.deepEqual(detect.parseDirs(null), []);
    });
  });

  describe('_buildSshCmd', () => {
    it('expands a leading ~ in the key path and runs remote sh with no tty', () => {
      const cmd = detect._buildSshCmd(GOOD);
      assert.ok(!cmd.includes('-i "~/.ssh'), 'leading ~ must be expanded to $HOME');
      assert.match(cmd, /ssh -T .*-o BatchMode=yes/);
      assert.match(cmd, /deploy-user@192\.0\.2\.10 sh$/);
    });
  });

  describe('DISCOVERY_SCRIPT', () => {
    it('uses both the docker compose label and a bounded candidate-path scan', () => {
      assert.match(detect.DISCOVERY_SCRIPT, /com\.docker\.compose\.project\.working_dir/);
      assert.match(detect.DISCOVERY_SCRIPT, /OPENCLAW_IMAGE=/);
      // Bounded scan — must NOT shell out to an unbounded recursive grep.
      assert.doesNotMatch(detect.DISCOVERY_SCRIPT, /grep -r/);
    });
  });

  describe('detectInstanceDir', () => {
    let calls;
    const orig = detect._internal.exec;
    beforeEach(() => { calls = []; });
    afterEach(() => { detect._internal.exec = orig; });

    it('refuses an unsafe target without running ssh', async () => {
      detect._internal.exec = (...a) => { calls.push(a); return ''; };
      const r = await detect.detectInstanceDir({ ...GOOD, host: 'h;evil' });
      assert.deepEqual(r.dirs, []);
      assert.match(r.error, /host/);
      assert.equal(calls.length, 0, 'ssh must not run for an unsafe target');
    });

    it('feeds the discovery script over stdin and returns parsed dirs', async () => {
      detect._internal.exec = (cmd, opts) => {
        calls.push({ cmd, opts });
        return '/Users/deploy-user/openclaw\n';
      };
      const r = await detect.detectInstanceDir(GOOD);
      assert.deepEqual(r.dirs, ['/Users/deploy-user/openclaw']);
      assert.equal(r.error, null);
      assert.equal(calls[0].opts.input, detect.DISCOVERY_SCRIPT, 'script is passed via stdin, not interpolated');
    });

    it('reports a clean "not found" when discovery yields nothing', async () => {
      detect._internal.exec = () => '\n';
      const r = await detect.detectInstanceDir(GOOD);
      assert.deepEqual(r.dirs, []);
      assert.match(r.error, /no OpenClaw stack directory found/i);
    });

    it('surfaces an ssh failure as an error without throwing', async () => {
      detect._internal.exec = () => { const e = new Error('boom'); e.stderr = 'Permission denied'; throw e; };
      const r = await detect.detectInstanceDir(GOOD);
      assert.deepEqual(r.dirs, []);
      assert.match(r.error, /ssh detect failed: Permission denied/);
    });
  });

  describe('DEFAULT_HEALTH_THRESHOLDS (#128)', () => {
    it('matches the documented defaults, frozen', () => {
      assert.deepEqual(detect.DEFAULT_HEALTH_THRESHOLDS, { warnCpuPct: 60, alarmCpuPct: 90, warnMemPct: 80, alarmMemPct: 95 });
      assert.ok(Object.isFrozen(detect.DEFAULT_HEALTH_THRESHOLDS));
    });
  });

  describe('parseRuntimeTelemetry (#128)', () => {
    it('parses a docker-mode probe, including human-unit memUsage into bytes', () => {
      const t = detect.parseRuntimeTelemetry(
        'mode=docker\ncpuPct=12.50\nmemPct=19.53\nmemUsage=104.9MiB / 536.9MiB\ncontainerHealthy=true\n'
        + 'stuckSessions=0\nlockHoldCount=0\nlockHoldMaxMs=\n'
      );
      assert.equal(t.mode, 'docker');
      assert.equal(t.cpuPct, 12.5);
      assert.equal(t.memPct, 19.53);
      assert.equal(t.memUsedBytes, Math.round(104.9 * 1024 * 1024));
      assert.equal(t.memLimitBytes, Math.round(536.9 * 1024 * 1024));
      assert.equal(t.containerHealthy, true);
      assert.equal(t.lockHoldMaxMs, 0, 'a blank field falls back to 0, not NaN');
    });

    it('parses a host-mode probe, where memUsedBytes arrives as a direct number', () => {
      const t = detect.parseRuntimeTelemetry('mode=host\ncpuPct=3.20\nmemPct=1.10\nmemUsedBytes=1048576\n');
      assert.equal(t.mode, 'host');
      assert.equal(t.cpuPct, 3.2);
      assert.equal(t.memUsedBytes, 1048576);
      assert.equal(t.memLimitBytes, null, 'host mode has no container limit');
      assert.equal(t.containerHealthy, null, 'host mode never reports a container health status');
    });

    it('is never-throw: empty, garbled, or non-string input yields mode unknown with null/0 fields', () => {
      for (const bad of ['', 'garbage with no equals signs', null, undefined, 42]) {
        const t = detect.parseRuntimeTelemetry(bad);
        assert.equal(t.mode, 'unknown');
        assert.equal(t.cpuPct, null);
        assert.equal(t.stuckSessions, 0);
      }
    });

    it('reports an unhealthy container distinctly from a healthy one', () => {
      assert.equal(detect.parseRuntimeTelemetry('mode=docker\ncontainerHealthy=false\n').containerHealthy, false);
      assert.equal(detect.parseRuntimeTelemetry('mode=docker\ncontainerHealthy=true\n').containerHealthy, true);
    });
  });

  describe('evaluateOpenclawHealth (#128 acceptance #5)', () => {
    const base = { cpuPct: 10, memPct: 10, stuckSessions: 0, lockHoldCount: 0, containerHealthy: true };

    it('is ok when every signal is clean', () => {
      const h = detect.evaluateOpenclawHealth(base);
      assert.equal(h.level, 'ok');
      assert.equal(h.healthSummary, 'no pathology detected');
    });

    it('warns on cpuPct > 60, memPct > 80, or stuckSessions > 0 — each independently', () => {
      assert.equal(detect.evaluateOpenclawHealth({ ...base, cpuPct: 61 }).level, 'warn');
      assert.equal(detect.evaluateOpenclawHealth({ ...base, memPct: 81 }).level, 'warn');
      assert.equal(detect.evaluateOpenclawHealth({ ...base, stuckSessions: 1 }).level, 'warn');
    });

    it('alarms on cpuPct > 90, memPct > 95, lockHoldCount > 0, or containerHealthy:false — each independently', () => {
      assert.equal(detect.evaluateOpenclawHealth({ ...base, cpuPct: 91 }).level, 'alarm');
      assert.equal(detect.evaluateOpenclawHealth({ ...base, memPct: 96 }).level, 'alarm');
      assert.equal(detect.evaluateOpenclawHealth({ ...base, lockHoldCount: 1 }).level, 'alarm');
      assert.equal(detect.evaluateOpenclawHealth({ ...base, containerHealthy: false }).level, 'alarm');
    });

    it('alarm wins over warn when both would independently apply', () => {
      // cpuPct 91 alarms; memPct 81 would only warn — the worse one must win.
      const h = detect.evaluateOpenclawHealth({ ...base, cpuPct: 91, memPct: 81 });
      assert.equal(h.level, 'alarm');
      assert.match(h.healthSummary, /CPU 91/);
      assert.doesNotMatch(h.healthSummary, /memory 81/, 'the warn-only reason must not also appear once alarm wins');
    });

    it('respects custom thresholds over the defaults', () => {
      const h = detect.evaluateOpenclawHealth({ ...base, cpuPct: 50 }, { warnCpuPct: 40, alarmCpuPct: 70, warnMemPct: 80, alarmMemPct: 95 });
      assert.equal(h.level, 'warn');
    });

    it('is unverified, never ok, when no process was found (mode=host with no metrics) (I-Gate Round 1 Finding 2, #5799301385)', () => {
      const h = detect.evaluateOpenclawHealth(detect.parseRuntimeTelemetry('mode=host\n'));
      assert.equal(h.level, 'unverified');
      assert.equal(h.resourceSummary, 'unavailable');
      assert.equal(h.healthSummary, 'telemetry unavailable');
      assert.deepEqual(h.reasons, ['no runtime metrics measured']);
    });

    it('is unverified, never ok, when Docker stats emitted no metric lines (mode=docker with no metrics)', () => {
      const h = detect.evaluateOpenclawHealth(detect.parseRuntimeTelemetry('mode=docker\n'));
      assert.equal(h.level, 'unverified');
    });

    it('is unverified for a null/undefined telemetry argument', () => {
      assert.equal(detect.evaluateOpenclawHealth(null).level, 'unverified');
      assert.equal(detect.evaluateOpenclawHealth(undefined).level, 'unverified');
    });

    it('is unverified for mode=unknown even if a stray metric field were present', () => {
      assert.equal(detect.evaluateOpenclawHealth({ mode: 'unknown', cpuPct: 5, memPct: 5, memUsedBytes: 100 }).level, 'unverified');
    });

    it('is NOT unverified once at least one real metric is present', () => {
      assert.equal(detect.evaluateOpenclawHealth(detect.parseRuntimeTelemetry('mode=host\ncpuPct=3.2\n')).level, 'ok');
      assert.equal(detect.evaluateOpenclawHealth(detect.parseRuntimeTelemetry('mode=host\nmemUsedBytes=1048576\n')).level, 'ok');
    });
  });

  describe('detectRuntimeAndStats (#128)', () => {
    const orig = detect._internal.exec;
    afterEach(() => { detect._internal.exec = orig; });

    it('refuses an unsafe target without running ssh', async () => {
      let ran = false;
      detect._internal.exec = () => { ran = true; return ''; };
      const r = await detect.detectRuntimeAndStats({ ...GOOD, host: 'h;evil' });
      assert.equal(r.mode, 'unknown');
      assert.match(r.error, /host/);
      assert.equal(ran, false, 'ssh must not run for an unsafe target');
    });

    it('feeds RUNTIME_STATS_SCRIPT over stdin and returns parsed telemetry + health', async () => {
      let seenInput = null;
      detect._internal.exec = (cmd, opts) => {
        seenInput = opts.input;
        return 'mode=docker\ncpuPct=12.5\nmemPct=19.53\ncontainerHealthy=true\nstuckSessions=0\nlockHoldCount=0\nlockHoldMaxMs=0\n';
      };
      const r = await detect.detectRuntimeAndStats(GOOD);
      assert.equal(r.mode, 'docker');
      assert.equal(r.error, null);
      assert.equal(r.telemetry.cpuPct, 12.5);
      assert.equal(r.health.level, 'ok');
      assert.equal(seenInput, detect.RUNTIME_STATS_SCRIPT, 'script is passed via stdin, not interpolated');
    });

    it('surfaces an ssh failure as an error without throwing', async () => {
      detect._internal.exec = () => { const e = new Error('boom'); e.stderr = 'Permission denied'; throw e; };
      const r = await detect.detectRuntimeAndStats(GOOD);
      assert.equal(r.mode, 'unknown');
      assert.equal(r.telemetry, null);
      assert.match(r.error, /ssh stats failed: Permission denied/);
    });
  });

  describe('RUNTIME_STATS_SCRIPT (#128)', () => {
    it('detects both branches and bounds the log scan — no unbounded tail', () => {
      assert.match(detect.RUNTIME_STATS_SCRIPT, /docker stats --no-stream/);
      assert.match(detect.RUNTIME_STATS_SCRIPT, /ps -o pcpu=,pmem=,rss=/);
      assert.match(detect.RUNTIME_STATS_SCRIPT, /--since 5m/);
      assert.doesNotMatch(detect.RUNTIME_STATS_SCRIPT, /grep -r/);
    });
  });

  describe('frontend wiring (public/ui.js + index.html)', () => {
    let ui, html;
    before(() => {
      ui = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
      html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    });
    it('renders a Detect button beside the Instance Dir input', () => {
      assert.match(html, /id="ocDetectBtn"/);
      assert.match(html, /class="oc-detect-row"/);
    });
    it('defines detectOcInstanceDir, posts to the detect endpoint, and wires the button', () => {
      assert.match(ui, /async function detectOcInstanceDir\(\)/);
      assert.match(ui, /apiMutate\('\/api\/openclaw\/detect-instance-dir', 'POST'/);
      assert.match(ui, /\$\('ocDetectBtn'\)\.addEventListener\('click', detectOcInstanceDir\)/);
    });
    it('guards on the SSH fields before calling out', () => {
      assert.match(ui, /Fill Host, SSH User, and SSH Key Path first/);
    });
  });
});
