'use strict';

// TLS for DIRECT ingress mode (mkcert-issued local certs that TC terminates
// itself). AUTH-1 (#395 / ADR 0003): in caddy ingress mode Caddy terminates TLS
// instead and this module is bypassed for the listener — but it is RETAINED as
// the rollback target (and the cutover reuses the mkcert cert it generates for
// Caddy's local site). Do not delete until the Caddy cutover has soaked. See
// lib/caddy.js and deploy/INGRESS.md.
//
// NOTE for whoever retires this module after the soak: `effectiveServerProtocol`
// and `effectiveServerPort` are NOT TLS logic. They answer "what is the server
// actually serving, and where" for every localhost API base URL TangleClaw
// injects, and they live here only because the protocol half was born beside the
// cert code. They must be RELOCATED (together — callers read them as a pair),
// never dropped with the rest of the module.

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const store = require('./store');
const { createLogger } = require('./logger');

const log = createLogger('https-setup');

const MKCERT_TIMEOUT_MS = 10000;
const MKCERT_HOSTS_DEFAULT = ['localhost', '127.0.0.1', '::1'];

/**
 * Directory where TangleClaw stores TLS certificates.
 * Uses the store's base path so tests can override it.
 * @returns {string}
 */
function getCertsDir() {
  return path.join(store._getBasePath(), 'certs');
}

/**
 * Run a command and return its stdout. Wraps execFileSync with short timeout.
 * @param {string} cmd
 * @param {string[]} args
 * @returns {string} trimmed stdout
 */
function _run(cmd, args) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    timeout: MKCERT_TIMEOUT_MS,
    stdio: ['ignore', 'pipe', 'pipe']
  }).toString().trim();
}

/**
 * Detect whether mkcert is installed and return its metadata.
 * @returns {{ available: boolean, version: string|null, carootPath: string|null, error: string|null }}
 */
function detectMkcert() {
  try {
    _run('mkcert', ['-help']);
  } catch (err) {
    return { available: false, version: null, carootPath: null, error: err.code === 'ENOENT' ? 'mkcert not found on PATH' : err.message };
  }

  let version = null;
  try {
    const out = _run('mkcert', ['-version']);
    version = out.split('\n')[0].trim() || null;
  } catch {
    // -version may print to stderr on some builds; ignore
  }

  let carootPath = null;
  try {
    carootPath = _run('mkcert', ['-CAROOT']) || null;
  } catch (err) {
    log.warn('mkcert -CAROOT failed', { message: err.message });
  }

  return { available: true, version, carootPath, error: null };
}

/**
 * Check whether the mkcert root CA has been installed (rootCA.pem exists in CAROOT).
 * @param {string} [carootPath]
 * @returns {boolean}
 */
function isCaInstalled(carootPath) {
  const dir = carootPath || (detectMkcert().carootPath);
  if (!dir) return false;
  try {
    return fs.existsSync(path.join(dir, 'rootCA.pem')) && fs.existsSync(path.join(dir, 'rootCA-key.pem'));
  } catch {
    return false;
  }
}

/**
 * Generate a TLS certificate for the given hosts using mkcert.
 * Installs the mkcert CA (idempotent) and writes cert.pem + key.pem into certsDir.
 * @param {object} [options]
 * @param {string[]} [options.hosts] - Hostnames to include in the cert SANs.
 * @param {string} [options.certsDir] - Destination directory (default: getCertsDir()).
 * @returns {{ certPath: string, keyPath: string, hosts: string[], expiry: string|null, carootPath: string|null }}
 */
