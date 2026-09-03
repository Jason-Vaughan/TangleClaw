'use strict';

/**
 * The sacrificial half of the directory scanner: a forked process that performs
 * filesystem work on paths the operator chose, so the server never does.
 *
 * WHY A SEPARATE PROCESS AND NOT A THREAD. A TCC-protected path on macOS does
 * not fail a read, it never answers one — the `open()` stays in the kernel for
 * the life of the process. `fs.promises` puts that call on libuv's threadpool,
 * which defaults to FOUR threads and is shared by every async filesystem call
 * in the process. A deadline can abandon the promise; it cannot cancel the
 * syscall, so the thread is gone for good. Four such reads and the process can
 * no longer perform ANY filesystem operation, on any path, while `/api/health`
 * keeps answering 200 and nothing surfaces.
 *
 * `worker_threads` is not a substitute: workers share the process-wide libuv
 * pool, and `terminate()` cannot interrupt a thread blocked in a syscall. Only
 * killing the process that owns the blocked thread reclaims the resource, and
 * that is what this file exists to be — the thing that can be killed.
 *
 * It therefore holds no state worth keeping and nothing else depends on it
 * being alive. The supervisor in `dir-scanner.js` kills it on a deadline and
 * forks a replacement on the next request.
 */

const path = require('node:path');
const fsp = require('node:fs').promises;
const git = require('./git');
// The pure-fs half of governance detection. Deliberately NOT `./engines`, which
// would open the server's SQLite database inside a process built to be killed.
const governance = require('./governance-state');
// The pure-fs config READER. Same reason as governance-state: `./store` owns
// this API but opens SQLite at require time, which this process must not do.
const projectConfig = require('./project-config');
// The pure-fs version chain. Deliberately NOT `./projects`, which owns the
// public name for this and pulls in the database with it.
const projectVersionFiles = require('./project-version-files');
const { createLogger, setConsoleStream } = require('./logger');

const log = createLogger('dir-scanner-child');

// What makes a directory look like a project to the first-run wizard. Presence
// of any one of these, a git branch, or TangleClaw's own config is enough to
// pre-tick it for import; everything else is still listed, just unticked.
const PROJECT_MARKERS = [
  'package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod',
  'Makefile', 'Gemfile', 'pom.xml', 'build.gradle',
  'CMakeLists.txt', 'setup.py', 'composer.json', 'mix.exs'
];

/**
 * Does `p` exist? Answers off the main thread and never throws.
 *
 * The synchronous `fs.existsSync` this replaces is the same hazard as a
 * synchronous readdir: on a path the kernel never answers for, it does not
 * return false, it does not return at all.
 *
 * @param {string} p - Absolute path to test.
 * @returns {Promise<boolean>}
 */
async function _exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Like `_exists`, but distinguishes "not there" from "there and refused".
 *
 * A REFUSAL IS NOT AN ABSENCE. `_exists` collapses both to `false`, which is
 * right for the walks — a directory they may not read is one they cannot list,
 * and either way it is not a candidate. It is wrong for a REGISTERED project:
 * rendering a directory the server may not traverse as one the operator deleted
 * is confidently wrong rather than merely absent, and it is the case #885 has to
 * tell apart. Kept separate rather than widening `_exists`, whose boolean
 * contract five other call sites in this file depend on.
 *
 * @param {string} p - Absolute path to test.
 * @returns {Promise<{exists: boolean, refused?: boolean}>}
 */
async function _probe(p) {
  try {
    await fsp.access(p);
    return { exists: true };
  } catch (err) {
    if (err && (err.code === 'EACCES' || err.code === 'EPERM')) {
      return { exists: true, refused: true };
    }
    return { exists: false };
  }
}

