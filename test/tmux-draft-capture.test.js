'use strict';

/*
 * The draft recorded before an injection clears the prompt (#1507).
 *
 * The old reader took the last non-empty line of the pane's bottom rows, which
 * in every modern TUI is the status footer under the composer: it logged chrome
 * as the operator's draft on every injection, and the real draft was destroyed
 * with nothing recorded. These tests hand the capture the pane shapes the
 * engines actually draw — composer, divider, footer — through the capture's
 * seams, and drive the clear itself against a real tmux pane. The draft's text
 * is kept in the private draft store; the log carries only where and how big,
 * because logs carry names, never payloads.
 */

const { describe, it, after, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execSync } = require('node:child_process');
const { setLevel, setConsoleStream } = require('../lib/logger');
const { useThrowawayStore } = require('./_engine-store');

setLevel('error');
// The composer profiles come from the engine profiles the store holds.
const _store = useThrowawayStore('tmux-draft-capture');
after(() => _store.cleanup());

const tmux = require('../lib/tmux');
const draftStore = require('../lib/draft-store');
const { IDLE_PANE, DIALOG_PANE, AG_TYPING_PANE } = require('./_wake-fixtures');

const NBSP = ' ';
const CLAUDE_FOOTER = '  ⏵⏵ bypass permissions on (shift+tab to cycle) · ← for agents';
const DIVIDER = '──────────────';

/** The four "drafts" #1507's log evidence recorded — every one a footer. */
const LOGGED_FOOTERS = [
  '⏵⏵ bypass permissions on (shift+tab to cycle)',
  '? for shortcuts',
  'Gemini 3.1 Pro · high',
  '⧉  design-overview'
];

const saved = { ...tmux._draftSeams };
afterEach(() => Object.assign(tmux._draftSeams, saved));

/**
 * Point the capture at a fixed pane and cursor.
 * @param {string[]} lines - The pane tail.
 * @param {{x:number, line:string}|null} cursor - The cursor, or null for "unavailable".
 */
function paneIs(lines, cursor) {
  tmux._draftSeams.capturePane = () => ({ lines, alternateScreen: false });
  tmux._draftSeams.cursorInfo = () => cursor;
}

/**
 * A cursor at the end of `line`'s text, as an engine leaves it after typing.
 * @param {string} line - The row the cursor is on.
 * @returns {{x:number, y:number, line:string}}
 */
function cursorAtEnd(line) {
  return { x: [...line].length, y: 0, line };
}

