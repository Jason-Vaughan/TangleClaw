'use strict';

/*
 * Tests for #438 — the session page's Copy buttons.
 *
 * A drag in the web terminal is consumed by the engine's TUI, which copies on
 * the HOST (pbcopy plus a tmux buffer) and never reaches the viewing device.
 * Desktop has the #431 Option-drag gesture; a phone has no Option key, so its
 * copy path is: banner Copy → GET /api/sessions/:project/clipboard →
 * `tmux show-buffer` → `tcCopyToClipboard`. The Peek drawer's Copy copies its
 * own rendered DOM text, so a phone needs no selection step at all.
 *
 * The tmux read is driven by a REAL fake `tmux` on PATH rather than a stubbed
 * error: the classification reads Node's child-process error shape plus tmux's
 * stderr wording, and a stub would assert the model under test (#894 lesson).
 */

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { setLevel } = require('../lib/logger');

setLevel('error');

const tmux = require('../lib/tmux');

const ROOT = path.join(__dirname, '..');

/**
 * Put a fake `tmux` at the front of PATH whose `show-buffer` verb behaves as
 * scripted, and return a restore function.
 *
 * `has-session` answers "live" so callers that probe first still get past it;
 * every other verb exits 0 silently so a server-side poller that fires during
 * the test cannot fail the run.
 *
 * @param {string} showBufferScript - Shell for the `show-buffer` branch.
 * @returns {() => void} Restores PATH and removes the fake.
 */
function installFakeTmux(showBufferScript) {
  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-fake-tmux-438-'));
  const script = [
    '#!/bin/sh',
    'case "$1" in',
    `  show-buffer) ${showBufferScript} ;;`,
    '  has-session) exit 0 ;;',
    '  *) exit 0 ;;',
    'esac'
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(binDir, 'tmux'), script, { mode: 0o755 });
  const realPath = process.env.PATH;
  process.env.PATH = `${binDir}:${realPath}`;
  return () => {
    process.env.PATH = realPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  };
}

/**
 * Point PATH at a directory holding no `tmux` at all, and return a restore
 * function. `sh` is still reachable — `execSync` invokes `/bin/sh` by path.
 * @returns {() => void}
 */
function removeTmuxFromPath() {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-no-tmux-438-'));
  const realPath = process.env.PATH;
  process.env.PATH = emptyDir;
  return () => {
    process.env.PATH = realPath;
    fs.rmSync(emptyDir, { recursive: true, force: true });
  };
}

/**
 * Make an HTTP request to the test server.
 * @param {http.Server} server
 * @param {string} urlPath
 * @returns {Promise<{ status: number, body: object }>}
 */
