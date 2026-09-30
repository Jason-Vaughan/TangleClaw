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
 * @param {number} [postStatus=201] - What a POST answers.
 * @returns {Promise<{code: number, stdout: string}>}
 */
async function run(phase, env, answer, postStatus = 201) {
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.method === 'GET') return res.end(JSON.stringify(answer));
    res.statusCode = postStatus;
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
  afterEach(() => { for (const f of fs.readdirSync(tmp)) fs.rmSync(path.join(tmp, f), { recursive: true, force: true }); });

  it('pre passes when the forwarded thread is the channel\'s, and fails when it is not or is missing', async () => {
    const ok = await run('pre', { TMPDIR: tmp, CODEX_THREAD_ID: 'old' }, { rotation: null, binding: { channelThread: 'old' } });
    assert.equal(ok.code, 0, ok.stdout);
    const wrong = await run('pre', { TMPDIR: tmp, CODEX_THREAD_ID: 'old' }, { rotation: null, binding: { channelThread: 'other' } });
    assert.equal(wrong.code, 1);
    const missing = await run('pre', { TMPDIR: tmp }, { rotation: null, binding: { channelThread: 'old' } });
    assert.equal(missing.code, 1);
    assert.match(missing.stdout, /FAIL {2}CODEX_THREAD_ID is exported/);
  });

  it('keeps its state in a private directory, and refuses one another user could have planted', async () => {
    await run('pre', { TMPDIR: tmp, CODEX_THREAD_ID: 'old' }, { rotation: null, binding: { channelThread: 'old' } });
    const dirs = fs.readdirSync(tmp).filter((f) => f.startsWith('tc-rotation-live-check-'));
    assert.equal(dirs.length, 1);
    assert.equal(fs.statSync(path.join(tmp, dirs[0])).mode & 0o077, 0, 'owner-only');
    fs.chmodSync(path.join(tmp, dirs[0]), 0o777);
    const r = await run('pre', { TMPDIR: tmp, CODEX_THREAD_ID: 'old' }, { rotation: null, binding: { channelThread: 'old' } });
    assert.equal(r.code, 2, 'a loosened directory is refused');
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
    const alreadyResumed = { rotation: null, latest: { ...good.rotation, state: 'active' }, binding: { matches: true } };
    const resumed = await run('post', { TMPDIR: tmp, CODEX_THREAD_ID: 'new' }, alreadyResumed);
    assert.equal(resumed.code, 0, `a context that already resumed passes: ${resumed.stdout}`);
    for (const status of [400, 403, 500]) {
      const refused = await run('post', { TMPDIR: tmp, CODEX_THREAD_ID: 'new' }, good, status);
      assert.equal(refused.code, 1, `a ${status} to the workload write is not a pass`);
    }
  });
});
