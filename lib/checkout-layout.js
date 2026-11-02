'use strict';
/**
 * Where the primary checkout is, and which of its worktrees a path belongs to.
 *
 * This repo's primary checkout is the running install: launchd serves `public/`
 * straight off that working tree. Chunk work happens in git worktrees, so
 * "which checkout does this path land in" is a question three callers ask — the
 * PreToolUse guard that refuses writes landing in the primary (#798), the
 * installer that wires it, and `lib/server-info.js` (#1672), which must not
 * silently adopt an active Builder/agent checkout's branch state or worktree
 * coupling as its own when it resolves which checkout the background server
 * runs from (`resolveServerCheckoutRoot`, `describeServerRootCoupling`). They
 * ask it identically, so it is answered once here rather than in several files
 * that can drift apart.
 *
 * Read from git's own bookkeeping on disk rather than by spawning git: the
 * guard runs ahead of every matched tool call, and a subprocess per keystroke is
 * a cost the answer does not need.
 *
 * That is a claim about the LAYOUT questions only, and it is worth bounding
 * because the guard does spawn git elsewhere. `isTracked` shells out to
 * `git ls-files`, deliberately: there is no on-disk index format this module
 * could read as cheaply or as correctly, and the call is reached only on the
 * file-write arm, only after these functions have already answered that the
 * write lands in the primary, and only when it is not the live surface — a path
 * that is rare by construction. The layout questions are asked on EVERY matched
 * call, which is why they must stay subprocess-free.
 *
 * Deliberately a leaf module — node built-ins plus `lib/project-paths.js`, the
 * repo's sole containment predicate — so a hook script outside `lib/` can
 * require it without pulling in the server.
 *
 * @module lib/checkout-layout
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync: _realExecFileSync } = require('node:child_process');

const { checkContainment } = require('./project-paths');

/**
 * The guard's sentinel override, relative to the primary checkout.
 *
 * It lives here rather than in either script because BOTH need it and neither
 * can import the other: the guard attaches stdin handlers at load, so requiring
 * it from the installer would hang. Spelled twice, a rename in the guard would
 * leave `--self-test` telling the operator to delete a path that no longer
 * exists — advice that reads authoritative and does nothing. This module is the
 * one thing both files already require.
 */
const OVERRIDE_FILE = path.join('.prawduct', '.allow-primary-write');

/** Env var that waives the guard for one command; can be set inline, so it is not sticky. */
const OVERRIDE_ENV = 'TANGLECLAW_ALLOW_PRIMARY_WRITE';

/**
 * Env var naming a dedicated server-install checkout root (#1672), independent
 * of wherever the running process's own module files happen to resolve from.
 * Set it when the background server (`com.tangleclaw.server` / the systemd
 * user unit) is installed to a canonical, dedicated checkout rather than
 * started from whatever checkout happened to be active — the case
 * `describeServerRootCoupling` below exists to detect when this is NOT set
 * and the fallback root turns out to be an active Builder/agent checkout or a
 * linked git worktree.
 */
const SERVER_ROOT_ENV = 'TANGLECLAW_SERVER_ROOT';

/**
 * Resolve a path through symlinks, final component included, tolerating a
 * target that does not exist yet.
 *
 * `realpathSync` throws on a missing path, and the guard's targets are
 * routinely about to be created — so resolve the deepest EXISTING ancestor and
 * re-attach the un-created tail. A missing intermediate directory cannot be a
 * symlink, so nothing is skipped by walking up.
 *
 * When resolution is impossible the LEXICAL path is returned. Said plainly
 * because the direction matters: for a containment test that fallback is
 * permissive, and it is chosen to match the guard's deliberate fail-open posture
 * rather than by accident.
 *
 * @param {string} p - Absolute or relative path.
 * @returns {string} Absolute, symlink-resolved path.
 */
function realOrSelf(p) {
  const lexical = path.resolve(p);
  let dir = lexical;
  const tail = [];
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), ...tail);
    } catch (err) {
      const parent = path.dirname(dir);
      if (parent === dir) return lexical;
      tail.unshift(path.basename(dir));
      dir = parent;
    }
  }
}