/**
 * Git branch/dirty info for `dir`, or null when it is not a repo.
 *
 * `null` means EXACTLY that and nothing else. A repository whose read ran out of
 * budget comes back as an object carrying `incomplete` — the names of the fields
 * that were never established — because a slow repository is still a repository
 * and the caller below derives project detection from `branch` being present.
 *
 * WHY THIS RUNS HERE AND NOT IN THE SERVER. `git.getInfo` shells out with
 * `execSync`, several times per repository, and a synchronous call cannot be
 * interrupted by any deadline — a timer does not fire while it runs. In the
 * server that was a second way to wedge the same request. Here the caller is a
 * process that exists to be killed, so a stalled `git` costs the same as a
 * stalled `readdir` and no more.
 *
 * `lib/git` now bounds all of one repository's invocations under a single budget
 * rather than capping each separately, so the overrun a stall can produce is
 * bounded by that budget instead of by the number of commands times the cap.
 *
 * One consequence worth knowing: `git.getInfo`'s two-minute cache now lives in
 * this process, so a child killed for a hang starts cold. That trades a few
 * repeated `git` calls after a kill for never blocking the server, which is the
 * right way round.
 *
 * CALLERS INSIDE A DEADLINED WALK MUST PASS WHAT IS LEFT OF IT. `git.getInfo`
 * bounds one repository's total git work, but its own default budget knows
 * nothing about the walk containing it — so a per-directory call that took the
 * default would let a single stalled repository overrun a walk deadline the loop
 * can only check BETWEEN iterations, never inside a synchronous spawn. Passing
 * the remainder is what makes the walk's own bound true rather than aspirational.
 *
 * @param {string} dir - Directory to inspect.
 * @param {number} [budgetMs] - Wall clock this read may take. Omit only outside
 *   a deadlined loop, where `git.getInfo`'s own budget is the bound.
 * @returns {{branch: string, dirty: boolean|null, lastCommit: string,
 *   lastCommitAge: string, latestTag: string|null, incomplete: string[]}|null}
 *   `null` only for a directory that is not a repository. A field named in
 *   `incomplete` has no value rather than a default — `dirty` is `null`, not
 *   `false`.
 */
function _gitInfo(dir, budgetMs) {
  try {
    return git.getInfo(dir, Number.isFinite(budgetMs) ? { budgetMs } : {});
  } catch {
    // Not a git repo, or git is not installed. Either way there is no branch to
    // report and the directory is still worth listing.
    return null;
  }
}

/**
 * The operations this child will perform. Anything not named here is refused
 * rather than guessed at, so a typo in a caller is a clear error instead of a
 * silent no-op.
 *
 * Each handler takes the request payload and resolves with a JSON-serialisable
 * value. Handlers may hang forever — that is the case this whole design exists
 * for — so none of them may hold state the supervisor would miss.
 */
