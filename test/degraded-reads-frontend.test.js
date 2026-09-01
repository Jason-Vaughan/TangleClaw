'use strict';

/*
 * #885 — the dashboard must render a read that could not be established as
 * unknown, never as its negative.
 *
 * The payload already distinguishes the three outcomes (#900 for liveness, #891
 * for git, #885's payload half for the scan and the per-project trio). Nothing
 * rendered any of it: a wedged tmux server drew every running session as "no
 * session", an unreadable folder silently shortened the list, and `dirty: null`
 * drew a repository as clean.
 *
 * These are the pure decision helpers the renderer branches on, in
 * `public/api-helper.js` — the shared frontend base, required directly here the
 * same way test/engine-picker-gating.test.js requires it. Testing them tests
 * every render site at once, which is the point of normalising six payload
 * shapes to one record before anything draws.
 *
 * The scan codes are NOT hand-written string literals. They are driven through
 * the real `dirScanner.failureCode`, so that renaming a code server-side fails
 * these guards instead of silently leaving the dashboard branching on a value
 * the server no longer emits.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const dirScanner = require('../lib/dir-scanner');

/**
 * Slice out a top-level function body by brace-matching from its declaration.
 *
 * `public/ui.js` and `public/landing.js` are browser global scripts rather than
 * requireable modules, so their wiring is pinned against source the same way
 * test/landing-wrap-single-flight.test.js pins the dashboard wrap trigger.
 *
 * @param {string} src - File source text.
 * @param {string} decl - The declaration to find, e.g. `function renderCard(project)`.
 * @returns {string} The body including its braces.
 */
function functionBody(src, decl) {
  const start = src.indexOf(decl);
  assert.notEqual(start, -1, `${decl} must exist`);
  const bodyStart = src.indexOf('{', start);
  let depth = 0;
  for (let i = bodyStart; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(bodyStart, i + 1);
  }
  assert.fail(`${decl} body must close`);
}

/**
 * Lift a pure renderer out of `ui.js` and RUN it, with the browser globals it
 * closes over passed in as parameters.
 *
 * Executing the real function beats asserting about its source: a source guard
 * that a dead branch can satisfy proves nothing, which is exactly what a
 * `countLabel = false` mutation demonstrated about the first version of these
 * tests. Only functions that touch no DOM are lifted this way.
 *
 * @param {string} src - `ui.js` source text.
 * @param {string} decl - The declaration, e.g. `function renderRootPanel()`.
 * @param {string} name - The function's name.
 * @param {object} scope - Free variables the function needs, by name.
 * @returns {Function} The real renderer, callable.
 */
function liftRenderer(src, decl, name, scope) {
  const source = decl + functionBody(src, decl);
  const names = Object.keys(scope);
  const factory = new Function(...names, `${source}\nreturn ${name};`);
  return factory(...names.map((k) => scope[k]));
}

/**
 * The production `esc`, copied from `public/landing.js` including its
 * non-string rejection. A more forgiving stub renders values the real one
 * drops, which would make assertions about rendered text quietly untrue.
 *
 * @param {*} str - Value to escape.
 * @returns {string}
 */
