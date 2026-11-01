'use strict';

/*
 * Resolving the origin TangleClaw advertises under Tailscale mode (#1380):
 * honest failure detection through every branch `tailscale status --json`
 * can answer, and the `[TailscaleHost]:[TC_PORT]` composition — orthogonal
 * to `ingressMode`, which this module never reads.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const ti = require('../lib/tailscale-ingress');

/** A fake `execFile` that answers successfully with `stdout`. */
function execFileOk(stdout) {
  return (cmd, args, opts, cb) => cb(null, stdout, '');
}

/** A fake `execFile` that fails with `err`. */
function execFileErr(err) {
  return (cmd, args, opts, cb) => cb(err, '', '');
}

/** A realistic `tailscale status --json` document, overridable per test. */
function statusDoc(overrides = {}) {
  return {
    BackendState: 'Running',
    CurrentTailnet: { MagicDNSEnabled: true },
    Self: { DNSName: 'cursatory.tail123678.ts.net.' },
    ...overrides
  };
}

describe('lib/tailscale-ingress.js (#1380)', () => {
  describe('resolveTailscaleHost', () => {
    it('resolves and strips the trailing dot from Self.DNSName', async () => {
      const result = await ti.resolveTailscaleHost({ execFile: execFileOk(JSON.stringify(statusDoc())) });
      assert.deepEqual(result, { ok: true, host: 'cursatory.tail123678.ts.net' });
    });

    it('trims incidental whitespace around the hostname', async () => {
      const doc = statusDoc({ Self: { DNSName: '  cursatory.tail123678.ts.net.  ' } });
      const result = await ti.resolveTailscaleHost({ execFile: execFileOk(JSON.stringify(doc)) });
      assert.equal(result.ok, true);
      assert.equal(result.host, 'cursatory.tail123678.ts.net');
    });

    it('reports cli-absent when the tailscale binary is not on PATH', async () => {
      const err = new Error('spawn tailscale ENOENT');
      err.code = 'ENOENT';
      const result = await ti.resolveTailscaleHost({ execFile: execFileErr(err) });
      assert.equal(result.ok, false);
      assert.equal(result.reason, ti.FAILURE_REASONS.CLI_ABSENT);
      assert.equal(result.detail, ti.FAILURE_MESSAGES[ti.FAILURE_REASONS.CLI_ABSENT]);
    });

    it('reports command-failed for any other execution error', async () => {
      const result = await ti.resolveTailscaleHost({ execFile: execFileErr(new Error('boom')) });
      assert.equal(result.ok, false);
      assert.equal(result.reason, ti.FAILURE_REASONS.COMMAND_FAILED);
    });

    it('reports probe-timeout when the command is killed for taking too long', async () => {
      const err = new Error('timed out');
      err.killed = true;
      err.signal = 'SIGTERM';
      const result = await ti.resolveTailscaleHost({ execFile: execFileErr(err) });
      assert.equal(result.ok, false);
      assert.equal(result.reason, ti.FAILURE_REASONS.PROBE_TIMEOUT);
    });

    it('reports not-json when the command answers with unparseable output', async () => {
      const result = await ti.resolveTailscaleHost({ execFile: execFileOk('not json at all') });
      assert.equal(result.ok, false);
      assert.equal(result.reason, ti.FAILURE_REASONS.NOT_JSON);
    });

    it('reports node-not-running with the actual backend state, never a silent fallback', async () => {
      const doc = statusDoc({ BackendState: 'NeedsLogin' });
      const result = await ti.resolveTailscaleHost({ execFile: execFileOk(JSON.stringify(doc)) });
      assert.equal(result.ok, false);
      assert.equal(result.reason, ti.FAILURE_REASONS.NODE_NOT_RUNNING);
      assert.match(result.detail, /"NeedsLogin"/);
    });

    it('reports node-not-running with the generic message when BackendState is missing', async () => {
      const doc = statusDoc();
      delete doc.BackendState;
      const result = await ti.resolveTailscaleHost({ execFile: execFileOk(JSON.stringify(doc)) });
      assert.equal(result.ok, false);
      assert.equal(result.reason, ti.FAILURE_REASONS.NODE_NOT_RUNNING);
      assert.equal(result.detail, ti.FAILURE_MESSAGES[ti.FAILURE_REASONS.NODE_NOT_RUNNING]);
    });

    it('reports magicdns-off when the tailnet has MagicDNS disabled', async () => {
      const doc = statusDoc({ CurrentTailnet: { MagicDNSEnabled: false } });
      const result = await ti.resolveTailscaleHost({ execFile: execFileOk(JSON.stringify(doc)) });
      assert.equal(result.ok, false);
      assert.equal(result.reason, ti.FAILURE_REASONS.MAGIC_DNS_OFF);
    });

    it('reports magicdns-off when CurrentTailnet is entirely absent', async () => {
      const doc = statusDoc();
      delete doc.CurrentTailnet;
      const result = await ti.resolveTailscaleHost({ execFile: execFileOk(JSON.stringify(doc)) });
      assert.equal(result.ok, false);
      assert.equal(result.reason, ti.FAILURE_REASONS.MAGIC_DNS_OFF);
    });

    it('reports no-dns-name when Self.DNSName is blank', async () => {
      const doc = statusDoc({ Self: { DNSName: '' } });
      const result = await ti.resolveTailscaleHost({ execFile: execFileOk(JSON.stringify(doc)) });
      assert.equal(result.ok, false);
      assert.equal(result.reason, ti.FAILURE_REASONS.NO_DNS_NAME);
    });

    it('reports no-dns-name when Self is entirely absent', async () => {
      const doc = statusDoc();
      delete doc.Self;
      const result = await ti.resolveTailscaleHost({ execFile: execFileOk(JSON.stringify(doc)) });
      assert.equal(result.ok, false);
      assert.equal(result.reason, ti.FAILURE_REASONS.NO_DNS_NAME);
    });
  });

  describe('composeAdvertisedOrigin', () => {
    it('always states the port explicitly, even the scheme default', () => {
      assert.equal(ti.composeAdvertisedOrigin('cursatory.tail123678.ts.net', 443), 'https://cursatory.tail123678.ts.net:443');
    });

    it('composes with a non-default port', () => {
      assert.equal(ti.composeAdvertisedOrigin('cursatory.tail123678.ts.net', 8443), 'https://cursatory.tail123678.ts.net:8443');
    });

    it('respects an explicit scheme', () => {
      assert.equal(ti.composeAdvertisedOrigin('cursatory.tail123678.ts.net', 8443, 'http'), 'http://cursatory.tail123678.ts.net:8443');
    });

    it('throws on a blank host', () => {
      assert.throws(() => ti.composeAdvertisedOrigin('', 8443), /host is required/);
      assert.throws(() => ti.composeAdvertisedOrigin('   ', 8443), /host is required/);
    });

    it('throws on a malformed port', () => {
      assert.throws(() => ti.composeAdvertisedOrigin('host.ts.net', 0), /whole number/);
      assert.throws(() => ti.composeAdvertisedOrigin('host.ts.net', 65536), /whole number/);
      assert.throws(() => ti.composeAdvertisedOrigin('host.ts.net', 8443.5), /whole number/);
      assert.throws(() => ti.composeAdvertisedOrigin('host.ts.net', 'nope'), /whole number/);
    });
  });

  describe('resolveAdvertisedOrigin', () => {
    it('answers disabled without touching tailscale at all, when enabled is false', async () => {
      let called = false;
      const execFile = (...args) => { called = true; return execFileOk('{}')(...args); };
      const result = await ti.resolveAdvertisedOrigin({ enabled: false, port: 8443, deps: { execFile } });
      assert.equal(result.ok, false);
      assert.equal(result.reason, ti.FAILURE_REASONS.DISABLED);
      assert.equal(called, false, 'must not spawn a process when the mode is off');
    });

    it('answers disabled when enabled is omitted', async () => {
      const result = await ti.resolveAdvertisedOrigin({ port: 8443 });
      assert.equal(result.reason, ti.FAILURE_REASONS.DISABLED);
    });

    it('answers bad-port before resolving the host, for a malformed port', async () => {
      let called = false;
      const execFile = (...args) => { called = true; return execFileOk('{}')(...args); };
      const result = await ti.resolveAdvertisedOrigin({ enabled: true, port: 0, deps: { execFile } });
      assert.equal(result.ok, false);
      assert.equal(result.reason, ti.FAILURE_REASONS.BAD_PORT);
      assert.equal(called, false);
    });

    it('is orthogonal to ingressMode — the same enabled+port resolve the same way regardless of scheme/ingress concerns', async () => {
      const execFile = execFileOk(JSON.stringify(statusDoc()));
      const result = await ti.resolveAdvertisedOrigin({ enabled: true, port: 8443, deps: { execFile } });
      assert.equal(result.ok, true);
      assert.equal(result.origin, 'https://cursatory.tail123678.ts.net:8443');
      assert.equal(result.host, 'cursatory.tail123678.ts.net');
    });

    it('propagates the honest failure reason instead of composing a URL', async () => {
      const doc = statusDoc({ BackendState: 'Stopped' });
      const result = await ti.resolveAdvertisedOrigin({ enabled: true, port: 8443, deps: { execFile: execFileOk(JSON.stringify(doc)) } });
      assert.equal(result.ok, false);
      assert.equal(result.reason, ti.FAILURE_REASONS.NODE_NOT_RUNNING);
      assert.equal('origin' in result, false);
    });

    it('never falls back to localhost on any failure path', async () => {
      const cases = [
        execFileErr((() => { const e = new Error('nope'); e.code = 'ENOENT'; return e; })()),
        execFileOk('garbage'),
        execFileOk(JSON.stringify(statusDoc({ BackendState: 'Stopped' }))),
        execFileOk(JSON.stringify(statusDoc({ CurrentTailnet: { MagicDNSEnabled: false } }))),
        execFileOk(JSON.stringify(statusDoc({ Self: { DNSName: '' } })))
      ];
      for (const execFile of cases) {
        const result = await ti.resolveAdvertisedOrigin({ enabled: true, port: 8443, deps: { execFile } });
        assert.equal(result.ok, false);
        assert.ok(!('origin' in result) || !String(result.origin || '').includes('localhost'));
      }
    });
  });
});
