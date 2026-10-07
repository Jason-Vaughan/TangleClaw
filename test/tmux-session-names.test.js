'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const tmux = require('../lib/tmux');
const { uniqueSessionName } = require('./_tmux-session-names');

const HELPER = path.join(__dirname, '_tmux-session-names.js');

/**
 * Ask a separate node process for names under one label.
 * @param {string} label - The label to pass
 * @param {number} count - How many names to ask for
 * @returns {string[]} The names that process was given
 */
function namesFromAnotherProcess(label, count) {
  const script = `const { uniqueSessionName } = require(${JSON.stringify(HELPER)});` +
    `const out = []; for (let i = 0; i < ${count}; i++) out.push(uniqueSessionName(${JSON.stringify(label)}));` +
    'process.stdout.write(JSON.stringify(out));';
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf8' }));
}

describe('uniqueSessionName — names for real tmux sessions in tests (#1983)', () => {
  it('never repeats a name within one process, even under the same label', () => {
    const names = Array.from({ length: 200 }, () => uniqueSessionName('same'));
    assert.equal(new Set(names).size, names.length);
  });

  it('gives two processes disjoint names for the same label', () => {
    // The defect was two suite runs sharing a literal name. Two real processes
    // asking under one label is that situation, minus tmux.
    const a = namesFromAnotherProcess('shared', 20);
    const b = namesFromAnotherProcess('shared', 20);
    const mine = Array.from({ length: 20 }, () => uniqueSessionName('shared'));
    const all = [...a, ...b, ...mine];
    assert.equal(new Set(all).size, all.length, 'no name may appear in two processes');
  });

  it('does not rest on the pid alone', () => {
    // A pid is unique only inside one pid namespace, and containers can share a
    // tmux socket. Strip the pid and the counter: what is left must still tell
    // two processes apart.
    const strip = (name) => name.replace(/_\d+_([0-9a-f]+)_\d+__$/, '_$1');
    const a = strip(namesFromAnotherProcess('ns', 1)[0]);
    const b = strip(namesFromAnotherProcess('ns', 1)[0]);
    assert.notEqual(a, b, 'the per-process nonce must differ between processes');
  });

  it('produces names lib/tmux accepts, with the label readable in them', () => {
    const name = uniqueSessionName('readable-label_1');
    assert.equal(tmux.isValidSessionName(name), true);
    assert.ok(name.includes('readable-label_1'));
    assert.ok(name.startsWith('__tc_test_'), 'a fixture must be recognisable in `tmux ls`');
  });

  it('keeps a derived longer name valid, for the prefix-targeting tests', () => {
    const base = uniqueSessionName('prefix');
    const longer = `${base}-neighbour`;
    assert.equal(tmux.isValidSessionName(longer), true);
    assert.ok(longer.startsWith(base) && longer !== base);
  });

  it('refuses a label tmux would reject or rewrite', () => {
    for (const bad of ['', 'a b', 'a.b', 'a:b', "a'b", null, undefined, 7]) {
      assert.throws(() => uniqueSessionName(bad), /label must be/);
    }
  });
});

