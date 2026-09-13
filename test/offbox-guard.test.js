'use strict';

// A Caddy site without a password answers only this machine.
//
// Caddy picks a site by the host name the client sends and listens on every
// interface, so a site name keeps nobody out; the generator adds a guard on the
// socket peer instead. Three layers, as in `pin-https-listener.test.js`:
//   - the GENERATOR and the text PLACEMENT, pure;
//   - the DECISIONS (the drift property and the in-place plan), against committed
//     `caddy adapt` JSON with `adapt` injected, so they run on CI with no `caddy`;
//   - an INTEGRATION layer handing real files to real `caddy adapt`, which skips
//     honestly without it.
// Nothing touches the live install: every file is under a temp dir, and Caddy
// validation and the launchd restart are injected.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const caddy = require('../lib/caddy');
const drift = require('../lib/caddy-drift');
const { parseArgs, run } = require('../scripts/guard-ungated-sites');
const { FIXTURE_CADDYFILES, FIXTURE_HASH } = require('./_caddy-drift-fixtures');

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const CADDY_AVAILABLE = caddy.detectCaddy().available;
const GUARD = caddy.OFFBOX_GUARD_LINES.join('\n');
/** TangleClaw's upstream in every fixture here. */
const OURS = new Set(['127.0.0.1:3102']);

/**
 * Load a committed `caddy adapt` fixture.
 * @param {string} name - Fixture name, e.g. `'ungated'`.
 * @returns {object} The adapted JSON.
 */
function adapted(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `caddy-adapt-${name}.json`), 'utf8'));
}

/**
 * An `adapt` stand-in that answers from committed fixtures by exact text, and
 * fails for any text it was not given — so a placement that produced anything
 * other than the expected file is refused rather than silently adapted.
 * @param {Object<string, string>} byName - Fixture name → Caddyfile text.
 * @returns {(text: string) => {ok: boolean, config: object|null, reason: string|null}}
 */
function fixtureAdapter(byName) {
  return (text) => {
    for (const [name, content] of Object.entries(byName)) {
      if (content === text) return { ok: true, config: adapted(name), reason: null };
    }
    return { ok: false, config: null, reason: 'no fixture for this text' };
  };
}

/**
 * Base generator options for the tests below.
 * @param {object} [extra] - Options to add.
 * @returns {object}
 */
function opts(extra = {}) {
  return { serverPort: 3102, certPath: '/c/cert.pem', keyPath: '/c/key.pem', ...extra };
}

/**
 * The text of each top-level site block, keyed by its header.
 * @param {string} content - Caddyfile text.
 * @returns {Map<string, string>}
 */
