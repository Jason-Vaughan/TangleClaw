'use strict';

/**
 * The dashboard says a session is wrapping, sourced from the run registry (#1034).
 *
 * Two halves that have to agree, and the reason this file holds both: the state
 * this chunk restores was previously "shipped" as a server field
 * (`_liveSession`'s `status`) that no frontend ever read, so a wrapping card
 * looked identical to a running one for three and a half months while a payload
 * test passed. Asserting the projection alone would reproduce exactly that, so
 * the renderer here is RUN and its output asserted (#885).
 */

const { describe, it, before, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const projects = require('../lib/projects');

const UI_SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');

/**
 * Slice out a top-level function body by brace-matching from its declaration.
 *
 * `public/ui.js` is a browser global script rather than a requireable module,
 * so its renderers are reached this way.
 *
 * @param {string} src - File source text.
 * @param {string} decl - The declaration, e.g. `function renderStatusDot(project)`.
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
 * closes over supplied as parameters.
 *
 * @param {string} decl - The declaration.
 * @param {string} name - The function's name.
 * @param {object} scope - Free variables by name.
 * @returns {Function} The real renderer, callable.
 */
function lift(decl, name, scope) {
  const names = Object.keys(scope);
  const factory = new Function(...names, `${decl}${functionBody(UI_SRC, decl)}\nreturn ${name};`);
  return factory(...names.map((k) => scope[k]));
}

/**
 * The production `esc`, copied from `public/landing.js` including its
 * non-string rejection. A more forgiving stub would render values the real one
 * drops, making assertions about rendered text quietly untrue.
 *
 * @param {*} str - Value to escape.
 * @returns {string}
 */
function esc(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** A session row, in the shape `_liveSession` / `_unknownSession` consume. */
const ROW = { id: 7, status: 'active', startedAt: '2026-09-06 12:00:00', tmuxSession: 'tc-demo' };

describe('the card reports a running wrap from the run registry (#1034)', () => {
  describe('the server projection', () => {
    let realWrapRun;

    beforeEach(() => { realWrapRun = projects._internal.wrapRun; });
    afterEach(() => { projects._internal.wrapRun = realWrapRun; });

    it('reports a running run, carrying the step and the start', () => {
      projects._internal.wrapRun = () => ({
        runId: 'r1', running: true, sessionId: 7, startedAt: 1757200000000,
        currentStepId: 'ai-content', finishedAt: null, result: null
      });
      assert.deepEqual(projects._wrapState('demo'),
        { step: 'ai-content', since: 1757200000000, stale: false });
    });

    // #1314 — a run claimed and never settled. The registry reports it as
    // `running: false, stale: true`, so the boolean stays the safe answer for
    // every consumer that only asks whether a wrap is in progress; this
    // projection is the one that has to keep the two apart.
    it('reports a WEDGED run as stale rather than collapsing it into "no wrap"', () => {
      projects._internal.wrapRun = () => ({
        runId: 'r1', running: false, stale: true, sessionId: 7, startedAt: 1757200000000,
        currentStepId: 'ai-content', finishedAt: null, result: null
      });
      assert.deepEqual(projects._wrapState('demo'),
        { step: 'ai-content', since: 1757200000000, stale: true },
        'the step it wedged ON is the most useful thing the card can say');
    });

    it('answers ESTABLISHED-absent as false, never as null', () => {
      // The registry is process-local by design, so an empty registry after a
      // restart is the truth rather than a gap — which is the whole reason this
      // chunk sources from the registry instead of the status column that could
      // outlive the process that set it. `false` and `null` are different
      // answers here and the payload keeps them apart.
      projects._internal.wrapRun = () => ({
        runId: null, running: false, sessionId: null, startedAt: null,
        currentStepId: null, finishedAt: null, result: null
      });
      assert.equal(projects._wrapState('demo'), false);
    });

    it('treats a FINISHED run as no wrap running', () => {
      // The registry keeps a finished run so the stream can replay it. Reading
      // `running` rather than the run's presence is what stops a card sticking
      // on the pinwheel after the wrap ends — the acceptance criterion's second
      // half ("finishing it changes it back").
      projects._internal.wrapRun = () => ({
        runId: 'r1', running: false, stale: false, sessionId: 7, startedAt: 1757200000000,
        currentStepId: 'commit', finishedAt: 1757200500000, result: { ok: true }
      });
      assert.equal(projects._wrapState('demo'), false);
    });

    it('answers null — not false — when the read itself fails', () => {
      projects._internal.wrapRun = () => { throw new Error('registry exploded'); };
      assert.equal(projects._wrapState('demo'), null,
        'a read that threw did not establish "no wrap"; false would claim it did');
    });

    it('names the unestablished read in the payload, on both session shapes', () => {
      // `incomplete` is the existing vocabulary for "this field could not be
      // established" — the same array that carries `active`. A wrap state we
      // could not read names itself there rather than hiding inside a false.
      projects._internal.wrapRun = () => { throw new Error('registry exploded'); };
      const wrapping = projects._wrapState('demo');
      assert.equal(wrapping, null);

      const live = projects._liveSession(ROW, wrapping);
      assert.deepEqual(live.incomplete, ['wrapping']);
      assert.equal(live.wrapping, null);

      const unknown = projects._unknownSession(ROW, 'read-timed-out', wrapping);
      assert.deepEqual(unknown.incomplete, ['active', 'wrapping']);
    });

    it('leaves incomplete empty when the wrap state WAS established', () => {
      const live = projects._liveSession(ROW, false);
      assert.deepEqual(live.incomplete, [], 'an established "no wrap" is not a gap');
      assert.equal(live.wrapping, false);
    });

    it('still reports the real registry as absent for a project that never wrapped', () => {
      // Drives the REAL seam, not the stub: proves the shape the stubs imitate
      // is the shape the registry actually returns.
      assert.equal(realWrapRun('a-project-that-has-never-wrapped').running, false);
    });
  });

  describe('the status dot the operator actually sees', () => {
    let dot;

    before(() => {
      require('../public/api-helper.js');
      dot = (project) => lift('function renderStatusDot(project)', 'renderStatusDot', {
        esc,
        tcSessionLiveness: globalThis.tcSessionLiveness,
        tcSessionWrapping: globalThis.tcSessionWrapping,
        tcSessionWrapStale: globalThis.tcSessionWrapStale,
        tcSessionWrapStep: globalThis.tcSessionWrapStep,
        tcSessionRead: globalThis.tcSessionRead,
        degradedTooltip: (read) => esc(read.why || '')
      })(project);
    });

    /**
     * The class list of the rendered dot, as a Set.
     *
     * Compared as whole tokens rather than by substring: `status-dot wrapping`
     * contains `status-dot`, and the sibling-class collision that produced
     * exactly this helper elsewhere (#885) came from a substring match.
     *
     * @param {string} html - Rendered dot markup.
     * @returns {Set<string>} The classes on the outer span.
     */
    function classesOf(html) {
      const m = html.match(/^<span class="([^"]*)"/);
      assert.ok(m, `dot must open with a class attribute, got: ${html}`);
      return new Set(m[1].split(/\s+/).filter(Boolean));
    }

    it('renders the pinwheel for a live session with a wrap running', () => {
      const html = dot({ session: { active: true, wrapping: { step: 'ai-content', since: 1 } } });
      assert.ok(classesOf(html).has('wrapping'), `expected the wrapping dot, got: ${html}`);
      assert.match(html, /ai-content/, 'the step travels as far as the tooltip');
      assert.match(html, /aria-label="Wrap running/, 'the state is not carried by shape alone');
    });

    it('renders the plain active dot when no wrap is running', () => {
      const html = dot({ session: { active: true, wrapping: false } });
      const classes = classesOf(html);
      assert.ok(classes.has('active'));
      assert.ok(!classes.has('wrapping'), `an established "no wrap" must not spin: ${html}`);
    });

    it('renders the pinwheel with no step when the registry has not named one yet', () => {
      // A run that has begun but not entered a step: `currentStepId` is null
      // between `begin` and the first step event, which is a real window.
      const html = dot({ session: { active: true, wrapping: { step: null, since: 1 } } });
      assert.ok(classesOf(html).has('wrapping'));
      assert.match(html, /aria-label="Wrap running"/, 'no dangling separator when there is no step');
    });

    // #1314 — the wedged run. Before the registry applied its own staleness
    // threshold to readers, this card spun forever; collapsing it into the
    // plain active dot instead would have hidden the fault behind the most
    // plausible reading there is.
    it('renders a stalled, distinct dot for a wrap that was claimed and never settled', () => {
      const html = dot({ session: { active: true, wrapping: { step: 'ai-content', since: 1, stale: true } } });
      const classes = classesOf(html);
      assert.ok(classes.has('wrap-stalled'), `expected the stalled dot, got: ${html}`);
      assert.ok(!classes.has('wrapping'), 'a wedged run is not making progress; it must not spin');
      assert.ok(!classes.has('active'), 'nor may it look like a session with nothing running');
      assert.match(html, /aria-label="Wrap stalled — ai-content"/,
        'the state and the step it wedged on are both in the accessible name');
    });

    it('fails OPEN when the wrap read could not be established', () => {
      // `wrapping: null` is the read that threw. The payload keeps the null and
      // names it in `incomplete`; the DISPLAY declines to claim anything,
      // because painting "working" on a card from a broken read is worse than
      // showing nothing. This is the opposite of medusa-wake's fail-closed
      // posture on the same registry, and deliberately so.
      const html = dot({ session: { active: true, wrapping: null, incomplete: ['wrapping'] } });
      assert.ok(!classesOf(html).has('wrapping'), `a failed read must not spin: ${html}`);
      assert.ok(classesOf(html).has('active'));
    });

    it('lets an unknown liveness outrank a running wrap', () => {
      // Both reads can be true at once — the registry answers from the server
      // process whether or not tmux answered. The unknown wins because it is
      // the only one of the two carrying a remedy.
      const html = dot({
        session: { active: null, cause: 'read-timed-out', incomplete: ['active'], wrapping: { step: 'commit', since: 1 } }
      });
      const classes = classesOf(html);
      assert.ok(classes.has('unknown'));
      assert.ok(!classes.has('wrapping'));
      assert.match(html, /status-dot-glyph/, 'the unknown keeps its glyph');
    });

    // The paths a populated fixture never reaches, and the ones most cards on a
    // real dashboard take (#885).
    it('renders the idle dot for a project with no session at all', () => {
      const html = dot({ name: 'p' });
      const classes = classesOf(html);
      assert.ok(!classes.has('wrapping'));
      assert.ok(!classes.has('active'));
      assert.match(html, /No active session/);
    });

    it('does not spin a session that is not live even if a wrap state is present', () => {
      const html = dot({ session: { active: false, wrapping: { step: 'commit', since: 1 } } });
      assert.ok(!classesOf(html).has('wrapping'), `not-live must never spin: ${html}`);
    });
  });

  describe('the two halves meet', () => {
    // THE TEST THIS CHUNK EXISTS FOR. Every assertion above this point drives
    // one realm against a fixture written by hand, and a hand-written fixture
    // is exactly what let the previous version of this feature "pass": the
    // server set `status` on the card and no renderer ever read it, so a
    // payload test and a renderer test were both green while the operator saw
    // an ordinary active card for three and a half months.
    //
    // So neither side's fixture is written here. The session object comes from
    // the SERVER's own projection, and it is fed to the FRONTEND's own
    // renderer. Rename the field on either side and this goes red; rename it on
    // both and it stays green, which is correct — that is a working feature
    // with a different field name.
    let dot;
    let realWrapRun;

    before(() => {
      require('../public/api-helper.js');
      dot = (project) => lift('function renderStatusDot(project)', 'renderStatusDot', {
        esc,
        tcSessionLiveness: globalThis.tcSessionLiveness,
        tcSessionWrapping: globalThis.tcSessionWrapping,
        tcSessionWrapStale: globalThis.tcSessionWrapStale,
        tcSessionWrapStep: globalThis.tcSessionWrapStep,
        tcSessionRead: globalThis.tcSessionRead,
        degradedTooltip: (read) => esc(read.why || '')
      })(project);
    });

    beforeEach(() => { realWrapRun = projects._internal.wrapRun; });
    afterEach(() => { projects._internal.wrapRun = realWrapRun; });

    /**
     * Render the dot for a card built by the server's real projection.
     *
     * @param {object} run - What the registry seam should answer.
     * @returns {string} The rendered dot markup.
     */
    function dotForRun(run) {
      projects._internal.wrapRun = () => run;
      const session = projects._liveSession(ROW, projects._wrapState('demo'));
      return dot({ name: 'demo', session });
    }

    it('spins for a run the server reports as running', () => {
      const html = dotForRun({
        runId: 'r1', running: true, sessionId: 7, startedAt: 1757200000000,
        currentStepId: 'ai-content', finishedAt: null, result: null
      });
      assert.match(html, /class="status-dot wrapping"/,
        `the server said a wrap is running and the card must show it, got: ${html}`);
      assert.match(html, /ai-content/, 'the registry\'s step reaches the operator');
    });

    it('stops spinning once the server reports the run finished', () => {
      // The acceptance criterion's second half, driven end to end rather than
      // asserted about a fixture: a finished run must return the card to plain
      // active, not leave it stuck on the pinwheel.
      const html = dotForRun({
        runId: 'r1', running: false, sessionId: 7, startedAt: 1757200000000,
        currentStepId: 'commit', finishedAt: 1757200500000, result: { ok: true }
      });
      assert.match(html, /class="status-dot active"/, `a finished run must not spin: ${html}`);
      assert.doesNotMatch(html, /wrapping/);
    });

    it('shows no pinwheel when the server could not read the registry', () => {
      projects._internal.wrapRun = () => { throw new Error('registry exploded'); };
      const session = projects._liveSession(ROW, projects._wrapState('demo'));
      assert.equal(session.wrapping, null, 'the payload is honest about the failed read');
      assert.deepEqual(session.incomplete, ['wrapping'], 'and names it');
      assert.doesNotMatch(dot({ name: 'demo', session }), /status-dot wrapping/,
        'while the display declines to claim anything — fail open');
    });
  });

  describe('the call site actually passes it', () => {
    // Every assertion above calls `_liveSession` / `_wrapState` directly, so
    // NONE of them notices if `enrichProject` stops handing the wrap state to
    // the projection. That is this chunk's own failure mode one frame upstream:
    // the payload builder stays perfect and the field silently goes undefined.
    // Source-checked rather than executed, and the honest reason is cheapness:
    // `enrichProject` runs fine in a test — `test/projects.test.js` and
    // `test/engine-error-surface.test.js` both execute it against a live store
    // with injected tmux names, and a stub answering a RUNNING run would
    // distinguish "argument passed" from "argument dropped" perfectly well.
    // These assertions buy the same mutation coverage for the price of reading
    // a string, which is the whole of the argument.
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'projects.js'), 'utf8');
    const body = (decl) => {
      const start = src.indexOf(decl);
      assert.notEqual(start, -1, `${decl} must exist`);
      const open = src.indexOf('{', start);
      let depth = 0;
      for (let i = open; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(open, i + 1);
      }
      assert.fail(`${decl} body must close`);
    };

    it('enrichProject reads the wrap state and passes it to BOTH projections', () => {
      const enrich = body('async function enrichProject(project, facts, context)');
      assert.match(enrich, /_wrapState\(project\.name\)/,
        'enrichProject must read the wrap state');
      assert.match(enrich, /_liveSession\(activeSession, wrapping\)/,
        'the live projection must receive it — without this the pinwheel silently stops');
      assert.match(enrich, /_unknownSession\(activeSession, verdict\.cause, wrapping\)/,
        'and so must the unknown projection');
    });

    it('keys the registry on the same name the wrap pipeline registers under', () => {
      // `lib/sessions.js` calls `wrapRunRegistry.begin(project.name, ...)`. A
      // read keyed on anything else — the id, the path — answers "no wrap"
      // forever, and every test that stubs the seam would still pass.
      const sessions = fs.readFileSync(path.join(__dirname, '..', 'lib', 'sessions.js'), 'utf8');
      assert.match(sessions, /wrapRunRegistry\.begin\(\s*project\.name/,
        'the pipeline registers under project.name');
      assert.match(body('function _wrapState(projectName)'), /_internal\.wrapRun\(projectName\)/);
      assert.match(body('async function enrichProject(project, facts, context)'),
        /_wrapState\(project\.name\)/, 'and the card reads under the same key');
    });
  });

  describe('the pinwheel has a rule to render with', () => {
    it('style.css defines .status-dot.wrapping', () => {
      // Without this, deleting the CSS rule leaves every test green while a
      // wrapping project renders as the bare no-session dot — markup with no
      // style is not a feature.
      const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
      assert.match(css, /\.status-dot\.wrapping\s*\{/, 'the wrapping dot needs a rule');
      const rule = css.slice(css.indexOf('.status-dot.wrapping'));
      assert.match(rule.slice(0, 400), /conic-gradient/, 'the blades are what make it a pinwheel');
      assert.match(rule.slice(0, 400), /animation:\s*spin/, 'and it spins');
    });

    it('style.css defines the detail row label too', () => {
      const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
      assert.match(css, /\.detail-wrapping\s*\{/);
    });

    it('every class the dot can emit has a rule — roster DERIVED, not listed', () => {
      // One call site is not the family. Pinning `.status-dot.wrapping` alone
      // closes today's instance and lets the next state ship unstyled, so the
      // roster comes from what `renderStatusDot` actually emits rather than
      // from a list written here that would go stale the moment a fifth state
      // arrives. `status-dot` itself is the base class and is expected.
      const uiSrc = fs.readFileSync(path.join(__dirname, '..', 'public', 'ui.js'), 'utf8');
      const start = uiSrc.indexOf('function renderStatusDot(project)');
      assert.notEqual(start, -1);
      const open = uiSrc.indexOf('{', start);
      let depth = 0;
      let body = '';
      for (let i = open; i < uiSrc.length; i++) {
        if (uiSrc[i] === '{') depth++;
        else if (uiSrc[i] === '}' && --depth === 0) { body = uiSrc.slice(open, i + 1); break; }
      }
      const emitted = new Set();
      // The lookahead matters: without it `class="status-dot-glyph"` also matches
      // and yields a phantom `-glyph` modifier. The glyph is a CHILD span, not a
      // state of the dot. Caught by this guard failing on its own first run,
      // which is the only reason it is written down here.
      for (const m of body.matchAll(/class="status-dot(?=[\s"])([^"]*)"/g)) {
        for (const cls of m[1].split(/\s+/).filter(Boolean)) emitted.add(cls);
      }
      assert.ok(emitted.size >= 2, `expected modifier classes, derived: ${[...emitted]}`);

      const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
      for (const cls of emitted) {
        assert.match(css, new RegExp(`\\.status-dot\\.${cls}\\s*\\{`),
          `renderStatusDot emits .status-dot.${cls} and style.css has no rule for it`);
      }
    });

    it('the keyframes the pinwheel animates with actually exist', () => {
      // `animation: spin` naming a keyframes block that no longer exists is a
      // silent no-op: the dot renders, and simply never turns.
      const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
      assert.match(css, /@keyframes\s+spin\s*\{/, 'the spin keyframes must exist');
    });
  });

  describe('the step and the elapsed reach a surface a touch operator can read', () => {
    // A `title` needs a hover and the ratified primary client is iPhone Safari,
    // where there is none — so the tooltip alone put the registry's richer
    // answer somewhere the operator can never reach.
    let detail;

    before(() => {
      require('../public/api-helper.js');
      detail = (project) => lift('function renderSessionDetail(project)', 'renderSessionDetail', {
        esc,
        tcSessionLiveness: globalThis.tcSessionLiveness,
        tcSessionWrapping: globalThis.tcSessionWrapping,
        tcSessionWrapStale: globalThis.tcSessionWrapStale,
        tcSessionWrapStep: globalThis.tcSessionWrapStep,
        tcSessionWrapElapsed: globalThis.tcSessionWrapElapsed,
        tcSessionRead: globalThis.tcSessionRead
      })(project);
    });

    it('says "Wrap stalled" in words, the one surface a touch operator can reach', () => {
      // The dot's discriminator is colour plus the absence of motion, and both
      // vanish under `prefers-reduced-motion`, in a screenshot, and for a
      // colour-blind operator. This row is what actually carries the state.
      const html = detail({ session: { active: true, startedAt: 'x', wrapping: { step: 'ai-content', since: Date.now() - 2_400_000, stale: true } } });
      assert.match(html, /Wrap stalled/);
      assert.match(html, /ai-content/, 'the step it wedged on');
      assert.match(html, /no progress for 40m/, 'and how long it has been that way');
      assert.ok(!/>Wrapping</.test(html), `a wedged run must not claim to be wrapping: ${html}`);
    });

    it('names the step in the disclosure row, not only the tooltip', () => {
      const html = detail({ session: { active: true, startedAt: 'x', wrapping: { step: 'changelog-update', since: Date.now() - 90000 } } });
      assert.match(html, /Wrapping/);
      assert.match(html, /changelog-update/);
    });

    it('falls back to the ordinary active line when nothing is wrapping', () => {
      const html = detail({ session: { active: true, startedAt: '2026-09-06 12:00:00', wrapping: false } });
      assert.match(html, /Active since/);
      assert.doesNotMatch(html, /Wrapping/);
    });

    it('formats the elapsed against an injected clock, so it is not timing-dependent', () => {
      const el = globalThis.tcSessionWrapElapsed;
      const at = (ms) => el({ session: { active: true, wrapping: { step: null, since: 1000 } } }, 1000 + ms);
      assert.equal(at(5000), '5s');
      assert.equal(at(90 * 1000), '1m');
      assert.equal(at(3 * 3600 * 1000 + 4 * 60 * 1000), '3h 4m');
    });

    it('reports no elapsed when the registry gave no start', () => {
      assert.equal(globalThis.tcSessionWrapElapsed({ session: { active: true, wrapping: { step: 'x', since: null } } }), null);
      assert.equal(globalThis.tcSessionWrapElapsed({ session: { active: true, wrapping: false } }), null);
    });
  });

  describe('wrapping stays orthogonal to liveness', () => {
    before(() => { require('../public/api-helper.js'); });

    it('does not add a fourth value to tcSessionLiveness', () => {
      // A fourth value would feed `renderSessionCount`, which counts
      // `liveness === 'live'` — so the header's active count would silently
      // drop by one the moment a wrap started. A wrapping session IS live.
      const wrapping = { session: { active: true, wrapping: { step: 'commit', since: 1 } } };
      assert.equal(globalThis.tcSessionLiveness(wrapping), 'live');
      assert.equal(globalThis.tcSessionWrapping(wrapping), true);
    });

    it('reports no wrap for a project with no session, without throwing', () => {
      assert.equal(globalThis.tcSessionWrapping(null), false);
      assert.equal(globalThis.tcSessionWrapping({}), false);
      assert.equal(globalThis.tcSessionWrapStep({}), null);
    });
  });
});
