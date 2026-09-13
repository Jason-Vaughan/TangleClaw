'use strict';

// #848 — retrofit the HTTP/1.1 pin onto a Caddyfile that is already deployed.
//
// Same two layers as `caddy-drift.test.js`, for the same reason. The DECISION
// layer runs everywhere, against committed `caddy adapt` JSON produced by real
// Caddy from real generator output, with `adapt` injected — so what counts as
// "only the pin changed" is covered on CI, which has no `caddy`. The INTEGRATION
// layer hands real Caddyfiles to real `caddy adapt` and skips honestly without it.
//
// Nothing here touches the live install: every file is written under a temp dir,
// and Caddy validation and the launchd restart are injected.

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { setLevel } = require('../lib/logger');

setLevel('error');

const caddy = require('../lib/caddy');
const drift = require('../lib/caddy-drift');
const { parseArgs, run } = require('../scripts/pin-https-listener');
const {
  FIXTURE_CADDYFILES,
  fixtureConfig,
  FIXTURE_HASH,
  FIXTURE_HTTPS_PORT,
  HAND_ADDED_BLOCK
} = require('./_caddy-drift-fixtures');

const FIXTURE_DIR = path.join(__dirname, 'fixtures');
const CADDY_AVAILABLE = caddy.detectCaddy().available;

/**
 * Load a committed `caddy adapt` fixture.
 * @param {string} name - Fixture name, e.g. `'no-h1'`.
 * @returns {object} Adapted Caddy JSON (a fresh copy on every call).
 */
function adapted(name) {
  return JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, `caddy-adapt-${name}.json`), 'utf8'));
}

/**
 * An `adapt` stand-in that answers only for the committed fixture texts, the way
 * real Caddy would, and fails for anything else — so a plan that adapts text no
 * fixture describes cannot quietly pass.
 * @param {Object<string, object>} [extra] - Additional text → adapted JSON pairs.
 * @returns {(text: string) => {ok: boolean, config: object|null, reason: string|null}}
 */
function fixtureAdapt(extra = {}) {
  const table = new Map(Object.entries(extra));
  for (const name of Object.keys(FIXTURE_CADDYFILES)) {
    table.set(FIXTURE_CADDYFILES[name], adapted(name));
  }
  return (text) => (table.has(text)
    ? { ok: true, config: JSON.parse(JSON.stringify(table.get(text))), reason: null }
    : { ok: false, config: null, reason: 'no fixture for this text' });
}

/**
 * Re-stamp a body with a generator-format integrity header, producing a file
 * `isGeneratedCaddyfile` accepts — the shape of a pristine install written
 * before the generator emitted the pin.
 * @param {string} body - Caddyfile body (everything after the header line).
 * @returns {string} Stamped Caddyfile text.
 */
function stamped(body) {
  const hash = crypto.createHash('sha256').update(body).digest('hex');
  return `${caddy.GENERATED_MARKER} (lib/caddy.js) sha256:${hash} — test stamp.\n${body}`;
}

/** @returns {string} The body of a Caddyfile, without its first line. */
function bodyOf(text) {
  return text.slice(text.indexOf('\n') + 1);
}