/**
 * Locate the primary checkout from any checkout of the same repository.
 *
 * A linked worktree's `.git` is a FILE holding
 * `gitdir: <primary>/.git/worktrees/<name>`; the primary's `.git` is a
 * directory. Any other layout — a submodule, a bare repo, a `.git` that is
 * neither — is reported as unknown rather than guessed at, because a guard that
 * invents a primary would refuse writes against a path nobody serves.
 *
 * @param {string} checkoutRoot - Absolute path to a checkout of the repository.
 * @returns {{primary:string, isWorktree:boolean}|null} Null when the layout
 *   could not be established.
 */
function locateCheckouts(checkoutRoot) {
  const root = realOrSelf(checkoutRoot);
  const dotGit = path.join(root, '.git');
  let st;
  try {
    st = fs.lstatSync(dotGit);
  } catch (err) {
    return null;
  }
  if (st.isDirectory()) return { primary: root, isWorktree: false };
  if (!st.isFile()) return null;

  let gitdir;
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(dotGit, 'utf8'));
    if (!m) return null;
    gitdir = path.resolve(root, m[1].trim());
  } catch (err) {
    return null;
  }
  // `<primary>/.git/worktrees/<name>` — three components up is the primary root.
  // Anchored on the `.git/worktrees` PAIR rather than on the last `worktrees`
  // segment alone, so a repository that happens to contain a directory called
  // `worktrees` cannot be read as a git worktree record.
  const parts = gitdir.split(path.sep);
  const at = parts.lastIndexOf('worktrees');
  if (at < 2 || parts[at - 1] !== '.git') return null;
  const primary = parts.slice(0, at - 1).join(path.sep) || path.sep;
  return { primary: realOrSelf(primary), isWorktree: true };
}

/**
 * Every linked worktree root the primary knows about.
 *
 * Enumerated from `.git/worktrees/*&#47;gitdir` rather than assumed to live under
 * `.claude/worktrees/`. The convention puts them there, and that is exactly why
 * they must be enumerated: a worktree NESTED inside the primary is lexically
 * inside it, so without subtracting these roots every write inside every
 * worktree would read as a write to the primary.
 *
 * An empty answer and an UNKNOWN answer are reported differently, and the
 * distinction is the whole safety property. `ENOENT` genuinely means "there are
 * no worktrees". `EACCES`, `EIO`, `ENOTDIR` mean the subtraction list could not
 * be established — and a caller handed an empty list reads every path inside
 * every nested worktree as belonging to the primary, so it refuses all of them.
 * Collapsing the two into `{roots: []}` is therefore a fail-CLOSED hole inside a
 * fail-open guard, and it is silent: `unreadable` would be empty too, so nothing
 * would print.
 *
 * @param {string} primary - Absolute primary checkout root.
 * @returns {{roots:string[], unreadable:string[], failed:string|null}} Resolved
 *   roots; the names of individual records that could not be read; and, when the
 *   directory itself could not be listed for a reason other than absence, the
 *   errno that stopped it.
 */
function linkedWorktreeRoots(primary) {
  const base = path.join(primary, '.git', 'worktrees');
  let names;
  try {
    names = fs.readdirSync(base);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { roots: [], unreadable: [], failed: null };
    return { roots: [], unreadable: [], failed: (err && err.code) || 'unknown' };
  }
  const roots = [];
  const unreadable = [];
  for (const name of names) {
    try {
      const gitdir = fs.readFileSync(path.join(base, name, 'gitdir'), 'utf8').trim();
      if (gitdir) roots.push(realOrSelf(path.dirname(gitdir)));
      else unreadable.push(name);
    } catch (err) {
      unreadable.push(name);
    }
  }
  return { roots, unreadable, failed: null };
}

/**
 * Does this path ultimately land in the primary checkout proper, rather than
 * inside one of its worktrees?
 *
 * Evaluated on the symlink-RESOLVED path, which is what makes a worktree's
 * symlinked governance state answer correctly: `.prawduct/learnings.md` inside a
 * worktree is a link into the primary and genuinely does land there. Whether
 * that matters is a separate question (it is untracked, so it does not); this
 * function answers only where the bytes go.
 *
 * `allowRoot` is passed to BOTH containment questions or the answer is
 * incoherent. A caller asking about a DIRECTORY — "does this git command act on
 * the primary?" — needs the primary root to count as inside itself, and needs a
 * worktree root to count as inside its own worktree so the subtraction below
 * fires. Setting it on one side only would refuse every command run in a
 * worktree root while missing every command run in the primary root: both
 * failures at once, in opposite directions.
 *
 * @param {string} realTarget - Absolute, symlink-resolved target path.
 * @param {string} primary - Absolute primary checkout root.
 * @param {string[]} worktreeRoots - Absolute, symlink-resolved worktree roots.
 * @param {object} [options]
 * @param {boolean} [options.allowRoot=false] - Treat a checkout root as being
 *   inside itself. For directory questions; leave off for file targets.
 * @returns {boolean} True when the path lands in the primary checkout proper.
 */