function esc(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

describe('degraded-read normalisation (#885)', () => {
  let liveness;
  let sessionRead;
  let dirtyState;
  let gitRead;
  let scanNotice;
  let unreadableNotice;

  before(() => {
    require('../public/api-helper.js');
    liveness = globalThis.tcSessionLiveness;
    sessionRead = globalThis.tcSessionRead;
    dirtyState = globalThis.tcGitDirtyState;
    gitRead = globalThis.tcGitRead;
    scanNotice = globalThis.tcScanNotice;
    unreadableNotice = globalThis.tcUnreadableNotice;
  });

  // The codes the server can actually produce, obtained from the server's own
  // mapping rather than restated. `failureCode`'s ORDER is a contract — a
  // remembered refusal carries BOTH tcCached and tcTimedOut — so the cached
  // fixture below carries both flags, which is the shape `_notAnswering` really
  // builds.
  describe('the codes under test are the codes the server emits', () => {
    it('failureCode maps the four scan failure flags', () => {
      assert.equal(dirScanner.failureCode({ tcCached: true, tcTimedOut: true }), 'SCAN_CACHED');
      assert.equal(dirScanner.failureCode({ tcTimedOut: true }), 'SCAN_TIMEOUT');
      assert.equal(dirScanner.failureCode({ tcAborted: true }), 'SCAN_ABORTED');
      assert.equal(dirScanner.failureCode(new Error('EACCES')), 'SCAN_FAILED');
    });
  });

  describe('tcSessionLiveness', () => {
    it('reports unknown when the liveness read did not answer', () => {
      // Mutation: return 'none' for active === null — today's lie, and the whole
      // of #900. A wedged tmux server would draw every running session as absent.
      const project = {
        session: { active: null, status: 'active', incomplete: ['active'], cause: 'read-timed-out' }
      };
      assert.equal(liveness(project), 'unknown');
    });

    it('reports live when tmux confirmed the pane', () => {
      assert.equal(liveness({ session: { active: true, incomplete: [], cause: null } }), 'live');
    });

    it('reports none — not unknown — when there is no session row at all', () => {
      // Mutation: treat an absent session as unknown. Every idle project on the
      // dashboard would then render as degraded, which inverts the bug rather
      // than fixing it.
      assert.equal(liveness({ session: null }), 'none');
      assert.equal(liveness({}), 'none');
      assert.equal(liveness(null), 'none');
    });

    it('reports none when tmux ANSWERED and the pane was absent', () => {
      // The honest negative must survive. Unknown must not swallow it.
      assert.equal(liveness({ session: { active: false, incomplete: [], cause: null } }), 'none');
    });
  });

  describe('tcSessionRead', () => {
    it('carries a why and a tmux-specific remedy when liveness is unknown', () => {
      const record = sessionRead({
        session: { active: null, status: 'active', incomplete: ['active'], cause: 'read-timed-out' }
      });
      assert.equal(record.known, false);
      assert.match(record.why, /could not be established/);
      assert.match(record.remedy, /tmux/);
    });

    it('does NOT reuse the directory remedy for the same cause token', () => {
      // `read-timed-out` means a wedged tmux server here and a filesystem
      // permission for a directory scan. One vocabulary of causes is the design;
      // one vocabulary of REMEDIES would tell an operator to grant Full Disk
      // Access because tmux hung.
      const record = sessionRead({
        session: { active: null, status: 'active', incomplete: ['active'], cause: 'read-timed-out' }
      });
      assert.doesNotMatch(record.remedy, /Full Disk Access/);
    });

    it('reports known for a live session', () => {
      const record = sessionRead({ session: { active: true, incomplete: [], cause: null } });
      assert.equal(record.known, true);
      assert.equal(record.why, null);
    });
  });

  describe('tcGitDirtyState', () => {
    it('reports unknown when dirty could not be established', () => {
      // Mutation: return 'clean' for dirty === null. That draws a dirty
      // repository as clean — the exact unknown-as-fact #891 removed from the
      // payload, reintroduced at the render boundary.
      assert.equal(dirtyState({ branch: 'main', dirty: null, incomplete: ['dirty'] }), 'unknown');
    });

    it('reports dirty and clean when the read established them', () => {
      assert.equal(dirtyState({ branch: 'main', dirty: true, incomplete: [] }), 'dirty');
      assert.equal(dirtyState({ branch: 'main', dirty: false, incomplete: [] }), 'clean');
    });

    it('reports null — not unknown — when there is no repository', () => {
      // Mutation: return 'unknown' for a missing git object. Every plain
      // directory on the dashboard would grow a "?" claiming a failed read that
      // never happened.
      assert.equal(dirtyState(null), null);
      assert.equal(dirtyState(undefined), null);
    });
  });

  describe('tcGitRead', () => {
    it('reports unknown for ANY short field, not only dirty', () => {
      // `incomplete` is the authoritative list. A branch that could not be read
      // is as unestablished as a working-tree state.
      const record = gitRead({ branch: '', dirty: true, incomplete: ['branch'], cause: 'read-timed-out' });
      assert.equal(record.known, false);
      assert.match(record.why, /branch/);
    });

    it('names the cause git actually reported', () => {
      const refused = gitRead({
        branch: 'main', dirty: null, incomplete: ['dirty'], cause: 'git-refused-to-read-repository'
      });
      assert.match(refused.why, /refused/);
      // A refusal is not a timeout, so it earns no "it retries" reassurance.
      assert.equal(refused.remedy, null);
    });

    it('reports known for a complete reading', () => {
      assert.equal(gitRead({ branch: 'main', dirty: false, incomplete: [], cause: null }).known, true);
    });

    it('never prints a payload field name at the operator', () => {
      // Mutation: join `incomplete` raw. "Could not establish dirty" reads as a
      // leak, and "dirty" means nothing to someone who did not write the field.
      const record = gitRead({ branch: 'main', dirty: null, incomplete: ['dirty'], cause: 'read-timed-out' });
      assert.doesNotMatch(record.why, /\bdirty\b/,
        'the field name must be translated, not echoed');
      assert.match(record.why, /uncommitted changes/);
    });

    it('names every field lib/git.js can actually report as short', () => {
      // Driven from the real producer's vocabulary rather than a guess: any
      // field name `getInfo` can push must have prose here, or this goes red.
      const gitSrc = fs.readFileSync(path.resolve(__dirname, '..', 'lib', 'git.js'), 'utf8');
      const names = new Set();
      for (const m of gitSrc.matchAll(/step\('([a-zA-Z]+)'/g)) names.add(m[1]);
      for (const m of gitSrc.matchAll(/incomplete\.push\('([a-zA-Z]+)'\)/g)) names.add(m[1]);
      assert.ok(names.size >= 4, 'the field vocabulary must have been found');
      for (const field of names) {
        const record = gitRead({ branch: 'main', dirty: null, incomplete: [field], cause: 'read-timed-out' });
        // The raw-name fallback renders as "Could not establish <field> —".
        // Prose that happens to contain the word is fine ("the current branch");
        // the bare token standing in for a sentence is not.
        assert.doesNotMatch(record.why, new RegExp(`establish ${field} —`),
          `"${field}" reaches the operator untranslated — add it to the field vocabulary`);
      }
    });

    it('does not answer an inherited property for a hostile field name', () => {
      // The lookup tables are keyed by payload values. A plain object answers
      // `constructor` with a function, which then lands inside a sentence an
      // operator reads. Mutation: drop the null prototype.
      const record = gitRead({
        branch: 'main', dirty: null, incomplete: ['constructor'], cause: 'toString'
      });
      assert.equal(typeof record.why, 'string');
      assert.doesNotMatch(record.why, /function|\[object|native code/i);
    });

    it('lists several short fields readably', () => {
      const record = gitRead({
        branch: '', dirty: null, incomplete: ['branch', 'dirty', 'latestTag'], cause: 'read-timed-out'
      });
      assert.match(record.why, /current branch, whether there are uncommitted changes and the latest tag/);
    });
  });

  describe('tcScanNotice', () => {
    it('returns null when the list is complete', () => {
      // Mutation: render a notice unconditionally. The healthy dashboard would
      // carry a permanent warning row.
      assert.equal(scanNotice({ dir: '/p', complete: true, code: null, reason: null, hint: null, listed: null }), null);
      assert.equal(scanNotice(null), null);
    });

    it('reports a truncated walk as info with no remedy', () => {
      // Mutation: give truncation kind 'warn', or hand it a remedy. Nothing is
      // wrong with a directory that answered fine and is merely larger than one
      // scan's budget; advising a permission change there is the misdiagnosis
      // this whole area exists to remove.
      const notice = scanNotice({
        dir: '/p',
        complete: false,
        code: 'SCAN_TRUNCATED',
        reason: 'The projects directory has more folders than one scan could check in time, '
          + 'so this list is short rather than complete. Nothing is wrong with it.',
        hint: null,
        listed: 42
      });
      assert.equal(notice.kind, 'info');
      assert.equal(notice.remedy, null);
      assert.equal(notice.listed, 42);
      assert.doesNotMatch(notice.why, /Full Disk Access/);
    });

    it('keeps the server hint for a remembered refusal AND says nothing is retrying', () => {
      // Two separate decisions, and deriving either from the other is the defect
      // three reviewers found independently. The condition is unchanged, so the
      // Full Disk Access remedy still stands; the backoff is an ADDITIONAL fact.
      const code = dirScanner.failureCode({ tcCached: true, tcTimedOut: true });
      const notice = scanNotice({
        dir: '/p',
        complete: false,
        code,
        reason: 'Could not read the projects directory, so folders that are not registered '
          + 'are missing from this list. Registered projects are unaffected.',
        hint: 'the directory did not respond. On macOS that is what a protected folder does '
          + 'when node has no Full Disk Access.',
        listed: null
      });
      assert.equal(notice.kind, 'warn');
      assert.match(notice.remedy, /Full Disk Access/,
        'a remembered refusal must keep the remedy — the condition it describes is unchanged');
      assert.match(notice.why, /not being retried/,
        'a remembered refusal must say that nothing is retrying it');
    });

    it('supplies a remedy for an ordinary failure the server left without one', () => {
      // An EACCES projects directory arrives as SCAN_FAILED with a null hint —
      // honest, but the operator gets no advice at all. Mutation: drop the
      // fallback and the row renders a problem with no next step.
      const code = dirScanner.failureCode(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
      const notice = scanNotice({
        dir: '/p', complete: false, code, reason: 'Could not read the projects directory.',
        hint: null, listed: null
      });
      assert.equal(code, 'SCAN_FAILED');
      assert.ok(notice.remedy, 'SCAN_FAILED must not leave the operator with no advice');
      // It must not GUESS a cause: SCAN_FAILED is the catch-all.
      assert.doesNotMatch(notice.remedy, /Full Disk Access/);
    });

    it('supplies a remedy for a missing directory', () => {
      const notice = scanNotice({
        dir: '/nope', complete: false, code: 'DIR_MISSING',
        reason: 'The projects directory does not exist: /nope', hint: null, listed: null
      });
      assert.match(notice.remedy, /Create the directory|Settings/);
    });

    it('prefers the server sentence over anything the renderer would invent', () => {
      const notice = scanNotice({
        dir: '/p', complete: false, code: 'SCAN_TIMEOUT',
        reason: 'A very specific server sentence.', hint: null, listed: null
      });
      assert.match(notice.why, /A very specific server sentence\./);
    });
  });

  describe('tcUnreadableNotice', () => {
    it('returns null for a readable project', () => {
      assert.equal(unreadableNotice({ name: 'p', unreadable: null }), null);
      assert.equal(unreadableNotice({ name: 'p' }), null);
    });

    it('carries the reason, the server hint, and what is missing', () => {
      const notice = unreadableNotice({
        name: 'p',
        unreadable: 'the directory did not answer',
        unreadableHint: 'the directory did not respond. On macOS that is what a protected '
          + 'folder does when node has no Full Disk Access.',
        unreadableCode: dirScanner.failureCode({ tcTimedOut: true })
      });
      assert.equal(notice.known, false);
      assert.match(notice.why, /did not answer/);
      assert.match(notice.why, /missing rather than absent/,
        'the operator must learn the detail is unestablished, not that the project lacks it');
      assert.match(notice.remedy, /Full Disk Access/);
    });

    it('says nothing is retrying a remembered refusal, and keeps its remedy', () => {
      const notice = unreadableNotice({
        name: 'p',
        unreadable: 'the directory did not answer',
        unreadableHint: 'grant Full Disk Access',
        unreadableCode: dirScanner.failureCode({ tcCached: true, tcTimedOut: true })
      });
      assert.match(notice.why, /not being retried/);
      assert.match(notice.remedy, /Full Disk Access/);
    });

    it('advises on EACCES — the failure whose remedy is most obvious', () => {
      // `lib/dir-scanner-child.js` reports a project directory that is THERE but
      // refused as `EACCES` with no hint of its own. Without a fallback the card
      // named the fault and offered nothing, while the vaguer SCAN_FAILED one
      // level up did get advice — exactly backwards.
      const notice = unreadableNotice({
        name: 'p',
        unreadable: 'permission denied',
        unreadableHint: null,
        unreadableCode: 'EACCES'
      });
      assert.ok(notice.remedy, 'EACCES must not leave the operator with no next step');
      assert.match(notice.remedy, /permission|Full Disk Access/i);
    });

    it('no hint-less code reaches a card with a reason and no next step', () => {
      // Derived from the PRODUCERS, which are tracked files. An earlier version
      // read the documented list out of `.prawduct/artifacts/api-contract.md` —
      // and that directory is GITIGNORED, so the guard passed on the machine
      // that wrote it and could never pass in CI. A fixture that depends on a
      // file which merely happens to exist locally is not a fixture.
      //
      // Two producers, and only these two can put a value in `unreadableCode`:
      //   - `dirScanner.failureCode`, called by `lib/project-facts.js`; and
      //   - `lib/dir-scanner-child.js`'s refused-read reply, whose raw `code` is
      //     forwarded verbatim by `readProjectFacts`.
      // The child's OTHER literal codes (ENOTDIR, ENOSYS) are thrown errors that
      // `failureCode` maps to SCAN_FAILED long before they could reach a card,
      // which is why this does not scrape every `code:` in that file — doing so
      // demanded a remedy for ENOTDIR, a value no card can ever display.
      //
      // `lib/project-facts.js` attaches the Full Disk Access hint exactly when
      // `tcTimedOut || tcCached`, so SCAN_TIMEOUT and SCAN_CACHED always arrive
      // WITH one and need no fallback. The rest arrive hint-less.
      const childSrc = fs.readFileSync(
        path.resolve(__dirname, '..', 'lib', 'dir-scanner-child.js'), 'utf8');
      assert.match(childSrc, /code: 'EACCES'/,
        'the child must still forward EACCES for this guard to mean anything');
      const reachable = [
        dirScanner.failureCode({ tcCached: true, tcTimedOut: true }),
        dirScanner.failureCode({ tcTimedOut: true }),
        dirScanner.failureCode({ tcAborted: true }),
        dirScanner.failureCode(new Error('x')),
        'EACCES'
      ];
      const alwaysHinted = new Set(['SCAN_TIMEOUT', 'SCAN_CACHED']);
      for (const code of reachable.filter((c) => !alwaysHinted.has(c))) {
        const notice = unreadableNotice({
          name: 'p', unreadable: 'x', unreadableHint: null, unreadableCode: code
        });
        // SCAN_ABORTED is the one that legitimately has none — this path may be
        // healthy, and advising a fix would blame the wrong folder.
        if (code === 'SCAN_ABORTED') {
          assert.equal(notice.remedy, null, 'a collateral abort must stay adviceless');
        } else {
          assert.ok(notice.remedy,
            `${code} reaches a card with no remedy — add it to the fallback table`);
        }
      }
    });

    it('lets the server hint win over the renderer fallback', () => {
      // The server authors its hint at the failure site and is more specific
      // than anything the table could infer.
      const notice = unreadableNotice({
        name: 'p', unreadable: 'x',
        unreadableHint: 'a very specific server remedy',
        unreadableCode: 'EACCES'
      });
      assert.match(notice.remedy, /A very specific server remedy/);
    });

    it('gives a collateral abort no remedy of its own', () => {
      // A read cancelled because ANOTHER directory was being given up on is not
      // a verdict on this one. The server attaches no hint deliberately, and
      // SCAN_ABORTED has no renderer fallback — advising a permission change
      // here would blame the wrong folder.
      const notice = unreadableNotice({
        name: 'p',
        unreadable: 'the read was cancelled while another directory was being given up on',
        unreadableHint: null,
        unreadableCode: dirScanner.failureCode({ tcAborted: true })
      });
      assert.equal(notice.remedy, null);
    });
  });
});

describe('the shared record is actually shared (#885)', () => {
  // Structural on purpose, and the exception proves the rule about preferring
  // behaviour: spreading the constructor and re-listing its fields produce
  // byte-identical output TODAY. The entire value is what happens when the
  // record grows a field later — a re-listing source silently would not get it.
  // There is no input that distinguishes the two now, so no behavioural test
  // can exist; the property being protected is structural, so the guard is too.
  it('the sources that extend the record spread it rather than re-listing it', () => {
    const helper = fs.readFileSync(
      path.resolve(__dirname, '..', 'public', 'api-helper.js'), 'utf8');
    for (const decl of ['function tcScanNotice(scan)', 'function tcUnreadableNotice(project)']) {
      const body = functionBody(helper, decl);
      assert.match(body, /\.\.\.tcDegradedRead\(|return tcDegradedRead\(/,
        `${decl} must spread or return the shared constructor, not rebuild its fields`);
      assert.doesNotMatch(body, /known:\s*false,\s*\n?\s*why:/,
        `${decl} re-lists the record's fields — a field added to tcDegradedRead would not reach it`);
    }
  });

  it('every source reports the same key set for the shared fields', () => {
    const shared = ['known', 'why', 'remedy'];
    const records = [
      globalThis.tcSessionRead({
        session: { active: null, incomplete: ['active'], cause: 'read-timed-out' }
      }),
      globalThis.tcGitRead({ branch: 'm', dirty: null, incomplete: ['dirty'], cause: 'read-timed-out' }),
      globalThis.tcScanNotice({
        dir: '/p', complete: false, code: 'SCAN_TIMEOUT', reason: 'x', hint: null, listed: null
      }),
      globalThis.tcUnreadableNotice({ name: 'p', unreadable: 'x', unreadableCode: 'EACCES' })
    ];
    for (const record of records) {
      for (const key of shared) {
        assert.ok(key in record, `every degraded-read record must carry "${key}"`);
      }
    }
  });
});

describe('an unregistered card gets the same answer as a registered one (#885)', () => {
  it('the walk projects every field the renderer reads', () => {
    // `lib/dir-scanner-child.js` builds its OWN git object for unregistered
    // entries rather than passing `getInfo`'s through, so it is a second
    // producer of the same contract. It shipped without `cause`, which meant
    // two cards in one list gave different answers to the same failure: the
    // registered one named the cause and offered the slow-repository remedy,
    // the unregistered one fell back to "the read did not complete" with none.
    const childSrc = fs.readFileSync(
      path.resolve(__dirname, '..', 'lib', 'dir-scanner-child.js'), 'utf8');
    const projection = childSrc.slice(childSrc.indexOf('git: gitInfo'));
    for (const field of ['branch', 'dirty', 'incomplete', 'cause']) {
      assert.match(projection.slice(0, 400), new RegExp(`${field}:\\s*gitInfo\\.${field}`),
        `the walk must project git.${field} — the dashboard reads it`);
    }
  });

  it('both card kinds render an identical badge for an identical failure', () => {
    // The behavioural half: same git object, same rendered badge. If a producer
    // narrows the object for one card, this diverges.
    const root = path.resolve(__dirname, '..');
    const uiSrc = fs.readFileSync(path.join(root, 'public/ui.js'), 'utf8');
    const badge = liftRenderer(uiSrc, 'function renderGitBadge(project)', 'renderGitBadge', {
      esc,
      degradedTooltip: liftRenderer(uiSrc, 'function degradedTooltip(record)', 'degradedTooltip', { esc }),
      tcGitDirtyState: globalThis.tcGitDirtyState,
      tcGitRead: globalThis.tcGitRead
    });
    const failing = { branch: 'main', dirty: null, incomplete: ['dirty'], cause: 'read-timed-out' };
    assert.match(badge({ git: failing }), /retries on the next poll/,
      'a projected git object carrying cause must earn the same remedy');
  });
});

describe('the dashboard actually consults the helpers (#885)', () => {
  let ui;
  let landing;

  before(() => {
    const root = path.resolve(__dirname, '..');
    ui = fs.readFileSync(path.join(root, 'public/ui.js'), 'utf8');
    landing = fs.readFileSync(path.join(root, 'public/landing.js'), 'utf8');
  });

  it('landing.js keeps the scan block instead of discarding it', () => {
    // Mutation: drop the assignment. Every guard above still passes and the
    // dashboard renders nothing — the helpers would be dead code.
    const body = functionBody(landing, 'async function loadProjects()');
    assert.match(body, /state\.projectsScan\s*=\s*data\.scan/,
      'loadProjects must keep the scan block; the notice cannot render without it');
    assert.match(landing, /projectsScan:\s*null/,
      'state must declare projectsScan so the first render has a defined value');
  });

  /**
   * Run the real `renderRootPanel` against a given scan block.
   * @param {object|null} scan - The `scan` block to render under.
   * @returns {string} The panel HTML.
   */
  function renderRoot(scan) {
    const render = liftRenderer(ui, 'function renderRootPanel()', 'renderRootPanel', {
      state: {
        config: { projectsDir: '/Users/x/Projects' },
        projects: [
          { name: 'a', registered: true, archived: false },
          { name: 'b', registered: false, archived: false }
        ],
        projectsScan: scan
      },
      esc,
      tcScanNotice: globalThis.tcScanNotice
    });
    return render();
  }

  const COMPLETE_SCAN = {
    dir: '/Users/x/Projects', complete: true, code: null, reason: null, hint: null, listed: null
  };

  it('the healthy panel is unchanged — no notice, and a real total', () => {
    const html = renderRoot(COMPLETE_SCAN);
    assert.ok(html.includes('1 registered / 2 total'), 'a complete list still reports a total');
    assert.doesNotMatch(html, /root-notice/, 'a healthy dashboard carries no warning row');
  });

  it('the ROOT count stops saying "total" when the list is short', () => {
    // Mutation: make the label unconditional. The panel would keep asserting a
    // completeness the server explicitly did not claim — the silent half of
    // #885. Asserted against RENDERED output, because a source check is
    // satisfied by a dead branch (a `countLabel = false` mutation proved it).
    const html = renderRoot({
      dir: '/Users/x/Projects', complete: false, code: 'SCAN_TIMEOUT',
      reason: 'Could not read the projects directory.', hint: null, listed: null
    });
    assert.doesNotMatch(html, /2 total/,
      'a short list must not be reported as a total');
    assert.ok(html.includes('1 registered / 2 listed'));
  });

  it('the notice carries the reason and the remedy as visible text', () => {
    // Not a tooltip: the remedy is the whole operator-facing value of degrading
    // instead of hanging, and a phone cannot hover.
    const html = renderRoot({
      dir: '/Users/x/Projects', complete: false, code: 'DIR_MISSING',
      reason: 'The projects directory does not exist: /Users/x/Projects',
      hint: null, listed: null
    });
    assert.ok(html.includes('root-notice'), 'the notice row must render');
    assert.ok(html.includes('does not exist'), 'the reason must be visible');
    assert.ok(html.includes('Create the directory'), 'the remedy must be visible');
  });

  it('a truncated walk renders as information, not as a fault', () => {
    const html = renderRoot({
      dir: '/Users/x/Projects', complete: false, code: 'SCAN_TRUNCATED',
      reason: 'More folders than one scan could check in time. Nothing is wrong with it.',
      hint: null, listed: 40
    });
    assert.ok(html.includes('root-notice-info'), 'truncation is info, not a warning');
    assert.doesNotMatch(html, /root-notice-warn/);
    assert.doesNotMatch(html, /Full Disk Access/,
      'a directory that answered fine must never be given a permissions remedy');
    // The glyph carries the distinction for anyone who cannot use the colour, so
    // it must differ too — a shared warning triangle would erase the difference
    // for exactly the readers the palette alone already fails.
    assert.ok(html.includes('&#8505;'), 'an informational notice takes the info glyph');
    assert.doesNotMatch(html, /&#9888;/, 'truncation must not wear the warning triangle');
  });

  it('a real fault takes the warning glyph, so the two are distinguishable', () => {
    const html = renderRoot({
      dir: '/Users/x/Projects', complete: false, code: 'SCAN_TIMEOUT',
      reason: 'Could not read the projects directory.', hint: null, listed: null
    });
    assert.ok(html.includes('&#9888;'));
    assert.doesNotMatch(html, /&#8505;/);
  });

  it('a truncated walk does not recolour the panel as needing attention', () => {
    // The amber border means "look at this". A directory that answered fine and
    // is merely large does not. Mutation: apply the class for any notice.
    const html = renderRoot({
      dir: '/p', complete: false, code: 'SCAN_TRUNCATED',
      reason: 'Nothing is wrong with it.', hint: null, listed: 40
    });
    assert.doesNotMatch(html, /root-panel-degraded/);
    const fault = renderRoot({
      dir: '/p', complete: false, code: 'SCAN_TIMEOUT', reason: 'x', hint: null, listed: null
    });
    assert.match(fault, /root-panel-degraded/, 'a real fault still marks the panel');
  });

  it('shows how far a cut-off walk got, when the scan reported it', () => {
    // Mutation: drop the count. `listed` is in the payload precisely so a short
    // list can be sized; computing it without rendering it is dead data.
    const html = renderRoot({
      dir: '/p', complete: false, code: 'SCAN_TRUNCATED',
      reason: 'Nothing is wrong with it.', hint: null, listed: 40
    });
    assert.match(html, /40 unregistered folders were checked before the cut-off/);
    const noCount = renderRoot({
      dir: '/p', complete: false, code: 'SCAN_TIMEOUT', reason: 'x', hint: null, listed: null
    });
    assert.doesNotMatch(noCount, /root-notice-listed/,
      'a failure with no count must not invent one');
  });

  it('presents the server remedy as a sentence without rewording it', () => {
    // Server hints are authored to follow a log label, so they start lower-case;
    // standalone that reads as truncated. Only the first letter may change — the
    // wording is the server's and is deliberate house style.
    const html = renderRoot({
      dir: '/p', complete: false, code: 'SCAN_TIMEOUT', reason: 'x',
      hint: 'the directory did not respond. On macOS that is what a protected folder does.',
      listed: null
    });
    assert.match(html, /The directory did not respond\. On macOS that is what a protected folder does\./);
  });

  describe('the empty list, which is the worst case rather than an exemption', () => {
    /**
     * Run the real `renderProjects` against a project list and scan, capturing
     * what it writes into the grid.
     * @param {object[]} projects - `state.projects`.
     * @param {object|null} scan - `state.projectsScan`.
     * @returns {string} The grid's innerHTML.
     */
    function renderGrid(projects, scan, filtered) {
      const grid = { innerHTML: '' };
      liftRenderer(ui, 'function renderProjects()', 'renderProjects', {
        document: { getElementById: () => grid },
        filterProjects: () => (filtered === undefined ? projects : filtered),
        renderCard: (p) => `<card>${p.name}</card>`,
        renderRootPanel: () => '<ROOT-PANEL>',
        state: { projects, projectsScan: scan },
        tcScanNotice: globalThis.tcScanNotice
      })();
      return grid.innerHTML;
    }

    const SHORT = {
      dir: '/p', complete: false, code: 'SCAN_TIMEOUT',
      reason: 'Could not read the projects directory.', hint: null, listed: null
    };
    const COMPLETE = {
      dir: '/p', complete: true, code: null, reason: null, hint: null, listed: null
    };

    it('does not claim "No projects yet" when the directory could not be read', () => {
      // Mutation: drop the listIsShort branch. This is #885's worst case — a
      // definite, actionable and wrong statement on a machine where nothing is
      // registered and the scan failed.
      const html = renderGrid([], SHORT);
      assert.doesNotMatch(html, /No projects yet/);
      assert.match(html, /could not be listed|could not be read/);
    });

    it('still invites a first project on a genuinely empty machine', () => {
      const html = renderGrid([], COMPLETE);
      assert.match(html, /No projects yet/);
      assert.match(html, /Create your first project/);
    });

    it('renders the ROOT panel on every path, empty and filtered included', () => {
      // Mutation: restore the early returns that skipped it. The notice would be
      // invisible in exactly the cases that need it most.
      assert.match(renderGrid([], SHORT), /<ROOT-PANEL>/, 'empty list');
      assert.match(renderGrid([], COMPLETE), /<ROOT-PANEL>/, 'empty and healthy');
      const filteredOut = renderGrid([{ name: 'a' }], SHORT, []);
      assert.match(filteredOut, /<ROOT-PANEL>/, 'filtered to nothing');
      assert.match(filteredOut, /No projects match your filter/);
      // And the ordinary path still renders panel + cards.
      const populated = renderGrid([{ name: 'a' }], COMPLETE);
      assert.match(populated, /<ROOT-PANEL><card>a<\/card>/);
    });
  });

  describe('the header session count', () => {
    /**
     * Run the real `renderSessionCount` over a project list.
     * @param {object[]} projects - `state.projects`.
     * @returns {string} The header's innerHTML.
     */
    function count(projects) {
      const el = { innerHTML: '' };
      liftRenderer(ui, 'function renderSessionCount()', 'renderSessionCount', {
        document: { getElementById: () => el },
        state: { projects },
        tcSessionLiveness: globalThis.tcSessionLiveness
      })();
      return el.innerHTML;
    }

    const LIVE = { session: { active: true, incomplete: [], cause: null } };
    const UNKNOWN = { session: { active: null, incomplete: ['active'], cause: 'read-timed-out' } };
    const NONE = { session: null };

    it('does not count an unknown session as not-active', () => {
      // Mutation: count unknowns as inactive. The header then reads "0 active
      // sessions" during the exact wedge the cards below are drawing `?` for —
      // a definite number the server does not have, contradicting the cards it
      // summarises, on the most prominent surface on the page.
      const html = count([UNKNOWN, UNKNOWN, NONE]);
      assert.match(html, /0<\/span> active sessions/);
      assert.match(html, /2 unknown/, 'the unknowns must be surfaced, not absorbed');
    });

    it('counts live sessions and unknowns separately', () => {
      assert.match(count([LIVE, LIVE, UNKNOWN]), /2<\/span> active sessions/);
      assert.match(count([LIVE, LIVE, UNKNOWN]), /1 unknown/);
    });

    it('reads exactly as before on a healthy dashboard', () => {
      // No unknowns must mean no extra clause at all.
      const html = count([LIVE, NONE]);
      assert.equal(html, '<span class="count-num">1</span> active session',
        'a healthy header must be exactly what it always was');
    });
  });

  it('renderRootPanel consults the shared helper rather than re-deriving completeness', () => {
    const body = functionBody(ui, 'function renderRootPanel()');
    assert.ok(body.includes('tcScanNotice(state.projectsScan)'),
      'the ROOT panel must ask the shared helper');
  });

  it('both card renderers share ONE git badge, and neither keeps a private copy', () => {
    // The duplicated markup is why a fix to one card left the other drawing an
    // unreadable repository as clean. Mutation: restore either private copy.
    for (const decl of ['function renderCard(project)', 'function renderUnregisteredCard(project)']) {
      const body = functionBody(ui, decl);
      assert.ok(body.includes('renderGitBadge(project)'),
        `${decl} must use the shared git badge`);
      assert.doesNotMatch(body, /project\.git\.dirty\s*\?/,
        `${decl} must not re-implement the dirty marker — that is the duplication that caused the bug`);
    }
  });

  describe('renderGitBadge, run for real', () => {
    /**
     * Run the real `renderGitBadge` against a git object.
     * @param {object|null} git - `project.git`.
     * @returns {string} Badge HTML.
     */
    function badge(git) {
      const render = liftRenderer(ui, 'function renderGitBadge(project)', 'renderGitBadge', {
        esc,
        degradedTooltip: liftRenderer(ui, 'function degradedTooltip(record)', 'degradedTooltip', { esc }),
        tcGitDirtyState: globalThis.tcGitDirtyState,
        tcGitRead: globalThis.tcGitRead
      });
      return render({ git });
    }

    it('marks an unestablished working tree with a VISIBLE glyph, not just a class', () => {
      // Mutation: drop the marker element. A class-name assertion would survive
      // that — `badge-git-unknown` contains the substring `git-unknown`, so
      // matching loosely passes while the operator sees nothing at all. Assert
      // the rendered glyph, which is the thing an operator can actually read.
      const unknown = badge({ branch: 'main', dirty: null, incomplete: ['dirty'], cause: 'read-timed-out' });
      const clean = badge({ branch: 'main', dirty: false, incomplete: [], cause: null });
      assert.match(unknown, /<span class="git-unknown"[^>]*>\?<\/span>/,
        'the unknown marker must render a visible glyph');
      assert.notEqual(unknown, clean,
        'an unestablished reading must not render identically to a clean one');
    });

    it('keeps the dirty marker and the clean absence intact', () => {
      assert.ok(badge({ branch: 'main', dirty: true, incomplete: [], cause: null }).includes('git-dirty'));
      const clean = badge({ branch: 'main', dirty: false, incomplete: [], cause: null });
      assert.doesNotMatch(clean, /git-dirty|git-unknown/);
    });

    it('renders nothing at all when the project is not a repository', () => {
      assert.equal(badge(null), '');
    });

    it('names the cause in the badge tooltip when a reading went short', () => {
      const html = badge({ branch: 'main', dirty: null, incomplete: ['dirty'], cause: 'read-timed-out' });
      assert.match(html, /title="[^"]*could not establish/i);
    });
  });

  it('the card status dot has a third state carrying a glyph, not colour alone', () => {
    const body = functionBody(ui, 'function renderCard(project)');
    assert.ok(body.includes('tcSessionLiveness(project)'),
      'the card must classify liveness through the shared helper');
    assert.ok(body.includes("liveness === 'unknown'"),
      'the card must draw the unknown distinctly from "no active session"');
    assert.ok(body.includes('status-dot-glyph'),
      'the unknown dot must carry a glyph — an error is never communicated by colour alone');
  });

  it('both card kinds share ONE unreadable badge, with no private copy', () => {
    // The badge was copy-pasted into both renderers — the same duplication
    // `renderGitBadge` exists to remove, one badge over. Mutation: inline the
    // markup into either renderer again.
    for (const decl of ['function renderCard(project)', 'function renderUnregisteredCard(project)']) {
      const body = functionBody(ui, decl);
      assert.ok(body.includes('renderUnreadableBadge(project)'),
        `${decl} must use the shared badge`);
      assert.doesNotMatch(body, /badge-unreadable/,
        `${decl} must not carry its own copy of the markup`);
    }
  });

  it('the unreadable badge renders the reason and the remedy in its tooltip', () => {
    const render = liftRenderer(ui, 'function renderUnreadableBadge(project)', 'renderUnreadableBadge', {
      esc,
      degradedTooltip: liftRenderer(ui, 'function degradedTooltip(record)', 'degradedTooltip', { esc }),
      tcUnreadableNotice: globalThis.tcUnreadableNotice
    });
    assert.equal(render({ name: 'p', unreadable: null }), '', 'a readable folder gets no badge');
    const html = render({
      name: 'p', unreadable: 'permission denied', unreadableHint: null, unreadableCode: 'EACCES'
    });
    assert.match(html, /badge-unreadable/);
    assert.match(html, /title="[^"]*permission denied/);
    assert.match(html, /title="[^"]*(permissions|Full Disk Access)/);
  });

  describe('the card detail rows, run for real', () => {
    /**
     * Run a lifted detail renderer.
     * @param {string} decl - Its declaration.
     * @param {string} name - Its name.
     * @param {object} project - The project to render.
     * @returns {string} HTML for the row value.
     */
    function detail(decl, name, project) {
      const render = liftRenderer(ui, decl, name, {
        esc,
        tcSessionLiveness: globalThis.tcSessionLiveness,
        tcSessionRead: globalThis.tcSessionRead,
        tcGitDirtyState: globalThis.tcGitDirtyState,
        tcGitRead: globalThis.tcGitRead
      });
      return render(project);
    }

    /**
     * @param {object} project - The project to render.
     * @returns {string} The Session row value.
     */
    const session = (project) =>
      detail('function renderSessionDetail(project)', 'renderSessionDetail', project);

    /**
     * @param {object} project - The project to render.
     * @returns {string} The Git row value.
     */
    const git = (project) =>
      detail('function renderGitDetail(project)', 'renderGitDetail', project);

    it('says unknown, and why, rather than "No active session"', () => {
      // Mutation: collapse the unknown branch. The row would state a definite
      // absence the server never established — the whole of #900 on this surface.
      const html = session({
        session: { active: null, status: 'active', incomplete: ['active'], cause: 'read-timed-out' }
      });
      assert.match(html, /Unknown/);
      assert.doesNotMatch(html, /No active session/);
      assert.match(html, /could not be established/, 'the row must name why');
    });

    it('still says "No active session" when there genuinely is none', () => {
      assert.equal(session({ session: null }), 'No active session');
      assert.equal(session({ session: { active: false, incomplete: [], cause: null } }),
        'No active session');
    });

    it('reports a live session unchanged', () => {
      assert.match(session({ session: { active: true, startedAt: '2026-08-13', incomplete: [] } }),
        /Active since 2026-08-13/);
    });

    it('names an unreadable working tree instead of leaving it to look clean', () => {
      // Mutation: drop the suffix. A bare branch name with no "(dirty)" is
      // exactly how a CLEAN repository is drawn, so the row would silently lie.
      const html = git({ git: { branch: 'main', dirty: null, incomplete: ['dirty'], cause: 'read-timed-out' } });
      assert.match(html, /working tree unknown/);
      assert.match(html, /Could not establish/i, 'the row must name why');
      const clean = git({ git: { branch: 'main', dirty: false, incomplete: [], cause: null } });
      assert.notEqual(html, clean);
    });

    it('leaves clean, dirty and not-a-repo readings alone', () => {
      assert.equal(git({ git: { branch: 'main', dirty: false, incomplete: [], cause: null } }), 'main');
      assert.equal(git({ git: { branch: 'main', dirty: true, incomplete: [], cause: null } }), 'main (dirty)');
      assert.equal(git({ git: null }), 'Not a git repo');
    });

    it('the detail panel delegates to both, rather than re-deriving them inline', () => {
      // Runs the panel for real. This was a source pin on `toggleCardDetail`'s
      // body while that function built the panel by hand against the DOM; the
      // panel is now a pure renderer, so the delegation can be asserted from
      // its OUTPUT instead — a source pin is satisfiable by a dead branch.
      const render = liftRenderer(ui, 'function renderCardDetail(project)', 'renderCardDetail', {
        esc,
        renderSessionDetail: () => 'SESSION-DELEGATED',
        renderAwarenessDetail: () => '',
        renderGitDetail: () => 'GIT-DELEGATED',
        tcUnreadableNotice: () => ({ why: 'FOLDER-DELEGATED', remedy: '' }),
        renderNextActionRow: () => ''
      });

      const html = render({ name: 'p', engine: null, tags: [], groups: [] });
      assert.match(html, /SESSION-DELEGATED/, 'session read must come from the shared helper');
      assert.match(html, /GIT-DELEGATED/, 'git read must come from the shared helper');
      assert.match(html, /FOLDER-DELEGATED/,
        'an unreadable folder must be explained in the detail too');
    });
  });
});
