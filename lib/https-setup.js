'use strict';

// TLS for DIRECT ingress mode (mkcert-issued local certs that TC terminates
// itself). AUTH-1 (#395 / ADR 0003): in caddy ingress mode Caddy terminates TLS
// instead and this module is bypassed for the listener — but it is RETAINED as
// the rollback target (and the cutover reuses the mkcert cert it generates for
// Caddy's local site). Do not delete until the Caddy cutover has soaked. See
// lib/caddy.js and deploy/INGRESS.md.
//
// NOTE for whoever retires this module after the soak: `effectiveServerProtocol`,
// `effectiveServerPort`, `effectiveOperatorFrontDoor` and `effectiveOperatorOrigin`
// are NOT TLS logic. The first two answer "what is the server actually serving,
// and where" for every localhost API base URL TangleClaw injects; the second two
// answer the DIFFERENT question of where an operator should knock, which behind
// Caddy is a different address entirely. They live here only because the protocol
// half was born beside the cert code. All four must be RELOCATED **together** —
// callers read them as a set, and separating the two questions is what the third
// exists to keep straight — never dropped with the rest of the module.

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
 * The mDNS name to put in the certificate's SAN list, given an OS hostname.
 *
 * `os.hostname()` on macOS usually ALREADY carries the `.local` suffix, so
 * appending one unconditionally produced `Machine-Name.local.local` — a SAN
 * matching nothing, which silently cost the certificate the one name another
 * device on the LAN can actually resolve. Extracted so the suffix rule is
 * checkable directly rather than only through a mkcert shell-out.
 *
 * @param {string|undefined|null} hostname - Raw `os.hostname()` value.
 * @returns {string|null} The mDNS host, or null when there is no usable name.
 */
function mdnsHostFor(hostname) {
  if (!hostname || typeof hostname !== 'string') return null;
  const trimmed = hostname.trim().replace(/\.+$/, '');
  if (!trimmed) return null;
  return trimmed.toLowerCase().endsWith('.local') ? trimmed : `${trimmed}.local`;
}

/**
 * Every host name a regenerated certificate must carry.
 *
 * Regeneration must never SHRINK the SAN list: a cert minted with a tailnet
 * FQDN, regenerated from the defaults alone, silently stops covering the name
 * the tailnet HTTPS site reuses it for. Measured on a clean-room install, so
 * this is not a theoretical hazard. Every path that generates or previews a
 * cert calls THIS, because two paths drifted once already — the union was added
 * to one and the other silently kept dropping names (#863).
 *
 * Lives here rather than in `scripts/ingress-cutover.js` because every input it
 * reads is defined in this module, and it now has a second consumer:
 * `servedHostAllowlist` derives from it, so "the names we serve" cannot drift
 * from "the names the certificate carries" (#864). The script re-exports it.
 *
 * @param {string|null} certPath - Existing cert to carry names forward from.
 * @param {object} config - Loaded TangleClaw config.
 * @returns {string[]} Deduplicated host list for mkcert.
 */
function certHostUnion(certPath, config) {
  // Read the standard cert location as well as whatever the caller resolved.
  // The "no valid cert configured" branch calls this BEFORE its certPath is
  // assigned — still null — and that is precisely the branch that regenerates,
  // so reading only the argument carried nothing forward and dropped every
  // name. Verified by running it: a cert holding a tailnet FQDN still came out
  // with only the defaults until this fallback existed.
  const candidates = [certPath, path.join(getCertsDir(), 'cert.pem')].filter(Boolean);
  const carried = candidates.flatMap((p) => certSanHosts(p));
  return [...new Set([
    ...carried,
    ...MKCERT_HOSTS_DEFAULT,
    mdnsHostFor(os.hostname()),
    (config && config.caddyTailnetHost) || null,
    (config && config.publicDomain) || null
  ].filter(Boolean))];
}

