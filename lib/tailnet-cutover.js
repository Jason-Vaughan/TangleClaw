'use strict';

/**
 * Moving the canonical tailnet host in caddy mode, as one transaction (#1905,
 * Architect rulings R46, A18 and A21).
 *
 * In caddy mode four things name the tailnet host: `config.caddyTailnetHost`,
 * the live Caddyfile's tailnet site, the certificate that site serves, and the
 * served-Host allowlist and operator links that follow the config. Moving one
 * without the others leaves an interval where they disagree. So the move has
 * two phases:
 *
 * 1. **Prepare** (`POST /api/setup/generate-cert {"reconcileTailnet":"prepare"}`)
 *    mints a transition certificate carrying the old and the new name, and
 *    changes nothing else.
 * 2. **Apply** (`node scripts/ingress-cutover.js --to caddy --tailnet-host <name>`)
 *    is the cutover transaction. It writes the Caddyfile and the config together
 *    and proves the new site answers. If it does not, it puts back the Caddyfile,
 *    the config and the reload, and reports whether that restore really worked.
 *
 * This module holds the decisions and the verification; `ingress-cutover.js`
 * owns the file writes and launchd. Every effect is injected, so each outcome,
 * including a rollback that itself fails, is testable without touching launchd.
 *
 * @module lib/tailnet-cutover
 */

const https = require('node:https');
const hostInventory = require('./host-inventory');

const HEALTH_TIMEOUT_MS = 5000;

/**
 * Stable outcome codes for a `--tailnet-host` apply. A caller branches on these.
 * @type {Readonly<Record<string, string>>}
 */
const TAILNET_CODES = Object.freeze({
  NOT_CADDY_MODE: 'tailnet-not-caddy-mode',
  INVALID_NAME: 'tailnet-invalid-name',
  NOT_OBSERVED: 'tailnet-not-observed',
  NO_CHANGE: 'tailnet-no-change',
  UNGATED: 'tailnet-ungated',
  CERT_MISSING: 'tailnet-cert-missing',
  ROLLED_BACK: 'tailnet-rolled-back',
  ROLLBACK_FAILED: 'tailnet-rollback-failed'
});

/**
 * Decide whether a `--tailnet-host` apply may run, before the Caddyfile, the
 * config or launchd is touched.
 *
 * The requested name must be a valid host name, must be the name the overlay
 * reports right now (a fresh observation, so a stale request cannot re-point the
 * site at a name the machine no longer has), must differ from the configured
 * one, must be gated (the generator refuses an ungated tailnet site), and must
 * already be carried by the certificate the site will serve. The last check is
 * what makes prepare a real phase: without the transition certificate the new
 * site would fail its TLS handshake the moment it went live.
 *
 * @param {object} args
 * @param {string} args.requested - The name passed to `--tailnet-host`.
 * @param {object} args.config - Loaded TangleClaw config (after any adoption).
 * @param {{host: string|null, reason?: string|null}} args.observation - A fresh overlay observation.
 * @param {string[]} args.certHosts - The SANs of the certificate the site will serve.
 * @param {boolean} args.gated - `caddy.tailnetSiteGated(config, gateState)`.
 * @returns {{ok: true, host: string, from: string|null}
 *   | {ok: false, code: string, reason: string}}
 */
function validateTailnetApply({ requested, config, observation, certHosts, gated }) {
  // A tailnet move changes the site of a RUNNING caddy ingress. On a direct
  // install the same run would also switch the ingress to caddy, and a failed
  // move could only put back the parts this apply owns, leaving the ingress
  // switched while reporting a clean rollback.
  if (!config || config.ingressMode !== 'caddy') {
    return { ok: false, code: TAILNET_CODES.NOT_CADDY_MODE,
      reason: '--tailnet-host moves the site of an install already in caddy mode. Switch the ingress '
        + 'first (node scripts/ingress-cutover.js --to caddy), or in direct mode use POST '
        + '/api/setup/generate-cert {"reconcileTailnet": true}' };
  }
  const host = hostInventory.normalizeHostName(requested);
  if (!host) {
    return { ok: false, code: TAILNET_CODES.INVALID_NAME,
      reason: `--tailnet-host ${JSON.stringify(requested)} is not a valid host name` };
  }
  const observed = hostInventory.normalizeHostName(observation && observation.host);
  if (observed !== host) {
    return { ok: false, code: TAILNET_CODES.NOT_OBSERVED,
      reason: `--tailnet-host ${host} is not the name the overlay reports now `
        + `(${observed || `none: ${(observation && observation.reason) || 'no observation'}`}); `
        + 'the tailnet site may only move to the name this machine actually has' };
  }
  const from = hostInventory.normalizeHostName(config && config.caddyTailnetHost);
  if (from === host) {
    return { ok: false, code: TAILNET_CODES.NO_CHANGE,
      reason: `the tailnet host is already ${host}; there is nothing to apply` };
  }
  if (!gated) {
    return { ok: false, code: TAILNET_CODES.UNGATED,
      reason: 'a Caddy tailnet site needs a gate: arm the TangleClaw login (or enable a Caddy '
        + 'basic_auth credential), then re-run' };
  }
  const covered = (certHosts || []).some((h) => hostInventory.normalizeHostName(h) === host);
  if (!covered) {
    return { ok: false, code: TAILNET_CODES.CERT_MISSING,
      reason: `the certificate does not carry ${host} yet. Run POST /api/setup/generate-cert `
        + '{"reconcileTailnet": "prepare"} first, then re-run this command' };
  }
  return { ok: true, host, from };
}