function landsInPrimary(realTarget, primary, worktreeRoots, options = {}) {
  const opts = { allowRoot: options.allowRoot === true };
  if (!checkContainment(primary, realTarget, opts).inside) return false;
  return !worktreeRoots.some((wt) => checkContainment(wt, realTarget, opts).inside);
}

/**
 * Whether `root` looks like a real TangleClaw checkout: it exists, is a
 * directory, contains `server.js` at its top level, and is a recognizable
 * git checkout (`locateCheckouts` resolves it) (#1672 Round 2).
 *
 * Checked before `resolveServerCheckoutRoot` ever treats a `${SERVER_ROOT_ENV}`
 * value as authoritative: an unchecked override pointing at a typo'd, deleted,
 * or unrelated path would otherwise turn every git/disk probe into "no-git" or
 * "unknown" while the server is live — worse than the coupling problem the
 * override exists to solve, since the server would go dark on staleness
 * detection entirely rather than merely reading the wrong (but real) checkout.
 *
 * @param {string} root - Absolute, already symlink-resolved path.
 * @returns {{ ok: boolean, reason: string|null }}
 */
function _validateServerCheckoutRoot(root) {
  let exists;
  try {
    exists = fs.existsSync(root);
  } catch (err) {
    return { ok: false, reason: `could not check whether the path exists: ${(err && err.message) || err}` };
  }
  if (!exists) return { ok: false, reason: 'path does not exist' };

  let stat;
  try {
    stat = fs.statSync(root);
  } catch (err) {
    return { ok: false, reason: `could not stat the path: ${(err && err.message) || err}` };
  }
  if (!stat.isDirectory()) return { ok: false, reason: 'path is not a directory' };

  if (!fs.existsSync(path.join(root, 'server.js'))) {
    return { ok: false, reason: 'no server.js at the path — not a recognizable TangleClaw checkout' };
  }

  if (!locateCheckouts(root)) {
    return { ok: false, reason: 'no recognizable git checkout (.git) at the path' };
  }

  return { ok: true, reason: null };
}

/**
 * Resolve the checkout root the background server should treat as its own,
 * without mutating anything on disk (#1672).
 *
 * Precedence: an explicit `${SERVER_ROOT_ENV}` override — a dedicated,
 * canonical server install, the clean-repointing case a smoke test or a
 * dedicated install wants — wins ONLY when it validates
 * (`_validateServerCheckoutRoot`, Round 2): it must exist, be a directory,
 * contain `server.js`, and be a recognizable git checkout. An override that
 * fails validation is never used as the resolved root — it falls back to
 * `defaultRoot` exactly as if unset, and the failure is reported in
 * `invalidServerRootOverride` so a caller can surface it rather than resolve
 * silently onto the wrong checkout. `defaultRoot` (normally wherever the
 * running process's own module resolved from, e.g. `path.resolve(__dirname,
 * '..')`) is otherwise used as-is, with no validation of its own — it is
 * the process's own checkout, not a caller-supplied path. Either way the
 * result is symlink-resolved (`realOrSelf`), and `source` says which path
 * was actually taken, so a caller never has to re-derive that itself.
 *
 * @param {string} defaultRoot - Absolute fallback root to use when no
 *   override is set, or when a set override fails validation.
 * @param {{ env?: NodeJS.ProcessEnv }} [options] - `env` defaults to
 *   `process.env`; a caller injects a fake one for determinism in tests.
 * @returns {{
 *   root: string,
 *   source: 'override'|'default',
 *   invalidServerRootOverride?: { requested: string, resolved: string, reason: string }
 * }} `invalidServerRootOverride` is present only when `${SERVER_ROOT_ENV}`
 *   was set but failed validation (and therefore was NOT used).
 */
