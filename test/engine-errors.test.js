'use strict';

/*
 * #261 — lib/engine-errors.js: the parser strategies an engine profile may
 * name, the validation of an `errorPatterns` declaration, and the
 * record/clear rule that turns one pane capture into `lastEngineError`.
 */

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const { setLevel } = require('../lib/logger');

setLevel('error');

const engineErrors = require('../lib/engine-errors');

// The shape Codex echoes for a failed Responses API call — the case the issue
// was filed on: an unsupported model under the current auth mode, every prompt.
const CODEX_400 = '{"type":"error","status":400,"error":{"type":"invalid_request_error",'
  + '"code":"unsupported_model","message":"The requested model \'gpt-5-codex\' is not supported '
  + 'under the current authentication mode. Sign in with an API key or choose a different model.",'
  + '"param":"model"}}';
const CODEX_500 = '{"type":"error","status":500,"error":{"type":"server_error",'
  + '"message":"The server had an error while processing your request. Sorry about that!"}}';

/** The Codex profile's declaration, as `data/engines/codex.json` ships it. */
function codexProfile() {
  return { id: 'codex', errorPatterns: [{ regex: '\\{"type":"error"', parser: 'codex-json' }] };
}

describe('engine-errors — codex-json parser', () => {
  it('parses a real 400 invalid_request_error: status, inner type, provider message', () => {
    const parsed = engineErrors.parseCodexJson(CODEX_400);
    assert.ok(parsed, 'a 4xx structured error must parse');
    assert.equal(parsed.status, 400);
    assert.equal(parsed.type, 'invalid_request_error');
    assert.match(parsed.message, /not supported under the current authentication mode/);
  });

  it('parses a 500 server_error', () => {
    const parsed = engineErrors.parseCodexJson(CODEX_500);
    assert.equal(parsed.status, 500);
    assert.equal(parsed.type, 'server_error');
    assert.match(parsed.message, /had an error while processing/);
  });

  it('reads a status carried inside the error object', () => {
    const parsed = engineErrors.parseCodexJson('{"type":"error","error":{"status":429,"type":"rate_limit_error","message":"slow down"}}');
    assert.equal(parsed.status, 429);
    assert.equal(parsed.type, 'rate_limit_error');
  });

  it('is not an API failure without a 4xx/5xx status, and not an error event without type=error', () => {
    assert.equal(engineErrors.parseCodexJson('{"type":"error","status":200,"error":{"message":"odd"}}'), null);
    assert.equal(engineErrors.parseCodexJson('{"type":"error","error":{"message":"no status"}}'), null);
    assert.equal(engineErrors.parseCodexJson('{"type":"response.completed","status":400}'), null);
    assert.equal(engineErrors.parseCodexJson('plain prose about {"type":"error"}'), null);
  });

  it('strict mode refuses a fragment; lenient mode still recovers status, type and message from it', () => {
    const fragment = CODEX_400.slice(0, 160); // tmux wrapped it and the rest never came
    assert.match(fragment, /"message":"The requested model '/, 'the fragment must cut mid-message');
    assert.equal(engineErrors.parseCodexJson(fragment), null, 'strict: not whole yet');
    const lenient = engineErrors.parseCodexJson(fragment, { lenient: true });
    assert.equal(lenient.status, 400);
    assert.equal(lenient.type, 'invalid_request_error');
    assert.match(lenient.message, /^The requested model/);
  });

  it('clamps a paragraph-long provider message', () => {
    const long = `{"type":"error","status":400,"error":{"type":"x","message":"${'m'.repeat(2000)}"}}`;
    const parsed = engineErrors.parseCodexJson(long);
    assert.ok(parsed.message.length <= 400, `message must be clamped, got ${parsed.message.length}`);
    assert.ok(parsed.message.endsWith('…'));
  });
});

describe('engine-errors — validatePatterns', () => {
  it('an absent field is fine; a present one must be an array of { regex, parser }', () => {
    assert.deepEqual(engineErrors.validatePatterns(undefined), []);
    assert.deepEqual(engineErrors.validatePatterns([]), []);
    assert.deepEqual(engineErrors.validatePatterns([{ regex: '^x', parser: 'codex-json' }]), []);
    assert.equal(engineErrors.validatePatterns('nope').length, 1);
    assert.equal(engineErrors.validatePatterns([null]).length, 1);
  });

  it('a regex that does not compile is rejected with the entry named', () => {
    const errors = engineErrors.validatePatterns([{ regex: '[', parser: 'codex-json' }]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^errorPatterns\[0\]\.regex does not compile/);
  });

  it('a parser is a NAME from the shipped table — anything else is rejected', () => {
    const errors = engineErrors.validatePatterns([{ regex: '^x', parser: 'require("child_process")' }]);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /parser must be one of: codex-json/);
    assert.deepEqual([...engineErrors.PARSER_NAMES], Object.keys(engineErrors.PARSERS));
  });

  it('an empty regex is rejected — it would match every line', () => {
    const errors = engineErrors.validatePatterns([{ regex: '', parser: 'codex-json' }]);
    assert.ok(errors.some((e) => /regex must be a non-empty string/.test(e)));
  });

  it('a nested quantifier is rejected with the reason — the pattern runs on the event loop per row per tick', () => {
    for (const bad of ['(a+)+', '^(\\d*)*$', '(x+)*y', '(ab*)+', '(a{2,})+']) {
      const errors = engineErrors.validatePatterns([{ regex: bad, parser: 'codex-json' }]);
      assert.equal(errors.length, 1, `${bad} must be rejected`);
      assert.match(errors[0], /nests a quantifier inside a quantified group/);
    }
    for (const fine of ['\\{"type":"error"', '(a|b)+', 'a+b*', '(?:x)+', '(a+)']) {
      assert.deepEqual(engineErrors.validatePatterns([{ regex: fine, parser: 'codex-json' }]), [], `${fine} must be accepted`);
    }
    assert.deepEqual(engineErrors.compilePatterns({ id: 'p', errorPatterns: [{ regex: '(a+)+', parser: 'codex-json' }] }), [],
      'the compiler skips what the validator rejects');
  });
});