describe('reading the draft through the engine\'s composer profile', () => {
  it('Claude, composer holds a draft above the footer: the draft\'s text, never the footer', () => {
    const typed = `❯${NBSP}can you check why tilt-claw isn't responding?`;
    paneIs(['  Churned for 17s', DIVIDER, typed, DIVIDER, CLAUDE_FOOTER], cursorAtEnd(typed));
    const d = tmux._readDraft('s', 'claude');
    assert.equal(d.state, 'draft');
    assert.equal(d.text, 'can you check why tilt-claw isn\'t responding?');
  });

  it('Claude, empty composer: nothing to record', () => {
    const empty = `❯${NBSP}`;
    paneIs([...IDLE_PANE.slice(0, 0), DIVIDER, empty, DIVIDER, CLAUDE_FOOTER], { x: 2, y: 0, line: empty });
    assert.deepEqual(tmux._readDraft('s', 'claude'), { state: 'empty', text: '', reason: null, draftPresent: false, rows: 0, complete: true });
  });

  it('Claude, a draft wrapped onto a second row inside the composer box: every row', () => {
    const first = `❯${NBSP}first line of the draft`;
    const second = '  and its second line';
    paneIs(['transcript', DIVIDER, first, second, DIVIDER, CLAUDE_FOOTER], cursorAtEnd(second));
    const d = tmux._readDraft('s', 'claude');
    assert.equal(d.state, 'draft');
    assert.equal(d.text, 'first line of the draft\nand its second line');
  });

  it('Claude, the cursor moved back up a wrapped draft: the rows below it are still the draft', () => {
    const first = `❯${NBSP}first line of the draft`;
    const second = '  and its second line';
    paneIs(['transcript', DIVIDER, first, second, DIVIDER, CLAUDE_FOOTER], { x: 5, y: 0, line: first });
    const d = tmux._readDraft('s', 'claude');
    assert.equal(d.text, 'first line of the draft\nand its second line');
    assert.equal(d.complete, true, 'bounded by the composer\'s lower border');
  });

  it('Codex, animated decoration inside the draft: the operator\'s text only', () => {
    const typed = '› fix⠋ the flaky wrap test';
    paneIs(['• Ran tests', typed, '', '  gpt-5.5 · Ready · 58% context left'], cursorAtEnd(typed));
    const d = tmux._readDraft('s', 'codex');
    assert.equal(d.text, 'fix the flaky wrap test');
    assert.equal(d.complete, false, 'no lower border: read to the cursor, and said to be possibly incomplete');
  });

  it('Claude, a permission dialog: a selector row is not a draft', () => {
    paneIs(DIALOG_PANE, cursorAtEnd(DIALOG_PANE[2]));
    const d = tmux._readDraft('s', 'claude');
    assert.equal(d.state, 'not-located');
    assert.match(d.reason, /not on a composer row/);
  });

  it('Codex: the draft after its glyph and pad, never the footer', () => {
    const typed = '› fix the flaky wrap test';
    paneIs(['• Ran tests', typed, '', '  gpt-5.5 · Ready · 58% context left'], cursorAtEnd(typed));
    const d = tmux._readDraft('s', 'codex');
    assert.equal(d.state, 'draft');
    assert.equal(d.text, 'fix the flaky wrap test');
  });

  it('Antigravity: the draft inside its box, never "? for shortcuts"', () => {
    paneIs(AG_TYPING_PANE, cursorAtEnd(AG_TYPING_PANE[1]));
    const d = tmux._readDraft('s', 'antigravity');
    assert.equal(d.state, 'draft');
    assert.equal(d.text, 'what is the status');
  });

  it('an openclaw connection id is read as its engine', () => {
    paneIs(['x'], cursorAtEnd('x'));
    assert.match(tmux._readDraft('s', 'openclaw:abc').reason, /engine "openclaw" declares no composer profile/);
  });

  it('says why when it cannot tell, and never guesses', () => {
    paneIs(['whatever'], cursorAtEnd('whatever'));
    assert.match(tmux._readDraft('s', null).reason, /engine is unknown/);
    assert.match(tmux._readDraft('s', 'aider').reason, /engine "aider" declares no composer profile/);
    paneIs(['whatever'], null);
    assert.match(tmux._readDraft('s', 'claude').reason, /cursor position was unavailable/);
    tmux._draftSeams.cursorInfo = () => { throw new Error('no such pane'); };
    assert.match(tmux._readDraft('s', 'claude').reason, /cursor could not be read: no such pane/);
  });

  it('a draft whose first row scrolled out of the tail is reported present but not captured', () => {
    const tail = `${NBSP}${NBSP}tail of a long draft`;
    // The cursor is on a glyph row (so the composer holds input), but that row
    // is not in the captured tail.
    const cursorRow = `❯${NBSP}typed`;
    paneIs(['unrelated', tail], { x: 7, y: 0, line: cursorRow });
    const d = tmux._readDraft('s', 'claude');
    assert.equal(d.state, 'not-located');
    assert.equal(d.draftPresent, true);
  });

  it('no footer from #1507\'s evidence is ever read as a draft, on any engine', () => {
    for (const footer of LOGGED_FOOTERS) {
      for (const engine of ['claude', 'codex', 'antigravity']) {
        const glyph = { claude: '❯', codex: '›', antigravity: '>' }[engine];
        const emptyRow = engine === 'claude' ? `${glyph}${NBSP}` : `${glyph} `;
        paneIs([DIVIDER, emptyRow, DIVIDER, `  ${footer}`], { x: 2, y: 0, line: emptyRow });
        const d = tmux._readDraft('s', engine);
        assert.notEqual(d.state, 'draft', `${engine}: an empty composer over "${footer}"`);
        assert.ok(!d.text.includes(footer.trim()), `${engine}: footer text leaked`);
      }
    }
  });
});