/**
 * One strict health request: healthy only on HTTP 200 with `status: "ok"`.
 *
 * Deliberately stricter than the cutover's `pollHealth`, which accepts a 503 or
 * a degraded 200 as "up". A tailnet move is judged on whether the new site
 * serves a healthy TangleClaw, and a degraded answer is a reason to roll back,
 * not to proceed (A21).
 *
 * With `servername`, the request connects to `connectHost` but presents that
 * name as SNI and `Host`, so it reaches the Caddy site for that name without
 * depending on DNS. The certificate the site served must carry the name too.
 *
 * @param {object} target
 * @param {string} target.url - e.g. `https://127.0.0.1:8443/api/health`.
 * @param {string} [target.servername] - SNI and Host name to present.
 * @param {object} [options]
 * @param {Function} [options.request] - `https.request` (tests inject a fake).
 * @param {number} [options.timeoutMs]
 * @returns {Promise<{ok: boolean, statusCode: number|null, status: string|null, error: string|null}>}
 */
function strictHealth(target, { request = https.request, timeoutMs = HEALTH_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (r) => {
      if (settled) return;
      settled = true;
      resolve({ statusCode: null, status: null, error: null, ...r });
    };
    let url;
    try {
      url = new URL(target.url);
    } catch (err) {
      done({ ok: false, error: `unbuildable health URL: ${err.message}` });
      return;
    }
    const opts = {
      host: url.hostname,
      port: url.port || 443,
      path: url.pathname,
      method: 'GET',
      rejectUnauthorized: false,
      timeout: timeoutMs,
      headers: {}
    };
    if (target.servername) {
      opts.servername = target.servername;
      opts.headers.Host = `${target.servername}:${opts.port}`;
    }
    let req;
    try {
      req = request(opts, (res) => {
        let body = '';
        res.setEncoding('utf8');
        // An aborted response emits 'error' and never 'end'; without this the
        // apply would wait forever instead of rolling back.
        res.on('error', (err) => done({ ok: false, statusCode: res.statusCode, error: err.message }));
        res.on('data', (c) => { body += c; });
        res.on('end', () => {
          let status = null;
          try { status = JSON.parse(body).status || null; } catch { status = null; }
          if (target.servername) {
            const cert = res.socket && typeof res.socket.getPeerCertificate === 'function'
              ? res.socket.getPeerCertificate() : null;
            const sans = String((cert && cert.subjectaltname) || '').toLowerCase();
            if (!sans.split(/,\s*/).includes(`dns:${target.servername}`)) {
              done({ ok: false, statusCode: res.statusCode, status,
                error: `the site served a certificate that does not carry ${target.servername}` });
              return;
            }
          }
          const ok = res.statusCode === 200 && status === 'ok';
          done({ ok, statusCode: res.statusCode, status,
            error: ok ? null : `unhealthy: HTTP ${res.statusCode}, status ${status === null ? 'unreadable' : JSON.stringify(status)}` });
        });
      });
    } catch (err) {
      done({ ok: false, error: `could not build the health request: ${err.message}` });
      return;
    }
    req.on('timeout', () => req.destroy(new Error(`no answer within ${timeoutMs}ms`)));
    req.on('error', (err) => done({ ok: false, error: err.message }));
    req.end();
  });
}

/**
 * Poll every check until all are strictly healthy in the same round, or the
 * tries run out.
 *
 * @param {Array<{label: string, url: string, servername?: string}>} checks
 * @param {object} [options]
 * @param {number} [options.tries=10]
 * @param {number} [options.intervalMs=2000]
 * @param {Function} [options.probe] - `strictHealth` (tests inject a fake).
 * @param {Function} [options.sleep] - Delay between rounds (tests inject a no-op).
 * @returns {Promise<{ok: boolean, rounds: number, last: Array<object>}>}
 */