/**
 * The host names this install legitimately answers to.
 *
 * Both cross-site guards decide "is this cross-site?" *relative to the request
 * itself* — `Sec-Fetch-Site` is computed by the browser from the page's own
 * origin, and the upgrade guard compares `Origin` against the request's own
 * `Host`. An attacker who controls DNS satisfies both: point `evil.example` at
 * `127.0.0.1`, get the operator to load it, and the browser reports
 * `same-origin` because as far as it knows, it is. The guards are asking the
 * request to vouch for itself. This list is the independent answer they check
 * against (#864).
 *
 * **Derived from `certHostUnion`, not assembled alongside it.** The names this
 * install serves and the names its certificate carries are the same question
 * asked twice, and the union had already drifted between two call sites once
 * (#863). Building a parallel copy here would have made a third, and it would
 * have been the only one missing `certSanHosts` — so an install whose cert
 * carries an operator-added name (added via `POST /api/setup/generate-cert`,
 * which lands in no config field) would load the dashboard over a valid
 * certificate, serve reads, then refuse every write and destroy every terminal
 * upgrade. The cert is the only record of those names, which is exactly why
 * this reads them from it.
 *
 * The one addition is the bare machine name: `studio` alongside `studio.local`.
 * A certificate has no reason to carry it, but a browser sends whatever the
 * operator typed, and on many LANs the short form resolves.
 *
 * IPv6 literals are stored unbracketed, matching what `new URL().hostname`
 * yields for a bracketed `Host` — the caller compares against that, never
 * against the raw header (see `_hostIsAllowed` in `server.js`).
 *
 * @param {object|null} config - Store config; `publicDomain` and
 *   `caddyTailnetHost` are read when present.
 * @param {object} [options]
 * @param {string} [options.hostname] - Override for `os.hostname()` (tests).
 * @param {string[]} [options.certHosts] - Override for the `certHostUnion`
 *   result (tests), so a case can pin behaviour without minting a certificate.
 * @param {string[]} [options.extraHosts] - Additional names to trust.
 * @returns {Set<string>} Lower-cased names, safe to test membership against.
 */
function servedHostAllowlist(config, options = {}) {
  const fromCert = Object.prototype.hasOwnProperty.call(options, 'certHosts')
    ? (options.certHosts || [])
    : certHostUnion(null, config);

  const allowed = new Set();
  for (const name of fromCert) {
    if (typeof name === 'string' && name.trim()) allowed.add(name.trim().toLowerCase());
  }

  const rawHostname = Object.prototype.hasOwnProperty.call(options, 'hostname')
    ? options.hostname
    : os.hostname();
  const mdnsHost = mdnsHostFor(rawHostname);
  if (mdnsHost) {
    allowed.add(mdnsHost.toLowerCase());
    allowed.add(mdnsHost.toLowerCase().replace(/\.local$/, ''));
  }

  // NOTE: bare IP addresses are deliberately NOT enumerated here. The caller
  // (`_hostIsAllowed` in `server.js`) accepts any IP-literal `Host` outright,
  // because an IP cannot be rebound — see the reasoning there. Listing this
  // machine's interface addresses would add a machine-dependent set that
  // changes with the network, to answer a question already answered.

  for (const name of options.extraHosts || []) {
    if (typeof name === 'string' && name.trim()) allowed.add(name.trim().toLowerCase());
  }

  allowed.delete('');
  return allowed;
}

/**
 * Every host name and IP already carried in a certificate's subjectAltName.
 *
 * Regenerating a certificate is DESTRUCTIVE to names nobody recorded anywhere
 * else: no config field stores the host list a cert was minted with, so a
 * regeneration that passes only the defaults silently drops a tailnet FQDN added
 * later via `POST /api/setup/generate-cert`, and the tailnet HTTPS site — which
 * reuses this very cert — stops matching. Reading the names back out of the cert
 * is the only way to preserve them, because the cert is the sole record.
 *
 * Returns `[]` on anything unreadable, so a caller unions against nothing rather
 * than aborting.
 *
 * @param {string} certPath - Path to the PEM certificate.
 * @returns {string[]} SAN entries as bare names/IPs, in certificate order.
 */
function certSanHosts(certPath) {
  if (!certPath) return [];
  try {
    const cert = new crypto.X509Certificate(fs.readFileSync(certPath, 'utf8'));
    const san = cert.subjectAltName;
    if (!san) return [];
    // Node renders SANs as `DNS:name, IP Address:1.2.3.4`. Split on commas that
    // separate entries, then strip the type prefix. Quoted forms appear for
    // names needing escaping; drop the quotes so the value round-trips to mkcert.
    return san.split(',')
      .map((part) => part.trim())
      .map((part) => {
        const idx = part.indexOf(':');
        return idx === -1 ? part : part.slice(idx + 1).trim();
      })
      .map((v) => (v.startsWith('"') && v.endsWith('"') ? v.slice(1, -1) : v))
      .filter(Boolean);
  } catch (err) {
    // Returning [] is correct — the caller unions against nothing and still
    // emits a working cert — but it must not be SILENT. This is the read whose
    // failure shrinks a certificate's SAN, which is precisely the outcome this
    // function exists to prevent and which shipped broken twice before a
    // clean-room run caught it. An empty result that nobody logged is
    // indistinguishable from a cert that genuinely had no names.
    log.warn('Could not read certificate SAN list — regeneration cannot carry existing names forward',
      { certPath, error: err.message });
    return [];
  }
}