describe('the clear: records what it read, and still clears when it could not read', () => {
  const session = '__tc_test_draft_clear__';
  const ATTEMPT = draftStore.sessionAttemptKey(9001);

  /**
   * Run `fn` with the logger's console copy captured.
   * @param {Function} fn - The work.
   * @returns {string} Everything logged.
   */
  function logged(fn) {
    let out = '';
    setConsoleStream({ write: (s) => { out += s; } });
    setLevel('info');
    try { fn(); } finally { setLevel('error'); setConsoleStream(null); }
    return out;
  }

  /**
   * A real bash pane with an unsent line typed at its prompt.
   * @param {string} draft - The typed text.
   */
  function paneWithDraft(draft) {
    tmux.createSession(session, { command: 'exec bash --norc --noprofile' });
    execSync(`tmux send-keys -t '=${session}:' -l '${draft}'`);
    execSync('sleep 0.3');
  }

  /** @returns {string} The pane's current prompt row. */
  function promptRow() {
    execSync('sleep 0.3');
    const rows = tmux.capturePane(session, { full: true }).lines.filter((l) => l.trim());
    return rows[rows.length - 1] || '';
  }

  it('a located draft is logged with its text, and the prompt is cleared', () => {
    try {
      paneWithDraft('echo OPERATORDRAFT');
      const typed = `❯${NBSP}half-typed instruction`;
      paneIs([DIVIDER, typed, DIVIDER, CLAUDE_FOOTER], cursorAtEnd(typed));
      const out = logged(() => tmux._clearPromptLine(session, 'claude', ATTEMPT));
      assert.match(out, /Cleared a draft from the prompt before injecting; kept in the draft store/);
      const kept = draftStore.readDrafts(ATTEMPT);
      assert.equal(kept.at(-1).text, 'half-typed instruction');
      assert.equal(kept.at(-1).engineId, 'claude');
      // Only an opaque reference and a size reach the log: no text, no digest.
      assert.match(out, new RegExp(`draftRef=${ATTEMPT}:${kept.at(-1).id} rows=1 chars=22\\n$`));
      assert.doesNotMatch(out, /half-typed instruction/, 'the log carries names, never the draft');
      assert.doesNotMatch(out, /sha|draftFile/);
      assert.doesNotMatch(out, /bypass permissions/);
      assert.equal(fs.statSync(draftStore.draftFile(ATTEMPT)).mode & 0o777, 0o600, 'readable by the operator only');
      assert.equal(fs.statSync(draftStore.draftsDir()).mode & 0o777, 0o700);
      assert.doesNotMatch(promptRow(), /OPERATORDRAFT/, 'the prompt was cleared');
    } finally {
      try { tmux.killSession(session); } catch (_) { /* already gone */ }
    }
  });

  it('a wrapped draft stays one log entry', () => {
    try {
      paneWithDraft('');
      const first = `❯${NBSP}line one`;
      const second = '  line two';
      paneIs([DIVIDER, first, second, DIVIDER, CLAUDE_FOOTER], cursorAtEnd(second));
      const out = logged(() => tmux._clearPromptLine(session, 'claude', ATTEMPT));
      assert.equal(out.trimEnd().split('\n').length, 1);
      assert.match(out, / rows=2 /);
      assert.equal(draftStore.readDrafts(ATTEMPT).at(-1).text, 'line one\nline two');
    } finally {
      try { tmux.killSession(session); } catch (_) { /* already gone */ }
    }
  });

  it('a stranded switchboard nudge is cleared without being kept as the operator\'s draft (#1621)', () => {
    try {
      paneWithDraft('');
      const wake = require('../lib/medusa-wake');
      const nudge = require('../lib/wake-transports').withNonce(
        wake._nudgeLineFor('/api/sessions/proj-a/medusa', 1, 'http://localhost:3102'), 'a1b2c3d4e5f6');
      const rows = [];
      for (let i = 0; i < nudge.length; i += 76) rows.push((i === 0 ? `❯${NBSP}` : '  ') + nudge.slice(i, i + 76));
      paneIs([DIVIDER, ...rows, DIVIDER, CLAUDE_FOOTER], cursorAtEnd(rows[rows.length - 1]));
      const before = draftStore.readDrafts(ATTEMPT).length;
      const out = logged(() => tmux._clearPromptLine(session, 'claude', ATTEMPT));
      assert.match(out, /Cleared a stranded switchboard nudge from the prompt before injecting/);
      assert.doesNotMatch(out, /kept in the draft store/);
      assert.equal(draftStore.readDrafts(ATTEMPT).length, before, 'nothing the operator typed, so nothing kept');
    } finally {
      try { tmux.killSession(session); } catch (_) { /* already gone */ }
    }
  });

  it('an empty composer logs nothing', () => {
    try {
      paneWithDraft('');
      const empty = `❯${NBSP}`;
      paneIs([DIVIDER, empty, DIVIDER, CLAUDE_FOOTER], { x: 2, y: 0, line: empty });
      assert.equal(logged(() => tmux._clearPromptLine(session, 'claude', ATTEMPT)), '');
    } finally {
      try { tmux.killSession(session); } catch (_) { /* already gone */ }
    }
  });

  it('an engine with no composer profile: still cleared (#812), and the log says no draft was captured', () => {
    try {
      paneWithDraft('echo UNPROFILEDDRAFT');
      const out = logged(() => tmux._clearPromptLine(session, 'aider', ATTEMPT));
      assert.match(out, /draft not captured: composer not located/);
      assert.match(out, /reason=engine "aider" declares no composer profile/);
      assert.doesNotMatch(out, /kept in the draft store|promptBeforeClear/);
      assert.deepEqual(draftStore.readDrafts(ATTEMPT).filter((d) => d.text.includes('UNPROFILEDDRAFT')), []);
      assert.doesNotMatch(promptRow(), /UNPROFILEDDRAFT/, 'cleared anyway: an appended paste would submit it');
    } finally {
      try { tmux.killSession(session); } catch (_) { /* already gone */ }
    }
  });

  it('sendKeys hands the clear the engine it was given', () => {
    try {
      paneWithDraft('');
      const typed = `❯${NBSP}draft via sendKeys`;
      paneIs([DIVIDER, typed, DIVIDER, CLAUDE_FOOTER], cursorAtEnd(typed));
      logged(() => tmux.sendKeys(session, 'true', { enter: false, engineId: 'claude', attemptKey: ATTEMPT }));
      assert.equal(draftStore.readDrafts(ATTEMPT).at(-1).text, 'draft via sendKeys');
    } finally {
      try { tmux.killSession(session); } catch (_) { /* already gone */ }
    }
  });

  it('with no attempt from the caller, the pane\'s own name and creation time key the draft', () => {
    try {
      paneWithDraft('');
      const typed = `❯${NBSP}master draft`;
      paneIs([DIVIDER, typed, DIVIDER, CLAUDE_FOOTER], cursorAtEnd(typed));
      logged(() => tmux._clearPromptLine(session, 'claude'));
      const created = tmux.sessionCreatedAt(session).createdAt;
      assert.ok(created, 'fixture precondition: the pane reports its creation time');
      assert.equal(draftStore.readDrafts(`${session}@${created}`).at(-1).text, 'master draft');
    } finally {
      try { tmux.killSession(session); } catch (_) { /* already gone */ }
    }
  });
});