function get(server, urlPath) {
  return new Promise((resolve, reject) => {
    const addr = server.address();
    const req = http.request({ hostname: '127.0.0.1', port: addr.port, path: urlPath, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        let parsed;
        try { parsed = JSON.parse(raw); } catch { parsed = raw; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/**
 * Extract a function's body from source by walking brace depth.
 * @param {string} src - File source
 * @param {string} marker - Text locating the function (e.g. 'function foo(')
 * @returns {string} the body including braces; '' when not found
 */
function functionBody(src, marker) {
  const start = src.indexOf(marker);
  if (start === -1) return '';
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') {
      depth--;
      if (depth === 0) return src.slice(bodyStart, i + 1);
    }
  }
  return '';
}

describe('tmux.readNewestBuffer — the newest buffer, or the honest reason there is none (#438)', () => {
  it('returns the buffer text UNTRIMMED — leading indentation and the trailing newline are content', () => {
    // THE MUTATION THIS CATCHES: routing the read through `_exec`, whose
    // `.trim()` would eat a copied snippet's first-line indentation.
    const restore = installFakeTmux('printf "    indented first line\\nsecond line\\n"; exit 0');
    try {
      const result = tmux.readNewestBuffer();
      assert.equal(result.ok, true);
      assert.equal(result.text, '    indented first line\nsecond line\n');
    } finally {
      restore();
    }
  });

  it('names "no buffers" as no-buffer, not as a failure', () => {
    // tmux 3.6a's exact wording for a server with nothing copied yet.
    const restore = installFakeTmux('echo "no buffers" >&2; exit 1');
    try {
      const result = tmux.readNewestBuffer();
      assert.equal(result.ok, false);
      assert.equal(result.cause, 'no-buffer');
      assert.match(result.error, /nothing to copy yet/i);
    } finally {
      restore();
    }
  });

  it('names an absent tmux server as no-server — nothing has been copied there either', () => {
    // Both wordings tmux uses, depending on whether the socket exists.
    for (const line of ['no server running on /private/tmp/tmux-501/default', 'error connecting to /private/tmp/tmux-501/default (No such file or directory)']) {
      const restore = installFakeTmux(`echo "${line}" >&2; exit 1`);
      try {
        const result = tmux.readNewestBuffer();
        assert.equal(result.ok, false);
        assert.equal(result.cause, 'no-server', line);
      } finally {
        restore();
      }
    }
  });

  it('names a missing tmux binary as tmux-missing', () => {
    const restore = removeTmuxFromPath();
    try {
      const result = tmux.readNewestBuffer();
      assert.equal(result.ok, false);
      assert.equal(result.cause, 'tmux-missing');
      assert.match(result.error, /not installed/);
    } finally {
      restore();
    }
  });

  it('reports any other tmux failure with its message, never as an empty success', () => {
    const restore = installFakeTmux('echo "protocol version mismatch (client 8, server 7)" >&2; exit 1');
    try {
      const result = tmux.readNewestBuffer();
      assert.equal(result.ok, false);
      assert.equal(result.cause, 'error');
      assert.match(result.error, /protocol version mismatch/);
    } finally {
      restore();
    }
  });
});

describe('sessions.clipboard + GET /api/sessions/:project/clipboard (#438)', () => {
  let tmpDir;
  let server;
  let store;
  let sessions;

  before(async () => {
    store = require('../lib/store');
    sessions = require('../lib/sessions');
    const { createServer } = require('../server');

    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-clipboard-438-'));
    store._setBasePath(tmpDir);
    store.init();

    const projectsDir = path.join(tmpDir, 'projects');
    fs.mkdirSync(projectsDir, { recursive: true });
    const config = store.config.load();
    config.projectsDir = projectsDir;
    store.config.save(config);

    for (const name of ['clip-none', 'clip-tmux', 'clip-webui']) {
      const dir = path.join(projectsDir, name);
      fs.mkdirSync(dir, { recursive: true });
      store.projects.create({ name, path: dir, engine: 'claude' });
    }
    const tmuxProject = store.projects.getByName('clip-tmux');
    store.sessions.start({ projectId: tmuxProject.id, engineId: 'claude', tmuxSession: 'fake-clip-438' });
    const webuiProject = store.projects.getByName('clip-webui');
    store.sessions.start({ projectId: webuiProject.id, engineId: 'openclaw', sessionMode: 'webui' });

    server = createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  });

  after(async () => {
    await new Promise((resolve) => server.close(resolve));
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('404 NOT_FOUND for an unknown project', async () => {
    const res = await get(server, '/api/sessions/no-such-project/clipboard');
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'NOT_FOUND');
    assert.match(res.body.error, /not found/);
  });

  it('404 NOT_FOUND when the project has no active session', async () => {
    const res = await get(server, '/api/sessions/clip-none/clipboard');
    assert.equal(res.status, 404);
    assert.equal(res.body.code, 'NOT_FOUND');
    assert.match(res.body.error, /No active session/);
  });

  it('404 for a Web UI session, saying why — there is no tmux to read', async () => {
    const res = await get(server, '/api/sessions/clip-webui/clipboard');
    assert.equal(res.status, 404);
    assert.match(res.body.error, /Web UI/);
  });

  it('200 with the buffer text and its character count when a buffer exists', async () => {
    const restore = installFakeTmux('printf "  copied from the pane\\n"; exit 0');
    try {
      const res = await get(server, '/api/sessions/clip-tmux/clipboard');
      assert.equal(res.status, 200);
      assert.equal(res.body.text, '  copied from the pane\n');
      assert.equal(res.body.chars, '  copied from the pane\n'.length);
      assert.equal(res.body.project, 'clip-tmux');
      assert.equal(res.body.tmuxSession, 'fake-clip-438');
    } finally {
      restore();
    }
  });

  it('404 NO_BUFFER when nothing has been copied yet — "nothing to copy", not "session gone"', async () => {
    const restore = installFakeTmux('echo "no buffers" >&2; exit 1');
    try {
      const res = await get(server, '/api/sessions/clip-tmux/clipboard');
      assert.equal(res.status, 404);
      assert.equal(res.body.code, 'NO_BUFFER');
      assert.match(res.body.error, /nothing to copy yet/i);
    } finally {
      restore();
    }
  });

  it('404 NO_BUFFER when no tmux server holds a buffer', async () => {
    const restore = installFakeTmux('echo "no server running on /private/tmp/tmux-501/default" >&2; exit 1');
    try {
      const res = await get(server, '/api/sessions/clip-tmux/clipboard');
      assert.equal(res.status, 404);
      assert.equal(res.body.code, 'NO_BUFFER');
      assert.match(res.body.error, /tmux server is not running/);
    } finally {
      restore();
    }
  });

  it('404 TMUX_UNAVAILABLE naming the missing binary when tmux is not installed', async () => {
    // THE MUTATION THIS CATCHES: a `hasSession` probe ahead of the read. Run
    // through the shell, a missing binary reads as "no such session", and the
    // operator would be told their session is gone when tmux is.
    const restore = removeTmuxFromPath();
    try {
      const res = await get(server, '/api/sessions/clip-tmux/clipboard');
      assert.equal(res.status, 404);
      assert.equal(res.body.code, 'TMUX_UNAVAILABLE');
      assert.match(res.body.error, /tmux is not installed/);
    } finally {
      restore();
    }
  });

  it('sessions.clipboard carries the tmux session name alongside a NO_BUFFER refusal', () => {
    const restore = installFakeTmux('echo "no buffers" >&2; exit 1');
    try {
      const result = sessions.clipboard('clip-tmux');
      assert.equal(result.text, null);
      assert.equal(result.code, 'NO_BUFFER');
      assert.equal(result.tmuxSession, 'fake-clip-438');
    } finally {
      restore();
    }
  });
});

describe('tcCopyOutcome — one toast decision for both Copy buttons (#438)', () => {
  before(() => {
    require('../public/api-helper.js');
  });

  it('reports the character count on success, singular and plural', () => {
    const { tcCopyOutcome } = globalThis;
    assert.deepEqual(tcCopyOutcome({ text: 'x', copied: true }), { msg: 'Copied 1 character', cls: 'toast-ok' });
    const outcome = tcCopyOutcome({ text: 'a'.repeat(1234), copied: true });
    assert.equal(outcome.cls, 'toast-ok');
    assert.match(outcome.msg, /^Copied 1,?234 characters$/);
  });

  it('a NO_BUFFER refusal is "nothing to copy yet", not a failure', () => {
    const { tcCopyOutcome } = globalThis;
    const outcome = tcCopyOutcome({ error: 'Nothing to copy yet — no terminal selection has been copied', errorCode: 'NO_BUFFER' });
    assert.equal(outcome.cls, 'toast-warn');
    assert.match(outcome.msg, /^Nothing to copy yet/);
    assert.doesNotMatch(outcome.msg, /Could not/);
  });

  it('empty text is "nothing to copy yet" even when the fetch succeeded', () => {
    const { tcCopyOutcome } = globalThis;
    assert.match(tcCopyOutcome({ text: '', copied: true }).msg, /^Nothing to copy yet/);
    assert.match(tcCopyOutcome({ text: null }).msg, /^Nothing to copy yet/);
  });

  it('names the server reason on any other refusal', () => {
    const { tcCopyOutcome } = globalThis;
    const outcome = tcCopyOutcome({ error: 'tmux is not installed on the TangleClaw host', errorCode: 'TMUX_UNAVAILABLE' });
    assert.equal(outcome.cls, 'toast-warn');
    assert.match(outcome.msg, /tmux is not installed on the TangleClaw host/);
  });

  it('the NO_BUFFER toast never tells a phone to select text — it points at Peek → Copy', () => {
    // The button exists for the device that cannot select the terminal at all.
    const { tcCopyOutcome } = globalThis;
    const outcome = tcCopyOutcome({ error: 'x', errorCode: 'NO_BUFFER' });
    assert.doesNotMatch(outcome.msg, /select text/i);
    assert.match(outcome.msg, /Peek/);
  });

  it('tcClipboardWritePath picks the in-gesture ClipboardItem write only when every capability it needs is present', () => {
    const { tcClipboardWritePath } = globalThis;
    assert.equal(tcClipboardWritePath({ hasWrite: true, hasClipboardItem: true, secure: true }), 'item');
    assert.equal(tcClipboardWritePath({ hasWrite: false, hasClipboardItem: true, secure: true }), 'legacy');
    assert.equal(tcClipboardWritePath({ hasWrite: true, hasClipboardItem: false, secure: true }), 'legacy');
    assert.equal(tcClipboardWritePath({ hasWrite: true, hasClipboardItem: true, secure: false }), 'legacy',
      'plain HTTP has no async Clipboard API — the legacy path is the only one there');
    assert.equal(tcClipboardWritePath(undefined), 'legacy');
  });

  it('a refused clipboard write is reported as such — never "Copied"', () => {
    // THE MUTATION THIS CATCHES: toasting the count before checking `copied`.
    const { tcCopyOutcome } = globalThis;
    const outcome = tcCopyOutcome({ text: 'some text', copied: false });
    assert.equal(outcome.cls, 'toast-warn');
    assert.doesNotMatch(outcome.msg, /^Copied/);
  });
});

describe('Session page wiring — source pins (#438)', () => {
  let sessionJs;
  let sessionHtml;

  before(() => {
    sessionJs = fs.readFileSync(path.join(ROOT, 'public', 'session.js'), 'utf8');
    sessionHtml = fs.readFileSync(path.join(ROOT, 'public', 'session.html'), 'utf8');
  });

  it('the banner carries a Copy button and the Peek drawer carries its own', () => {
    assert.match(sessionHtml, /<button[^>]*id="copyBtn"[^>]*>Copy<\/button>/);
    assert.match(sessionHtml, /<button[^>]*id="peekCopy"[^>]*>Copy<\/button>/);
  });

  it('both buttons are wired to their handlers', () => {
    assert.ok(sessionJs.includes("$('copyBtn').addEventListener('click', copyTerminalSelection)"));
    assert.ok(sessionJs.includes("$('peekCopy').addEventListener('click', copyPeekText)"));
  });

  it('the toolbar handler fetches the clipboard route and carries the server code to the toast decision', () => {
    const fetchBody = functionBody(sessionJs, 'async function fetchTerminalSelection(');
    assert.ok(fetchBody, 'fetchTerminalSelection must exist');
    assert.ok(fetchBody.includes('/clipboard`'), 'must read GET /api/sessions/:project/clipboard');
    assert.ok(fetchBody.includes('api.lastErrorCode'), 'the server code (NO_BUFFER) must reach the decision');
    const body = functionBody(sessionJs, 'async function copyTerminalSelection(');
    assert.ok(body, 'copyTerminalSelection must exist');
    assert.ok(body.includes('tcCopyToClipboard('), 'the iOS-safe helper is the fallback clipboard path (#436)');
    assert.ok(body.includes('tcCopyOutcome('), 'toast wording goes through the tested decision');
  });

  it('the toolbar handler issues the promise-valued ClipboardItem write INSIDE the gesture — no await before it', () => {
    // iOS Safari drops user activation across an await; the one write it keeps
    // activation for is a ClipboardItem whose value is the pending fetch.
    const body = functionBody(sessionJs, 'async function copyTerminalSelection(');
    assert.ok(body.includes('tcClipboardWritePath('), 'the path is the tested decision');
    const writeCall = "await nav.clipboard.write([new ClipboardItem({ 'text/plain': blobPromise })])";
    const writeAt = body.indexOf(writeCall);
    assert.ok(writeAt !== -1, 'must hand navigator.clipboard.write a ClipboardItem holding the fetch promise, not the resolved text');
    const before = body.slice(0, writeAt);
    assert.ok(!/\bawait\b/.test(before),
      'no await may precede the write call — that is the activation the fix exists to keep');
  });

  it('the Peek handler copies the drawer\'s rendered text, not a fresh terminal read', () => {
    const body = functionBody(sessionJs, 'async function copyPeekText(');
    assert.ok(body, 'copyPeekText must exist');
    assert.ok(body.includes('peekRawText'), 'must copy the ANSI-stripped text the drawer shows');
    assert.ok(!body.includes('/clipboard'), 'a phone needs no tmux selection for this path');
    assert.ok(body.includes('tcCopyToClipboard(') && body.includes('tcCopyOutcome('));
  });

  it('Web UI sessions get the Copy button disabled like Peek — there is no tmux to read', () => {
    const body = functionBody(sessionJs, 'function applyWebuiMode(');
    assert.ok(body.includes("disable('copyBtn'"));
  });
});

describe('The buffer is the operator\'s, not TangleClaw\'s (#438)', () => {
  it('sendKeys deletes its delivery buffer (paste-buffer -d) so the newest buffer is never a command-bar send', () => {
    // THE MUTATION THIS CATCHES: dropping `-d`. Buffers are server-global and
    // `show-buffer` reads the newest, so every injection would then shadow the
    // operator's copy — one install had 3,331 delivery buffers stacked up.
    // Whole-source pin, as the #75 `-p` pin is: `sendKeys(session, text,
    // options = {})` defeats a brace-walking body extractor at its own
    // signature. The module has exactly one paste-buffer call.
    const source = fs.readFileSync(path.join(ROOT, 'lib', 'tmux.js'), 'utf8');
    assert.equal(source.split('tmux paste-buffer').length - 1, 1, 'one paste-buffer call site');
    assert.match(source, /tmux paste-buffer -p -t \$\{_target\(session\)\} -d/);
  });

  it('deploy/tmux.conf no longer pipes copy-mode drags into a file nothing reads', () => {
    const conf = fs.readFileSync(path.join(ROOT, 'deploy', 'tmux.conf'), 'utf8');
    const bindings = conf.split('\n').filter((line) => /^\s*bind-key/.test(line));
    assert.equal(bindings.filter((line) => line.includes('MouseDragEnd1Pane')).length, 0,
      'the MouseDragEnd1Pane override must stay retired — the default sets the tmux buffer the Copy button reads');
    assert.ok(!bindings.some((line) => line.includes('.tangleclaw/clipboard')));
  });
});