function siteBlocks(content) {
  const blocks = new Map();
  const re = /^(\S[^\n{]*?) \{\n([\s\S]*?)^\}$/gm;
  for (const m of content.matchAll(re)) {
    if (m[1].trim()) blocks.set(m[1].trim(), m[2]);
  }
  return blocks;
}

describe('offbox guard — the generator', () => {
  it('guards an ungated site, ahead of its reverse_proxy', () => {
    const block = siteBlocks(caddy.buildCaddyfileContent(opts())).get('localhost');
    assert.ok(block.includes(`${GUARD}\n\treverse_proxy 127.0.0.1:3102`), block);
  });

  it('guards every ungated site, including a public domain', () => {
    const content = caddy.buildCaddyfileContent(opts({ publicDomain: 'tc.example.com' }));
    for (const header of ['localhost', 'tc.example.com']) {
      assert.ok(siteBlocks(content).get(header).includes(GUARD), header);
    }
  });

  it('does not guard a gated site — the login is what admits other machines', () => {
    const content = caddy.buildCaddyfileContent(opts({
      basicAuthUser: 'jason', basicAuthHash: FIXTURE_HASH,
      tailnetHost: 'box.tail-example.ts.net', remoteHttpCatchAll: true, publicDomain: 'tc.example.com'
    }));
    assert.ok(!content.includes('remote_ip'), 'a gated file carries no peer guard');
    assert.ok(!content.includes('abort'), 'a gated file aborts nothing');
  });

  it('never guards the redirect block', () => {
    const content = caddy.buildCaddyfileContent(opts({
      basicAuthUser: 'jason', basicAuthHash: FIXTURE_HASH, tailnetHost: 'box.tail-example.ts.net'
    }));
    assert.ok(!siteBlocks(content).get('http://box.tail-example.ts.net').includes('abort'));
  });

  it('still refuses to emit an ungated remote site — the guard is not a gate', () => {
    assert.throws(() => caddy.buildCaddyfileContent(opts({ tailnetHost: 'box.tail-example.ts.net' })),
      /tailnetHost requires/);
    assert.throws(() => caddy.buildCaddyfileContent(opts({ remoteHttpCatchAll: true })),
      /remoteHttpCatchAll requires/);
  });

  it('omits the guard only when asked to reproduce an older file', () => {
    assert.ok(!caddy.buildCaddyfileContent(opts({ offboxGuard: false })).includes('remote_ip'));
    assert.ok(caddy.buildCaddyfileContent(opts({ offboxGuard: undefined })).includes('remote_ip'),
      'anything but an explicit false guards');
  });
});

describe('offbox guard — placement in an existing file', () => {
  it('turns a pre-guard generated file into exactly what the generator writes now', () => {
    const legacy = caddy.buildCaddyfileContent(opts({ publicDomain: 'tc.example.com', offboxGuard: false }));
    const current = caddy.buildCaddyfileContent(opts({ publicDomain: 'tc.example.com' }));
    const out = caddy.insertOffboxGuard(legacy, '127.0.0.1:3102');
    assert.equal(out.content, current, 'byte-identical, so a later create-gate round trip holds');
    assert.equal(caddy.isGeneratedCaddyfile(out.content), true, 're-stamped');
    assert.deepEqual(out.guarded, ['localhost', 'tc.example.com']);
  });

  it('keeps a hand-edited file\'s first line, so the cutover still protects it', () => {
    const hand = '# my notes\n{\n\tadmin off\n}\n\nlocalhost {\n\treverse_proxy 127.0.0.1:3102\n}\n';
    const out = caddy.insertOffboxGuard(hand, '127.0.0.1:3102');
    assert.equal(out.content.split('\n')[0], '# my notes');
    assert.equal(caddy.isGeneratedCaddyfile(out.content), false);
    assert.ok(out.content.includes(`localhost {\n${GUARD}\n\treverse_proxy`));
  });

  it('skips a block with a gate, an import, or its own @offbox — and changes nothing then', () => {
    for (const inner of [
      '\tbasic_auth {\n\t\tjason HASH\n\t}\n\treverse_proxy 127.0.0.1:3102',
      '\timport tcauth\n\treverse_proxy 127.0.0.1:3102',
      '\t@offbox path /x\n\treverse_proxy 127.0.0.1:3102',
      '\tforward_auth 127.0.0.1:9 {\n\t\turi /check\n\t}\n\treverse_proxy 127.0.0.1:3102'
    ]) {
      const content = `localhost {\n${inner}\n}\n`;
      const out = caddy.insertOffboxGuard(content, '127.0.0.1:3102');
      assert.equal(out.content, content, inner);
      assert.deepEqual(out.guarded, []);
    }
  });

  it('places nothing where the proxy is nested, and ignores snippets and the global block', () => {
    const content = '{\n\tadmin off\n}\n(snip) {\n\treverse_proxy 127.0.0.1:1\n}\n'
      + 'localhost {\n\thandle /x {\n\t\treverse_proxy 127.0.0.1:3102\n\t}\n}\n';
    assert.deepEqual(caddy.insertOffboxGuard(content, '127.0.0.1:3102').guarded, []);
  });

  it('leaves a block that forwards somewhere other than TangleClaw alone', () => {
    // A hand-added block may front a service meant to be reachable; whether it
    // is belongs to PortHub's declared reach, not to this guard.
    const content = 'box.ts.net:3250 {\n\treverse_proxy 127.0.0.1:3250\n}\n\nlocalhost {\n\treverse_proxy 127.0.0.1:3102\n}\n';
    const out = caddy.insertOffboxGuard(content, '127.0.0.1:3102');
    assert.deepEqual(out.guarded, ['localhost']);
    assert.ok(out.content.startsWith('box.ts.net:3250 {\n\treverse_proxy 127.0.0.1:3250\n}'));
  });

  it('does not count a brace inside a placeholder as a block', () => {
    const content = 'http://box {\n\tredir https://box:8443{uri}\n}\n\nlocalhost {\n\treverse_proxy 127.0.0.1:3102\n}\n';
    assert.deepEqual(caddy.insertOffboxGuard(content, '127.0.0.1:3102').guarded, ['localhost']);
  });
});

describe('offbox guard — reading the guard out of adapted JSON', () => {
  const guardRoute = () => JSON.parse(JSON.stringify(
    adapted('ungated').apps.http.servers.srv0.routes[0].handle[0].routes[0]
  ));

  it('recognises the route the generator emits', () => {
    assert.equal(drift.isOffboxGuardRoute(guardRoute()), true);
  });

  it('rejects every near-miss that would keep somebody out of only part of the site, or nobody', () => {
    const mutants = {
      'an extra host matcher': (r) => { r.match[0].host = ['localhost']; },
      'a second matcher set (OR)': (r) => { r.match.push({ path: ['/x'] }); },
      'a non-loopback range': (r) => { r.match[0].not[0].remote_ip.ranges.push('192.168.0.0/16'); },
      'no ranges': (r) => { r.match[0].not[0].remote_ip.ranges = []; },
      'not negated': (r) => { r.match = [{ remote_ip: r.match[0].not[0].remote_ip }]; },
      'a response instead of an abort': (r) => { delete r.handle[0].abort; },
      'a second handler': (r) => { r.handle.push({ handler: 'reverse_proxy' }); }
    };
    for (const [name, mutate] of Object.entries(mutants)) {
      const route = guardRoute();
      mutate(route);
      assert.equal(drift.isOffboxGuardRoute(route), false, name);
    }
  });

  it('accepts loopback ranges only', () => {
    for (const r of ['127.0.0.1/8', '127.0.0.1', '127.0.0.1/32', '::1', '::1/128']) {
      assert.equal(drift.isLoopbackRange(r), true, r);
    }
    for (const r of ['127.0.0.1/7', '0.0.0.0/0', '10.0.0.1', '::/0', '::1/64', '127.0.0.300', '', null]) {
      assert.equal(drift.isLoopbackRange(r), false, String(r));
    }
  });

  it('requires the guard BEFORE the proxy', () => {
    const routes = adapted('ungated').apps.http.servers.srv0.routes[0].handle[0].routes;
    assert.equal(drift.refusesOffboxBeforeProxy(routes), true);
    assert.equal(drift.refusesOffboxBeforeProxy([...routes].reverse()), false);
  });

  it('does not let a guard inside one matched route cover its siblings', () => {
    const [guard, proxy] = adapted('ungated').apps.http.servers.srv0.routes[0].handle[0].routes;
    const scoped = { match: [{ path: ['/x/*'] }], handle: [{ handler: 'subroute', routes: [guard, proxy] }] };
    assert.equal(drift.refusesOffboxBeforeProxy([scoped, proxy]), false);
    const unmatched = { handle: [{ handler: 'subroute', routes: [guard, proxy] }] };
    assert.equal(drift.refusesOffboxBeforeProxy([unmatched, proxy]), true);
  });

  it('accepts a guard inside EACH matched handle, and not inside only some', () => {
    // The hand fix for a site whose proxies sit in `handle` blocks: Caddy runs
    // `handle` before a site-level `abort`, so the guard has to go inside each.
    const [guard, proxy] = adapted('ungated').apps.http.servers.srv0.routes[0].handle[0].routes;
    const handleOf = (matcher, routes) => ({ match: matcher, handle: [{ handler: 'subroute', routes }] });
    const a = handleOf([{ path: ['/manifest.json'] }], [guard, proxy]);
    const b = handleOf([{ path: ['/api/*'] }], [guard, proxy]);
    const catchAll = { handle: [{ handler: 'subroute', routes: [guard, proxy] }] };
    assert.equal(drift.refusesOffboxBeforeProxy([a, b]), true);
    assert.equal(drift.refusesOffboxBeforeProxy([a, catchAll]), true);
    assert.equal(drift.refusesOffboxBeforeProxy([a, handleOf([{ path: ['/x'] }], [proxy])]), false);
    assert.equal(drift.refusesOffboxBeforeProxy([]), false, 'nothing proxied is not "refuses"');
  });
});

describe('offbox guard — the drift property', () => {
  it('holds for what the generator writes, gated or not', () => {
    for (const name of ['generated', 'ungated']) {
      const sites = drift.summarizeConfig(adapted(name)).sites;
      assert.equal(drift.checkOffboxRefused(sites, OURS).status, drift.HOLDS, name);
    }
  });

  it('diverges when ONE of the routes merged into a site does not refuse other machines', () => {
    // Two blocks for the same host on the same listener merge into one site; the
    // unguarded one is a way in for the whole host, whichever came first.
    const guarded = adapted('ungated').apps.http.servers.srv0.routes[0];
    const unguarded = adapted('ungated-unguarded').apps.http.servers.srv0.routes[0];
    for (const order of [[guarded, unguarded], [unguarded, guarded]]) {
      const config = adapted('ungated');
      config.apps.http.servers.srv0.routes = order;
      const sites = drift.summarizeConfig(config).sites;
      assert.equal(sites.size, 1, 'precondition: one merged site');
      assert.equal(drift.checkOffboxRefused(sites, OURS).status, drift.DIVERGED);
    }
  });

  it('does not judge an ungated site that forwards to something other than TangleClaw', () => {
    const sites = drift.summarizeConfig(adapted('hand-edited')).sites;
    const stray = [...sites.values()].find((s) => s.proxies.includes('127.0.0.1:3250'));
    assert.ok(stray && stray.gates.length === 0 && !stray.offboxRefused, 'precondition: the stray block is open');
    assert.equal(drift.checkOffboxRefused(sites, OURS).status, drift.HOLDS);
    assert.equal(drift.checkOffboxRefused(sites, new Set(['127.0.0.1:3250'])).status, drift.DIVERGED,
      'the same site IS judged once its upstream is named as ours');
    assert.equal(drift.checkOffboxRefused(drift.summarizeConfig(adapted('ungated-unguarded')).sites).status,
      drift.HOLDS, 'with no upstream named, nothing is TangleClaw\'s');
  });

  it('diverges for a pre-guard ungated file, and names the fix', () => {
    const result = drift.checkOffboxRefused(drift.summarizeConfig(adapted('ungated-unguarded')).sites, OURS);
    assert.equal(result.status, drift.DIVERGED);
    assert.equal(result.findings.length, 1);
    assert.match(result.findings[0], /for localhost proxies to 127\.0\.0\.1:3102 with no gate/);
    assert.match(result.findings[0], /node scripts\/guard-ungated-sites\.js/);
  });

  it('is reported with the other properties, and when nothing could be measured', () => {
    const notice = drift.describeDrift({
      measured: true,
      reason: null,
      properties: {
        gatedProxies: { status: drift.NOT_MEASURED, findings: ['ungated'] },
        offboxRefused: { status: drift.DIVERGED, findings: ['serves other machines'] }
      },
      findings: ['serves other machines']
    });
    assert.equal(notice.severity, 'diverged');
    assert.deepEqual(notice.findings, ['serves other machines']);
    const unrun = drift.describeDrift({
      measured: false, reason: 'no caddy', properties: {}, findings: []
    });
    assert.equal(unrun.severity, 'unknown');
  });
});

describe('offbox guard — the in-place plan', () => {
  const adapt = fixtureAdapter({
    'ungated-unguarded': FIXTURE_CADDYFILES['ungated-unguarded'],
    ungated: FIXTURE_CADDYFILES.ungated,
    generated: FIXTURE_CADDYFILES.generated
  });

  it('plans exactly the file the generator now writes', () => {
    const plan = drift.planOffboxGuard(FIXTURE_CADDYFILES['ungated-unguarded'], 3102, adapt);
    assert.equal(plan.status, drift.GUARD_READY, plan.reason || '');
    assert.equal(plan.content, FIXTURE_CADDYFILES.ungated);
    assert.deepEqual(plan.guarded, ['localhost']);
  });

  it('has nothing to do for a file already guarded or gated', () => {
    for (const name of ['ungated', 'generated']) {
      assert.equal(drift.planOffboxGuard(FIXTURE_CADDYFILES[name], 3102, adapt).status, drift.GUARD_ALREADY, name);
    }
  });

  it('refuses, never "already guarded", when TangleClaw\'s port is missing or invalid', () => {
    // Without a port no site is TangleClaw's, so the property would judge
    // nothing and read as holding — "Nothing to do" over a file still open.
    for (const port of [undefined, null, 0, -1, 70000, 3102.5, '3102']) {
      const plan = drift.planOffboxGuard(FIXTURE_CADDYFILES['ungated-unguarded'], port, adapt);
      assert.equal(plan.status, drift.GUARD_REFUSED, String(port));
      assert.match(plan.reason, /server port is not a valid port/);
    }
  });

  it('the command refuses with no port rather than reporting nothing to do', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-offbox-noport-'));
    try {
      const file = path.join(dir, 'Caddyfile');
      fs.writeFileSync(file, FIXTURE_CADDYFILES['ungated-unguarded'], { mode: 0o600 });
      let out = '';
      let err = '';
      const code = run({
        caddyfilePath: file, serverPort: undefined, uid: 501, stamp: 'S',
        stdout: { write: (s) => { out += s; } }, stderr: { write: (s) => { err += s; } },
        deps: {
          plan: (text, port) => drift.planOffboxGuard(text, port, adapt),
          validate: () => assert.fail('validated'), reload: () => assert.fail('reloaded')
        }
      });
      assert.equal(code, 1);
      assert.doesNotMatch(out, /Nothing to do/);
      assert.match(err, /REFUSED/);
      assert.equal(fs.readFileSync(file, 'utf8'), FIXTURE_CADDYFILES['ungated-unguarded']);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses when the live file cannot be adapted', () => {
    const plan = drift.planOffboxGuard('garbage', 3102, () => ({ ok: false, config: null, reason: `bad ${FIXTURE_HASH}` }));
    assert.equal(plan.status, drift.GUARD_REFUSED);
    assert.ok(!plan.reason.includes(FIXTURE_HASH), 'redacted');
  });

  it('refuses when Caddy would read anything else changed', () => {
    const before = adapted('ungated-unguarded');
    const after = adapted('ungated');
    after.apps.http.servers.srv0.listen = [':9999'];
    const plan = drift.planOffboxGuard(FIXTURE_CADDYFILES['ungated-unguarded'], 3102,
      (text) => ({ ok: true, config: text === FIXTURE_CADDYFILES.ungated ? after : before, reason: null }));
    assert.equal(plan.status, drift.GUARD_REFUSED);
    assert.match(plan.reason, /change other settings/);
  });

  it('refuses when a site still serves other machines after placement', () => {
    const before = adapted('ungated-unguarded');
    const plan = drift.planOffboxGuard(FIXTURE_CADDYFILES['ungated-unguarded'], 3102,
      () => ({ ok: true, config: before, reason: null }));
    assert.equal(plan.status, drift.GUARD_REFUSED);
    assert.match(plan.reason, /still serves other machines/);
  });

  it('refuses when no block can take the guard', () => {
    const before = adapted('ungated-unguarded');
    const plan = drift.planOffboxGuard('localhost {\n\timport x\n\treverse_proxy 127.0.0.1:3102\n}\n', 3102,
      () => ({ ok: true, config: before, reason: null }));
    assert.equal(plan.status, drift.GUARD_REFUSED);
    assert.match(plan.reason, /no block was found/);
  });
});

describe('guard-ungated-sites — the command', () => {
  /**
   * A temp Caddyfile, and a capture of everything `run` writes.
   * @param {string} content - File text.
   * @returns {object}
   */
  function harness(content) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-offbox-'));
    const caddyfilePath = path.join(dir, 'Caddyfile');
    fs.writeFileSync(caddyfilePath, content, { mode: 0o600 });
    const out = { text: '' };
    const err = { text: '' };
    return {
      dir, caddyfilePath, out, err,
      stdout: { write: (s) => { out.text += s; } },
      stderr: { write: (s) => { err.text += s; } },
      read: () => fs.readFileSync(caddyfilePath, 'utf8'),
      cleanup: () => fs.rmSync(dir, { recursive: true, force: true })
    };
  }
  const legacy = FIXTURE_CADDYFILES['ungated-unguarded'];
  const readyPlan = () => ({
    status: drift.GUARD_READY, reason: null, content: FIXTURE_CADDYFILES.ungated, guarded: ['localhost']
  });

  it('parses its flags', () => {
    assert.deepEqual(parseArgs(['--dry-run']), { dryRun: true, help: false, unknown: [] });
    assert.deepEqual(parseArgs(['-h', '--x']), { dryRun: false, help: true, unknown: ['--x'] });
  });

  it('writes the plan, restarts Caddy, and exits 0', () => {
    const h = harness(legacy);
    try {
      let reloads = 0;
      const code = run({
        caddyfilePath: h.caddyfilePath, serverPort: 3102, uid: 501, stamp: 'S', stdout: h.stdout, stderr: h.stderr,
        deps: { plan: readyPlan, validate: () => ({ ok: true }), reload: () => { reloads++; return { ok: true }; } }
      });
      assert.equal(code, 0, h.err.text);
      assert.equal(h.read(), FIXTURE_CADDYFILES.ungated);
      assert.equal(reloads, 1);
      assert.match(h.out.text, /Restricted localhost to this machine/);
    } finally { h.cleanup(); }
  });

  it('exits 2 when the guard is on disk but Caddy did not restart', () => {
    const h = harness(legacy);
    try {
      const code = run({
        caddyfilePath: h.caddyfilePath, serverPort: 3102, uid: 501, stamp: 'S', stdout: h.stdout, stderr: h.stderr,
        deps: { plan: readyPlan, validate: () => ({ ok: true }), reload: () => ({ ok: false, error: 'boom', command: 'launchctl x' }) }
      });
      assert.equal(code, 2);
      assert.equal(h.read(), FIXTURE_CADDYFILES.ungated);
      assert.match(h.err.text, /NOT live/);
      assert.match(h.err.text, /Why: boom/, 'the reason Caddy did not restart is shown');
      assert.match(h.err.text, /Run: launchctl x/);
    } finally { h.cleanup(); }
  });

  it('restores the original when Caddy rejects the new file', () => {
    const h = harness(legacy);
    try {
      let reloads = 0;
      const code = run({
        caddyfilePath: h.caddyfilePath, serverPort: 3102, uid: 501, stamp: 'S', stdout: h.stdout, stderr: h.stderr,
        deps: { plan: readyPlan, validate: () => ({ ok: false, error: 'bad' }), reload: () => { reloads++; return { ok: true }; } }
      });
      assert.equal(code, 1);
      assert.equal(h.read(), legacy);
      assert.equal(reloads, 0, 'nothing is restarted onto a rejected file');
    } finally { h.cleanup(); }
  });

  it('writes nothing on a dry run, a refusal, or a file already guarded', () => {
    const cases = [
      { dryRun: true, plan: readyPlan, code: 0 },
      { plan: () => ({ status: drift.GUARD_REFUSED, reason: `nope ${FIXTURE_HASH}`, content: null, guarded: [] }), code: 1 },
      { plan: () => ({ status: drift.GUARD_ALREADY, reason: null, content: null, guarded: [] }), code: 0 }
    ];
    for (const c of cases) {
      const h = harness(legacy);
      try {
        const code = run({
          caddyfilePath: h.caddyfilePath, serverPort: 3102, uid: 501, stamp: 'S', dryRun: c.dryRun,
          stdout: h.stdout, stderr: h.stderr,
          deps: { plan: c.plan, validate: () => assert.fail('validated'), reload: () => assert.fail('reloaded') }
        });
        assert.equal(code, c.code);
        assert.equal(h.read(), legacy);
        assert.ok(!(h.out.text + h.err.text).includes(FIXTURE_HASH), 'redacted');
      } finally { h.cleanup(); }
    }
  });
});