describe('the draft store', () => {
  it('keeps the most recent drafts per attempt, and no more', () => {
    const key = draftStore.sessionAttemptKey(9101);
    for (let i = 0; i < draftStore.KEEP + 3; i++) {
      draftStore.saveDraft(key, { engineId: 'claude', text: `draft ${i}`, rows: 1, complete: true });
    }
    const kept = draftStore.readDrafts(key);
    assert.equal(kept.length, draftStore.KEEP);
    assert.equal(kept.at(-1).text, `draft ${draftStore.KEEP + 2}`);
    assert.equal(kept[0].text, 'draft 3');
  });

  it('two attempts under one tmux name never share a file', () => {
    draftStore.saveDraft('proj@1000', { engineId: 'claude', text: 'first launch', rows: 1, complete: true });
    draftStore.saveDraft('proj@2000', { engineId: 'claude', text: 'second launch', rows: 1, complete: true });
    assert.deepEqual(draftStore.readDrafts('proj@2000').map((d) => d.text), ['second launch']);
  });

  it('refuses a key that is not an attempt, so no caller can address another path', () => {
    for (const bad of ['../../etc/passwd', 'proj', 'session-x', '', null]) {
      assert.throws(() => draftStore.draftFile(bad), /not an attempt key/);
    }
  });

  it('never writes through a symlink planted where a draft file goes', () => {
    const key = draftStore.sessionAttemptKey(9102);
    fs.mkdirSync(draftStore.draftsDir(), { recursive: true, mode: 0o700 });
    const target = path.join(draftStore.draftsDir(), 'elsewhere.txt');
    fs.writeFileSync(target, 'untouched\n');
    fs.symlinkSync(target, draftStore.draftFile(key));
    assert.throws(() => draftStore.saveDraft(key, { engineId: 'claude', text: 'x', rows: 1, complete: true }), /ELOOP|symbolic/);
    assert.equal(fs.readFileSync(target, 'utf8'), 'untouched\n');
  });

  it('keeps a draft seven days past its attempt: the Operator\'s retention choice', () => {
    assert.equal(draftStore.RETAIN_MS, 7 * 24 * 60 * 60 * 1000);
  });

  it('deletes an attempt\'s file a retention period after it ended, and not before', () => {
    const live = draftStore.sessionAttemptKey(9201);
    const ended = draftStore.sessionAttemptKey(9202);
    const recent = draftStore.sessionAttemptKey(9203);
    for (const k of [live, ended, recent]) draftStore.saveDraft(k, { engineId: 'claude', text: 't', rows: 1, complete: true });
    const now = Date.now();
    const endedAtMs = (k) => ({ [live]: null, [ended]: now - draftStore.RETAIN_MS, [recent]: now - 1000 }[k] ?? null);
    const r = draftStore.pruneDrafts({ now, endedAtMs });
    assert.ok(r.deleted.includes(ended));
    assert.ok(!r.deleted.includes(live) && !r.deleted.includes(recent));
    assert.equal(fs.existsSync(draftStore.draftFile(ended)), false);
    assert.equal(fs.existsSync(draftStore.draftFile(live)), true);
  });

  it('reads a session attempt\'s end from its session row', () => {
    const store = require('../lib/store');
    const project = store.projects.create({ name: 'draft-retention', path: fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'tc-dr-')), engine: 'claude' });
    const row = store.sessions.start({ projectId: project.id, engineId: 'claude', tmuxSession: 'draft-retention' });
    const key = draftStore.sessionAttemptKey(row.id);
    draftStore.saveDraft(key, { engineId: 'claude', text: 't', rows: 1, complete: true });
    assert.deepEqual(draftStore.pruneDrafts({ now: Date.now() + 2 * draftStore.RETAIN_MS }).deleted.filter((k) => k === key), [],
      'a live attempt keeps its drafts however old');
    store.sessions.kill(row.id, 'test');
    assert.deepEqual(draftStore.pruneDrafts({ now: Date.now() + draftStore.RETAIN_MS + 60000 }).deleted.filter((k) => k === key), [key]);
  });

  it('a draft that cannot be kept is reported without its text, and the prompt is still cleared', () => {
    const session = '__tc_test_draft_unkept__';
    try {
      tmux.createSession(session, { command: 'exec bash --norc --noprofile' });
      const typed = `❯${NBSP}secret-ish draft`;
      paneIs([DIVIDER, typed, DIVIDER, CLAUDE_FOOTER], cursorAtEnd(typed));
      tmux._draftSeams.saveDraft = () => { throw new Error('EACCES'); };
      let out = '';
      setConsoleStream({ write: (x) => { out += x; } });
      setLevel('info');
      try { tmux._clearPromptLine(session, 'claude', draftStore.sessionAttemptKey(9301)); } finally { setLevel('error'); setConsoleStream(null); }
      assert.match(out, /could not be kept before clearing it .*error=EACCES/);
      assert.doesNotMatch(out, /secret-ish/);
    } finally {
      try { tmux.killSession(session); } catch (_) { /* already gone */ }
    }
  });
});