function generateCerts(options = {}) {
  const detection = detectMkcert();
  if (!detection.available) {
    throw new Error(`mkcert is not available: ${detection.error || 'unknown'}`);
  }

  const certsDir = options.certsDir || getCertsDir();
  if (!fs.existsSync(certsDir)) {
    fs.mkdirSync(certsDir, { recursive: true, mode: 0o700 });
  }
  try {
    fs.accessSync(certsDir, fs.constants.W_OK);
  } catch {
    throw new Error(`Cert directory is not writable: ${certsDir}`);
  }

  const hostname = os.hostname();
  const hosts = Array.isArray(options.hosts) && options.hosts.length > 0
    ? options.hosts
    : [...MKCERT_HOSTS_DEFAULT, `${hostname}.local`];

  // Trusting the local CA (`mkcert -install`) is a PRIVILEGED, interactive step —
  // it shells out to sudo / `security add-trusted-cert`. It belongs to install.sh,
  // which runs in a terminal; from the headless launchd server there is no TTY for
  // sudo, so attempting it here failed hard with an opaque error and aborted cert
  // generation entirely. Cert generation itself is UNPRIVILEGED and always works.
  // So: only attempt the trust-install when the CA isn't already present, and treat
  // a failure as NON-FATAL — generate the cert regardless. The https-check endpoint
  // surfaces `caInstalled` so the wizard can flag an untrusted CA, and install.sh
  // (or a manual `mkcert -install`) is the supported way to trust it.
  if (!isCaInstalled(detection.carootPath)) {
    try {
      _run('mkcert', ['-install']);
    } catch (err) {
      log.warn('mkcert -install could not trust the local CA (expected from the headless server — run install.sh, or `mkcert -install` in a terminal, to trust it)', { message: err.message });
    }
  }

  const certPath = path.join(certsDir, 'cert.pem');
  const keyPath = path.join(certsDir, 'key.pem');

  try {
    _run('mkcert', ['-cert-file', certPath, '-key-file', keyPath, ...hosts]);
  } catch (err) {
    throw new Error(`mkcert cert generation failed: ${err.message}`);
  }

  // Tighten perms on the private key
  try { fs.chmodSync(keyPath, 0o600); } catch { /* best-effort */ }

  const expiry = _readCertExpiry(certPath);

  log.info('Generated TLS certificate', { certPath, keyPath, hosts, expiry });

  return { certPath, keyPath, hosts, expiry, carootPath: detection.carootPath };
}

/**
 * Validate that a cert + key pair exists, is readable, parses as PEM, and matches.
 * @param {string} certPath
 * @param {string} keyPath
 * @returns {{ ok: boolean, error: string|null, expiry: string|null, subject: string|null }}
 */
function validateCertFiles(certPath, keyPath) {
  if (!certPath || !keyPath) {
    return { ok: false, error: 'certPath and keyPath are required', expiry: null, subject: null };
  }

  for (const p of [certPath, keyPath]) {
    if (!fs.existsSync(p)) return { ok: false, error: `File not found: ${p}`, expiry: null, subject: null };
    try {
      fs.accessSync(p, fs.constants.R_OK);
    } catch {
      return { ok: false, error: `File not readable: ${p}`, expiry: null, subject: null };
    }
  }

  let cert;
  try {
    const pem = fs.readFileSync(certPath, 'utf8');
    cert = new crypto.X509Certificate(pem);
  } catch (err) {
    return { ok: false, error: `Invalid certificate PEM: ${err.message}`, expiry: null, subject: null };
  }

  let key;
  try {
    const pem = fs.readFileSync(keyPath, 'utf8');
    key = crypto.createPrivateKey(pem);
  } catch (err) {
    return { ok: false, error: `Invalid private key PEM: ${err.message}`, expiry: null, subject: null };
  }

  if (!cert.checkPrivateKey(key)) {
    return { ok: false, error: 'Certificate and private key do not match', expiry: null, subject: null };
  }

  return { ok: true, error: null, expiry: cert.validTo || null, subject: cert.subject || null };
}

/**
 * Build platform-specific copy-paste instructions for trusting the mkcert root CA on a remote machine.
 * @param {string} carootPath - Path to the mkcert CAROOT directory on this machine.
 * @returns {{ caRootPath: string, rootCaPath: string, steps: Array<{ platform: string, label: string, command: string }>, note: string }}
 */