const HANDLERS = {
  /**
   * Confirm the child is alive and answering, and say which process answered.
   *
   * The pid is the point: it is how a caller tells "the same child replied"
   * from "a replacement child replied", which is the difference between a
   * healthy round trip and a silent respawn after a crash.
   *
   * @returns {Promise<{pid: number}>}
   */
  async ping() {
    return { pid: process.pid };
  },

  /**
   * Everything the dashboard needs to know about ONE registered project's own
   * directory: whether it is there, what governs it, its git state, and its
   * TangleClaw config — gathered in a single round trip so the server never
   * touches that path itself.
   *
   * Deliberately scoped to a single project rather than a batch. Batching would
   * cost one round trip per poll instead of N, but the supervisor's deadline
   * kills the CHILD, not a request — so a batch can only ever fail whole, and one
   * unreadable directory would permanently cost every other project its answer.
   * Per request, the failure is attributed to the path that caused it, which is
   * what lets each caller carry its own `pathKey` and the supervisor's backoff
   * skip that directory on later polls. Within a single poll the isolation is
   * weaker than that sounds — siblings riding the same child die with it — so the
   * property is convergence after one poll, not immunity during it.
   *
   * The reads below the probe run SYNCHRONOUSLY here on purpose: this process
   * exists to be killed, so a blocking read costs it and nothing else. Ordering
   * them after the probe is a cheap filter, NOT a guarantee — be precise about
   * which case it catches. A directory the kernel refuses answers `EACCES` and is
   * filtered. A TCC-protected one does not answer at all, so the probe itself
   * hangs and the supervisor's deadline is what ends it; nothing here catches
   * that, and nothing needs to, because being killed is this process's job.
   *
   * A directory that is not there reports `not-applicable` governance and null
   * git, config and version — matching what a caller could otherwise only learn
   * by testing existence itself, which is the read this op exists to take off
   * the event loop.
   *
   * THIS OP WRITES, which no other handler here does. Version detection carries
   * a read-time self-heal: a project whose live version has moved past its cached
   * one gets the cache rewritten (#165). That write happens in a process the
   * supervisor SIGKILLs, so it is staged and renamed rather than written in
   * place — see `lib/project-version-files.js:writeVersionCacheFile`. A plain
   * write here would leave a truncated cache behind on every kill that landed
   * mid-write, and the reader parses whatever it finds.
   *
   * @param {object} payload - Request payload.
   * @param {string} payload.dir - Absolute path to the project root.
   * @param {string} [payload.engineId] - Engine id from the canonical DB row.
   * @returns {Promise<{exists: boolean, governanceState: string, git: object|null,
   *   config: object|null, version: string|null, unreadable?: string,
   *   code?: string}>} `unreadable` and `code` appear only on the refused branch —
   *   a directory that is there but which this server may not read.
   */
  async projectFacts({ dir, engineId }) {
    const probe = await _probe(dir);
    if (probe.refused) {
      // Present, but the server may not look inside. Reported rather than
      // guessed at: everything below would fail one call at a time and each
      // failure would have to be re-interpreted here.
      return {
        exists: true,
        governanceState: 'not-applicable',
        git: null,
        config: null,
        version: null,
        unreadable: 'the directory is there but this server may not read it (permission denied)',
        code: 'EACCES'
      };
    }
    const exists = probe.exists;
    if (!exists) {
      // Nothing beneath a directory that is not there is worth attempting, and
      // `git.getInfo` in particular would spawn subprocesses to learn that.
      return {
        exists: false, governanceState: 'not-applicable', git: null, config: null, version: null
      };
    }
    return {
      exists: true,
      governanceState: governance.governanceState(dir, { engineId }),
      git: _gitInfo(dir),
      // Reads the cache, the live sources, and rewrites the cache when they
      // disagree. Null when nothing on disk names a version — the dashboard
      // renders a project without a version label rather than inventing one.
      version: projectVersionFiles.detectProjectVersion(dir),
      // The reader, never the writer. `projectConfig.load` returns documented
      // defaults for a missing or malformed file, so the caller cannot tell a
      // project that has no config from one whose config would not parse — which
      // is exactly what it could not tell before this moved, and not a
      // distinction this op is the place to introduce.
      config: projectConfig.load(dir, {
        // Reported, not swallowed. `load` returns documented defaults for a
        // config it cannot parse, which is right — but a project whose settings
        // silently read as defaults because its JSON is corrupt is a support
        // question with no evidence behind it. Debug, not warn: this runs per
        // project on a ten-second poll.
        onError: (err, configPath) => log.debug('project config unreadable — using defaults',
          { path: configPath, error: err.message })
      }),
      continuityIndex: require('./continuity').readIndex(dir)
    };
  },

  /**
   * The subdirectories of `dir` that are not already registered projects, shaped
   * like project records so the dashboard can render both from one list.
   *
   * Stopping at the budget TRUNCATES rather than throwing: a discovery walk that
   * ran out of time has still discovered everything it got to, and this backs the
   * dashboard's project list. Throwing would take a slow directory — hundreds of
   * projects, a sluggish disk — from "the list took a while" to "the list is
   * empty", silently, because the caller degrades a failure to the registered
   * projects alone.
   *
   * @param {object} payload - Request payload.
   * @param {string} payload.dir - Absolute projects directory to walk.
   * @param {string[]} payload.skipNames - Names already registered or archived.
   * @param {number} payload.budgetMs - How long the whole walk may take.
   * @returns {Promise<{unregistered: object[], truncated: boolean}>}
   */
  /**
   * Answer whether ONE directory can be read at all, and nothing more.
   *
   * The system-health panel's Full Disk Access check (#345) needs exactly the
   * read #859 describes: a `readdir` on a TCC-protected path from a process
   * without the grant does not fail, it never returns, and the supervisor's
   * deadline is the only thing that ends it. Every other op here walks and
   * classifies what it finds; this one deliberately does not, because the
   * question is "does this path answer", and the cheapest read that asks it is
   * the one that costs least when the answer is no.
   *
   * @param {{dir: string}} payload - Absolute path to read.
   * @returns {Promise<{entries: number}>} How many entries the read returned.
   */
  async probeDir({ dir }) {
    const entries = await fsp.readdir(dir);
    return { entries: entries.length };
  },

  async listUnregistered({ dir, skipNames = [], budgetMs }) {
    const deadlineAt = Date.now() + budgetMs;
    // A Set does not survive JSON, so it arrives as an array and is rebuilt
    // here — membership is tested once per entry and this list is not short.
    const skip = new Set(skipNames);
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const unregistered = [];
    let truncated = false;

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;
      if (skip.has(entry.name)) continue;

      if (Date.now() >= deadlineAt) {
        truncated = true;
        break;
      }

      const dirPath = path.join(dir, entry.name);
      unregistered.push({
        id: null,
        name: entry.name,
        path: dirPath,
        registered: false,
        engine: null,
        tags: [],
        ports: {},
        session: null,
        git: _gitInfo(dirPath, deadlineAt - Date.now()),
        status: null,
        hasTangleclawConfig: await _exists(path.join(dirPath, '.tangleclaw', 'project.json')),
        createdAt: null,
        updatedAt: null,
        archived: false
      });
    }

    return { unregistered, truncated };
  },

  /**
   * Enumerate and classify the immediate subdirectories of `dir` for the
   * first-run wizard.
   *
   * ONE budget covers the whole walk rather than each call within it: a directory
   * with hundreds of children can exhaust any reasonable budget in per-call
   * increments while every individual call stays under it.
   *
   * Unlike the dashboard's list this one cannot return a partial answer quietly —
   * the operator is about to tick boxes from it, and a list silently missing half
   * the directories reads as "those are not there". So it throws, carrying
   * `tcTruncated`, which is deliberately NOT `tcTimedOut`: this walk was being
   * answered, just not fast enough, and blaming Full Disk Access for a large
   * directory on a slow disk sends the operator to fix the wrong thing.
   *
   * @param {object} payload - Request payload.
   * @param {string} payload.dir - Absolute, already-resolved directory to scan.
   * @param {number} payload.budgetMs - How long the whole walk may take.
   * @param {string} [payload.ownInstallRealPath] - Realpath of the checkout the
   *   server runs from. When present, each entry is marked `isOwnInstall` so
   *   the caller can keep the install out of the wizard (#708). The realpath
   *   probe runs HERE, in the process that exists to be killed — in the parent
   *   it would be a synchronous per-entry filesystem call on the event loop,
   *   the exact shape that wedged this route on a TCC-protected directory
   *   (#859).
   * @returns {Promise<{projects: object[]}>}
   */
  async scanEntries({ dir, budgetMs, ownInstallRealPath }) {
    const deadlineAt = Date.now() + budgetMs;

    const stat = await fsp.stat(dir);
    if (!stat.isDirectory()) {
      throw Object.assign(new Error(`not a directory: ${dir}`), { code: 'ENOTDIR' });
    }

    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const candidates = entries.filter(e => e.isDirectory() && !e.name.startsWith('.'));
    const detected = [];

    for (const entry of candidates) {
      if (Date.now() >= deadlineAt) {
        throw Object.assign(
          new Error(`checked ${detected.length} of ${candidates.length} subdirectories `
            + `in ${budgetMs}ms and gave up`),
          { tcTruncated: true }
        );
      }

      const dirPath = path.join(dir, entry.name);

      // Identity, not spelling: a symlinked or otherwise aliased route to the
      // running checkout is still the running checkout, and a directory that
      // merely shares the name is not. A path that will not resolve is
      // certainly not this running install, so the failure answer is false.
      let isOwnInstall = false;
      if (ownInstallRealPath) {
        try {
          isOwnInstall = (await fsp.realpath(dirPath)) === ownInstallRealPath;
        } catch {
          isOwnInstall = false;
        }
      }

      const gitInfo = _gitInfo(dirPath, deadlineAt - Date.now());
      const hasTangleclawConfig = await _exists(path.join(dirPath, '.tangleclaw', 'project.json'));

      // Sequential and short-circuiting, deliberately. Probing all twelve markers
      // concurrently would issue twelve threadpool calls per directory to answer
      // a question the first hit settles — cheap against a healthy filesystem,
      // and against a blocked one it is twelve stuck slots instead of one.
      let hasProjectMarker = false;
      for (const marker of PROJECT_MARKERS) {
        if (await _exists(path.join(dirPath, marker))) {
          hasProjectMarker = true;
          break;
        }
      }

      detected.push({
        name: entry.name,
        path: dirPath,
        hasTangleclawConfig,
        // `incomplete` travels with the two fields it qualifies. Without it a
        // `dirty: null` this walk never got to check is indistinguishable here
        // from a repository that is genuinely clean — the same false fact the
        // projectFacts path carries it to prevent.
        //
        // `cause` travels for the same reason one level down: it is WHY those
        // fields were not established, and the dashboard renders it. Dropping it
        // here gave two cards in the same list different answers to the same
        // failure — a registered project naming the cause and offering the
        // slow-repository remedy, an unregistered one falling back to "the read
        // did not complete" with no advice at all.
        git: gitInfo
          ? {
            branch: gitInfo.branch,
            dirty: gitInfo.dirty,
            incomplete: gitInfo.incomplete,
            cause: gitInfo.cause
          }
          : null,
        detected: !!((gitInfo && gitInfo.branch) || hasTangleclawConfig || hasProjectMarker),
        isOwnInstall
      });
    }

    return { projects: detected };
  },

  /**
   * Create `dir` if it is absent and its parent is present.
   *
   * PERFORMS NO PATH VALIDATION — deliberately. The rule that this may only
   * create a folder inside the operator's home directory is a security boundary
   * enforced by the only caller (`projects.createProjectsDir`), where it can be
   * stated once and tested once. Duplicating it here would create a second copy
   * to keep in sync, and a boundary in two places is a boundary in neither.
   * Anything calling this op is responsible for having checked.
   *
   * Reports which of the three outcomes happened rather than throwing for two of
   * them: "it was already there" is a success (two clicks on the same button), and
   * "the parent is missing" is an operator-fixable condition with its own message,
   * not an error.
   *
   * @param {object} payload - Request payload.
   * @param {string} payload.dir - Absolute directory to create.
   * @returns {Promise<{status: 'exists'|'parent-missing'|'created', parent: string}>}
   */
  async createDir({ dir }) {
    const parent = path.dirname(dir);

    if (await _exists(dir)) {
      return { status: 'exists', parent };
    }
    // The parent must already exist. Creating ONE level is "you pointed at
    // ~/Documents/Projects and it wasn't there yet"; creating five is building a
    // tree nobody asked for at a path nobody checked.
    if (!await _exists(parent)) {
      return { status: 'parent-missing', parent };
    }

    await fsp.mkdir(dir);
    return { status: 'created', parent };
  }
};

