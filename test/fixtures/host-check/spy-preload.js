'use strict';

/**
 * Preloaded (`node -r`) into a real run of `scripts/host-check.js` by T-H0.
 * Wraps every way the process could write a file, run a command, open a
 * socket, open the database or start file logging, records each call, and at
 * exit writes the record to `HOST_CHECK_SPY_REPORT` with the ORIGINAL
 * `writeFileSync`, so the spy's own write is not counted.
 *
 * It records; it does not block. The test asserts on the record.
 */

const fs = require('node:fs');
const childProcess = require('node:child_process');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const sqlite = require('node:sqlite');

const originalWriteFileSync = fs.writeFileSync;
const record = { writes: [], execs: [], sockets: [], requests: [], reads: [], database: [], storeInit: 0, fileLogging: 0 };

/**
 * Replace `obj[name]` with a recording wrapper that still calls the original.
 * @param {object} obj - Module object.
 * @param {string} name - Function name.
 * @param {function(Array): void} onCall - Records the call.
 * @returns {void}
 */
function wrap(obj, name, onCall) {
  const original = obj[name];
  if (typeof original !== 'function') return;
  obj[name] = function wrapped(...args) {
    onCall(args);
    return original.apply(this, args);
  };
}

const WRITE_FNS = ['writeFile', 'writeFileSync', 'appendFile', 'appendFileSync', 'mkdir', 'mkdirSync',
  'mkdtemp', 'mkdtempSync', 'rm', 'rmSync', 'rmdir', 'rmdirSync', 'unlink', 'unlinkSync', 'rename',
  'renameSync', 'copyFile', 'copyFileSync', 'cp', 'cpSync', 'symlink', 'symlinkSync', 'link', 'linkSync',
  'chmod', 'chmodSync', 'chown', 'chownSync', 'truncate', 'truncateSync', 'utimes', 'utimesSync',
  'createWriteStream'];
for (const name of WRITE_FNS) wrap(fs, name, (args) => record.writes.push({ fn: name, target: String(args[0]) }));
for (const name of ['writeFile', 'appendFile', 'mkdir', 'mkdtemp', 'rm', 'rmdir', 'unlink', 'rename', 'copyFile', 'cp', 'symlink', 'chmod', 'truncate']) {
  wrap(fs.promises, name, (args) => record.writes.push({ fn: `promises.${name}`, target: String(args[0]) }));
}
/**
 * Whether an open() flag value can write.
 * @param {*} flags - String or numeric flags.
 * @returns {boolean}
 */
function writesWith(flags) {
  if (flags === undefined || flags === null) return false;
  if (typeof flags === 'number') return (flags & (fs.constants.O_WRONLY | fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_APPEND)) !== 0;
  return /[wa+]/.test(String(flags));
}
wrap(fs, 'openSync', (args) => { if (writesWith(args[1])) record.writes.push({ fn: 'openSync', target: String(args[0]) }); });
wrap(fs, 'open', (args) => { if (writesWith(args[1])) record.writes.push({ fn: 'open', target: String(args[0]) }); });
wrap(fs.promises, 'open', (args) => { if (writesWith(args[1])) record.writes.push({ fn: 'promises.open', target: String(args[0]) }); });
wrap(fs, 'writeSync', (args) => { if (args[0] > 2) record.writes.push({ fn: 'writeSync', target: `fd ${args[0]}` }); });
wrap(fs, 'readFileSync', (args) => record.reads.push(String(args[0])));
wrap(fs, 'readFile', (args) => record.reads.push(String(args[0])));

for (const name of ['exec', 'execSync', 'execFile', 'execFileSync', 'spawn', 'spawnSync', 'fork']) {
  wrap(childProcess, name, (args) => record.execs.push({
    fn: name,
    cmd: String(args[0]),
    args: Array.isArray(args[1]) ? args[1].map(String) : []
  }));
}

for (const name of ['connect', 'createConnection']) {
  wrap(net, name, (args) => {
    const o = args[0] && typeof args[0] === 'object' ? args[0] : { port: args[0], host: args[1] };
    record.sockets.push({ host: o.host || null, port: o.port || null, path: o.path || null });
  });
}
for (const [label, mod] of [['http', http], ['https', https]]) {
  for (const name of ['request', 'get']) {
    wrap(mod, name, (args) => {
      const o = args[0] && typeof args[0] === 'object' && !(args[0] instanceof URL) ? args[0] : { href: String(args[0]) };
      record.requests.push({ module: label, host: o.host || o.hostname || null, port: o.port || null, path: o.path || null, method: o.method || 'GET', headers: Object.keys(o.headers || {}), href: o.href || null });
    });
  }
}

const OriginalDatabase = sqlite.DatabaseSync;
sqlite.DatabaseSync = function SpiedDatabaseSync(...args) {
  record.database.push(String(args[0]));
  return new OriginalDatabase(...args);
};

const store = require('../../../lib/store');
const logger = require('../../../lib/logger');
wrap(store, 'init', () => { record.storeInit += 1; });
wrap(logger, 'initFileLogging', () => { record.fileLogging += 1; });

process.on('exit', () => {
  originalWriteFileSync(process.env.HOST_CHECK_SPY_REPORT, JSON.stringify(record));
});