function resolveServerCheckoutRoot(defaultRoot, options = {}) {
  const env = options.env || process.env;
  const override = env[SERVER_ROOT_ENV];
  if (typeof override === 'string' && override.trim().length > 0) {
    const requested = override.trim();
    const resolved = realOrSelf(requested);
    const validity = _validateServerCheckoutRoot(resolved);
    if (validity.ok) {
      return { root: resolved, source: 'override' };
    }
    return {
      root: realOrSelf(defaultRoot),
      source: 'default',
      invalidServerRootOverride: { requested, resolved, reason: validity.reason }
    };
  }
  return { root: realOrSelf(defaultRoot), source: 'default' };
}

/**
 * Describe how a resolved checkout root relates to the primary/worktree
 * layout around it (#1672), for a caller — the background server — that must
 * not silently inherit an active Builder/agent checkout's coupling as if it
 * were its own, isolated install.
 *
 * Two independent facts, because they are different risks:
 * - `isLinkedWorktree`: the resolved root ITSELF is a linked worktree, not a
 *   primary checkout — a server running from here is coupled to whatever
 *   primary that worktree hangs off, and that primary's own lifecycle
 *   (removed, rebased, pruned) can pull the rug out from under the server.
 * - `hasLinkedWorktrees`: the resolved root IS a primary checkout, but one or
 *   more Builder/agent worktrees are linked off it right now — an active
 *   Builder checkout sharing the same primary the server reads its own
 *   branch/freshness from. This does not misreport the server's own
 *   `currentDiskSha`/branch state (it is still reading the primary's own
 *   HEAD, which is correct for the primary itself, and a linked worktree's
 *   own HEAD never desyncs what this reports); the flag is purely
 *   informational, so an operator can tell the server isn't running from an
 *   otherwise-isolated, dedicated-only checkout.
 *
 * Read-only: calls only `locateCheckouts`/`linkedWorktreeRoots`, neither of
 * which touches anything outside `.git`, and mutates nothing.
 *
 * @param {string} resolvedRoot - Normally `resolveServerCheckoutRoot(...).root`.
 * @param {{ launchdPlistPath?: string, existsSync?: Function, readFileSync?: Function }} [opts]
 *   (Round 3, #1672) `launchdPlistPath` overrides which plist
 *   `launchdWorkingDirectory` is read from (default: this user's
 *   `~/Library/LaunchAgents/com.tangleclaw.server.plist`); `existsSync`/
 *   `readFileSync` are injectable for deterministic testing.
 * @returns {{
 *   checkout: {primary: string, isWorktree: boolean}|null,
 *   isLinkedWorktree: boolean,
 *   hasLinkedWorktrees: boolean,
 *   linkedWorktreeCount: number,
 *   coupled: boolean,
 *   launchdWorkingDirectory: string|null
 * }} `checkout` is `null` when the root is not inside a recognizable git
 *   layout at all (e.g. a tarball install with no `.git`) — not itself a
 *   coupling risk, so `coupled` stays `false` in that case. Otherwise
 *   `coupled` is `isLinkedWorktree || hasLinkedWorktrees`: true whenever the
 *   resolved root shares a lifecycle with some other active checkout.
 *   `launchdWorkingDirectory` is the `WorkingDirectory` the plist at
 *   `launchdPlistPath` currently declares, or `null` when that plist
 *   doesn't exist, can't be read, or has no such key — never thrown, and
 *   never compared against `resolvedRoot` here (a caller that wants "does
 *   the server actually run from where launchd points it" compares the two
 *   fields itself).
 */
function describeServerRootCoupling(resolvedRoot, opts = {}) {
  const checkout = locateCheckouts(resolvedRoot);
  const launchdWorkingDirectory = _readLaunchdWorkingDirectory(opts);
  if (!checkout) {
    return {
      checkout: null, isLinkedWorktree: false, hasLinkedWorktrees: false, linkedWorktreeCount: 0,
      coupled: false, launchdWorkingDirectory
    };
  }
  if (checkout.isWorktree) {
    return {
      checkout, isLinkedWorktree: true, hasLinkedWorktrees: false, linkedWorktreeCount: 0,
      coupled: true, launchdWorkingDirectory
    };
  }
  const { roots } = linkedWorktreeRoots(checkout.primary);
  return {
    checkout,
    isLinkedWorktree: false,
    hasLinkedWorktrees: roots.length > 0,
    linkedWorktreeCount: roots.length,
    coupled: roots.length > 0,
    launchdWorkingDirectory
  };
}