/**
 * Flatten an error into something IPC can carry.
 *
 * `code` travels separately from the message because callers branch on it —
 * `ENOENT` means "offer to create this directory" and a reworded sentence must
 * not be able to change that. The stack is deliberately dropped: it describes
 * this file, not the caller's problem.
 *
 * @param {Error|any} err - Whatever the handler threw.
 * @returns {{message: string, code: string|undefined}}
 */
function _plainError(err) {
  if (err && typeof err === 'object') {
    return {
      message: String(err.message || err),
      code: err.code,
      // The one condition this side is entitled to declare. `tcTruncated` means
      // "the directory WAS answering, there was just more of it than the budget
      // allowed" — a healthy machine with a big folder on a slow disk. It has to
      // survive the hop because the caller words a different sentence for it, and
      // because the alternative sentence tells the operator to change a privacy
      // setting that was never the problem.
      //
      // `tcTimedOut` is deliberately NOT carried: only the supervisor's own
      // deadline may declare a path unresponsive, and that is the one flag that
      // earns the Full Disk Access remedy. A child cannot be allowed to claim it.
      tcTruncated: err.tcTruncated ? true : undefined
    };
  }
  return { message: String(err), code: undefined, tcTruncated: undefined };
}

/**
 * Run one request and reply with its outcome.
 *
 * Never throws and never rejects: this is the top of the child's call stack, so
 * an escaping error would kill the process and strand the supervisor's pending
 * request until its deadline — a five-second wait for a failure already known.
 * A reply that says "this failed, and why" is strictly better.
 *
 * @param {{id: number, op: string, payload: object}} msg - Request from the supervisor.
 * @returns {Promise<void>}
 */