async function verifyTailnetApply(checks, {
  tries = 10, intervalMs = 2000, probe = strictHealth,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms))
} = {}) {
  let last = [];
  for (let round = 1; round <= tries; round++) {
    last = [];
    for (const check of checks) {
      last.push({ label: check.label, ...(await probe(check)) });
    }
    if (last.every((r) => r.ok)) return { ok: true, rounds: round, last };
    if (round < tries) await sleep(intervalMs);
  }
  return { ok: false, rounds: tries, last };
}

/**
 * Put back what a failed `--tailnet-host` apply changed, and verify each part.
 *
 * `rolledBack` is true ONLY when all three are proven: the Caddyfile reads back
 * as the prior bytes, the config reads back with the prior `caddyTailnetHost`,
 * and the reload succeeded with the local site strictly healthy again (A21).
 * Anything short of that is reported part by part with the exact recovery
 * steps, never as a rollback.
 *
 * @param {object} args
 * @param {string} args.caddyfilePath
 * @param {Buffer|null} args.priorCaddyfile - The bytes before the apply; null if there was no file.
 * @param {string|null} args.priorTailnetHost - `caddyTailnetHost` before the apply.
 * @param {string|null} args.backupPath - Where the prior Caddyfile was copied, for the recovery text.
 * @param {object} args.effects
 * @param {Function} args.effects.restoreCaddyfile - `(bytes|null) => void`; null removes the file.
 * @param {Function} args.effects.readCaddyfile - `() => Buffer|null`.
 * @param {Function} args.effects.restoreConfig - `(priorTailnetHost) => void`.
 * @param {Function} args.effects.readTailnetHost - `() => string|null`, read back from the store.
 * @param {Function} args.effects.reload - `() => void`; throws if the reload failed.
 * @param {Function} args.effects.verifyLocal - `() => Promise<{ok: boolean, last?: Array}>`.
 * @returns {Promise<{rolledBack: boolean, residual: object, recovery: string|null}>}
 */
async function rollbackTailnetApply({
  caddyfilePath, priorCaddyfile, priorTailnetHost, backupPath, effects
}) {
  const residual = { caddyfile: null, caddyTailnetHost: null, reload: null };

  try {
    effects.restoreCaddyfile(priorCaddyfile);
    const now = effects.readCaddyfile();
    const same = priorCaddyfile === null
      ? now === null
      : Buffer.isBuffer(now) && now.equals(priorCaddyfile);
    residual.caddyfile = same ? 'restored' : 'NOT restored: the file does not match the prior bytes';
  } catch (err) {
    residual.caddyfile = `NOT restored: ${err.message}`;
  }

  try {
    effects.restoreConfig(priorTailnetHost);
    const now = effects.readTailnetHost();
    residual.caddyTailnetHost = (now || null) === (priorTailnetHost || null)
      ? 'restored'
      : `NOT restored: config still says ${JSON.stringify(now)}`;
  } catch (err) {
    residual.caddyTailnetHost = `NOT restored: ${err.message}`;
  }

  try {
    effects.reload();
    const health = await effects.verifyLocal();
    residual.reload = health.ok
      ? 'restored'
      : `NOT restored: the reloaded site is not healthy (${describeChecks(health.last)})`;
  } catch (err) {
    residual.reload = `NOT restored: ${err.message}`;
  }

  const rolledBack = Object.values(residual).every((v) => v === 'restored');
  if (rolledBack) return { rolledBack: true, residual, recovery: null };

  const steps = [];
  if (residual.caddyfile !== 'restored') {
    steps.push(backupPath
      ? `copy ${backupPath} back to ${caddyfilePath}`
      : `remove ${caddyfilePath} (there was none before the apply)`);
  }
  if (residual.caddyTailnetHost !== 'restored') {
    steps.push(`set "caddyTailnetHost" back to ${JSON.stringify(priorTailnetHost || null)} in config.json`);
  }
  steps.push('then run: node scripts/ingress-cutover.js --to caddy');
  return { rolledBack: false, residual, recovery: steps.join('; ') };
}

/**
 * One line summarizing check results, for messages.
 * @param {Array<{label: string, ok: boolean, error?: string|null}>} [last]
 * @returns {string}
 */
function describeChecks(last) {
  return (last || []).map((r) => `${r.label}: ${r.ok ? 'healthy' : (r.error || 'unhealthy')}`).join('; ')
    || 'no checks ran';
}

module.exports = {
  TAILNET_CODES,
  validateTailnetApply,
  strictHealth,
  verifyTailnetApply,
  rollbackTailnetApply,
  describeChecks
};
