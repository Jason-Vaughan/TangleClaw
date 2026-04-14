'use strict';

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

  // Install CA (idempotent — mkcert detects existing CA and no-ops)
  try {
    _run('mkcert', ['-install']);
  } catch (err) {
    throw new Error(`mkcert -install failed: ${err.message}`);
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
  getCertsDir
};
