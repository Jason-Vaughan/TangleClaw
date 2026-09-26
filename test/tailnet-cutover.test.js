'use strict';

// #1905 Chunk 2 (Architect rulings A18, A21): the caddy-mode tailnet move.
// Pins the apply's refusals, the strict health rule (200 + status "ok" only,
// with the certificate carrying the candidate name), the retry loop, an honest
// rollback result under each injected failure, and that the cert union, the
// allowlist, the operator link and the Caddy site name the same host before
// prepare, after prepare, after apply and after a rollback.

const { describe, it, before, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { setLevel } = require('../lib/logger');
const store = require('../lib/store');
const hostInventory = require('../lib/host-inventory');
const httpsSetup = require('../lib/https-setup');
const sessionOwnership = require('../lib/session-ownership');
const tc = require('../lib/tailnet-cutover');
const cutover = require('../scripts/ingress-cutover');

setLevel('error');

const OLD = 'old.tail123.ts.net';
const NEW = 'box.tail123.ts.net';

describe('validateTailnetApply', () => {
  const base = {
    requested: NEW,
    config: { caddyTailnetHost: OLD, ingressMode: 'caddy' },
    observation: { host: NEW },
    certHosts: ['localhost', OLD, NEW],
    gated: true
  };

  it('accepts a gated move to the observed name the certificate carries, normalizing case and dots', () => {
    const v = tc.validateTailnetApply({ ...base, requested: 'Box.Tail123.TS.net.' });
    assert.deepEqual(v, { ok: true, host: NEW, from: OLD });
  });

  it('accepts creating the site for a detected name when none is configured', () => {
    const v = tc.validateTailnetApply({ ...base, config: { ingressMode: 'caddy' } });
    assert.deepEqual(v, { ok: true, host: NEW, from: null });
  });

  for (const [label, patch, code] of [
    ['a direct-mode install', { config: { caddyTailnetHost: OLD, ingressMode: 'direct' } }, tc.TAILNET_CODES.NOT_CADDY_MODE],
    ['an install with no ingress mode set', { config: { caddyTailnetHost: OLD } }, tc.TAILNET_CODES.NOT_CADDY_MODE],
    ['an invalid name', { requested: 'not a host' }, tc.TAILNET_CODES.INVALID_NAME],
    ['a name the overlay does not report now', { observation: { host: 'other.tail123.ts.net' } }, tc.TAILNET_CODES.NOT_OBSERVED],
    ['no observation at all', { observation: { host: null, reason: 'tailscale: unavailable' } }, tc.TAILNET_CODES.NOT_OBSERVED],
    ['the name already configured', { config: { caddyTailnetHost: `${NEW}.`, ingressMode: 'caddy' } }, tc.TAILNET_CODES.NO_CHANGE],
    ['an ungated install', { gated: false }, tc.TAILNET_CODES.UNGATED],
    ['a certificate that lacks the name (prepare not run)', { certHosts: ['localhost', OLD] }, tc.TAILNET_CODES.CERT_MISSING]
  ]) {
    it(`refuses ${label}`, () => {
      const v = tc.validateTailnetApply({ ...base, ...patch });
      assert.equal(v.ok, false);
      assert.equal(v.code, code);
      assert.ok(v.reason);
    });
  }

  it('names prepare as the remedy for a missing certificate name', () => {
    const v = tc.validateTailnetApply({ ...base, certHosts: [OLD] });
    assert.match(v.reason, /"reconcileTailnet": "prepare"/);
  });
});

/**
 * A fake `https.request` answering with the given status, body and peer SANs.
 * @param {object} answer
 * @returns {{request: Function, calls: Array<object>}}
 */
function fakeRequest({ statusCode = 200, body = '{"status":"ok"}', sans = null, error = null }) {
  const calls = [];
  const request = (opts, onRes) => {
    calls.push(opts);
    const req = new EventEmitter();
    req.end = () => setImmediate(() => {
      if (error) { req.emit('error', new Error(error)); return; }
      const res = new EventEmitter();
      res.statusCode = statusCode;
      res.setEncoding = () => {};
      res.socket = { getPeerCertificate: () => (sans === null ? {} : { subjectaltname: sans }) };
      onRes(res);
      res.emit('data', body);
      res.emit('end');
    });
    req.destroy = (err) => req.emit('error', err);
    return req;
  };
  return { request, calls };
}

describe('strictHealth', () => {
  const local = { url: 'https://localhost:8443/api/health' };
  const site = { url: 'https://127.0.0.1:8443/api/health', servername: NEW };

  it('is healthy only on HTTP 200 with status "ok"', async () => {
    const r = await tc.strictHealth(local, { request: fakeRequest({}).request });
    assert.equal(r.ok, true);
  });

  for (const [label, answer] of [
    ['a 503', { statusCode: 503, body: '{"status":"degraded"}' }],
    ['a degraded 200', { statusCode: 200, body: '{"status":"degraded"}' }],
    ['an unreadable body', { statusCode: 200, body: 'not json' }],
    ['a connection error', { error: 'ECONNREFUSED' }]
  ]) {
    it(`is not healthy on ${label}`, async () => {
      const r = await tc.strictHealth(local, { request: fakeRequest(answer).request });
      assert.equal(r.ok, false);
      assert.ok(r.error);
    });
  }

  it('settles as unhealthy when the response aborts mid-body', async () => {
    const request = (opts, onRes) => {
      const req = new EventEmitter();
      req.end = () => setImmediate(() => {
        const res = new EventEmitter();
        res.statusCode = 200;
        res.setEncoding = () => {};
        onRes(res);
        res.emit('data', '{"sta');
        res.emit('error', new Error('aborted'));
      });
      req.destroy = () => {};
      return req;
    };
    const r = await tc.strictHealth(local, { request });
    assert.equal(r.ok, false);
    assert.match(r.error, /aborted/);
  });

  it('presents the candidate as SNI and Host, and needs the served cert to carry it', async () => {
    const good = fakeRequest({ sans: `DNS:localhost, DNS:${NEW}` });
    const r = await tc.strictHealth(site, { request: good.request });
    assert.equal(r.ok, true);
    assert.equal(good.calls[0].host, '127.0.0.1');
    assert.equal(good.calls[0].servername, NEW);
    assert.equal(good.calls[0].headers.Host, `${NEW}:8443`);

    const wrong = await tc.strictHealth(site, { request: fakeRequest({ sans: 'DNS:localhost' }).request });
    assert.equal(wrong.ok, false, 'a healthy answer from the wrong site is not the new site');
    assert.match(wrong.error, /does not carry/);
  });
});

describe('verifyTailnetApply', () => {
  const checks = [{ label: 'local' }, { label: NEW }];

  it('passes only when every check is healthy in the same round', async () => {
    let n = 0;
    const probe = async (c) => { n += 1; return { ok: c.label === 'local' || n > 3 }; };
    const r = await tc.verifyTailnetApply(checks, { tries: 5, probe, sleep: async () => {} });
    assert.equal(r.ok, true);
    assert.equal(r.rounds, 2);
  });

  it('fails once the tries run out, having slept between rounds', async () => {
    let sleeps = 0;
    const r = await tc.verifyTailnetApply(checks, {
      tries: 3, probe: async () => ({ ok: false, error: 'down' }), sleep: async () => { sleeps += 1; }
    });
    assert.equal(r.ok, false);
    assert.equal(r.rounds, 3);
    assert.equal(sleeps, 2);
    assert.match(tc.describeChecks(r.last), /local: down/);
  });
});

describe('rollbackTailnetApply', () => {
  const PRIOR = Buffer.from('prior caddyfile\n');

  /**
   * Effects over an in-memory Caddyfile and config, with injectable failures.
   * @param {object} [fail]
   * @returns {object}
   */
  function effects(fail = {}) {
    const state = { file: Buffer.from('new caddyfile\n'), host: NEW };
    return {
      state,
      restoreCaddyfile: (b) => { if (fail.caddyfile) throw new Error('EACCES'); state.file = b; },
      readCaddyfile: () => (fail.caddyfileReadback ? Buffer.from('other') : state.file),
      restoreConfig: (h) => { if (fail.config) throw new Error('EROFS'); state.host = h; },
      readTailnetHost: () => (fail.configReadback ? NEW : state.host),
      reload: () => { if (fail.reload) throw new Error('launchctl load failed'); },
      verifyLocal: async () => (fail.health
        ? { ok: false, last: [{ label: 'local', ok: false, error: 'HTTP 503' }] }
        : { ok: true, last: [] })
    };
  }
  const args = (e, prior = PRIOR) => ({
    caddyfilePath: '/b/Caddyfile', priorCaddyfile: prior, priorTailnetHost: OLD,
    backupPath: '/b/Caddyfile.tailnet-x.bak', effects: e
  });

  it('reports rolledBack only when the Caddyfile, the config and the reload are all proven restored', async () => {
    const e = effects();
    const r = await tc.rollbackTailnetApply(args(e));
    assert.equal(r.rolledBack, true);
    assert.equal(r.recovery, null);
    assert.ok(e.state.file.equals(PRIOR));
    assert.equal(e.state.host, OLD);
  });

  it('removes a Caddyfile that did not exist before', async () => {
    const e = effects();
    const r = await tc.rollbackTailnetApply(args(e, null));
    assert.equal(r.rolledBack, true);
    assert.equal(e.state.file, null);
  });

  for (const [label, fail, part, recovery] of [
    ['the Caddyfile write fails', { caddyfile: true }, 'caddyfile', /copy \/b\/Caddyfile\.tailnet-x\.bak back/],
    ['the Caddyfile reads back different', { caddyfileReadback: true }, 'caddyfile', /copy .* back/],
    ['the config save fails', { config: true }, 'caddyTailnetHost', /"caddyTailnetHost" back to "old/],
    ['the config reads back unchanged', { configReadback: true }, 'caddyTailnetHost', /caddyTailnetHost/],
    ['the reload fails', { reload: true }, 'reload', /ingress-cutover\.js --to caddy/],
    ['the reloaded site is unhealthy', { health: true }, 'reload', /ingress-cutover\.js --to caddy/]
  ]) {
    it(`is a typed non-success when ${label}, naming the residual and the recovery`, async () => {
      const r = await tc.rollbackTailnetApply(args(effects(fail)));
      assert.equal(r.rolledBack, false);
      assert.match(r.residual[part], /^NOT restored/);
      assert.match(r.recovery, recovery);
      assert.match(r.recovery, /node scripts\/ingress-cutover\.js --to caddy/);
      for (const [k, v] of Object.entries(r.residual)) {
        if (k !== part) assert.equal(v, 'restored', `${k} is reported on its own`);
      }
    });
  }
});

describe('the cutover carries the move', () => {
  it('parses --tailnet-host only with --to caddy', () => {
    assert.equal(cutover.parseArgs(['--to', 'caddy', '--tailnet-host', NEW]).tailnetHost, NEW);
    assert.equal(cutover.parseArgs(['--to', 'direct', '--tailnet-host', NEW]).target, null,
      'a direct run writes no Caddyfile, so there is no site to move');
    assert.equal('tailnetHost' in cutover.parseArgs(['--to', 'caddy']), false,
      'without the flag the parsed shape is unchanged');
  });

  it('exposes stable result codes for the refusal and both apply outcomes', () => {
    assert.equal(cutover.CUTOVER_CODES.TAILNET_REFUSED, 'tailnet-refused');
    assert.equal(cutover.CUTOVER_CODES.TAILNET_ROLLED_BACK, 'tailnet-rolled-back');
    assert.equal(cutover.CUTOVER_CODES.TAILNET_ROLLBACK_FAILED, 'tailnet-rollback-failed');
  });

  it('writes rolledBack, residual and recovery to the result file', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tailnet-result-'));
    const file = path.join(dir, 'r.json');
    try {
      cutover.writeCutoverResult(file, {
        ok: false, code: 'tailnet-rollback-failed', target: 'caddy', error: 'x',
        tailnetHost: NEW, rolledBack: false,
        residual: { caddyfile: 'restored', caddyTailnetHost: 'NOT restored: EROFS', reload: 'restored' },
        recovery: 'set "caddyTailnetHost" back'
      });
      const r = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(r.tailnetHost, NEW);
      assert.equal(r.rolledBack, false);
      assert.equal(r.residual.caddyTailnetHost, 'NOT restored: EROFS');
      assert.equal(r.recovery, 'set "caddyTailnetHost" back');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('decides a rolled-back result by rolledBack alone, and routes the refusal before any write', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'ingress-cutover.js'), 'utf8');
    const refusal = src.indexOf('CUTOVER_CODES.TAILNET_REFUSED, verdict.reason');
    const firstWrite = src.indexOf('fs.writeFileSync(plan.caddyfile.path, plan.caddyfile.content');
    assert.ok(refusal > 0 && refusal < firstWrite, 'validation must end the run before the Caddyfile is written');
    assert.match(src, /if \(rollback\.rolledBack\) \{[\s\S]*TAILNET_ROLLED_BACK[\s\S]*TAILNET_ROLLBACK_FAILED/);
  });
});

describe('parity across prepare, apply and rollback (R46)', () => {
  const TEMPLATES = {
    ttyd: fs.readFileSync(path.join(__dirname, '..', 'deploy', 'com.tangleclaw.ttyd.plist'), 'utf8'),
    caddy: fs.readFileSync(path.join(__dirname, '..', 'deploy', 'com.tangleclaw.caddy.plist'), 'utf8')
  };
  const GATED = {
    serverPort: 3101, ttydPort: 3100, caddyHttpsPort: 8443, caddyHttpPort: 8080,
    authEnabled: true, basicAuthUser: 'tcadmin', basicAuthHash: '$2a$14$abcdefghijklmnopqrstuv'
  };
  let realExec;
  let tmpDir;

  /**
   * The tailnet site name a cutover would write for this config.
   * @param {object} config
   * @param {string} [tailnetHost] - A `--tailnet-host` override.
   * @returns {string|null}
   */
  function caddySite(config, tailnetHost) {
    const plan = cutover.planCutover('caddy', {
      config, env: { caddyPath: '/c', ttydPath: '/t', home: '/h', baseDir: '/b', repoDir: '/r',
        launchdPath: '/bin', launchAgentsDir: '/h/L', uid: 501 },
      upstreamPort: 3102, certPath: '/c/cert.pem', keyPath: '/c/key.pem',
      caddyfilePath: '/b/Caddyfile', socketPath: '/b/run/ttyd.sock',
      ttydTemplate: TEMPLATES.ttyd, caddyTemplate: TEMPLATES.caddy, lanHost: null,
      ...(tailnetHost ? { tailnetHost } : {})
    });
    const m = plan.caddyfile.content.match(/^([a-z0-9.-]+\.ts\.net) \{$/m);
    return { site: m ? m[1] : null, patch: plan.configPatch };
  }

  /**
   * Every consumer's answer for a config.
   * @param {object} config
   * @param {string[]} certHosts - The certificate's names in that state.
   * @returns {object}
   */
  function consumers(config, certHosts) {
    const canonical = hostInventory.resolveTailnetHost(config).host;
    return {
      canonical,
      cert: certHosts.includes(canonical),
      allowlist: httpsSetup.servedHostAllowlist(config, { certHosts }).has(canonical),
      link: sessionOwnership.resolveOperatorHost({}, config).host,
      caddy: caddySite(config).site
    };
  }

  before(() => {
    realExec = hostInventory._internal.execSync;
    hostInventory._internal.execSync = () => JSON.stringify({ Self: { DNSName: `${NEW}.` } });
    sessionOwnership._resetHostCacheForTest();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tailnet-parity-'));
    store._setBasePath(tmpDir);
    store.init();
  });
  after(() => {
    hostInventory._internal.execSync = realExec;
    sessionOwnership._resetHostCacheForTest();
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  afterEach(() => sessionOwnership._resetHostCacheForTest());

  const before_ = { ...GATED, caddyTailnetHost: OLD };

  it('drift, before prepare: every consumer names the configured host', () => {
    const c = consumers(before_, ['localhost', OLD]);
    assert.deepEqual(c, { canonical: OLD, cert: true, allowlist: true, link: OLD, caddy: OLD });
  });

  it('after prepare: nothing flips, and the transition cert already covers both', () => {
    const certHosts = ['localhost', OLD, NEW];
    const c = consumers(before_, certHosts);
    assert.deepEqual(c, { canonical: OLD, cert: true, allowlist: true, link: OLD, caddy: OLD });
    assert.ok(certHosts.includes(NEW));
  });

  it('apply: the Caddy site and caddyTailnetHost move in the same config patch, then all agree', () => {
    const planned = caddySite(before_, NEW);
    assert.equal(planned.site, NEW);
    assert.equal(planned.patch.caddyTailnetHost, NEW, 'the config flip rides the transaction');
    const afterApply = { ...before_, ...planned.patch };
    const c = consumers(afterApply, ['localhost', OLD, NEW]);
    assert.deepEqual(c, { canonical: NEW, cert: true, allowlist: true, link: NEW, caddy: NEW });
  });

  it('after a driven failed apply, the rollback puts every consumer back on the configured host', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tailnet-run-'));
    try {
      const run = await drive({ dir, verifyResults: [false, true] });
      assert.equal(run.code, cutover.CUTOVER_CODES.TAILNET_ROLLED_BACK);
      assert.equal(run.extra.rolledBack, true);
      const cfg = run.configStore.load();
      assert.equal(cfg.caddyTailnetHost, OLD, 'the config was really restored');
      assert.equal(fs.readFileSync(run.caddyfilePath, 'utf8'), 'prior\n', 'the Caddyfile was really restored');
      // The store here holds only the keys the apply moves; the gate lives in the base config.
      const c = consumers({ ...GATED, ...cfg }, ['localhost', OLD, NEW]);
      assert.deepEqual(c, { canonical: OLD, cert: true, allowlist: true, link: OLD, caddy: OLD });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Drive `runTailnetVerification` against a real temp Caddyfile and an in-memory
 * config store, as a `--tailnet-host` apply leaves them just before step 6.
 *
 * @param {object} args
 * @param {string} args.dir - Temp directory.
 * @param {boolean[]} args.verifyResults - What successive verify calls answer.
 * @param {Function} [args.execFile] - launchctl stand-in.
 * @returns {Promise<object>}
 */
async function drive({ dir, verifyResults, execFile = () => {} }) {
  const caddyfilePath = path.join(dir, 'Caddyfile');
  const backup = path.join(dir, 'Caddyfile.tailnet-x.bak');
  fs.writeFileSync(caddyfilePath, 'moved\n');
  fs.writeFileSync(backup, 'prior\n');
  let saved = { ingressMode: 'caddy', caddyTailnetHost: NEW };
  const configStore = { load: () => ({ ...saved }), save: (c) => { saved = { ...c }; } };
  const calls = [];
  let n = 0;
  const verify = async (checks) => {
    const ok = verifyResults[Math.min(n, verifyResults.length - 1)];
    n += 1;
    return { ok, rounds: 1, last: checks.map((c) => ({ label: c.label, ok, error: ok ? null : 'HTTP 503' })) };
  };
  const out = {};
  await cutover.runTailnetVerification({
    plan: {
      healthUrl: 'https://localhost:8443/api/health',
      caddyfile: { path: caddyfilePath },
      plists: [{ path: '/L/com.tangleclaw.caddy.plist' }, { path: '/L/com.tangleclaw.ttyd.plist' }],
      launchctl: [['kickstart', '-k', 'gui/501/com.tangleclaw.server']]
    },
    ctx: { tailnetHost: NEW, priorTailnetHost: OLD },
    localCheck: { label: 'local', url: 'https://localhost:8443/api/health' },
    siteCheck: { label: NEW, url: 'https://127.0.0.1:8443/api/health', servername: NEW },
    priorCaddyfile: Buffer.from('prior\n'),
    tailnetBackup: backup,
    finish: (code, error, extra) => Object.assign(out, { code, error, extra }),
    deps: { verify, configStore, execFile: (...a) => { calls.push(a); return execFile(...a); } }
  });
  return { ...out, configStore, caddyfilePath, backup, calls };
}

describe('runTailnetVerification, driven', () => {
  let dir;
  before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-tailnet-drive-')); });
  after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const fresh = () => fs.mkdtempSync(path.join(dir, 'r-'));

  it('a healthy move finishes ok, keeps the new config and drops the backup', async () => {
    const run = await drive({ dir: fresh(), verifyResults: [true] });
    assert.equal(run.code, cutover.CUTOVER_CODES.OK);
    assert.equal(run.error, null);
    assert.equal(run.configStore.load().caddyTailnetHost, NEW);
    assert.equal(fs.existsSync(run.backup), false, 'a backup that may hold a credential is not left behind');
    assert.equal(run.calls.length, 0, 'no reload on success');
  });

  it('an unhealthy move rolls back the Caddyfile, the config and the reload, and reports it', async () => {
    const run = await drive({ dir: fresh(), verifyResults: [false, true] });
    assert.equal(run.code, cutover.CUTOVER_CODES.TAILNET_ROLLED_BACK);
    assert.ok(run.error, 'a rolled-back move is not a success');
    assert.deepEqual(run.extra.residual, { caddyfile: 'restored', caddyTailnetHost: 'restored', reload: 'restored' });
    assert.equal(run.configStore.load().caddyTailnetHost, OLD);
    assert.equal(fs.readFileSync(run.caddyfilePath, 'utf8'), 'prior\n');
    assert.deepEqual(run.calls.map((c) => c[1][0]), ['unload', 'load', 'kickstart'], 'Caddy and the server are reloaded');
    assert.equal(fs.existsSync(run.backup), false);
  });

  it('a reload that fails is a typed rollback failure that keeps the backup and names the recovery', async () => {
    const run = await drive({
      dir: fresh(),
      verifyResults: [false, true],
      execFile: (_bin, args) => { if (args[0] === 'load') throw new Error('Load failed: 5: Input/output error'); }
    });
    assert.equal(run.code, cutover.CUTOVER_CODES.TAILNET_ROLLBACK_FAILED);
    assert.equal(run.extra.rolledBack, false);
    assert.match(run.extra.residual.reload, /^NOT restored: Load failed/);
    assert.equal(run.extra.residual.caddyfile, 'restored');
    assert.match(run.extra.recovery, /ingress-cutover\.js --to caddy/);
    assert.equal(fs.existsSync(run.backup), true, 'the backup stays while recovery may need it');
  });

  it('a reload that leaves the site unhealthy is a rollback failure, not a rollback', async () => {
    const run = await drive({ dir: fresh(), verifyResults: [false, false] });
    assert.equal(run.code, cutover.CUTOVER_CODES.TAILNET_ROLLBACK_FAILED);
    assert.match(run.extra.residual.reload, /not healthy/);
  });
});
