'use strict';

/**
 * The helper's config: where TangleClaw is, and the one author, server and
 * channel it listens to (#2031). It holds no secret. It lives outside the
 * repository, owner-only, so no Discord id is ever in a tracked file.
 *
 * The base URL is checked because the helper token travels to it in a header.
 * The bridge answers the helper only for a request made directly from this
 * machine, so the base URL must name this machine: `http` or `https`, on a
 * loopback host.
 *
 * @module lib/bridge-helper/config
 */

const fs = require('node:fs');
const path = require('node:path');

/** A Discord id: a snowflake. */
const SNOWFLAKE = /^\d{15,20}$/;

/** Hosts that are this machine. */
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** How often the helper asks what to post, in seconds: the bounds and the default. */
const POLL = Object.freeze({ min: 5, max: 300, default: 15 });

/** A config that is absent or not usable. The message names a code and a field, never a value. */
class ConfigError extends Error {
  /**
   * @param {('config-missing'|'config-invalid')} code - Why.
   * @param {string} [field] - Which field, when one is at fault.
   */
  constructor(code, field) {
    super(field ? `${code}: ${field}` : code);
    this.code = code;
    this.field = field || null;
  }
}

/**
 * Where the helper keeps everything of its own.
 * @param {string} home - The user's home directory.
 * @returns {{dir: string, config: string, state: string, lock: string, status: string}}
 */
function paths(home) {
  const dir = path.join(home, '.tangleclaw', 'bridge-helper');
  return {
    dir, config: path.join(dir, 'config.json'), state: path.join(dir, 'state.json'),
    lock: path.join(dir, 'helper.pid'), status: path.join(dir, 'status.json')
  };
}

/**
 * TangleClaw's origin, from a base URL the operator gave.
 * @param {*} value - The URL as given.
 * @returns {string|null} The origin, or null when it is not one the helper will send its token to.
 */
function usableOrigin(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    return null;
  }
  if (url.username || url.password || !LOOPBACK.has(url.hostname)) return null;
  return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : null;
}

/**
 * Check a config and return it in its stored form.
 * @param {object} raw - Candidate config.
 * @returns {{baseUrl: string, authorId: string, guildId: string, channelId: string, pollSeconds: number}}
 * @throws {ConfigError} Naming the first field that does not pass.
 */
function validate(raw) {
  const config = raw && typeof raw === 'object' ? raw : {};
  const baseUrl = usableOrigin(config.baseUrl);
  if (!baseUrl) throw new ConfigError('config-invalid', 'baseUrl');
  for (const field of ['authorId', 'guildId', 'channelId']) {
    if (typeof config[field] !== 'string' || !SNOWFLAKE.test(config[field])) throw new ConfigError('config-invalid', field);
  }
  const pollSeconds = config.pollSeconds === undefined ? POLL.default : config.pollSeconds;
  if (!Number.isInteger(pollSeconds) || pollSeconds < POLL.min || pollSeconds > POLL.max) throw new ConfigError('config-invalid', 'pollSeconds');
  return { baseUrl, authorId: config.authorId, guildId: config.guildId, channelId: config.channelId, pollSeconds };
}

/**
 * Read the config.
 * @param {string} file - Its path.
 * @returns {{baseUrl: string, authorId: string, guildId: string, channelId: string, pollSeconds: number}}
 * @throws {ConfigError} `config-missing` when there is none, `config-invalid` when it does not pass.
 */
function readConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new ConfigError(err.code === 'ENOENT' ? 'config-missing' : 'config-invalid');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ConfigError('config-invalid');
  }
  return validate(parsed);
}

/**
 * Write the config, owner-only, replacing any earlier one whole.
 * @param {string} file - Its path.
 * @param {object} raw - Candidate config; checked first, and nothing is written if it does not pass.
 * @returns {object} What was written.
 * @throws {ConfigError} When it does not pass.
 */
function writeConfig(file, raw) {
  const config = validate(raw);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return config;
}

module.exports = { ConfigError, SNOWFLAKE, paths, usableOrigin, readConfig, writeConfig };