describe('every injection names its engine', () => {
  it('each sendKeys call outside lib/tmux.js passes engineId', () => {
    const root = path.join(__dirname, '..', 'lib');
    const files = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        if (e.isDirectory()) walk(abs);
        else if (e.name.endsWith('.js') && abs !== path.join(root, 'tmux.js')) files.push(abs);
      }
    };
    walk(root);
    const calls = [];
    for (const f of files) {
      const src = fs.readFileSync(f, 'utf8');
      const re = /\bsendKeys\(/g;
      let m;
      while ((m = re.exec(src))) {
        // The call's own argument list, up to its matching close paren.
        let depth = 0;
        let end = m.index + m[0].length - 1;
        for (; end < src.length; end++) {
          if (src[end] === '(') depth++;
          else if (src[end] === ')' && --depth === 0) break;
        }
        const call = src.slice(m.index, end + 1);
        // A declaration or a seam default (`sendKeys: null`, a JSDoc mention) is not a call site.
        if (/^sendKeys\((tmuxSession|session), text/.test(call)) continue;
        calls.push({ file: path.relative(root, f), call });
      }
    }
    assert.ok(calls.length >= 7, `found the call sites (${calls.length})`);
    const missing = calls.filter((c) => !/engineId/.test(c.call));
    assert.deepEqual(missing.map((c) => `${c.file}: ${c.call.split('\n')[0]}`), []);
  });
});
