'use strict';

/*
 * #1384 — inline handlers in public/ui.js wrote their arguments as
 * `fn('${esc(v)}')`. `esc` turns `'` into `&#39;`, and the HTML parser decodes
 * that back to `'` before the handler's JS is parsed, so a value holding an
 * apostrophe (a project named O'Brien) closed the string early and the handler
 * never ran. Every handler now takes its argument through `jsArg`.
 *
 * The tests decode each attribute the way a browser does and then run the
 * handler text, so they assert what the handler RECEIVES rather than how the
 * source is spelled.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
const ui = read('ui.js');
const landing = read('landing.js');

/**
 * Slice a function declaration out of source text by brace-matching.
 *
 * @param {string} src - File source text.
 * @param {string} decl - Declaration head, e.g. `function foo(`.
 * @returns {string} The declaration through its balanced closing brace.
 */
function liftFunction(src, decl) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  assert.fail(`${decl} body must close`);
}

// The shipped encoders, run as they are rather than copied.
const { esc, jsArg } = new Function(
  `${liftFunction(landing, 'function esc(')}\n${liftFunction(landing, 'function jsArg(')}\nreturn { esc, jsArg };`
)();

/**
 * Decode entities the way the HTML parser does to an attribute value.
 *
 * @param {string} s - Raw attribute text.
 * @returns {string} What the handler's JS source becomes.
 */
function decodeAttr(s) {
  return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

/**
 * Run decoded handler source against recording stubs and return every call.
 *
 * @param {string} source - Handler JS, e.g. `event.stopPropagation(); openSettings("x")`.
 * @returns {Array<{fn: string, args: Array<*>}>} Calls the handler made.
 */
function runHandler(source) {
  const calls = [];
  const names = [...new Set([...source.matchAll(/([A-Za-z_$][\w$]*)\(/g)].map((m) => m[1]))]
    .filter((n) => n !== 'if');
  const stubs = names.map((fn) => (...args) => { calls.push({ fn, args }); });
  const event = { key: 'Enter', preventDefault() {}, stopPropagation() {} };
  new Function('event', ...names, source)(event, ...stubs);
  return calls.filter((c) => c.fn !== 'preventDefault' && c.fn !== 'stopPropagation');
}

const AWKWARD = ["O'Brien", 'say "hi"', 'a\\b', '</script><b>', 'tab\there', 'ünïcødé', "it's & <that>"];

describe('jsArg (#1384)', () => {
  for (const value of AWKWARD) {
    it(`round-trips ${JSON.stringify(value)} through a double-quoted attribute`, () => {
      const attr = `fn(${jsArg(value)})`;
      assert.ok(!attr.includes('"'), 'the literal must not end the attribute');
      assert.deepEqual(runHandler(decodeAttr(attr)), [{ fn: 'fn', args: [value] }]);
    });
  }

  it('round-trips an array and a number unchanged', () => {
    assert.deepEqual(runHandler(decodeAttr(`fn(${jsArg(["O'Brien", 'x'])}, ${jsArg(7)})`)),
      [{ fn: 'fn', args: [["O'Brien", 'x'], 7] }]);
  });

  it('turns undefined into null so the call still parses', () => {
    assert.deepEqual(runHandler(decodeAttr(`fn(${jsArg(undefined)})`)), [{ fn: 'fn', args: [null] }]);
  });

  it('shows the old form breaking, so the round trip above is a real test', () => {
    const old = decodeAttr(`fn('${esc("O'Brien")}')`);
    assert.throws(() => runHandler(old), SyntaxError);
  });
});

describe('public/ui.js handlers (#1384)', () => {
  it('has no inline handler that quotes an interpolation in single quotes', () => {
    // A handler attribute is double-quoted; inside it, `'${...}'` is the broken
    // construction whatever is interpolated. Code inside ${...} is skipped, so
    // `${isAll ? 'null' : jsArg(tag)}` is not a hit.
    const offenders = [];
    for (const m of ui.matchAll(/\son[a-z]+="([^"]*)"/g)) {
      const attr = m[1];
      let depth = 0;
      for (let i = 0; i < attr.length; i++) {
        if (attr.startsWith('${', i)) { depth++; i++; continue; }
        if (depth > 0 && attr[i] === '{') depth++;
        else if (depth > 0 && attr[i] === '}') depth--;
        else if (depth === 0 && attr[i] === "'" && attr.startsWith('${', i + 1)) {
          offenders.push(m[0].slice(0, 120));
          break;
        }
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('keeps one encoder: no esc(JSON.stringify(...)) left in a handler', () => {
    const hits = [...ui.matchAll(/\son[a-z]+="[^"]*esc\(JSON\.stringify/g)].map((m) => m[0].slice(0, 120));
    assert.deepEqual(hits, []);
  });

  it('the card detail panel hands O\'Brien to every handler intact', () => {
    const decl = 'function renderCardDetail(project)';
    const src = liftFunction(ui, decl);
    const scope = {
      esc,
      jsArg,
      renderSessionDetail: () => '',
      renderAwarenessDetail: () => '',
      renderStrandedDetail: () => '',
      renderStrandedGithubDetail: () => '',
      renderSessionHealthDetail: () => '',
      renderGitDetail: () => '',
      tcUnreadableNotice: () => null,
      renderNextActionRow: () => '',
      formatTagList: () => 'None'
    };
    const names = Object.keys(scope);
    const render = new Function(...names, `${src}\nreturn renderCardDetail;`)(...names.map((k) => scope[k]));
    const html = render({ name: "O'Brien", engine: null, tags: [], groups: [], session: { active: true } });

    const handlers = [...html.matchAll(/\sonclick="([^"]*)"/g)].map((m) => decodeAttr(m[1]));
    assert.ok(handlers.length >= 3, 'the panel must render its action buttons');
    for (const h of handlers) {
      const calls = runHandler(h);
      assert.equal(calls.length, 1, `one call expected from ${h}`);
      assert.deepEqual(calls[0].args, ["O'Brien"], `${calls[0].fn} must receive the exact name`);
    }
  });

  it('the port group header hands an apostrophe name to togglePortGroup intact', () => {
    const line = ui.split('\n').find((l) => l.includes('onclick="togglePortGroup('));
    assert.ok(line, 'the port group toggle must exist');
    const attr = line.match(/onclick="([^"]*)"/)[1];
    const project = "O'Brien";
    const rendered = new Function('jsArg', 'project', 'return `' + attr + '`;')(jsArg, project);
    assert.deepEqual(runHandler(decodeAttr(rendered)), [{ fn: 'togglePortGroup', args: [project] }]);
  });
});
