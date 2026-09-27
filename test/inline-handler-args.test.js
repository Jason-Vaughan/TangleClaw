'use strict';

/*
 * #1384 — inline handlers in public/ui.js wrote their arguments as
 * `fn('${esc(v)}')`. `esc` turns `'` into `&#39;`, and the HTML parser decodes
 * that back to `'` before the handler's JS is parsed, so a value holding an
 * apostrophe (a project named O'Brien) closed the string early and the handler
 * never ran. Every handler now takes its argument through `jsArg`.
 *
 * #1902 carried the same fix to every other page script, and the scan below
 * now covers all of `public/*.js`, not only `ui.js`.
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
const session = read('session.js');
const PAGE_SCRIPTS = fs.readdirSync(path.join(__dirname, '..', 'public')).filter((f) => f.endsWith('.js')).sort();

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

/**
 * Every inline handler in `src` that quotes an interpolation in single quotes.
 * A handler attribute is double-quoted; inside it, `'${...}'` is the broken
 * construction whatever is interpolated. Code inside ${...} is skipped, so
 * `${isAll ? 'null' : jsArg(tag)}` is not a hit.
 *
 * @param {string} src - Page script source.
 * @returns {string[]} The offending attribute text, truncated.
 */
function quotedInterpolations(src) {
  const offenders = [];
  for (const m of src.matchAll(/\son[a-z]+="([^"]*)"/g)) {
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
  return offenders;
}

/**
 * Render one handler attribute from a source line as a template literal, with
 * the named values in scope, decode it as the browser would, and run it.
 *
 * @param {string} src - Page script source.
 * @param {string} needle - Text that picks the source line.
 * @param {string} attrName - Attribute to take, e.g. `onchange`.
 * @param {Record<string, *>} scope - Values the template interpolates.
 * @returns {Array<{fn: string, args: Array<*>}>} Calls the handler made.
 */
function runSourceHandler(src, needle, attrName, scope) {
  const line = src.split('\n').find((l) => l.includes(needle));
  assert.ok(line, `no source line contains ${needle}`);
  const attr = line.match(new RegExp(`${attrName}="([^"]*)"`))[1];
  const names = Object.keys(scope);
  const rendered = new Function(...names, 'return `' + attr + '`;')(...names.map((k) => scope[k]));
  return runHandler(decodeAttr(rendered));
}

describe('every page script (#1384, #1902)', () => {
  it('the scan covers more than ui.js', () => {
    for (const f of ['ui.js', 'setup.js', 'session.js', 'landing.js', 'history-drawer.js']) assert.ok(PAGE_SCRIPTS.includes(f), f);
  });

  for (const f of PAGE_SCRIPTS) {
    it(`${f} has no inline handler that quotes an interpolation in single quotes`, () => {
      assert.deepEqual(quotedInterpolations(read(f)), []);
    });
  }

  it('the scan still catches the old form', () => {
    assert.equal(quotedInterpolations("x = `<i onclick=\"fn('${esc(v)}')\">`;").length, 1);
  });

  it('keeps one encoder: no esc(JSON.stringify(...)) left in a handler', () => {
    for (const f of PAGE_SCRIPTS) {
      const hits = [...read(f).matchAll(/\son[a-z]+="[^"]*esc\(JSON\.stringify/g)].map((m) => m[0].slice(0, 120));
      assert.deepEqual(hits, [], f);
    }
  });
});

describe('session.js carries its own jsArg (#1902)', () => {
  // session.html does not load landing.js. Until #1605 gives the encoders one
  // owner, the copy must encode exactly as the original does.
  const own = new Function(
    `${liftFunction(session, 'function esc(')}\n${liftFunction(session, 'function jsArg(')}\nreturn jsArg;`
  )();

  it('encodes every awkward value exactly as landing.js does', () => {
    for (const v of [...AWKWARD, undefined, 7, ["O'Brien", 'x'], null]) assert.equal(own(v), jsArg(v), JSON.stringify(v));
  });

  it('the group pill hands an apostrophe group id to toggleGroupPopover intact', () => {
    const calls = runSourceHandler(session, 'toggleGroupPopover(this,', 'onclick', { jsArg: own, esc, g: { id: "grp'1", name: 'x' } });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].fn, 'toggleGroupPopover');
    assert.equal(calls[0].args[1], "grp'1", 'the group id arrives exactly');
  });
});

describe('the other page scripts hand values over intact (#1902)', () => {
  it('the setup wizard checkbox gives wizardToggleProject an apostrophe project name', () => {
    const calls = runSourceHandler(read('setup.js'), 'wizardToggleProject(', 'onchange', { jsArg, esc, p: { name: "O'Brien" } });
    assert.deepEqual(calls, [{ fn: 'wizardToggleProject', args: ["O'Brien", undefined] }]);
  });

  it('the setup redirect buttons navigate to a URL holding an apostrophe', () => {
    const src = read('setup.js');
    for (const [needle, name] of [["href=${jsArg(url)}", 'url'], ["href=${jsArg(redirectUrl)}", 'redirectUrl']]) {
      const line = src.split('\n').find((l) => l.includes(needle));
      assert.ok(line, needle);
      const attr = line.match(/onclick="([^"]*)"/)[1];
      const value = "https://h/?q=it's";
      const rendered = new Function('jsArg', name, 'return `' + attr + '`;')(jsArg, value);
      const window = { location: {} };
      new Function('window', decodeAttr(rendered))(window);
      assert.equal(window.location.href, value, name);
    }
  });

  it('the install copy buttons give wizardCopyInstall the exact command', () => {
    const command = `echo 'it\'s' && brew install "x"`;
    const calls = runSourceHandler(read('setup.js'), 'wizardCopyInstall(${jsArg(command)})', 'onclick', { jsArg, command });
    assert.deepEqual(calls, [{ fn: 'wizardCopyInstall', args: [command] }]);
  });

  it('the launch-mode radio assigns its key exactly', () => {
    const line = landing.split('\n').find((l) => l.includes('selectedLaunchMode=${jsArg(key)}'));
    assert.ok(line, 'the launch-mode radio must use jsArg');
    const attr = line.match(/onchange="([^"]*)"/)[1];
    const rendered = new Function('jsArg', 'key', 'return `' + attr + '`;')(jsArg, "odd'key");
    let selectedLaunchMode = null;
    const updateLaunchModeWarning = () => {};
    new Function('ctx', 'updateLaunchModeWarning', decodeAttr(rendered).replace('selectedLaunchMode=', 'ctx.v='))(
      { set v(x) { selectedLaunchMode = x; } }, updateLaunchModeWarning);
    assert.equal(selectedLaunchMode, "odd'key");
  });

  it('the history drawer passes the session id through jsArg', () => {
    const drawer = read('history-drawer.js');
    for (const needle of ['onclick="openHistorySession(', 'openHistorySession(${jsArg(safeSid(s.sid))})" tabindex', 'runTranscriptSearch(']) {
      const line = drawer.split('\n').find((l) => l.includes(needle));
      assert.ok(line && line.includes('${jsArg(safeSid('), needle);
    }
    const calls = runSourceHandler(drawer, 'onclick="openHistorySession(', 'onclick', { jsArg, safeSid: (x) => String(x).replace(/[^A-Za-z0-9_-]/g, ''), s: { sid: 'abc-1' } });
    assert.deepEqual(calls, [{ fn: 'openHistorySession', args: ['abc-1'] }]);
  });
});

describe('public/ui.js handlers (#1384)', () => {
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
