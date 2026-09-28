'use strict';

/**
 * The helper's two secrets, kept only in the macOS Keychain (#1799, invariant 3).
 *
 * Read with `/usr/bin/security find-generic-password -s <service> -a <account> -w`,
 * whose standard output is the secret. It is stored with
 * `add-generic-password -U ... -w` and NO value after `-w`, which makes
 * `security` prompt; the value is written to that prompt on standard input. The
 * secret is therefore never in a process argument (visible to `ps`), an
 * environment variable, a file or a log, and an error from either call is
 * mapped to a closed code rather than passed on, because `security`'s own
 * stderr is not ours to vouch for.
 *
 * @module lib/discord-helper/secrets
 */

const { execFile, spawn } = require('node:child_process');

/** The two secrets, by the name the CLI uses. */
const SECRETS = Object.freeze({
  bot: { service: 'tangleclaw-discord-helper', account: 'discord-bot-token' },
  channel: { service: 'tangleclaw-discord-helper', account: 'operator-channel-token' }
});

const SECURITY = '/usr/bin/security';

/** A refusal whose message names a code and never the secret or `security`'s output. */
class SecretError extends Error {
  /**
   * @param {string} code - `secret-missing` or `secret-read-failed`
   * @param {string} name - Which secret
   */
  constructor(code, name) {
    super(`${code}: ${name}`);
    this.code = code;
    this.secretName = name;
  }
}

/**
 * Injectable process seams, so tests can prove what reaches argv and stdin.
 * @type {{execFile: Function, spawn: Function}}
 */
const _internal = { execFile, spawn };

/**
 * Read one secret from the Keychain.
 * @param {'bot'|'channel'} name - Which secret
 * @returns {Promise<string>}
 */
function readSecret(name) {
  const item = SECRETS[name];
  if (!item) return Promise.reject(new SecretError('secret-read-failed', String(name)));
  return new Promise((resolve, reject) => {
    _internal.execFile(SECURITY, ['find-generic-password', '-s', item.service, '-a', item.account, '-w'],
      { timeout: 10000 }, (err, stdout) => {
        if (err) {
          // 44 is `security`'s "item not found".
          return reject(new SecretError(err.code === 44 ? 'secret-missing' : 'secret-read-failed', name));
        }
        const value = String(stdout || '').replace(/\n$/, '');
        if (!value) return reject(new SecretError('secret-missing', name));
        resolve(value);
      });
  });
}

/**
 * Store one secret in the Keychain, replacing any earlier value.
 * @param {'bot'|'channel'} name - Which secret
 * @param {string} value - The secret; it travels on stdin only
 * @returns {Promise<void>}
 */
function storeSecret(name, value) {
  const item = SECRETS[name];
  if (!item || typeof value !== 'string' || !value || /[\r\n]/.test(value)) {
    return Promise.reject(new SecretError('secret-read-failed', String(name)));
  }
  return new Promise((resolve, reject) => {
    // `-w` last and with no value: `security` then prompts for the password,
    // twice, and reads both answers from stdin.
    const child = _internal.spawn(SECURITY,
      ['add-generic-password', '-U', '-s', item.service, '-a', item.account, '-w'],
      { stdio: ['pipe', 'ignore', 'ignore'] });
    child.on('error', () => reject(new SecretError('secret-read-failed', name)));
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new SecretError('secret-read-failed', name))));
    child.stdin.end(`${value}\n${value}\n`);
  });
}

module.exports = { SECRETS, SecretError, readSecret, storeSecret, _internal };