describe('insertHttpsListenerPin — placing the pin on text', () => {
  it('turns the unpinned generator output back into exactly the pinned output', () => {
    // The strongest statement available without Caddy: the placement lands the
    // block byte-for-byte where the generator itself puts it.
    const result = caddy.insertHttpsListenerPin(FIXTURE_CADDYFILES['no-h1'], FIXTURE_HTTPS_PORT);
    assert.equal(result.placement, 'global-block');
    assert.equal(result.content, FIXTURE_CADDYFILES.generated);
  });

  it('leaves a hand-edited file\'s first line alone, so the cutover keeps protecting it', () => {
    const handEdited = FIXTURE_CADDYFILES['no-h1'] + HAND_ADDED_BLOCK;
    assert.equal(caddy.isGeneratedCaddyfile(handEdited), false, 'precondition: hand-edited');
    const result = caddy.insertHttpsListenerPin(handEdited, FIXTURE_HTTPS_PORT);
    assert.equal(result.content, FIXTURE_CADDYFILES['hand-edited']);
    assert.equal(caddy.isGeneratedCaddyfile(result.content), false);
  });

  it('re-stamps a pristine generated file, so it stays safe to regenerate', () => {
    const pristine = stamped(bodyOf(FIXTURE_CADDYFILES['no-h1']));
    assert.equal(caddy.isGeneratedCaddyfile(pristine), true, 'precondition: pristine');
    const result = caddy.insertHttpsListenerPin(pristine, FIXTURE_HTTPS_PORT);
    assert.equal(caddy.isGeneratedCaddyfile(result.content), true);
    assert.equal(bodyOf(result.content), bodyOf(FIXTURE_CADDYFILES.generated));
  });

  it('prepends a global options block when the file has none, keeping the rest verbatim', () => {
    const bare = 'localhost:8443 {\n\tredir https://example.test{uri}\n}\n';
    const result = caddy.insertHttpsListenerPin(bare, 8443);
    assert.equal(result.placement, 'new-global-block');
    assert.equal(result.content, `{\n\tservers :8443 {\n\t\tprotocols h1\n\t}\n}\n\n${bare}`);
  });

  it('closes on the GLOBAL block\'s brace, not on a nested block or an inline placeholder', () => {
    const text = [
      '# operator notes',
      '',
      '{',
      '\thttps_port 9443',
      '\tlog {',
      '\t\toutput file /var/log/{env.HOST}.log',
      '\t}',
      '}',
      '',
      'localhost {',
      '\treverse_proxy 127.0.0.1:3102',
      '}',
      ''
    ].join('\n');
    const result = caddy.insertHttpsListenerPin(text, 9443);
    assert.equal(result.placement, 'global-block');
    const lines = result.content.split('\n');
    const pinAt = lines.indexOf('\tservers :9443 {');
    assert.equal(lines[pinAt - 1], '\t}', 'after the nested log block closes');
    assert.equal(lines[pinAt + 3], '}', 'immediately before the global block closes');
    assert.equal(lines[pinAt + 4], '', 'and the site below is untouched');
    assert.equal(result.content.replace('\tservers :9443 {\n\t\tprotocols h1\n\t}\n', ''), text);
  });

  it('treats a `{` after a site header as that site\'s body, not a global block', () => {
    const text = 'localhost\n{\n\treverse_proxy 127.0.0.1:3102\n}\n';
    assert.equal(caddy.insertHttpsListenerPin(text, 8443).placement, 'new-global-block');
  });

  it('throws on a global block that never closes, and on a port that is not a port', () => {
    assert.throws(() => caddy.insertHttpsListenerPin('{\n\tadmin off\n', 8443), /no closing brace/);
    for (const port of [0, 70000, '8443', 8443.5, null]) {
      assert.throws(() => caddy.insertHttpsListenerPin('{\n}\n', port), /httpsPort/, String(port));
    }
    assert.throws(() => caddy.insertHttpsListenerPin(null, 8443), /content/);
  });
});