describe('no test creates a real tmux session under a fixed name (#1983)', () => {
  /**
   * Remove comments, so prose that quotes a name is not read as code.
   * @param {string} src - JavaScript source
   * @returns {string} The source without block or line comments
   */
  function stripComments(src) {
    return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  }

  // The files that start a real tmux session. A new one belongs in this list;
  // the scan below is what finds it.
  const REAL_SESSION_FILES = ['activity-observer.test.js', 'tmux-draft-capture.test.js', 'tmux-named-paste-buffer.test.js', 'tmux.test.js'];

  /**
   * Matches a call that starts a real session: the lib helper, or tmux itself
   * as an argv element or inside a shell string. A `createSession` pulled out
   * of the module by destructuring is not seen; no test does that, and the
   * fakes several suites define under that name would be read as real ones.
   */
  const CALLS_LIB = /\btmux\.createSession\(/;
  const SPAWNS_TMUX = /['"`]new-session['"`]\s*,|\b(?:exec|execSync|execFileSync|spawn|spawnSync)\(\s*['"`][^'"`\n]*\btmux new-session\b/;

  it('knows every test file that starts one', () => {
    const found = fs.readdirSync(__dirname)
      .filter((f) => f.endsWith('.test.js') && f !== path.basename(__filename))
      .filter((f) => {
        const src = stripComments(fs.readFileSync(path.join(__dirname, f), 'utf8'));
        // Spawning tmux directly is always real: the #902 guard poisons only
        // `tmux.createSession`, so installing it excuses that call and no other.
        if (SPAWNS_TMUX.test(src)) return true;
        return CALLS_LIB.test(src) && !/installTmuxGuard\(/.test(src);
      })
      .sort();
    assert.deepEqual(found, REAL_SESSION_FILES,
      'a test file that starts a real tmux session must be listed here and take its names from uniqueSessionName');
  });

  /**
   * The names a file hands to tmux when it starts a session, as written.
   * @param {string} src - Comment-free source
   * @returns {string[]} Each name expression: an identifier, or a quoted or template literal
   */
  function sessionNameExpressions(src) {
    const out = [];
    const arg = '([A-Za-z_$][\\w$]*|\'[^\']*\'|"[^"]*"|`[^`]*`)';
    for (const m of src.matchAll(new RegExp(`\\btmux\\.createSession\\(\\s*${arg}`, 'g'))) out.push(m[1]);
    for (const m of src.matchAll(new RegExp(`['"\`]new-session['"\`]\\s*,[^\\]]*?['"\`]-s['"\`]\\s*,\\s*${arg}`, 'g'))) out.push(m[1]);
    return out;
  }

  /**
   * Whether a name expression can only ever hold a factory name.
   * @param {string} expr - One entry from `sessionNameExpressions`
   * @param {string} src - Comment-free source of the file it came from
   * @returns {boolean} True when the name is a factory name, a name derived from one, or one tmux never sees
   */
  function isFactoryName(expr, src) {
    const derived = /^`\$\{([A-Za-z_$][\w$]*)\}[\w-]*`$/.exec(expr);
    if (derived) return isFactoryName(derived[1], src);
    if (/^(['"`])[^'"`]*\1$/.test(expr)) {
      // A literal is acceptable only where createSession refuses it before
      // spawning anything, which is what the invalid-name tests pass.
      return !expr.includes('${') && !tmux.isValidSessionName(expr.slice(1, -1));
    }
    // Anything else that is not a plain identifier is an expression built in
    // place (a concatenation, a call), which cannot be traced to the factory.
    if (!/^[A-Za-z_$][\w$]*$/.test(expr)) return false;
    const decl = new RegExp(`\\b(?:const|let|var)\\s+${expr.replace(/\$/g, '\\$')}\\s*=\\s*([^;\\n]+)`, 'g');
    const values = [...src.matchAll(decl)].map((m) => m[1].trim());
    return values.length > 0 && values.every((v) => /^uniqueSessionName\(/.test(v) || (v !== expr && isFactoryName(v, src)));
  }

  for (const file of REAL_SESSION_FILES) {
    it(`${file} gives tmux only names that come from the factory`, () => {
      const src = stripComments(fs.readFileSync(path.join(__dirname, file), 'utf8'));
      const exprs = sessionNameExpressions(src);
      assert.ok(exprs.length > 0, `${file} is listed as starting real sessions but no start was found`);
      // THE MUTATION THIS CATCHES: a session started under a literal, a
      // pid-built template, or a variable assigned anything but a factory name.
      const offenders = [...new Set(exprs)].filter((e) => !isFactoryName(e, src));
      assert.deepEqual(offenders, [], `${file} starts a real session under a name that is not from uniqueSessionName`);
      // A name inside a shell string cannot be traced, so that form is not allowed here.
      assert.doesNotMatch(src, /\btmux new-session\b[^'"`\n]*\s-s\s/,
        `${file} starts a session from a shell string; pass the name as an argv element or use tmux.createSession`);
    });
  }

  it('the name check rejects the shapes it exists to catch', () => {
    const bad = (body) => {
      const src = stripComments(body);
      return sessionNameExpressions(src).filter((e) => !isFactoryName(e, src));
    };
    assert.deepEqual(bad("tmux.createSession('__tc_test_fixed__', {});"), ["'__tc_test_fixed__'"]);
    assert.deepEqual(bad('tmux.createSession("my-fixed-session");'), ['"my-fixed-session"']);
    assert.deepEqual(bad('const n = `tc-x-${process.pid}`;\ntmux.createSession(n);'), ['n']);
    assert.deepEqual(bad("const n = 'tcx-' + process.pid;\nexecFileSync('tmux', ['new-session', '-d', '-s', n]);"), ['n']);
    assert.deepEqual(bad("tmux.createSession(undeclared);"), ['undeclared']);
    assert.deepEqual(bad("const n = uniqueSessionName('a');\nconst m = `${n}-longer`;\ntmux.createSession(m);\n" +
      "execFileSync('tmux', ['new-session', '-d', '-s', `${n}-x`]);\ntmux.createSession('invalid name!');\ntmux.createSession('');"), []);
  });
});