// ---------------------------------------------------------------------------
// Launchd plist repointing & dedicated-checkout provisioning (#1672 Round 3)
//
// The executable half of the dedicated-install story `resolveServerCheckoutRoot`
// only DESCRIBES: an operator (or a smoke-test harness) can use these to
// actually point the `com.tangleclaw.server` launchd job's WorkingDirectory
// at a chosen checkout, and to provision a disk-light dedicated checkout to
// point it at. Every fs/process call here is injectable (`opts.*Sync`), so a
// test never has to touch this machine's real plist or run real `launchctl`
// — repointing and provisioning are inert until a caller explicitly asks for
// them, and the real defaults only apply when nothing is injected.
// ---------------------------------------------------------------------------

/** Default location of the com.tangleclaw.server launchd plist on this user's machine. */
function _defaultLaunchdPlistPath() {
  return path.join(os.homedir(), 'Library', 'LaunchAgents', 'com.tangleclaw.server.plist');
}

/**
 * Read a `<key>${key}</key>` entry's `<string>` value out of plist XML.
 * Not a general plist parser (this repo is zero-dependency, and the
 * `com.tangleclaw.server` plist's own shape — a flat `<dict>` of
 * key/string pairs, no nested dicts for the keys this module touches — is
 * simple enough not to need one): finds the key, reads the `<string>` that
 * immediately follows it.
 *
 * @param {string} xml
 * @param {string} key
 * @returns {string|null} `null` when the key isn't present.
 */
function _extractPlistStringValue(xml, key) {
  const re = new RegExp(`<key>${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</key>\\s*<string>([^<]*)</string>`);
  const m = re.exec(xml);
  return m ? m[1] : null;
}

/**
 * Escape the three characters that give XML text structural meaning, so a
 * value substituted into plist XML can never be parsed as a tag.
 * @param {string} value
 * @returns {string}
 */
