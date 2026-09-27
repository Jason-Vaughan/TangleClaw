'use strict';

/*
 * #1836 — `tc` keeps Node's "EnvHttpProxyAgent is experimental" warning off
 * its stderr, and only that warning. Under Codex's loopback network profile
 * the engine sets NODE_USE_ENV_PROXY=1, Node raises the warning while it
 * bootstraps, and without the filter it lands in every `tc` answer an agent
 * reads.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');

const { suppressBenignWarnings } = require('../lib/tc-warnings');

/**
 * A warning shaped the way Node delivers one to its listeners.
 * @param {string} code - Warning code.
 * @returns {Error}
 */
function warning(code) {
  return Object.assign(new Error(`warning ${code}`), { name: 'Warning', code });
}

describe('tc warning filter (#1836)', () => {
  it('drops the experimental env-proxy warning and hands every other warning to the original listener', () => {
    const proc = new EventEmitter();
    const seen = [];
    proc.on('warning', (w) => seen.push(w.code));
    suppressBenignWarnings(proc);
    proc.emit('warning', warning('UNDICI-EHPA'));
    proc.emit('warning', warning('DEP0005'));
    proc.emit('warning', Object.assign(new Error('no code'), { name: 'Warning' }));
    assert.deepEqual(seen, ['DEP0005', undefined]);
  });

  it('is idempotent: installing twice neither doubles delivery nor re-wraps', () => {
    const proc = new EventEmitter();
    const seen = [];
    proc.on('warning', (w) => seen.push(w.code));
    suppressBenignWarnings(proc);
    suppressBenignWarnings(proc);
    assert.equal(proc.listenerCount('warning'), 1);
    proc.emit('warning', warning('X-OTHER'));
    assert.deepEqual(seen, ['X-OTHER']);
  });

  it('a real tc run under NODE_USE_ENV_PROXY prints its own error and no proxy-agent warning (needs a Node that raises the env-proxy warning)', (t) => {
    const env = {
      ...process.env,
      NODE_USE_ENV_PROXY: '1',
      HTTP_PROXY: 'http://127.0.0.1:9',
      HTTPS_PROXY: 'http://127.0.0.1:9',
      NO_PROXY: '',
      TANGLECLAW_API: 'http://127.0.0.1:9'
    };
    delete env.NODE_NO_WARNINGS;
    // The control: without the filter, does this Node print the warning at
    // all? If not, "tc printed none" would prove nothing.
    const control = spawnSync(process.execPath, ['-e', 'setTimeout(() => {}, 20)'], { env, encoding: 'utf8', timeout: 30000 });
    if (!control.stderr.includes('UNDICI-EHPA')) {
      t.skip(`Node ${process.version} does not raise the env-proxy warning, so its absence would prove nothing`);
      return;
    }
    const tc = spawnSync(process.execPath, [path.join(__dirname, '..', 'bin', 'tc'), 'whoami'], { env, encoding: 'utf8', timeout: 30000 });
    assert.equal(tc.status, 2, `tc reports the unreachable server: ${tc.stderr}`);
    assert.match(tc.stderr, /^tc: /m, 'tc still says what happened');
    assert.ok(!tc.stderr.includes('UNDICI-EHPA'), `the proxy-agent warning leaked: ${tc.stderr}`);
  });
});
