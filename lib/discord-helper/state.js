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
 * A write that fails is one answer, `StateWriteError`, and changes nothing: the
 * file keeps what it held, and so does this process, which adopts a `set` or a
 * `remove` only once it is on disk. A caller that could not record an attempt
 * has therefore not made one.
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
 * The state file exists but cannot be read. It is never replaced by an empty
 * record, because forgetting a `posting` entry could post that reply twice.
 */
class StateError extends Error {
  constructor() {
    super('state-unreadable');
    this.code = 'state-unreadable';
  }
}

/**
 * The state file could not be written (a full disk, permissions). The record
 * on disk is whatever it was before the write.
 */
class StateWriteError extends Error {
  constructor() {
    super('state-write-failed');
    this.code = 'state-write-failed';
  }
}

/**
 * Read the state file.
 * @param {string} file - Absolute path
 * @returns {{salt: string, replies: object}|null} null when there is no file yet
 * @throws {StateError} When the file exists and is not a state record
 */
function readData(file) {
  if (!fs.existsSync(file)) return null;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  // prawduct:allow prawduct/broad-except -- an unreadable or unparsable file is one answer, a closed code
  } catch {
    throw new StateError();
  }
  if (!parsed || typeof parsed.salt !== 'string' || !parsed.replies || typeof parsed.replies !== 'object') throw new StateError();
  return parsed;
}

/**
 * The entries, read without writing: for `status`, which runs beside a live
 * helper and must never write back a copy older than the helper's.
 * @param {string} file - Absolute path
 * @returns {Array<[number, object]>}
 * @throws {StateError} When the file exists and is not a state record
 */
function peekState(file) {
  const data = readData(file);
  return data ? Object.entries(data.replies).map(([k, v]) => [Number(k), v]) : [];
}

/**
 * Open (or create) the state file. Only one process may hold it open: the
 * running helper, or `settle` while the helper is stopped.
 * @throws {StateError} When the file exists and is not a state record
 * @throws {StateWriteError} When the file cannot be written; `set` and `remove` throw it too
 * @param {string} file - Absolute path
 * @returns {{get: function(number): (object|undefined), set: function(number, object): void,
 *   remove: function(number): void, entries: function(): Array<[number, object]>, salt: string}}
 */
function openState(file) {
  const data = readData(file) || { salt: crypto.randomBytes(3).toString('hex'), replies: {} };
  /**
   * Write the record with `replies` in it, and only then make them this
   * process's own. Every write of the file passes through here.
   * @param {object} replies - The entries to hold from now on
   * @returns {void}
   * @throws {StateWriteError} When the write failed; nothing changed
   */
  const save = (replies) => {
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
      fs.writeFileSync(tmp, JSON.stringify({ ...data, replies }), { mode: 0o600 });
      fs.renameSync(tmp, file);
    // prawduct:allow prawduct/broad-except -- any failed write is one answer, a closed code; fs's own message names paths
    } catch {
      try { fs.rmSync(tmp, { force: true }); } catch { /* left behind; the next write replaces it */ } // prawduct:allow prawduct/broad-except -- a temp file that cannot be removed changes nothing about the answer
      throw new StateWriteError();
    }
    data.replies = replies;
  };
  save(data.replies);
  return {
    salt: data.salt,
    get: (id) => data.replies[String(id)],
    set: (id, entry) => save({ ...data.replies, [String(id)]: entry }),
    remove: (id) => {
      const rest = { ...data.replies };
      delete rest[String(id)];
      save(rest);
    },
    entries: () => Object.entries(data.replies).map(([k, v]) => [Number(k), v])
  };
}

/**
 * The Discord nonce for one part of one outbound item: at most 25 characters,
 * as Discord requires. Part 0 keeps the plain form.
 * @param {string} salt - The state file's salt
 * @param {number} outboundId - TangleClaw outbound id
 * @param {number} [part] - Which part of a split item
 * @returns {string}
 */
function nonceFor(salt, outboundId, part = 0) {
  return `tc${salt}${outboundId}${part ? `p${part}` : ''}`.slice(0, 25);
}

module.exports = { openState, peekState, nonceFor, StateError, StateWriteError };