function _escapeXmlText(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Replace a `<key>${key}</key>`'s `<string>` value in plist XML, leaving
 * everything else untouched.
 *
 * @param {string} xml
 * @param {string} key
 * @param {string} value - XML-escaped before insertion.
 * @returns {string}
 * @throws {Error} When the key is not present in `xml` — a template or
 *   existing plist missing the key this module is specifically asked to
 *   rewrite is malformed input, not a case to silently skip.
 */
function _replacePlistStringValue(xml, key, value) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(<key>${escapedKey}</key>\\s*<string>)[^<]*(</string>)`);
  if (!re.test(xml)) {
    throw new Error(`plist XML has no <key>${key}</key> entry to rewrite`);
  }
  const escapedValue = _escapeXmlText(value);
  // A replacer FUNCTION, not a `$1${value}$2`-shaped replacement string: the
  // latter treats a literal `$` in `escapedValue` (an unlikely but possible
  // character in a filesystem path) as a special replacement pattern
  // (`$$`, `$1`, `$&`, ...) and would corrupt the output silently.
  return xml.replace(re, (_match, pre, post) => `${pre}${escapedValue}${post}`);
}

/**
 * Read `launchdWorkingDirectory` for `describeServerRootCoupling` — never
 * throws, reports `null` for anything that stops it (plist missing,
 * unreadable, no `WorkingDirectory` key).
 *
 * @param {{ launchdPlistPath?: string, existsSync?: Function, readFileSync?: Function }} [opts]
 * @returns {string|null}
 */
function _readLaunchdWorkingDirectory(opts = {}) {
  const existsSync = opts.existsSync || fs.existsSync;
  const readFileSync = opts.readFileSync || fs.readFileSync;
  const plistPath = opts.launchdPlistPath || _defaultLaunchdPlistPath();
  try {
    if (!existsSync(plistPath)) return null;
    const xml = readFileSync(plistPath, 'utf8');
    return _extractPlistStringValue(xml, 'WorkingDirectory');
  } catch {
    return null;
  }
}

/**
 * Rewrite a launchd plist's `WorkingDirectory` to `targetCheckoutRoot`, and
 * substitute every other placeholder `deploy/install.sh`'s own `sed` pass
 * would have (#1672 Round 4; Round 3 rewrote `WorkingDirectory` alone,
 * which left a literal `__NODE_PATH__` in an installed plist whenever the
 * SOURCE was the raw, unrendered template — caught by review, not by this
 * module's own Round 3 tests, none of which exercised the template path).
 * Pure string templating on already-read XML — no filesystem write, no
 * process execution; `repointLaunchdServerPlist` is what actually persists
 * the result.
 *
 * Still rewrites ONLY `WorkingDirectory` among the STRUCTURAL keys (not
 * `ProgramArguments`' `server.js` entry, which this repo's real template
 * keeps as a bare relative string resolved against `WorkingDirectory` —
 * rewriting it would diverge from `install.sh`'s own convention for no
 * benefit). `__NODE_PATH__`, `__HOME__` and `__LAUNCHD_PATH__` are
 * PLACEHOLDERS, not structure: a raw template read from `deploy/` still
 * has them literally in its text, so they are substituted the same way
 * `install.sh`'s `sed` pass already does, from the live process by default
 * (never hardcoded, since the real values are genuinely this install's
 * own: `process.execPath`, `os.homedir()`, `process.env.PATH`).
 *
 * **Fails closed**: after every substitution, if ANY `__[A-Z0-9_]+__`
 * -shaped placeholder remains anywhere in the rendered XML — one of these
 * three misspelled, or a template that gained a new one this function does
 * not yet know to fill — this throws rather than returning XML with a
 * literal, broken placeholder in it. Caught here, before
 * `repointLaunchdServerPlist` ever writes, renames or reloads anything.
 *
 * @param {string} targetCheckoutRoot - Absolute, already-validated checkout root.
 * @param {{
 *   templateXml: string,
 *   nodePath?: string,
 *   homeDir?: string,
 *   launchdPath?: string
 * }} opts - `templateXml`: the plist XML to rewrite. The other three override
 *   what each placeholder is filled with — a test's deterministic values, or
 *   a caller repointing a plist for a different user/host than this process's own.
 * @returns {string} The rewritten plist XML.
 * @throws {TypeError} When `opts.templateXml` is missing or empty.
 * @throws {Error} When `templateXml` has no `WorkingDirectory` key to
 *   rewrite, or any `__[A-Z0-9_]+__` placeholder remains after every known
 *   substitution has run.
 */
function renderLaunchdServerPlist(targetCheckoutRoot, opts = {}) {
  if (typeof opts.templateXml !== 'string' || opts.templateXml.length === 0) {
    throw new TypeError('renderLaunchdServerPlist requires opts.templateXml (the plist XML to rewrite)');
  }
  let xml = _replacePlistStringValue(opts.templateXml, 'WorkingDirectory', targetCheckoutRoot);

  const nodePath = opts.nodePath || process.execPath;
  const homeDir = opts.homeDir || os.homedir();
  const launchdPath = opts.launchdPath || process.env.PATH || '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  xml = xml
    .split('__NODE_PATH__').join(_escapeXmlText(nodePath))
    .split('__HOME__').join(_escapeXmlText(homeDir))
    .split('__LAUNCHD_PATH__').join(_escapeXmlText(launchdPath));

  const unresolved = /__[A-Z0-9_]+__/.exec(xml);
  if (unresolved) {
    throw new Error(`plist XML still has an unresolved placeholder after rendering: ${unresolved[0]}`);
  }
  return xml;
}

/**
 * Repoint the `com.tangleclaw.server` launchd job's `WorkingDirectory` at
 * `targetCheckoutRoot` — the executable half of the dedicated-install story
 * `resolveServerCheckoutRoot` only describes. Fails closed:
 * `targetCheckoutRoot` must pass `validateServerCheckoutRoot` before
 * anything is read or written.
 *
 * **Source selection (#1672 Round 4).** `opts.templatePath`, or
 * `opts.readFrom` (`'existing'` forces `plistPath`, `'template'` forces the
 * default template path), wins when given — same as Round 3. With NEITHER
 * given, the default is now: prefer the plist already installed at
 * `plistPath`, when one exists, over the raw checked-in template. Round 3's
 * default was the reverse (always the template), which is exactly what let
 * a literal, unresolved `__NODE_PATH__` reach an installed plist — the raw
 * template still has every `deploy/install.sh`-substituted placeholder in
 * it verbatim, while an already-installed plist has them already filled
 * in correctly for this host. The template is still the fallback when
 * nothing is installed at `plistPath` yet (a genuinely first-time
 * repoint), and `renderLaunchdServerPlist`'s own placeholder substitution
 * (and its fail-closed check) runs either way, so a first-time repoint
 * from the raw template is correct too, not merely the installed-plist case.
 *
 * Writes the rewritten XML to `plistPath` (default: this user's
 * `~/Library/LaunchAgents/com.tangleclaw.server.plist`) ATOMICALLY: a temp
 * file beside it, then a rename — never a partially written plist on disk
 * even if the process is killed mid-write.
 *
 * Never touches `launchctl` unless `opts.reload === true`, and even then
 * only through `opts.execFileSync` (default: the real
 * `child_process.execFileSync`) — a caller that doesn't ask for `reload`
 * never spawns a process at all, and any test can inject a stub.
 *
 * @param {string} targetCheckoutRoot
 * @param {{
 *   readFrom?: 'template'|'existing',
 *   templatePath?: string,
 *   plistPath?: string,
 *   nodePath?: string,
 *   homeDir?: string,
 *   launchdPath?: string,
 *   reload?: boolean,
 *   execFileSync?: Function,
 *   existsSync?: Function,
 *   readFileSync?: Function,
 *   writeFileSync?: Function,
 *   renameSync?: Function
 * }} [opts] - `nodePath`/`homeDir`/`launchdPath` pass through to
 *   {@link renderLaunchdServerPlist}'s own placeholder substitution.
 * @returns {{ plistPath: string, sourcePath: string, xml: string, reloaded: boolean }}
 * @throws {Error} When `targetCheckoutRoot` fails validation, the source
 *   plist cannot be read, it has no `WorkingDirectory` entry to rewrite, or
 *   a placeholder remains unresolved after rendering (see
 *   {@link renderLaunchdServerPlist}) — none of these ever reach a write.
 */
function repointLaunchdServerPlist(targetCheckoutRoot, opts = {}) {
  const validity = _validateServerCheckoutRoot(targetCheckoutRoot);
  if (!validity.ok) {
    throw new Error(`cannot repoint launchd to an invalid server checkout: ${validity.reason}`);
  }

  const existsSync = opts.existsSync || fs.existsSync;
  const readFileSync = opts.readFileSync || fs.readFileSync;
  const writeFileSync = opts.writeFileSync || fs.writeFileSync;
  const renameSync = opts.renameSync || fs.renameSync;
  const execFileSync = opts.execFileSync || _realExecFileSync;

  const plistPath = opts.plistPath || _defaultLaunchdPlistPath();
  const templateDefaultPath = path.join(targetCheckoutRoot, 'deploy', 'com.tangleclaw.server.plist');
  let sourcePath;
  if (opts.templatePath) {
    sourcePath = opts.templatePath;
  } else if (opts.readFrom === 'existing') {
    sourcePath = plistPath;
  } else if (opts.readFrom === 'template') {
    sourcePath = templateDefaultPath;
  } else {
    sourcePath = existsSync(plistPath) ? plistPath : templateDefaultPath;
  }

  let sourceXml;
  try {
    sourceXml = readFileSync(sourcePath, 'utf8');
  } catch (err) {
    throw new Error(`could not read source plist at ${sourcePath}: ${(err && err.message) || err}`);
  }

  const xml = renderLaunchdServerPlist(targetCheckoutRoot, {
    templateXml: sourceXml,
    nodePath: opts.nodePath,
    homeDir: opts.homeDir,
    launchdPath: opts.launchdPath
  });

  const tmpPath = `${plistPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmpPath, xml, 'utf8');
  renameSync(tmpPath, plistPath);

  let reloaded = false;
  if (opts.reload === true) {
    execFileSync('launchctl', ['unload', plistPath], { stdio: 'ignore' });
    execFileSync('launchctl', ['load', plistPath], { stdio: 'ignore' });
    reloaded = true;
  }

  return { plistPath, sourcePath, xml, reloaded };
}