describe('offbox guard — against real caddy', { skip: !CADDY_AVAILABLE && 'caddy is not installed' }, () => {
  it('guards a real pre-guard file into what the generator writes now', () => {
    const plan = drift.planOffboxGuard(FIXTURE_CADDYFILES['ungated-unguarded'], 3102);
    assert.equal(plan.status, drift.GUARD_READY, plan.reason || '');
    assert.equal(plan.content, FIXTURE_CADDYFILES.ungated);
  });

  it('reads the live hand-edited SHAPE — snippet import, handle blocks, a redirect — as holding', () => {
    // Transcribed from the shape of this project's live Caddyfile (no credential):
    // a gate imported from a snippet, a path exemption in its own `handle`, and a
    // redirect-only site. Every proxying site has a gate, so nothing is ungated.
    const shape = [
      '{', '\thttps_port 8443', '\thttp_port 8080', '\tadmin off', '\tauto_https disable_redirects', '}', '',
      '(tcauth) {', '\tbasic_auth {', `\t\tjason ${FIXTURE_HASH}`, '\t}', '}', '',
      'localhost {', '\ttls /c/cert.pem /c/key.pem', '\timport tcauth', '\treverse_proxy 127.0.0.1:3102', '}', '',
      'box.tail-example.ts.net {', '\ttls /c/cert.pem /c/key.pem',
      '\t@ownauth path /manifest.json', '\thandle @ownauth {', '\t\treverse_proxy 127.0.0.1:3102', '\t}',
      '\thandle {', '\t\timport tcauth', '\t\treverse_proxy 127.0.0.1:3102', '\t}', '}', '',
      'http://box.tail-example.ts.net {', '\tredir https://box.tail-example.ts.net:8443{uri}', '}', '',
      'http:// {', '\timport tcauth', '\treverse_proxy 127.0.0.1:3102', '}', ''
    ].join('\n');
    assert.equal(drift.planOffboxGuard(shape, 3102).status, drift.GUARD_ALREADY);
  });

  it('scores hand-placed guards the way Caddy orders them', () => {
    // Caddy runs `handle` before `abort`, so a site-level guard in front of
    // `handle` blocks never fires; one inside EVERY proxying handle does.
    const guard = (indent) => caddy.OFFBOX_GUARD_LINES.map((l) => `${indent}${l.trim()}`).join('\n');
    const site = (body) => `localhost {\n${body}\n}\n`;
    const verdict = (text) => {
      const a = drift.adaptCaddyfileContent(text);
      assert.equal(a.ok, true, a.reason || '');
      return drift.checkOffboxRefused(drift.summarizeConfig(a.config).sites, OURS).status;
    };
    assert.equal(verdict(site(`${guard('\t')}\n\thandle {\n\t\treverse_proxy 127.0.0.1:3102\n\t}`)), drift.DIVERGED);
    assert.equal(verdict(site(`\t@m path /manifest.json\n\thandle @m {\n${guard('\t\t')}\n\t\treverse_proxy 127.0.0.1:3102\n\t}\n`
      + `\thandle {\n${guard('\t\t')}\n\t\treverse_proxy 127.0.0.1:3102\n\t}`)), drift.HOLDS);
    assert.equal(verdict(site(`\t@m path /manifest.json\n\thandle @m {\n\t\treverse_proxy 127.0.0.1:3102\n\t}\n`
      + `\thandle {\n${guard('\t\t')}\n\t\treverse_proxy 127.0.0.1:3102\n\t}`)), drift.DIVERGED);
  });

  it('refuses a hand-edited ungated site it cannot place into', () => {
    const shape = '{\n\tadmin off\n}\n\nlocalhost {\n\thandle {\n\t\treverse_proxy 127.0.0.1:3102\n\t}\n}\n';
    const plan = drift.planOffboxGuard(shape, 3102);
    assert.equal(plan.status, drift.GUARD_REFUSED);
  });
});
