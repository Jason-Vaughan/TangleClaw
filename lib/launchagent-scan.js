'use strict';

/**
 * Find user LaunchAgents that still name a filesystem path.
 *
 * The supported way to run a macOS automation that needs a privacy (TCC)
 * grant — Calendar, Contacts, a protected folder — is a project-owned
 * LaunchAgent whose plist carries the project's ABSOLUTE path (see
 * `docs/macos-tcc-automations.md` for why the managed session cannot do it).
 * That path is frozen into `~/Library/LaunchAgents/<label>.plist` in
 * `ProgramArguments`, `WorkingDirectory`, `StandardOutPath` and
 * `StandardErrorPath`, and launchd learns nothing when TangleClaw renames the
 * project directory: the job fails on its next run, in its own log, with
 * nothing pointing back at the rename (#1148).
 *
 * This module answers one question for the rename path: which plists still
 * mention the old path? It reads, it never writes — rewriting a plist
 * TangleClaw did not create is the operator's call, made with this list in
 * hand — and it never throws, because a rename that already happened on disk
 * must not fail over a diagnostic. What it could not read is reported as
 * such rather than folded into "no match": an unreadable plist may name the
 * path too, and saying nothing would paint an unknown as a clean result.
 *
 * The directory is a parameter so tests point it at a temp dir; the real
 * location comes from `defaultLaunchAgentsDir()`.
 *
 * @module lib/launchagent-scan
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * The per-user LaunchAgents directory on this machine.
 * @returns {string}
 */
function defaultLaunchAgentsDir() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents');
}

/**
 * Escape a string so it matches itself literally inside a RegExp.
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The job's `Label` from an XML plist, falling back to the file's basename
 * (which is the label by launchd convention) when the key is absent or the
 * file is not XML.
 * @param {string} text - Plist contents.
 * @param {string} file - Absolute plist path.
 * @returns {string}
 */
function readLabel(text, file) {
  const m = /<key>\s*Label\s*<\/key>\s*<string>([^<]*)<\/string>/.exec(text);
  const label = m ? m[1].trim() : '';
  return label || path.basename(file, '.plist');
}

/**
 * Scan every `*.plist` in `dir` for `needle` as a substring anywhere in the
 * file — `ProgramArguments`, `WorkingDirectory`, the stdout/stderr paths —
 * so which key holds the path does not matter. A match must end at a path
 * boundary, defined positively: the next character is `/` (a path beneath
 * the project), `<` (the plist string's closing tag), a `"` or `'` (a quoted
 * path inside a shell one-liner), or the end of the line. So
 * `/Users/me/Projects/app` matches `/Users/me/Projects/app/run.sh` and
 * `<string>/Users/me/Projects/app</string>`, and does not match
 * `/Users/me/Projects/app-2`, `/Users/me/Projects/app (old)` or
 * `/Users/me/Projects/app日本`.
 *
 * Two limits, stated so nobody widens the scan by accident. Matching is
 * case-sensitive, while the default APFS volume is not: a plist naming the
 * path in different case is not reported. And inside a shell one-liner the
 * layout still matters — an UNQUOTED path followed by a space
 * (`cd /Users/me/Projects/app && ./run.sh`) is not reported, because a space
 * is also what separates a sibling's name from its suffix.
 *
 * Never throws. A missing or unlistable directory is an empty result; a
 * plist that cannot be read is listed under `unreadable` instead of being
 * counted as a non-match.
 *
 * @param {string} needle - Absolute path to look for.
 * @param {string} dir - LaunchAgents directory to scan.
 * @returns {{ matches: Array<{ file: string, label: string }>, unreadable: string[] }}
 */
function scanLaunchAgents(needle, dir) {
  const result = { matches: [], unreadable: [] };
  if (typeof needle !== 'string' || needle.length === 0) return result;
  if (typeof dir !== 'string' || dir.length === 0) return result;
  let entries;
  try {
    entries = fs.readdirSync(dir);
  } catch {
    // Not a macOS box, no LaunchAgents ever installed, or the directory is
    // unlistable — every case reads "nothing to warn about" for a rename.
    return result;
  }
  const re = new RegExp(`${escapeRegExp(needle)}(?=[/<"']|$)`, 'm');
  for (const entry of entries.sort()) {
    if (!entry.endsWith('.plist')) continue;
    const file = path.join(dir, entry);
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      // A permission denial or a directory wearing a .plist name. It may
      // still reference the path; the caller says so rather than "no match".
      result.unreadable.push(file);
      continue;
    }
    if (!re.test(text)) continue;
    result.matches.push({ file, label: readLabel(text, file) });
  }
  return result;
}

/**
 * The matching plists only — the contract most callers want. Same scan as
 * `scanLaunchAgents`, same never-throws guarantee; an absent directory is `[]`.
 * @param {string} needle - Absolute path to look for.
 * @param {string} dir - LaunchAgents directory to scan.
 * @returns {Array<{ file: string, label: string }>}
 */
function scanForPath(needle, dir) {
  return scanLaunchAgents(needle, dir).matches;
}

/**
 * One operator-facing sentence for a rename result's `warnings` array, or
 * `null` when there is nothing to say. Names every job (label and plist
 * path) so the operator can edit them without a second search, and says
 * plainly that TangleClaw did not rewrite them. An unreadable plist gets its
 * own clause: it is not a match, but it is not a clean result either.
 *
 * @param {string} oldPath - The path the project was renamed away from.
 * @param {{ matches: Array<{ file: string, label: string }>, unreadable: string[] }} scan
 * @returns {string|null}
 */
function formatWarning(oldPath, scan) {
  const matches = (scan && Array.isArray(scan.matches)) ? scan.matches : [];
  const unreadable = (scan && Array.isArray(scan.unreadable)) ? scan.unreadable : [];
  const parts = [];
  if (matches.length > 0) {
    const n = matches.length;
    const list = matches.map(m => `${m.label} (${m.file})`).join(', ');
    parts.push(`${n} LaunchAgent${n === 1 ? '' : 's'} still reference${n === 1 ? 's' : ''} the old path ${oldPath}: ${list}. `
      + 'TangleClaw does not rewrite LaunchAgents — update the plist by hand and reload it with '
      + '`launchctl bootout gui/$(id -u)/<label>` then `launchctl bootstrap gui/$(id -u) <plist>` '
      + '(see docs/macos-tcc-automations.md)');
  }
  if (unreadable.length > 0) {
    const n = unreadable.length;
    parts.push(`${n} LaunchAgent plist${n === 1 ? '' : 's'} could not be read and may also reference it: ${unreadable.join(', ')}`);
  }
  return parts.length > 0 ? parts.join('. ') : null;
}

module.exports = {
  defaultLaunchAgentsDir,
  scanLaunchAgents,
  scanForPath,
  formatWarning
};