/**
 * Provision a dedicated checkout at `dedicatedRoot` from `primaryRoot`
 * (#1672 Round 3) — a disk-light way to create the stable, isolated
 * checkout `TANGLECLAW_SERVER_ROOT`/`repointLaunchdServerPlist` are meant
 * to point at, without a second full clone's disk cost.
 *
 * `opts.mode: 'worktree'` (default) uses `git worktree add --detach`: a
 * linked worktree of `primaryRoot`'s own repository — shares history and
 * objects, no second `.git`. `opts.mode: 'clone'` uses `git clone --shared
 * <primaryRoot> <dedicatedRoot>` instead: a genuinely separate repository
 * (its own `.git`, so pruning or rebasing the primary can't affect it the
 * way a linked worktree's primary lifecycle can) that still shares object
 * storage with the primary rather than duplicating it.
 *
 * Refuses to provision over an existing path — never overwrites.
 *
 * @param {string} primaryRoot - An existing checkout to provision from.
 * @param {string} dedicatedRoot - Absolute path to create; must not exist yet.
 * @param {{ mode?: 'worktree'|'clone', ref?: string, execFileSync?: Function, existsSync?: Function }} [opts]
 *   `ref`: branch/commit to check out (`worktree` mode only; omitted means
 *   `--detach` from the primary's current HEAD).
 * @returns {{ dedicatedRoot: string, mode: 'worktree'|'clone' }}
 * @throws {Error} When `dedicatedRoot` already exists, or git itself fails.
 */