describe('engine-errors — scanLines', () => {
  const compiled = engineErrors.compilePatterns(codexProfile());

  it('finds the structured error among ordinary rows', () => {
    const hit = engineErrors.scanLines(['> fix the tests', CODEX_400, '', '> '], compiled);
    assert.equal(hit.status, 400);
    assert.equal(hit.line, CODEX_400);
  });

  it('reassembles a line tmux wrapped across rows at the pane width', () => {
    const width = 80;
    const rows = [];
    for (let i = 0; i < CODEX_400.length; i += width) rows.push(CODEX_400.slice(i, i + width));
    assert.ok(rows.length > 2, 'the fixture must actually wrap');
    const hit = engineErrors.scanLines(['> prompt', ...rows, '', '> '], compiled);
    assert.ok(hit, 'a wrapped error must still be found');
    assert.equal(hit.status, 400);
    assert.equal(hit.type, 'invalid_request_error');
    assert.match(hit.message, /choose a different model\.$/, 'reassembly must recover the whole message');
  });

  it('still finds the line behind a TUI gutter, indent or wrap prefix — the bundled regex is not anchored', () => {
    const bundled = JSON.parse(require('node:fs').readFileSync(
      require('node:path').join(__dirname, '..', 'data', 'engines', 'codex.json'), 'utf8'));
    const list = engineErrors.compilePatterns(bundled);
    for (const prefix of ['  ', '│ ', '⏺ ', '> ']) {
      const hit = engineErrors.scanLines([`${prefix}${CODEX_400}`], list);
      assert.ok(hit && hit.status === 400, `prefix ${JSON.stringify(prefix)} must not defeat detection`);
    }
  });

  it('caps the row an operator-authored pattern runs against', () => {
    const list = engineErrors.compilePatterns({ id: 'p', errorPatterns: [{ regex: 'NEEDLE$', parser: 'codex-json' }] });
    const long = 'x'.repeat(engineErrors.MAX_ROW_CHARS) + 'NEEDLE';
    assert.equal(engineErrors.scanLines([long], list), null, 'text past the cap is never seen by the regex');
    const within = 'x'.repeat(engineErrors.MAX_ROW_CHARS - 200) + CODEX_500;
    assert.equal(engineErrors.scanLines([within], engineErrors.compilePatterns(codexProfile())).status, 500);
  });

  it('reports the most recent of two errors', () => {
    const hit = engineErrors.scanLines([CODEX_500, 'retrying', CODEX_400], compiled);
    assert.equal(hit.status, 400);
  });

  it('ignores an SGR-wrapped line no worse than a plain one, and finds nothing in a healthy pane', () => {
    const wrapped = `[31m${CODEX_500}[0m`;
    assert.equal(engineErrors.scanLines([wrapped], compiled).status, 500);
    assert.equal(engineErrors.scanLines(['> prompt', 'Sure — here is the diff', '> '], compiled), null);
    assert.equal(engineErrors.scanLines(['{"type":"error","status":200}'], compiled), null);
  });

  it('an engine with no patterns scans nothing', () => {
    assert.deepEqual(engineErrors.compilePatterns({ id: 'claude' }), []);
    assert.deepEqual(engineErrors.compilePatterns(null), []);
    assert.equal(engineErrors.scanLines([CODEX_400], []), null);
  });

  it('a pattern validation would reject is skipped, not fatal for its neighbours', () => {
    const list = engineErrors.compilePatterns({
      id: 'weird',
      errorPatterns: [{ regex: '(', parser: 'codex-json' }, { regex: 'nope', parser: 'unknown' }, { regex: '^\\{', parser: 'codex-json' }]
    });
    assert.equal(list.length, 1);
    assert.equal(engineErrors.scanLines([CODEX_400], list).status, 400);
  });
});

