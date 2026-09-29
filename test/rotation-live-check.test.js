'use strict';

/*
 * #2032: the live-Codex check script is itself checked here, against a stub
 * server, so the verdicts an independent executor reads from a real pane mean
 * what they say: `pre` passes only when the forwarded thread is the channel's,
 * and `post` passes only for a new thread that is the bound replacement.
 */

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'rotation-live-check.js');

/**
 * Run a phase against a stub answering `GET /api/tc/rotation` with `rotation`.
 * @param {string} phase - pre | post.
 * @param {object} env - CODEX_THREAD_ID and friends.
 * @param {object} answer - The GET body.
 * @returns {Promise<{code: number, stdout: string}>}
 */
async function run(phase, env, answer) {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') return res.end(JSON.stringify(answer));
    res.statusCode = 201;
    return res.end('{}');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    return await new Promise((resolve) => {
      execFile(process.execPath, [SCRIPT, phase], {
        env: { PATH: process.env.PATH, TMPDIR: env.TMPDIR, TANGLECLAW_API: `http://127.0.0.1:${server.address().port}`,
          TANGLECLAW_PROJECT_ID: '1', TANGLECLAW_LAUNCH_ID: 'launch-live', ...env }
      }, (err, stdout) => resolve({ code: err ? err.code : 0, stdout }));
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

describe('scripts/rotation-live-check.js (#2032)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-live-check-'));
  afterEach(() => { for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f)); });

  it('pre passes when the forwarded thread is the channel\'s, and fails when it is not or is missing', async () => {
    const ok = await run('pre', { TMPDIR: tmp, CODEX_THREAD_ID: 'old' }, { rotation: null, binding: { channelThread: 'old' } });
    assert.equal(ok.code, 0, ok.stdout);
    const wrong = await run('pre', { TMPDIR: tmp, CODEX_THREAD_ID: 'old' }, { rotation: null, binding: { channelThread: 'other' } });
    assert.equal(wrong.code, 1);
    const missing = await run('pre', { TMPDIR: tmp }, { rotation: null, binding: { channelThread: 'old' } });
    assert.equal(missing.code, 1);
    assert.match(missing.stdout, /FAIL {2}CODEX_THREAD_ID is exported/);
  });

  it('post passes only for a new thread that the reconciling rotation bound', async () => {
    await run('pre', { TMPDIR: tmp, CODEX_THREAD_ID: 'old' }, { rotation: null, binding: { channelThread: 'old' } });
    const good = { rotation: { state: 'reconciling', replacementThreadId: 'new', priorThreadId: 'old' }, binding: { matches: true } };
    const ok = await run('post', { TMPDIR: tmp, CODEX_THREAD_ID: 'new' }, good);
    assert.equal(ok.code, 0, ok.stdout);
    const same = await run('post', { TMPDIR: tmp, CODEX_THREAD_ID: 'old' }, { ...good, rotation: { ...good.rotation, replacementThreadId: 'old' } });
    assert.equal(same.code, 1, 'the same thread as before is not a rotation');
    const unbound = await run('post', { TMPDIR: tmp, CODEX_THREAD_ID: 'new' }, { ...good, rotation: { ...good.rotation, replacementThreadId: 'third' } });
    assert.equal(unbound.code, 1);
  });
});