/**
 * Does this certificate actually cover `host`?
 *
 * Serving a site under a name the certificate does not carry fails in the
 * browser with a name-mismatch the operator cannot fix, so a name is only worth
 * putting in the Caddyfile once the cert vouches for it. Answers **false** on
 * any unreadable or unparseable cert rather than throwing: the caller's next
 * move is "then don't advertise that name", which is the safe direction, and a
 * missing cert is already reported elsewhere.
 *
 * @param {string} certPath - Path to the PEM certificate.
 * @param {string} host - Hostname to check.
 * @returns {boolean}
 */
function certCoversHost(certPath, host) {
  if (!certPath || !host) return false;
  try {
    const cert = new crypto.X509Certificate(fs.readFileSync(certPath, 'utf8'));
    // checkHost() implements RFC 6125 name matching (SAN first, wildcards) —
    // far more than a substring search over the SAN string would, and it is the
    // same comparison a client performs.
    return cert.checkHost(host) !== undefined;
  } catch {
    return false;
  }
}

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

  const mdnsHost = mdnsHostFor(os.hostname());
  const hosts = Array.isArray(options.hosts) && options.hosts.length > 0
    ? options.hosts
    : [...MKCERT_HOSTS_DEFAULT, ...(mdnsHost ? [mdnsHost] : [])];

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
 * NOT the scheme to send an OPERATOR to (#710 chunk 3). In caddy mode this
 * returns `http` — correctly, since that is what TC binds — while the operator's
 * front door is Caddy's HTTPS port. `effectiveOperatorFrontDoor` answers that
 * question and reuses this one only where the two coincide.
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
 * `server.js` main, engine configs via `engines._getRulesContent`, and the master
 * identity file via `master.buildMasterClaudeMd`.
 *
 * NOT the post-setup redirect any more (#710 chunk 3). That asks where the
 * OPERATOR should knock, which behind Caddy is a different address than the one
 * this server is bound to — `effectiveOperatorFrontDoor` answers it, and reuses
 * this function only for the direct-mode case where the two coincide.
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
 * @returns {{origin: string, via: 'proxy'|'server'}} `origin` is scheme, host and
 *   port with no trailing slash. `via` says WHO answers there: `'proxy'` when
 *   Caddy is in front (a response from it proves nothing about the server behind
 *   it, which is why the two travel together), `'server'` when the origin is this
 *   server's own listener.
 */
function effectiveOperatorFrontDoor(config, hostname, env) {
  const host = hostname || 'localhost';
  if (config && config.ingressMode === 'caddy') {
    // The default comes from store, not a local literal: `lib/caddy.js` and the
    // cutover already carry their own `8443`, and a fourth copy is one rename
    // away from naming a port nothing listens on.
    return {
      origin: `https://${host}:${config.caddyHttpsPort || store.DEFAULT_CONFIG.caddyHttpsPort}`,
      via: 'proxy'
    };
  }
  return {
    origin: `${effectiveServerProtocol(config)}://${host}:${effectiveServerPort(config, env)}`,
    via: 'server'
  };
}

/**
 * The front door as a bare origin string, for callers that need only the address.
 *
 * `via` and `origin` come out of one conditional deliberately. A caller that
 * probes the origin to decide whether TangleClaw is back needs to know whether a
 * response proves anything — behind a proxy it does not, because the proxy stays
 * up and answers while the server behind it restarts — and two separate
 * derivations of "is this proxied" would be free to disagree with the address
 * they describe.
 * @param {object} config - Global config, or a shallow override.
 * @param {string} hostname - Host the operator reached this server on, no port.
 * @param {object} [env] - Environment; injectable for tests.
 * @returns {string} Origin — scheme, host and port, no trailing slash or path.
 */
function effectiveOperatorOrigin(config, hostname, env) {
  return effectiveOperatorFrontDoor(config, hostname, env).origin;
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
  MKCERT_HOSTS_DEFAULT,
  mdnsHostFor,
  certHostUnion,
  servedHostAllowlist,
  certCoversHost,
  certSanHosts,
  detectMkcert,
  isCaInstalled,
  generateCerts,
  validateCertFiles,
  getRemoteTrustInstructions,
  getCertsDir,
  effectiveServerProtocol,
  effectiveServerPort,
  effectiveOperatorFrontDoor,
  effectiveOperatorOrigin,
  isBindableServerPort
};
