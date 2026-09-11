'use strict';

/**
 * Render a value as a single `/bin/sh` word.
 *
 * Single quotes because they are the only shell quoting that is total: inside
 * them nothing expands and nothing escapes, so `$HOME`, `$(id)`, a backtick, a
 * double quote and a backslash are all just characters. The one character a
 * single-quoted string cannot contain is a single quote, which is why it is
 * closed, escaped and reopened (`'` → `'\''`).
 *
 * All of these are legal in a macOS directory name, and the operator chooses
 * where TangleClaw is installed — so every generated command line that embeds a
 * path has to survive them.
 *
 * **Double quotes are not a substitute.** They stop word-splitting on a space,
 * which is the failure people notice, and stop nothing else: `"$HOME/x"` still
 * expands, and a literal `"` or `\` breaks the quoting outright. Two separate
 * generators shipped the double-quoted form for exactly that reason (#759,
 * #1062), and an assertion that a command "is quoted" passes for both.
 *
 * @param {*} value - Raw value destined for a shell command line
 * @returns {string} The value as one shell word, quotes included
 */
function shellWord(value) {
  return `'${String(value).replace(/'/g, "'\\''")}'`;
}

/**
 * Read the first shell WORD out of a command line.
 *
 * Scoped hard, and the scope is the point: it walks quoting state and stops at
 * the first unquoted whitespace. It does not expand anything, does not
 * understand operators, redirection, escapes outside quotes, or `$`/backticks —
 * a general shell parser is a defect class this repo has met repeatedly, and
 * this is not one. What it IS is the exact inverse of {@link shellWord} plus
 * the two other shapes a command may already carry.
 *
 * Adjacent runs concatenate, the way a shell concatenates them: `'a b'c` is one
 * word `a bc`, which is what makes `'<dir>'/data/hooks/x.sh` a single word and
 * what makes `shellWord`'s `'` → `'\''` escape round-trip without a special
 * case.
 *
 * The legacy double-quoted form is read too — commands wired before the quoting
 * changed are still in machine-local settings files, and a reader that could
 * not unquote them would report a correctly-wired install as broken. Inside
 * double quotes nothing is interpreted here either; that is a deliberate
 * limitation, since anything needing it should not have been double-quoted.
 *
 * @param {string} text - A command line, or one word
 * @returns {string} The first word, unquoted; '' when there is none
 */
function firstWord(text) {
  if (typeof text !== 'string') return '';
  let out = '';
  let quote = null;
  let started = false;
  let escaped = false;
  for (const ch of text) {
    if (escaped) { out += ch; escaped = false; continue; }
    if (quote) {
      if (ch === quote) quote = null;
      else out += ch;
      continue;
    }
    // A backslash outside quotes escapes the next character. This is not
    // general-shell ambition: `shellWord` emits exactly this construct for an
    // embedded single quote (`'` → `'\\''`), so without it the function is not
    // its own inverse — a path containing an apostrophe round-tripped to a
    // backslash and lost the quote.
    if (ch === '\\') { escaped = true; started = true; continue; }
    if (ch === "'" || ch === '\"') { quote = ch; started = true; continue; }
    if (/\s/.test(ch)) {
      if (started) break;
      continue;
    }
    started = true;
    out += ch;
  }
  return out;
}

module.exports = { shellWord, firstWord };