describe('engine-errors — observe: the record/clear rule', () => {
  let clock;
  beforeEach(() => {
    engineErrors._reset();
    clock = 1_700_000_000_000;
    engineErrors._internal.now = () => clock;
  });
  afterEach(() => {
    engineErrors._internal.now = () => Date.now();
    engineErrors._reset();
  });

  const session = { id: 7 };

  it('records { type, status, message, timestamp } on a match and exposes it without the raw row', () => {
    const rec = engineErrors.observe(session, ['> go', CODEX_400], codexProfile());
    assert.deepEqual(rec, {
      type: 'invalid_request_error',
      status: 400,
      message: rec.message,
      timestamp: new Date(clock).toISOString()
    });
    assert.equal('line' in engineErrors.get(7), false, 'the matched row stays internal');
  });

  it('the same row still on screen keeps its first-seen timestamp', () => {
    engineErrors.observe(session, [CODEX_400], codexProfile());
    clock += 60_000;
    const again = engineErrors.observe(session, ['above', CODEX_400, '> '], codexProfile());
    assert.equal(again.timestamp, new Date(clock - 60_000).toISOString());
  });

  it('clears once a capture no longer holds a matching row — the pane moved past it', () => {
    engineErrors.observe(session, [CODEX_400], codexProfile());
    assert.ok(engineErrors.get(7));
    const cleared = engineErrors.observe(session, ['> next prompt', 'Done — 3 files changed', '> '], codexProfile());
    assert.equal(cleared, null);
    assert.equal(engineErrors.get(7), null);
  });

  it('an EMPTY capture is no reading — the record and its timestamp survive it (#894 shape)', () => {
    engineErrors.observe(session, [CODEX_400], codexProfile());
    const before = engineErrors.get(7);
    clock += 4_000;
    // Exactly what `tmux.capturePane` returns when tmux failed or timed out.
    const empty = { lines: [], alternateScreen: false };
    assert.deepEqual(engineErrors.observe(session, empty.lines, codexProfile()), before, 'nothing captured must change nothing');
    clock += 4_000;
    const again = engineErrors.observe(session, ['above', CODEX_400, '> '], codexProfile());
    assert.equal(again.timestamp, before.timestamp, 'the next real capture must not re-stamp the same error as new');
    assert.deepEqual(engineErrors.observe(session, undefined, codexProfile()), before);
  });

  it('a different error replaces the record with a fresh timestamp', () => {
    engineErrors.observe(session, [CODEX_400], codexProfile());
    clock += 5_000;
    const next = engineErrors.observe(session, [CODEX_400, 'retry', CODEX_500], codexProfile());
    assert.equal(next.status, 500);
    assert.equal(next.timestamp, new Date(clock).toISOString());
  });

  it('an engine with no patterns neither records nor clears', () => {
    engineErrors.observe(session, [CODEX_400], codexProfile());
    assert.ok(engineErrors.observe(session, ['anything'], { id: 'claude' }), 'no patterns: leave the record alone');
    assert.equal(engineErrors.observe({ id: 8 }, [CODEX_400], { id: 'claude' }), null);
  });

  it('forget drops the record for an ended session', () => {
    engineErrors.observe(session, [CODEX_400], codexProfile());
    engineErrors.forget(7);
    assert.equal(engineErrors.get(7), null);
  });
});