describe('isPinOnlyChange — what Caddy reads, not what the text says', () => {
  it('accepts a change whose only effect is the pin', () => {
    const verdict = drift.isPinOnlyChange(adapted('no-h1'), adapted('generated'), FIXTURE_HTTPS_PORT);
    assert.deepEqual(verdict, { ok: true, reason: null });
  });

  it('refuses when the listener still is not h1-only afterwards', () => {
    const verdict = drift.isPinOnlyChange(adapted('no-h1'), adapted('no-h1'), FIXTURE_HTTPS_PORT);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /still does not read/);
  });

  it('refuses when anything else Caddy reads changed alongside the pin', () => {
    // `hand-edited` carries the pin AND an extra site: the pin alone is present,
    // but so is a difference that is not the pin.
    const verdict = drift.isPinOnlyChange(adapted('no-h1'), adapted('hand-edited'), FIXTURE_HTTPS_PORT);
    assert.equal(verdict.ok, false);
    assert.match(verdict.reason, /other settings/);
  });

  it('refuses a setting lost from the pinned listener itself', () => {
    // The idle timeout exists BEFORE and is gone AFTER — the shape Caddy produces
    // when an address-less `servers` block yields to a new `servers :<port>`.
    // Only `protocols` is set aside on that listener; everything else still counts.
    const before = adapted('no-h1');
    Object.values(before.apps.http.servers)
      .find((s) => s.listen.includes(`:${FIXTURE_HTTPS_PORT}`)).idle_timeout = 300000000000;
    const lost = drift.isPinOnlyChange(before, adapted('generated'), FIXTURE_HTTPS_PORT);
    assert.equal(lost.ok, false);
    assert.match(lost.reason, /other settings/);
  });
});

describe('planHttpsListenerPin — the decision, on committed adapt fixtures', () => {
  it('is READY for an unpinned file, with exactly the pinned content', () => {
    const plan = drift.planHttpsListenerPin(FIXTURE_CADDYFILES['no-h1'], FIXTURE_HTTPS_PORT, fixtureAdapt());
    assert.equal(plan.status, drift.PIN_READY, plan.reason);
    assert.equal(plan.content, FIXTURE_CADDYFILES.generated);
    assert.equal(plan.placement, 'global-block');
  });

  it('is ALREADY-PINNED, with nothing to write, when the pin holds', () => {
    const plan = drift.planHttpsListenerPin(FIXTURE_CADDYFILES.generated, FIXTURE_HTTPS_PORT, fixtureAdapt());
    assert.equal(plan.status, drift.PIN_ALREADY);
    assert.equal(plan.content, null);
  });

  it('refuses a file Caddy cannot adapt, and redacts the reason', () => {
    const plan = drift.planHttpsListenerPin('anything', FIXTURE_HTTPS_PORT, () => ({
      ok: false, config: null, reason: `basic_auth fixture ${FIXTURE_HASH}`
    }));
    assert.equal(plan.status, drift.PIN_REFUSED);
    assert.equal(plan.content, null);
    assert.ok(!plan.reason.includes(FIXTURE_HASH), 'the hash must not survive into the reason');
  });

  it('refuses when nothing listens on the configured HTTPS port', () => {
    const plan = drift.planHttpsListenerPin(FIXTURE_CADDYFILES['no-h1'], 9443, fixtureAdapt());
    assert.equal(plan.status, drift.PIN_REFUSED);
    assert.match(plan.reason, /no listener on :9443/);
  });

  it('refuses to override protocols the operator set on purpose', () => {
    const explicit = adapted('no-h1');
    Object.values(explicit.apps.http.servers)
      .find((s) => s.listen.includes(`:${FIXTURE_HTTPS_PORT}`)).protocols = ['h1', 'h2'];
    const text = `${FIXTURE_CADDYFILES['no-h1']}# explicit\n`;
    const plan = drift.planHttpsListenerPin(text, FIXTURE_HTTPS_PORT, fixtureAdapt({ [text]: explicit }));
    assert.equal(plan.status, drift.PIN_REFUSED);
    assert.match(plan.reason, /explicitly set to h1, h2/);
  });

  it('refuses when the pinned text would change anything else Caddy reads', () => {
    // The pinned text adapts, but to a config that differs beyond the pin.
    const pinnedText = caddy.insertHttpsListenerPin(FIXTURE_CADDYFILES['no-h1'], FIXTURE_HTTPS_PORT).content;
    const adapt = (text) => (text === pinnedText
      ? { ok: true, config: adapted('hand-edited'), reason: null }
      : fixtureAdapt()(text));
    const plan = drift.planHttpsListenerPin(FIXTURE_CADDYFILES['no-h1'], FIXTURE_HTTPS_PORT, adapt);
    assert.equal(plan.status, drift.PIN_REFUSED);
    assert.match(plan.reason, /other settings/);
    assert.equal(plan.content, null);
  });

  it('refuses when the pinned text no longer adapts', () => {
    const adapt = (text) => (text === FIXTURE_CADDYFILES['no-h1']
      ? fixtureAdapt()(text)
      : { ok: false, config: null, reason: 'parse error' });
    const plan = drift.planHttpsListenerPin(FIXTURE_CADDYFILES['no-h1'], FIXTURE_HTTPS_PORT, adapt);
    assert.equal(plan.status, drift.PIN_REFUSED);
    assert.match(plan.reason, /with the pin added could not be adapted/);
  });

  it('refuses, rather than throwing, when the text cannot be placed', () => {
    const text = '{\n\tadmin off\n';
    const plan = drift.planHttpsListenerPin(text, FIXTURE_HTTPS_PORT, fixtureAdapt({ [text]: adapted('no-h1') }));
    assert.equal(plan.status, drift.PIN_REFUSED);
    assert.match(plan.reason, /no closing brace/);
  });
});