async function _handle(msg) {
  const { id, op, payload } = msg || {};
  const handler = HANDLERS[op];

  if (!handler) {
    _reply({ id, ok: false, error: { message: `unknown scanner operation: ${op}`, code: 'ENOSYS' } });
    return;
  }

  try {
    const value = await handler(payload || {});
    _reply({ id, ok: true, value });
  } catch (err) { // prawduct:allow prawduct/broad-except -- top of the child's call stack; the error is reported to the supervisor, not swallowed
    _reply({ id, ok: false, error: _plainError(err) });
  }
}

/**
 * Send a reply, tolerating a supervisor that has already gone away.
 *
 * `process.send` throws on a closed channel, and the channel closing is the
 * NORMAL end of this process's life — the supervisor kills children that took
 * too long, and a killed child's last in-flight reply races the kill. Throwing
 * there would turn an expected shutdown into an unhandled rejection in the logs.
 *
 * @param {object} message - The reply envelope.
 * @returns {void}
 */
function _reply(message) {
  if (!process.connected) return;
  try {
    process.send(message);
  } catch { // prawduct:allow prawduct/broad-except -- the channel closed between the check and the send; there is no one left to tell
    // The supervisor is gone. It has already failed this request on its side.
  }
}

// Only when actually forked. A test that requires this file for its helpers must
// not thereby install a `disconnect` handler on ITS OWN process — the test runner
// forks test files too, so the handler would fire on the runner's channel and
// exit the test process mid-suite. `require.main` is the exact distinction:
// `fork()` makes this file the entry point, `require()` never does.
if (require.main === module) {
  // WITHOUT THIS, EVERY WARNING THIS PROCESS EMITS IS DISCARDED. The logger sends
  // debug/info/warn to `process.stdout` and only error to `process.stderr`, and
  // the supervisor forks this child with stdout `'ignore'` — so the default sink
  // for a warning here is /dev/null. That is not academic: this process owns
  // diagnostics no other can produce, including an unwritable version cache and a
  // `versionFilePath` naming a file that is not there, and those reached the
  // server's log until the reads that produce them moved in here. Pinning the
  // stream sends them to the piped stderr, which `lib/dir-scanner.js` re-emits
  // into the server's log line by line.
  setConsoleStream(process.stderr);

  process.on('message', (msg) => { _handle(msg); });

  // Outlive nothing. If the supervisor dies — crash, kill, server restart — this
  // process has no reason to exist and no one to answer; without this it would be
  // reparented to init and linger, holding whatever it was blocked on. Children
  // that survive their parent are how a leak becomes permanent.
  process.on('disconnect', () => { process.exit(0); });
}

// HANDLERS is exported because the walks are where the product's behavior lives —
// marker short-circuiting, deadline truncation, what counts as a candidate — and
// that behavior is only testable by stubbing `fs`, which cannot be done across a
// process boundary. Tests exercise the walks directly here, in-process, and prove
// the delegation separately. Nothing in the server calls these except through the
// supervisor.
module.exports = { HANDLERS, PROJECT_MARKERS, _plainError };
