'use strict';

/**
 * MED-2K9P Chunk 02 — structural source probes for the banner Medusa control in
 * `public/session.js`. The visual is operator-verified (VRF), but two behaviors
 * are security-/correctness-relevant and cheap to pin against regression:
 *   1. Inbound cross-session text (`from`/`message`) is untrusted and MUST be
 *      escaped before it reaches innerHTML (XSS guard).
 *   2. The receive flow rides the existing session poll (no new UI timer) and
 *      does not announce a pre-existing backlog as "new" on first paint.
 * Mirrors the source-probe convention in `settings-modal-silentprime.test.js`.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.js'), 'utf8');

/**
 * Slice a named function's body out of the source for scoped assertions.
 * @param {string} name - Function name.
 * @returns {string} The body slice (name → next top-level `\nfunction `).
 */
function fnBody(name) {
  const start = src.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `function ${name} not found`);
  const next = src.indexOf('\nfunction ', start + 1);
  return src.slice(start, next === -1 ? undefined : next);
}

describe('public/session.js — Medusa control (MED-2K9P Chunk 02)', () => {
  it('escapes untrusted inbound message text in the read panel', () => {
    const body = fnBody('renderMedusaMessages');
    // Both the sender and the message body are escaped before interpolation.
    assert.match(body, /esc\(msg\.from/);
    assert.match(body, /esc\(msg\.message/);
    // And nothing raw-interpolates msg.from/msg.message without esc().
    assert.doesNotMatch(body, /\$\{msg\.from\}/);
    assert.doesNotMatch(body, /\$\{msg\.message\}/);
  });

  it('escapes untrusted sender names in the peers popover', () => {
    const body = fnBody('showMedusaPeers');
    assert.match(body, /esc\(f\)/);
    assert.doesNotMatch(body, /\$\{f\}/);
  });

  it('seeds prevUnread on first render so a pre-existing backlog is not announced as new', () => {
    const body = fnBody('renderMedusaControl');
    // The first-render guard reads the `shown` flag and seeds prevUnread.
    assert.match(body, /if\s*\(\s*!m\.shown\s*\)/);
    assert.match(body, /m\.prevUnread\s*=\s*m\.unread/);
    // The flow only fires when unread rose beyond the prior count.
    assert.match(body, /m\.unread\s*>\s*m\.prevUnread/);
  });

  it('rides the existing session poll — no new timer for Medusa', () => {
    // pollMedusa is invoked from pollStatus (the shared cadence), and the Medusa
    // code introduces no setInterval/setTimeout of its own.
    assert.match(fnBody('pollStatus'), /pollMedusa\(/);
    for (const name of ['pollMedusa', 'renderMedusaControl', 'flowMedusaInbound', 'toggleMedusa']) {
      const body = fnBody(name);
      assert.doesNotMatch(body, /setInterval\(|setTimeout\(/, `${name} must not start a timer`);
    }
  });

  it('announces arrivals on an aria-live region (non-color/-motion a11y cue)', () => {
    const body = fnBody('flowMedusaInbound');
    assert.match(body, /getElementById\(['"]medusaLive['"]\)/);
    assert.match(body, /new Medusa message/);
  });

  // Regression — inbox modal could not be dismissed once opened: opening it marks
  // read → unread 0 → the badge (the toggle) self-hides, leaving no close control
  // and no Escape handler (mobile trap). Fix: explicit ✕ in the panel header, a
  // delegated close handler, Escape-to-close, and a dedicated closeMedusaInbox().
  describe('inbox panel is dismissable (regression: self-hiding badge left it stuck)', () => {
    it('renders an explicit close button in both the empty and populated panel', () => {
      const body = fnBody('renderMedusaMessages');
      // The shared header holds the ✕ close control...
      assert.match(body, /medusa-panel-close/);
      assert.match(body, /aria-label="Close inbox"/);
      // ...and it is used in both branches (header const, no lone title left behind).
      assert.doesNotMatch(body, /'<div class="group-popover-title">Medusa inbox<\/div>'/);
    });

    it('exposes a dedicated close path separate from the open toggle', () => {
      const body = fnBody('closeMedusaInbox');
      assert.match(body, /panel\.hidden\s*=\s*true/);
    });

    it('wires the close button (delegated) and Escape to close the panel', () => {
      // Delegated because the panel innerHTML is re-rendered on each open.
      assert.match(src, /\.medusa-panel-close'\)\)\s*closeMedusaInbox\(\)/);
      // Escape closes the open panel.
      assert.match(src, /e\.key !== 'Escape'/);
      assert.match(src, /!panel\.hidden.*closeMedusaInbox\(\)/s);
    });
  });

  // MED-2K9P art upgrade (approach B): real gold WebP art — two facing heads
  // flanking the MEDUSA emblem, per-head <img> so the inbound/outbound heads glow
  // independently; status carried by state (dim off / amber-glow error), not recolor.
  describe('banner mark uses the real art with per-head elements', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.html'), 'utf8');
    const mark = (html.match(/<span class="medusa-mark"[^>]*>([\s\S]*?)<\/span>/) || [])[1] || '';
    it('renders separate inbound/outbound head images', () => {
      assert.match(html, /class="medusa-head medusa-head--in"[^>]*src="\/medusa-head-left\.webp"/);
      assert.match(html, /class="medusa-head medusa-head--out"[^>]*src="\/medusa-head-right\.webp"/);
      // The crude placeholder SVG paths are gone.
      assert.doesNotMatch(html, /class="golden"/);
    });
    it('places the MEDUSA emblem between the two heads (no bridge)', () => {
      // Order within the mark: inbound head → emblem → outbound head.
      assert.match(mark, /medusa-head--in[\s\S]*medusa-emblem[\s\S]*medusa-head--out/);
      assert.match(html, /class="medusa-emblem"[^>]*src="\/medusa-wordmark\.webp"/);
      // The bridge element and its asset reference are gone.
      assert.doesNotMatch(html, /medusa-bridge/);
    });
    it('ships the referenced WebP assets — and no longer the bridge', () => {
      for (const f of ['medusa-head-left.webp', 'medusa-head-right.webp', 'medusa-wordmark.webp']) {
        assert.ok(fs.existsSync(path.join(__dirname, '..', 'public', f)), `${f} missing`);
      }
      assert.ok(!fs.existsSync(path.join(__dirname, '..', 'public', 'medusa-bridge.webp')),
        'medusa-bridge.webp should be removed');
    });
  });

  // Hover help — the control's `title` explains what Medusa is + what it's doing,
  // distinct from the concise aria-label (which stays the accessible name).
  describe('control has descriptive hover help', () => {
    it('medusaHelpText explains the switchboard and the live state', () => {
      const body = fnBody('medusaHelpText');
      assert.match(body, /switchboard|session-to-session/);
      assert.match(body, /listening/);   // the "on" state describes what it's doing
    });
    it('wires the tooltip to the help text, not the terse aria-label', () => {
      assert.match(src, /heads\.title\s*=\s*medusaHelpText\(m\)/);
      // aria-label stays the concise state label (accessible name hygiene).
      assert.match(src, /heads\.setAttribute\('aria-label', label\)/);
    });
  });

  // MED-2K9P v2 T3 — loop setup modal (replaces the Chunk 03 manual compose box;
  // that box is deliberately GONE per the T3 acceptance, and its security/
  // honesty pins carry over here: XSS guard on roster names, honest result +
  // roster states, no-new-timer rule, off-state gating). Visual is operator-VRF'd.
  describe('loop setup modal (MED-2K9P v2 T3)', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.html'), 'utf8');

    it('the manual compose box is gone (T3 acceptance)', () => {
      assert.doesNotMatch(html, /medusaComposePanel/);
      assert.doesNotMatch(src, /sendMedusaMessage|renderMedusaCompose|openMedusaCompose/);
    });

    it('renders the loop button + modal form elements', () => {
      assert.match(html, /id="medusaLoop"[^>]*aria-haspopup="dialog"/);
      assert.match(html, /id="medusaLoopModal"/);
      for (const id of ['medusaLoopTarget', 'medusaLoopTask', 'medusaLoopDone', 'medusaLoopMode', 'medusaLoopMaxRounds', 'medusaLoopMaxMinutes', 'medusaLoopLaunchBtn', 'medusaLoopCancelBtn']) {
        assert.match(html, new RegExp(`id="${id}"`), `${id} missing from the modal`);
      }
      // Both judge modes are selectable from the start (operator-ratified §8).
      assert.match(html, /value="supervised"/);
      assert.match(html, /value="autonomous"/);
    });

    it('escapes untrusted roster names/ids in the target picker (XSS guard)', () => {
      const body = fnBody('renderMedusaLoopTargets');
      assert.match(body, /esc\(w\.id\)/);
      assert.match(body, /esc\(w\.name/);
      // Nothing raw-interpolates a roster field into the option markup.
      assert.doesNotMatch(body, /\$\{w\.id\}/);
      assert.doesNotMatch(body, /\$\{w\.name\}/);
    });

    it('surfaces the honest launch result — the Bridge-delivered invite is stated as such, and failure never claims launched', () => {
      const body = fnBody('launchMedusaLoop');
      // TC#552: the out-of-band task notice is gone — the toast claims only
      // what the contract guarantees (the Bridge delivers the invite; its open
      // response reports no live-vs-queued, so neither does the UI).
      assert.doesNotMatch(body, /taskDelivery/);
      assert.match(body, /the Bridge delivers the invite/);
      // The failure path reports it couldn't open — no blanket success.
      assert.match(body, /Couldn't open loop/);
      assert.doesNotMatch(body, /['"`]Launched/);
    });

    it('validates target, task, done criteria, and positive-integer guards client-side before POSTing', () => {
      const body = fnBody('launchMedusaLoop');
      assert.match(body, /Pick a session/);
      assert.match(body, /Describe the task/);
      assert.match(body, /done criteria/);
      assert.match(body, /Number\.isInteger\(maxRounds\)/);
      assert.match(body, /Number\.isInteger\(maxMinutes\)/);
      // Uses the shared apiMutate JSON path to the loop endpoint, converting
      // operator-facing minutes to the contract's wall-clock seconds.
      assert.match(body, /apiMutate\([\s\S]*?medusa\/loop/);
      assert.match(body, /maxWallTimeSeconds:\s*maxMinutes\s*\*\s*60/);
    });

    it('distinguishes a failed roster fetch from an empty roster (never a false "nobody home")', () => {
      // The empty-roster state is honest and disables the picker...
      const render = fnBody('renderMedusaLoopTargets');
      assert.match(render, /No other Medusa sessions/);
      assert.match(render, /disabled = true/);
      // ...and openMedusaLoopModal routes a null (failed) fetch to the real error.
      const open = fnBody('openMedusaLoopModal');
      assert.match(open, /data === null/);
      assert.match(open, /api\.lastError/);
      assert.match(open, /Couldn't load sessions/);
    });

    it('gates the loop control on listener state — hidden + closed when off', () => {
      const body = fnBody('renderMedusaControl');
      assert.match(body, /m\.state\s*!==\s*'off'/);
      assert.match(body, /closeMedusaLoopModal\(\)/);
    });

    it('lights the outbound head and announces the send on the aria-live region', () => {
      const body = fnBody('flowMedusaOutbound');
      assert.match(body, /flow-out/);
      assert.match(body, /getElementById\(['"]medusaLive['"]\)/);
      assert.match(body, /delivered|queued/i);
    });

    it('adds no new UI timer — the modal rides existing plumbing (no-timer rule #98/#268)', () => {
      for (const name of ['openMedusaLoopModal', 'renderMedusaLoopTargets', 'launchMedusaLoop', 'flowMedusaOutbound', 'closeMedusaLoopModal']) {
        assert.doesNotMatch(fnBody(name), /setInterval\(|setTimeout\(/, `${name} must not start a timer`);
      }
    });

    it('wires the loop button, Launch/Cancel, and Escape to close', () => {
      assert.match(src, /medusaLoop'?\)?\.addEventListener\('click', openMedusaLoopModal\)/);
      assert.match(src, /medusaLoopLaunchBtn'?\)?\.addEventListener\('click', launchMedusaLoop\)/);
      assert.match(src, /medusaLoopCancelBtn'?\)?\.addEventListener\('click', closeMedusaLoopModal\)/);
      // Escape closes the open loop modal too.
      assert.match(src, /loopModal\.classList\.contains\('open'\)\)\s*closeMedusaLoopModal\(\)/);
    });

    it('a launch failure keeps the modal open (form input never lost)', () => {
      const body = fnBody('launchMedusaLoop');
      // The failure branch shows the inline error; only the success branch closes.
      assert.match(body, /fail\(`Couldn't open loop/);
      const successBranch = body.slice(body.indexOf('result && result.loop'), body.lastIndexOf('} else {'));
      assert.match(successBranch, /closeMedusaLoopModal\(\)/);
      const failureBranch = body.slice(body.lastIndexOf('} else {'));
      assert.doesNotMatch(failureBranch, /closeMedusaLoopModal\(\)/);
    });
  });

  // MED-2K9P v2 T4 — banner loop view + force-done. Visuals are operator-VRF'd;
  // these pin the security/honesty/a11y contracts: XSS guard on Bridge-supplied
  // loop data, honest state labels (halted is ONLY the server guard; force-done
  // renders from the structured closeSignal), the never-color-only status cue,
  // the no-new-timer rule, and the control invariant surfacing.
  describe('banner loop view + force-done (MED-2K9P v2 T4)', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.html'), 'utf8');
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.css'), 'utf8');

    it('renders the loops chip + loops panel markup', () => {
      assert.match(html, /id="medusaLoopsChip"[^>]*aria-haspopup="dialog"/);
      assert.match(html, /id="medusaLoopsPanel"[^>]*role="dialog"/);
    });

    it('the status poll carries the loops (rides the existing cadence, no new timer)', () => {
      const body = fnBody('pollMedusa');
      assert.match(body, /m\.loops\s*=\s*data\.loops/);
      assert.match(body, /m\.loopsError\s*=\s*data\.loopsError/);
      for (const name of ['renderMedusaLoopsChip', 'openMedusaLoopsPanel', 'renderMedusaLoopsPanel', 'forceDoneMedusaLoop', 'closeMedusaLoopsPanel']) {
        assert.doesNotMatch(fnBody(name), /setInterval\(|setTimeout\(/, `${name} must not start a timer`);
      }
    });

    it('the chip text carries the status (round count / live count) — the glow is never the only cue', () => {
      const body = fnBody('renderMedusaLoopsChip');
      // Text content set alongside the has-live-loop class toggle.
      assert.match(body, /has-live-loop/);
      assert.match(body, /chip\.textContent/);
      assert.match(body, /R\$\{l\.round\}/);
      // A loop-fetch failure surfaces on the chip, never a silent hide.
      assert.match(body, /loopsError/);
    });

    it('the live-loop glow animation is suppressed under prefers-reduced-motion', () => {
      assert.match(css, /has-live-loop[\s\S]*?animation:\s*medusa-loop-glow/);
      assert.match(css, /prefers-reduced-motion[\s\S]{0,200}has-live-loop[\s\S]{0,100}animation:\s*none/);
    });

    it('escapes every Bridge-supplied field in the loops panel (XSS guard — loop data is cross-session)', () => {
      const body = fnBody('renderMedusaLoopsPanel');
      for (const expr of ['esc\\(other\\)', 'esc\\(loop\\.id\\)', 'esc\\(loop\\.task', 'esc\\(loop\\.target\\)', 'esc\\(stateLabel\\)', 'esc\\(msg\\.from', 'esc\\(msg\\.message', 'esc\\(m\\.loopsError\\)']) {
        assert.match(body, new RegExp(expr), `${expr} must be escaped`);
      }
      assert.doesNotMatch(body, /\$\{loop\.task\}|\$\{loop\.id\}|\$\{msg\.message\}|\$\{msg\.from\}|\$\{other\}/);
    });

    it('state labels are honest: halted is only the server guard; force-done renders from the structured closeSignal', () => {
      const body = fnBody('medusaLoopStateLabel');
      assert.match(body, /halted by guard/);
      assert.match(body, /closeSignal\s*&&\s*loop\.closeSignal\.reason/);
      assert.match(body, /'force-done'/);
    });

    it('force-done is initiator-only in the UI and a halted loop surfaces "cannot be closed" (guard semantics)', () => {
      const body = fnBody('renderMedusaLoopsPanel');
      assert.match(body, /live\s*&&\s*loop\.role\s*===\s*'initiator'/);
      assert.match(body, /guard-halted — cannot be closed/);
    });

    it('force-done confirms, POSTs to the force-done endpoint, and never pretends on failure', () => {
      const body = fnBody('forceDoneMedusaLoop');
      assert.match(body, /window\.confirm\(/);
      assert.match(body, /apiMutate\([\s\S]*?force-done/);
      assert.match(body, /Couldn't end loop/);
      assert.match(body, /api\.lastError/);
      // Success is announced on the aria-live region (non-color cue).
      assert.match(body, /medusaLive/);
    });

    it('the transcript is labeled as observed-only (the Bridge keeps no full history)', () => {
      const body = fnBody('renderMedusaLoopsPanel');
      assert.match(body, /As observed by this session/);
    });

    it('wires the chip, panel delegation (close / force-done / transcript), Escape, and outside click', () => {
      assert.match(src, /medusaLoopsChip'?\)?\.addEventListener\('click', openMedusaLoopsPanel\)/);
      assert.match(src, /\.medusa-force-done'\)/);
      assert.match(src, /\.medusa-loop-transcript-toggle'\)/);
      assert.match(src, /loopsPanel\.hidden\)\s*closeMedusaLoopsPanel\(\)/);
      assert.match(src, /closeMedusaLoopsPanel\(\); \/\/ v2 T4/);
    });
  });

  // TC#561 — the FEEDBACK + satisfied-CLOSEOUT half of the loop control spine.
  // Visuals are operator-VRF'd; the source pins the gate (only when the
  // initiator can actually judge), the honest labels, and the wiring.
  describe('supervised continue/feedback + satisfied closeout (TC#561)', () => {
    const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'session.css'), 'utf8');

    it('defines the continue + closeout handlers', () => {
      for (const name of ['continueMedusaLoop', 'closeoutMedusaLoop']) {
        assert.ok(src.includes(`function ${name}(`), `${name} must be defined`);
      }
    });

    it('offers Send feedback + Mark done ONLY when the initiator can judge (responded state)', () => {
      const body = fnBody('renderMedusaLoopsPanel');
      // The gate is role initiator AND state responded — never for a target,
      // never in initiated/continue/complete (the Bridge would 400 a round).
      assert.match(body, /loop\.role\s*===\s*'initiator'\s*&&\s*loop\.state\s*===\s*'responded'/);
      assert.match(body, /medusa-loop-continue/);
      assert.match(body, /medusa-loop-closeout/);
      // The composer only renders under the same canJudge gate.
      assert.match(body, /canJudge\s*&&\s*feedbackOpen/);
    });

    it('the feedback composer has a labelled textarea and escapes the target name (no raw interpolation)', () => {
      const body = fnBody('renderMedusaLoopsPanel');
      assert.match(body, /medusa-loop-feedback-label/);
      assert.match(body, /<textarea[^>]*medusa-loop-feedback-input/);
      assert.match(body, /placeholder="What should \$\{esc\(other\)\}/);
      assert.doesNotMatch(body, /\$\{other\}/); // never raw
    });

    it('continue validates non-empty feedback, POSTs to the continue endpoint, and never pretends on failure', () => {
      const body = fnBody('continueMedusaLoop');
      assert.match(body, /Enter feedback before sending/);       // client-side guard
      assert.match(body, /apiMutate\([\s\S]*?\/continue/);
      assert.match(body, /Couldn't send feedback/);
      assert.match(body, /api\.lastError/);
      // Optimistic advance uses the Bridge's returned state/round, not a guess.
      assert.match(body, /loop\.state\s*=\s*result\.loopState/);
    });

    it('closeout is a SATISFIED close, labeled distinctly from force-done', () => {
      const body = fnBody('closeoutMedusaLoop');
      assert.match(body, /window\.confirm\(/);
      assert.match(body, /apiMutate\([\s\S]*?\/closeout/);
      assert.match(body, /marked done/);
      assert.doesNotMatch(body, /force-done/); // the satisfied path must not borrow the kill-switch label
      assert.match(body, /Couldn't close loop/);
    });

    it('wires the new delegated controls (continue toggle, feedback send, closeout)', () => {
      assert.match(src, /\.medusa-loop-closeout'\)/);
      assert.match(src, /\.medusa-loop-continue'\)/);
      assert.match(src, /\.medusa-loop-feedback-send'\)/);
      // The composer open-state is a Set mirroring the transcript one.
      assert.match(src, /medusaExpandedFeedback/);
    });

    it('styles the new controls (accent continue/send, quiet closeout, ≥36px touch targets)', () => {
      assert.match(css, /\.medusa-loop-continue[\s\S]*?min-height:\s*36px/);
      assert.match(css, /\.medusa-loop-closeout[\s\S]*?min-height:\s*36px/);
      assert.match(css, /\.medusa-loop-feedback-input/);
    });

    it('the poll re-render defers to the FOCUSED composer (multi-composer safe) but can never deadlock', () => {
      // Regression (Critic cumulative BLOCKING): a guard keyed on residual
      // textarea .value froze the panel forever after a send (sent text stays
      // in the DOM). The guard keys on document.activeElement — the composer
      // actually focused, scoped to the panel — so a blurred/sent composer
      // always re-renders, AND a non-first composer is protected too (a
      // first-match querySelector would drop focus on the 2nd of two).
      const body = fnBody('renderMedusaLoopsPanel');
      assert.match(body, /document\.activeElement/);
      assert.match(body, /active\.closest\('\.medusa-loop-feedback-input'\)/);
      assert.match(body, /panel\.contains\(active\)/);
      assert.doesNotMatch(body, /\.value\.trim\(\)/, 'must NOT gate the re-render on residual DOM value (deadlock source)');
      assert.doesNotMatch(body, /panel\.querySelector\('\.medusa-loop-feedback-input'\)/, 'first-match query drops focus for a non-first composer');
      // The guard returns BEFORE the panel innerHTML is rebuilt.
      const guardIdx = body.indexOf('document.activeElement');
      const renderIdx = body.indexOf('panel.innerHTML =');
      assert.ok(guardIdx >= 0 && renderIdx > guardIdx, 'guard precedes the re-render');
    });

    it('draft text survives re-render via the drafts Map (seeded into the textarea), cleared on send/close', () => {
      const body = fnBody('renderMedusaLoopsPanel');
      // The textarea is seeded from the draft Map and carries data-loop-id.
      assert.match(body, /medusaFeedbackDrafts\.get\(loop\.id\)/);
      assert.match(body, /data-loop-id="\$\{esc\(loop\.id\)\}"[^>]*medusa-loop-feedback-input|medusa-loop-feedback-input[^>]*data-loop-id/);
      assert.match(body, /\$\{esc\(draft\)\}<\/textarea>/); // seeded + escaped
      // Drafts are persisted on input and cleared on send + on close.
      assert.match(src, /addEventListener\('input'[\s\S]*?medusaFeedbackDrafts\.set/);
      assert.match(fnBody('continueMedusaLoop'), /medusaFeedbackDrafts\.delete\(loopId\)/);
    });

    it('the satisfied closeout label survives a refresh (durable row, not just the toast)', () => {
      const body = fnBody('medusaLoopStateLabel');
      assert.match(body, /reason\s*===\s*'satisfied'/);
      assert.match(body, /marked done/);
      // force-done stays distinct.
      assert.match(body, /'force-done'/);
    });

    it('the continue toast is honest when the round hit maxRounds and the Bridge auto-halted', () => {
      const body = fnBody('continueMedusaLoop');
      assert.match(body, /result\.loopState\s*===\s*'halted'/);
      assert.match(body, /halted/);
    });
  });
});