describe('the drift check names the remedy for an unpinned listener', () => {
  const baseline = drift.summarizeConfig(adapted('generated')).listeners;

  it('points an UNPINNED listener at the pin tool', () => {
    const live = drift.summarizeConfig(adapted('no-h1')).listeners;
    const result = drift.checkHttpsProtocols(live, baseline, FIXTURE_HTTPS_PORT);
    assert.equal(result.status, drift.DIVERGED);
    assert.match(result.findings[0], /scripts\/pin-https-listener\.js/);
  });

  it('does not advertise the tool for protocols set on purpose, which it would refuse', () => {
    const address = `:${FIXTURE_HTTPS_PORT}`;
    const live = new Map([[address, { address, protocols: ['h1', 'h2'] }]]);
    const result = drift.checkHttpsProtocols(live, baseline, FIXTURE_HTTPS_PORT);
    assert.equal(result.status, drift.DIVERGED);
    assert.ok(!/pin-https-listener/.test(result.findings[0]), result.findings[0]);
  });
});

describe('pin-https-listener script', () => {
  /**
   * Run the script against a temp Caddyfile with every side effect injected.
   * @param {object} opts
   * @returns {{ code: number, out: string, err: string, file: string, dir: string,
   *   reloads: number[], validated: string[] }}
   */
  function runIn({ content, plan, dryRun = false, validate, reload }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-pin-h1-'));
    const file = path.join(dir, 'Caddyfile');
    fs.writeFileSync(file, content, { mode: 0o600 });
    let out = '';
    let err = '';
    const reloads = [];
    const validated = [];
    const code = run({
      caddyfilePath: file,
      httpsPort: FIXTURE_HTTPS_PORT,
      dryRun,
      uid: 501,
      stamp: '2026-09-12T00-00-00-000Z',
      deps: {
        plan: plan || ((text, port) => drift.planHttpsListenerPin(text, port, fixtureAdapt())),
        validate: (p) => {
          validated.push(fs.readFileSync(p, 'utf8'));
          return validate ? validate(p) : { ok: true, error: null };
        },
        reload: (uid) => {
          reloads.push(uid);
          return reload ? reload(uid) : { ok: true, error: null, command: 'launchctl kickstart' };
        }
      },
      stdout: { write: (s) => { out += s; } },
      stderr: { write: (s) => { err += s; } }
    });
    return { code, out, err, file, dir, reloads, validated };
  }

  /** @returns {string[]} Backup files beside the Caddyfile. */
  function backups(dir) {
    return fs.readdirSync(dir).filter((n) => n !== 'Caddyfile');
  }

  it('parses --dry-run and --help, and collects anything else as unknown', () => {
    assert.deepEqual(parseArgs([]), { dryRun: false, help: false, unknown: [] });
    assert.deepEqual(parseArgs(['--dry-run', '-h', '--force']), { dryRun: true, help: true, unknown: ['--force'] });
  });

  it('pins an unpinned file in place, keeps a private backup, validates, then restarts Caddy', () => {
    const r = runIn({ content: FIXTURE_CADDYFILES['no-h1'] });
    try {
      assert.equal(r.code, 0, r.err);
      assert.equal(fs.readFileSync(r.file, 'utf8'), FIXTURE_CADDYFILES.generated);
      assert.deepEqual(r.validated, [FIXTURE_CADDYFILES.generated], 'validated the NEW content');
      assert.deepEqual(r.reloads, [501]);
      const kept = backups(r.dir);
      assert.equal(kept.length, 1);
      const backup = path.join(r.dir, kept[0]);
      assert.equal(fs.readFileSync(backup, 'utf8'), FIXTURE_CADDYFILES['no-h1']);
      assert.equal(fs.statSync(backup).mode & 0o777, 0o600, 'the backup carries a credential hash');
      assert.match(r.out, /Pinned the HTTPS listener/);
    } finally {
      fs.rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('--dry-run writes nothing, restarts nothing, and says what it would do', () => {
    const r = runIn({ content: FIXTURE_CADDYFILES['no-h1'], dryRun: true });
    try {
      assert.equal(r.code, 0, r.err);
      assert.equal(fs.readFileSync(r.file, 'utf8'), FIXTURE_CADDYFILES['no-h1']);
      assert.deepEqual(backups(r.dir), []);
      assert.deepEqual(r.reloads, []);
      assert.deepEqual(r.validated, []);
      assert.match(r.out, /\[dry-run\]/);
      assert.match(r.out, new RegExp(`servers :${FIXTURE_HTTPS_PORT}`));
    } finally {
      fs.rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('does nothing, successfully, when the file is already pinned', () => {
    const r = runIn({ content: FIXTURE_CADDYFILES.generated });
    try {
      assert.equal(r.code, 0, r.err);
      assert.equal(fs.readFileSync(r.file, 'utf8'), FIXTURE_CADDYFILES.generated);
      assert.deepEqual(backups(r.dir), []);
      assert.deepEqual(r.reloads, [], 'restarting Caddy for no change would drop every terminal');
      assert.match(r.out, /already pinned/);
    } finally {
      fs.rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('on a refusal writes nothing, exits non-zero, and points at the manual steps', () => {
    const r = runIn({
      content: FIXTURE_CADDYFILES['no-h1'],
      plan: () => ({ status: drift.PIN_REFUSED, reason: `because ${FIXTURE_HASH}`, content: 'X', placement: null })
    });
    try {
      assert.equal(r.code, 1);
      assert.equal(fs.readFileSync(r.file, 'utf8'), FIXTURE_CADDYFILES['no-h1']);
      assert.deepEqual(backups(r.dir), []);
      assert.deepEqual(r.reloads, []);
      assert.match(r.err, /REFUSED/);
      assert.match(r.err, /deploy\/INGRESS\.md/);
      assert.ok(!r.err.includes(FIXTURE_HASH), 'redacted on the way to the terminal');
    } finally {
      fs.rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('restores the original and does not restart Caddy when the new file does not validate', () => {
    const r = runIn({
      content: FIXTURE_CADDYFILES['no-h1'],
      validate: () => ({ ok: false, error: 'bad config' })
    });
    try {
      assert.equal(r.code, 1);
      assert.equal(fs.readFileSync(r.file, 'utf8'), FIXTURE_CADDYFILES['no-h1']);
      assert.deepEqual(r.reloads, []);
      assert.match(r.err, /original was restored/);
    } finally {
      fs.rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('keeps the pin and prints the restart command when Caddy cannot be restarted', () => {
    const r = runIn({
      content: FIXTURE_CADDYFILES['no-h1'],
      reload: () => ({ ok: false, error: 'no launchd', command: 'launchctl kickstart -k gui/501/x' })
    });
    try {
      assert.equal(r.code, 0);
      assert.equal(fs.readFileSync(r.file, 'utf8'), FIXTURE_CADDYFILES.generated);
      assert.match(r.err, /Run: launchctl kickstart -k gui\/501\/x/);
    } finally {
      fs.rmSync(r.dir, { recursive: true, force: true });
    }
  });

  it('reports an unreadable Caddyfile rather than throwing', () => {
    let err = '';
    const code = run({
      caddyfilePath: path.join(os.tmpdir(), 'tc-no-such-caddyfile-848'),
      httpsPort: FIXTURE_HTTPS_PORT,
      uid: 501,
      stamp: 'x',
      deps: { plan: () => assert.fail('must not plan without a file') },
      stdout: { write: () => {} },
      stderr: { write: (s) => { err += s; } }
    });
    assert.equal(code, 1);
    assert.match(err, /could not read/);
  });
});

describe('pin-https-listener — against real caddy', { skip: !CADDY_AVAILABLE && 'caddy is not installed' }, () => {
  it('pins the unpinned generator output, and the drift check then holds', () => {
    const plan = drift.planHttpsListenerPin(FIXTURE_CADDYFILES['no-h1'], FIXTURE_HTTPS_PORT);
    assert.equal(plan.status, drift.PIN_READY, plan.reason);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-pin-h1-e2e-'));
    try {
      const file = path.join(dir, 'Caddyfile');
      fs.writeFileSync(file, plan.content, { mode: 0o600 });
      const result = drift.checkCaddyDrift({ config: fixtureConfig(), caddyfilePath: file, leases: [] });
      assert.equal(result.properties.httpsProtocols.status, drift.HOLDS);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('pins a hand-edited file while keeping its hand-added site', () => {
    const plan = drift.planHttpsListenerPin(FIXTURE_CADDYFILES['no-h1'] + HAND_ADDED_BLOCK, FIXTURE_HTTPS_PORT);
    assert.equal(plan.status, drift.PIN_READY, plan.reason);
    assert.equal(plan.content, FIXTURE_CADDYFILES['hand-edited']);
  });

  it('pins a file with no global options block', () => {
    const bare = 'localhost:8443 {\n\treverse_proxy 127.0.0.1:3102\n}\n';
    const plan = drift.planHttpsListenerPin(bare, 8443);
    assert.equal(plan.status, drift.PIN_READY, plan.reason);
    assert.equal(plan.placement, 'new-global-block');
  });

  it('REFUSES where Caddy would drop an address-less servers block\'s settings', () => {
    // Probed against Caddy 2.11: once `servers :8443` exists, the listener stops
    // taking settings from a bare `servers { … }` block, so a naive insert would
    // silently lose the idle timeout. The adapt comparison is what sees it.
    const text = [
      '{',
      '\tservers {',
      '\t\ttimeouts {',
      '\t\t\tidle 5m',
      '\t\t}',
      '\t}',
      '}',
      '',
      'localhost:8443 {',
      '\treverse_proxy 127.0.0.1:3102',
      '}',
      ''
    ].join('\n');
    const plan = drift.planHttpsListenerPin(text, 8443);
    assert.equal(plan.status, drift.PIN_REFUSED);
    assert.match(plan.reason, /other settings/);
  });

  it('REFUSES a port nothing listens on, even though the pin would parse', () => {
    const plan = drift.planHttpsListenerPin(FIXTURE_CADDYFILES['no-h1'], 9443);
    assert.equal(plan.status, drift.PIN_REFUSED);
    assert.match(plan.reason, /no listener/);
  });
});