function provisionDedicatedServerCheckout(primaryRoot, dedicatedRoot, opts = {}) {
  const existsSync = opts.existsSync || fs.existsSync;
  const execFileSync = opts.execFileSync || _realExecFileSync;
  const mode = opts.mode === 'clone' ? 'clone' : 'worktree';

  if (existsSync(dedicatedRoot)) {
    throw new Error(`refusing to provision over an existing path: ${dedicatedRoot}`);
  }

  if (mode === 'clone') {
    execFileSync('git', ['clone', '--shared', primaryRoot, dedicatedRoot], { stdio: 'ignore' });
  } else {
    const args = ['worktree', 'add', '--detach', dedicatedRoot];
    if (opts.ref) args.push(opts.ref);
    execFileSync('git', args, { cwd: primaryRoot, stdio: 'ignore' });
  }

  return { dedicatedRoot, mode };
}

/**
 * CLI body for this module's `--repoint`/`--provision-dedicated` entrypoints
 * (#1672 Round 3) — split out from the `require.main === module` guard so it
 * is directly callable (and testable) without spawning this file as a real
 * subprocess. `opts.fns` forwards fs/process injections through to
 * `repointLaunchdServerPlist`/`provisionDedicatedServerCheckout`, and
 * `opts.log` overrides where the result is printed (default `console.log`).
 *
 * @param {string[]} argv - Arguments after the script path (`process.argv.slice(2)`).
 * @param {{ fns?: object, log?: Function }} [opts]
 * @returns {object} Whichever operation's own return value.
 * @throws {Error} Usage error, or whatever the underlying operation throws.
 */
function _runCli(argv, opts = {}) {
  const log = opts.log || console.log;
  const args = Array.isArray(argv) ? argv : [];
  const valueAfter = (flag) => {
    const i = args.indexOf(flag);
    return i === -1 ? undefined : args[i + 1];
  };

  if (args.includes('--repoint')) {
    const target = valueAfter('--repoint');
    const plistPath = valueAfter('--plist');
    const result = repointLaunchdServerPlist(target, {
      ...(plistPath ? { plistPath } : {}),
      reload: args.includes('--reload'),
      ...opts.fns
    });
    log(`repointed ${result.plistPath} -> WorkingDirectory=${target}${result.reloaded ? ' (reloaded)' : ''}`);
    return result;
  }

  if (args.includes('--provision-dedicated')) {
    const dedicatedRoot = valueAfter('--provision-dedicated');
    const primaryRoot = valueAfter('--primary') || process.cwd();
    const result = provisionDedicatedServerCheckout(primaryRoot, dedicatedRoot, { ...opts.fns });
    log(`provisioned ${result.dedicatedRoot} (${result.mode}) from ${primaryRoot}`);
    return result;
  }

  throw new Error(
    'usage: node lib/checkout-layout.js --repoint <targetCheckoutRoot> [--plist <plistPath>] [--reload]'
    + ' | --provision-dedicated <dedicatedRoot> [--primary <primaryRoot>]'
  );
}

if (require.main === module) {
  try {
    _runCli(process.argv.slice(2));
  } catch (err) {
    console.error((err && err.message) || err);
    process.exitCode = 1;
  }
}

module.exports = {
  realOrSelf,
  locateCheckouts,
  linkedWorktreeRoots,
  landsInPrimary,
  resolveServerCheckoutRoot,
  describeServerRootCoupling,
  validateServerCheckoutRoot: _validateServerCheckoutRoot,
  renderLaunchdServerPlist,
  repointLaunchdServerPlist,
  provisionDedicatedServerCheckout,
  _runCli,
  OVERRIDE_FILE,
  OVERRIDE_ENV,
  SERVER_ROOT_ENV
};
