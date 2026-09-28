'use strict';

/**
 * The helper's durable record of replies it is posting (#1799, invariant 6 and
 * "a restart between post and ack").
 *
 * One entry per TangleClaw outbound id: `posting` is written BEFORE the post is
 * sent and `posted` (with Discord's message id) the moment Discord answers, so
 * a restart finds either a reply it knows it posted (it only re-acknowledges) or
 * one whose post may or may not have landed. The file is written atomically
 * (temp file, then rename) so a crash never leaves half a record.
 *
 * Also holds a per-state-file salt for Discord nonces: the nonce is derived from
 * the outbound id, and ids restart from 1 if TangleClaw's database is replaced,
 * so the salt keeps a new install's reply 1 from matching an old one inside
 * Discord's de-duplication window.
 *
 * @module lib/discord-helper/state
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Open (or create) the state file.
 * @param {string} file - Absolute path
 * @returns {{get: function(number): (object|undefined), set: function(number, object): void,
 *   remove: function(number): void, entries: function(): Array<[number, object]>, salt: string}}
 */
function openState(file) {
  let data = { salt: crypto.randomBytes(3).toString('hex'), replies: {} };
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed && typeof parsed.salt === 'string' && parsed.replies && typeof parsed.replies === 'object') data = parsed;
  }
  /** @returns {void} */
  const save = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };
  save();
  return {
    salt: data.salt,
    get: (id) => data.replies[String(id)],
    set: (id, entry) => { data.replies[String(id)] = entry; save(); },
    remove: (id) => { delete data.replies[String(id)]; save(); },
    entries: () => Object.entries(data.replies).map(([k, v]) => [Number(k), v])
  };
}

/**
 * The Discord nonce for one outbound id: at most 25 characters, as Discord requires.
 * @param {string} salt - The state file's salt
 * @param {number} outboundId - TangleClaw outbound id
 * @returns {string}
 */
function nonceFor(salt, outboundId) {
  return `tc${salt}${outboundId}`.slice(0, 25);
}

module.exports = { openState, nonceFor };