function getRemoteTrustInstructions(carootPath) {
  const caRootPath = carootPath || '';
  const rootCaPath = caRootPath ? path.join(caRootPath, 'rootCA.pem') : '';

  const steps = [
    {
      platform: 'macOS',
      label: 'Trust the root CA in the System Keychain',
      command: 'sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain rootCA.pem'
    },
    {
      platform: 'Linux',
      label: 'Trust the root CA in the system trust store (Debian/Ubuntu)',
      command: 'sudo cp rootCA.pem /usr/local/share/ca-certificates/tangleclaw-rootCA.crt && sudo update-ca-certificates'
    },
    {
      platform: 'Windows',
      label: 'Trust the root CA (run in an elevated PowerShell)',
      command: 'Import-Certificate -FilePath .\\rootCA.pem -CertStoreLocation Cert:\\LocalMachine\\Root'
    }
  ];

  return {
    caRootPath,
    rootCaPath,
    steps,
    note: 'Copy rootCA.pem from the TangleClaw host to your remote machine, then run the command for your platform from the directory where you copied it.'
  };
}

/**
 * Predict the protocol the server will actually serve under the given config —
 * the single predicate behind every injected "TangleClaw API base URL"
 * (engine configs via `engines._getRulesContent`, the master identity file
 * via `master.buildMasterClaudeMd`).
 *
 * Mirrors boot reality (`server.js` main): in caddy ingress mode TC always
 * binds plain HTTP on the loopback — caddy owns TLS — regardless of
 * `httpsEnabled`; otherwise HTTPS needs `httpsEnabled` AND both cert paths
 * (`httpsEnabled` defaults to true, so a no-cert install serves HTTP via the
 * `createServer` fallback). Same conjunction as `server.js`'s
 * `willServeHttps`. A configured-but-unreadable cert file still falls back to
 * HTTP at runtime with a logged warning — a static predicate can't see file
 * contents, and boot deliberately keeps its own attempt-then-fallback
 * semantics (the warn is the operator's signal).
 *
 * ENG-5R2W: engine configs and the master file previously derived the scheme
 * from `httpsEnabled` alone, so caddy-mode installs (and no-cert installs on
 * the default-true flag) injected an `https://` base URL nothing was serving —
 * every guided API call failed until the caller guessed the http fallback.
 *
 * @param {object} config - Global config (`store.config.load()`).
 * @returns {'http'|'https'} Scheme for localhost API base URLs.
 */
function effectiveServerProtocol(config) {
  if (!config || config.ingressMode === 'caddy') return 'http';
  return (config.httpsEnabled && config.httpsCertPath && config.httpsKeyPath) ? 'https' : 'http';
}

/**
 * Whether a raw `TANGLECLAW_PORT` value names a port the server could bind.
 * Digits only — `Number()` alone would accept `'0x10'` as 16 and `'1e3'` as
 * 1000, which no plist would ever mean.
 * @param {*} raw - Unparsed environment value.
 * @returns {boolean}
 */
function isBindableServerPort(raw) {
  if (raw === undefined || raw === null) return false;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) return false;
  const n = Number(s);
  return n > 0 && n <= 65535;
}

/**
 * Resolve the port the server is actually listening on — the sibling of
 * `effectiveServerProtocol` (#497 / ENG-5R2W) for the other half of every
 * localhost API base URL, and the one derivation shared by the listen call in
 * `server.js` main, engine configs via `engines._getRulesContent`, the master
 * identity file via `master.buildMasterClaudeMd`, and the post-HTTPS-restart
 * redirect.
 *
 * Deliberately NOT used by `scripts/ingress-cutover.js`: that runs
 * out-of-process, where `TANGLECLAW_PORT` describes whoever launched the shell
 * rather than the installed service, so it reads the plist directly.
 *
 * `TANGLECLAW_PORT` wins over config because the installed launchd plist sets
 * it to 3102 and never touches `config.serverPort`, which stays at the shipped
 * default of 3101. Deriving the port from config alone therefore names a port
 * nothing is listening on for every standard install: the post-setup restart
 * redirected operators to a connection-refused page, and generated project
 * configs told their agents the PortHub API lived on 3101, so lease and
 * heartbeat calls failed silently.
 *
 * An unbindable `TANGLECLAW_PORT` falls back rather than propagating a
 * malformed `localhost:NaN` into generated content. This function is pure and
 * silent by design — it runs on every config regeneration, so it must not log.
 * Boot is responsible for saying so loudly once: `server.js` main checks
 * `isBindableServerPort` and logs before binding, which is what preserves the
 * hard failure `server.listen('typo')` used to raise.
 *
 * @param {object} config - Global config (`store.config.load()`).
 * @param {object} [env] - Environment to read; injectable for tests, defaults to `process.env`.
 * @returns {number} Port for localhost API base URLs and for binding.
 */
function effectiveServerPort(config, env) {
  const raw = (env || process.env).TANGLECLAW_PORT;
  if (isBindableServerPort(raw)) return Number(String(raw).trim());
  return (config && config.serverPort) || store.DEFAULT_CONFIG.serverPort;
}

/**
 * The origin an OPERATOR should open — the front door, which is not always the
 * door this server is listening on.
 *
 * This is a different question from `effectiveServerProtocol` /
 * `effectiveServerPort`, and conflating the two is the defect it exists to fix.
 * Those two predict what **TC's own listener** serves. In caddy mode that is
 * plain HTTP on the loopback, because Caddy terminates TLS and proxies inward —
 * so composing them there yields `http://host:3102`, TC's loopback-only and
 * **ungated** door. Sending an operator to it walks them straight past the login
 * gate, and from any other device it is simply dead. The pre-#654 wizard's dead
 * `:3101` redirect, which read as "HTTPS setup is broken", is the same failure
 * from the other direction.
 *
 * In caddy mode the front door is Caddy's HTTPS listener: `buildCaddyfileContent`
 * puts every site on `httpsPort` and gives the plain-HTTP site a `redir` to it,
 * so HTTPS on that port is the one address that always answers. Outside caddy
 * mode the two helpers above ARE the front door, and are reused rather than
 * re-derived.
 *
 * `hostname` must come from the request's `Host` header, never from the
 * Caddyfile: a freshly generated local site says `localhost`, which is not where
 * a remote operator is standing.
 *
 * Pure, so a caller can ask about a config that is not in force yet — the setup
 * route asks about `{ ...config, ingressMode: 'caddy' }` while a cutover is still
 * running, which is precisely "where will they go once this lands".
 *
 * @param {object} config - Global config (`store.config.load()`), or a shallow
 *   override describing the state being moved to.
 * @param {string} hostname - Host the operator reached this server on, no port.
 * @param {object} [env] - Environment; injectable for tests, defaults to `process.env`.
 * @returns {string} Origin — scheme, host and port, no trailing slash or path.
 */
function effectiveOperatorOrigin(config, hostname, env) {
  const host = hostname || 'localhost';
  if (config && config.ingressMode === 'caddy') {
    // The default comes from store, not a local literal: `lib/caddy.js` and the
    // cutover already carry their own `8443`, and a fourth copy is one rename
    // away from naming a port nothing listens on.
    return `https://${host}:${config.caddyHttpsPort || store.DEFAULT_CONFIG.caddyHttpsPort}`;
  }
  return `${effectiveServerProtocol(config)}://${host}:${effectiveServerPort(config, env)}`;
}

/**
 * Attempt to read a certificate's "valid to" timestamp. Returns null on failure.
 * @param {string} certPath
 * @returns {string|null}
 */
function _readCertExpiry(certPath) {
  try {
    const pem = fs.readFileSync(certPath, 'utf8');
    const cert = new crypto.X509Certificate(pem);
    return cert.validTo || null;
  } catch {
    return null;
  }
}

module.exports = {
  detectMkcert,
  isCaInstalled,
  generateCerts,
  validateCertFiles,
  getRemoteTrustInstructions,
  getCertsDir,
  effectiveServerProtocol,
  effectiveServerPort,
  effectiveOperatorOrigin,
  isBindableServerPort
};
