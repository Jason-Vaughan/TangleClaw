'use strict';

/*
 * Frontend structural tests for chunk G slice 2 (#331) — the landing-page
 * Project Master pane. The chat surface IS the terminal: a ttyd iframe onto
 * the reserved tmux session `tangleclaw-master`, attached ONLY after
 * POST /api/master/ensure succeeds (ttyd attaches to existing sessions only).
 *
 * ui.js / index.html render via static markup + DOM wiring with many
 * top-level deps, so source-level structural assertions are the pragmatic
 * contract lock-in — same pattern as test/upload-modal-frontend.test.js.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { makeDocument, withIdParsingInnerHTML } = require('./_mini-dom');
const { liftDeclaration } = require('./helpers/lift');
const loadApiHelperGlobals = require('./_api-helper-globals');

describe('Project Master pane — landing page (chunk G slice 2, #331)', () => {
  let html;
  let js;
  let css;
  /** The ui.js Project Master section, isolated so assertions about what the
   *  master code must NOT do (e.g. polling) don't trip on unrelated code. */
  let masterSection;

  before(() => {
    const pub = path.join(__dirname, '..', 'public');
    html = fs.readFileSync(path.join(pub, 'index.html'), 'utf8');
    js = fs.readFileSync(path.join(pub, 'ui.js'), 'utf8');
    css = fs.readFileSync(path.join(pub, 'style.css'), 'utf8');

    const start = js.indexOf('── Project Master');
    const end = js.indexOf('── Event Bindings ──');
    assert.ok(start > -1 && end > start, 'ui.js has a Project Master section before Event Bindings');
    masterSection = js.slice(start, end);
  });

  /**
   * `_mini-dom.js`'s `makeElement` carries no `.style` object, no
   * `insertBefore`, and a plain string `innerHTML` with no parsing — and
   * its `doc` carries no `querySelector` at all (only elements have one).
   * ui.js's `addMasterAttachmentStrip`/`addMasterChatWorkspace` need all
   * of these. Stubs each onto every element this `doc` creates, and
   * `insertBefore`/`querySelector` onto `doc` itself/`doc.body`, and onto
   * every pre-created id-element `makeDocument(ids)` handed back (those
   * are never routed through `createElement`, so the wrap below would
   * otherwise miss them).
   * @param {object} doc
   * @param {object} [ids] - The `ids` map `makeDocument` returned, if any.
   */
  function withStyleAndInsertBeforeStub(doc, ids) {
    const addInsertBefore = (el) => {
      el.insertBefore = (newNode, referenceNode) => {
        newNode.parentNode = el;
        const idx = referenceNode ? el.childNodes.indexOf(referenceNode) : -1;
        if (idx === -1) el.childNodes.push(newNode); else el.childNodes.splice(idx, 0, newNode);
        return newNode;
      };
    };
    addInsertBefore(doc.body);
    doc.querySelector = (sel) => doc.body.querySelector(sel);
    for (const el of Object.values(ids || {})) {
      el.style = el.style || {};
      addInsertBefore(el);
    }
    const realCreateElement = doc.createElement.bind(doc);
    doc.createElement = (tag) => {
      const el = realCreateElement(tag);
      el.style = {};
      addInsertBefore(el);
      withIdParsingInnerHTML(el, doc);
      return el;
    };
  }

  describe('markup', () => {
    it('header has a Master toggle button wired to the panel with a status dot', () => {
      assert.match(html, /id="masterToggle"[^>]*aria-controls="masterPanel"/s);
      assert.match(html, /id="masterToggle"[^>]*aria-expanded="false"/s);
      assert.match(html, /id="masterDot"/);
    });

    it('the master panel carries a status row, retry button, and the iframe', () => {
      assert.match(html, /id="masterPanel" class="master-panel"/);
      // Same move as the drawer's: the page carries the mount root, the shared
      // component carries the controls. See master-drawer-frontend for why both
      // halves are asserted.
      assert.match(html, /id="masterPanelBar"/);
      const bar = require('./_api-helper-globals')().tcMasterControlBarMarkup('masterPanel', {});
      assert.match(bar, /id="masterPanelDot"/);
      assert.match(bar, /id="masterPanelStatusText"/);
      assert.match(bar, /id="masterPanelRetryBtn"/);
      assert.match(html, /id="masterFrame"/);
    });

    it('the iframe ships WITHOUT a src — attach happens only after ensure', () => {
      const iframeTag = html.match(/<iframe id="masterFrame"[^>]*>/);
      assert.ok(iframeTag, 'master iframe exists');
      assert.ok(!/\ssrc=/.test(iframeTag[0]), 'iframe must not have a static src attribute');
    });
  });

  describe('ensure-then-attach flow', () => {
    it('opening the panel runs the ensure flow', () => {
      assert.match(masterSection, /function toggleMaster\(\)/);
      assert.match(masterSection, /if \(state\.masterOpen\) ensureMasterAttached\(\);/);
    });

    it('ensure POSTs /api/master/ensure and only attaches on success', () => {
      const fn = masterSection.slice(
        masterSection.indexOf('async function ensureMasterAttached'),
        masterSection.indexOf('function attachMasterFrame')
      );
      assert.match(fn, /api\('\/api\/master\/ensure', \{ method: 'POST' \}\)/);
      // Failure path returns BEFORE attachMasterFrame is reached.
      const failIdx = fn.indexOf('if (!result)');
      const attachIdx = fn.indexOf('attachMasterFrame()');
      assert.ok(failIdx > -1, 'ensure checks the api() null-on-error contract');
      assert.ok(attachIdx > failIdx, 'attach happens only after the failure guard');
      // `'down'` is no longer the unconditional argument: a refusal because tmux
      // never answered is an unknown, not a down master, and painting it red
      // would state the exact fact the server said it could not establish. The
      // down path still exists and is now proven by EXECUTION in
      // `test/master-unknown-frontend.test.js` ("still paints down when the
      // ensure genuinely failed"), which is a stronger claim than this slice.
      assert.match(fn, /setMasterStatus\(unknown \? '' : 'down'/);
    });

    it('failure surfaces the real server message and a retry affordance', () => {
      assert.match(masterSection, /api\.lastError/);
      assert.match(js, /onRetry: ensureMasterAttached/);
    });

    it('the iframe attaches to the reserved tmux session, once per page load', () => {
      assert.match(masterSection, /frame\.src = '\/terminal\/\?arg=tangleclaw-master';/);
      assert.match(masterSection, /if \(frame\.dataset\.attached === 'true'\) return;/);
    });

    it('re-ensure is re-entrant-guarded', () => {
      assert.match(masterSection, /if \(state\.masterEnsuring\) return;/);
    });
  });

  describe('relaunch (#3130 PRR-A R1 BLOCKING 1)', () => {
    it('is composed from the same two routes Kill and Launch already call, in sequence, behind a confirm', () => {
      const fn = masterSection.slice(
        masterSection.indexOf('function relaunchMaster'),
        masterSection.indexOf('function addMasterRelaunchButton')
      );
      assert.match(fn, /window\.confirm\(/);
      assert.match(fn, /api\('\/api\/master\/kill', \{ method: 'POST' \}\)/);
      assert.match(fn, /\.then\(\(\) => api\('\/api\/master\/ensure', \{ method: 'POST' \}\)\)/);
      // Kill is issued and its promise chained before ensure ever runs.
      const killIdx = fn.indexOf("api('/api/master/kill'");
      const ensureIdx = fn.indexOf("api('/api/master/ensure'");
      assert.ok(killIdx > -1 && ensureIdx > killIdx, 'kill must be issued, and chained, before ensure');
      assert.match(fn, /if \(state\.masterEnsuring\) return;/, 're-entrant-guarded like ensureMasterAttached');
    });

    it('a failed relaunch surfaces the real server message, same as a failed ensure', () => {
      const fn = masterSection.slice(
        masterSection.indexOf('function relaunchMaster'),
        masterSection.indexOf('function addMasterRelaunchButton')
      );
      assert.match(fn, /api\.lastErrorCode === 'MASTER_LIVENESS_UNKNOWN'/);
      assert.match(fn, /api\.lastError \|\| 'Failed to relaunch the master session'/);
    });

    it('the button is inserted as a sibling of Kill, outside the shared bar component, and wired after mount', () => {
      assert.match(masterSection, /function addMasterRelaunchButton\(prefix\)/);
      assert.match(masterSection, /document\.getElementById\(`\$\{prefix\}KillBtn`\)/);
      assert.match(masterSection, /btn\.addEventListener\('click', relaunchMaster\);/);
      assert.match(masterSection, /killBtn\.parentNode\.insertBefore\(btn, killBtn\);/);
      assert.match(js, /masterBar\.mount\(\);\s*\n\s*addMasterRelaunchButton\('masterPanel'\);/);
    });

    it('setMasterStatus hides the injected button exactly when it hides Kill — status "down"', () => {
      const fn = masterSection.slice(
        masterSection.indexOf('function setMasterStatus'),
        masterSection.indexOf('async function ensureMasterAttached')
      );
      assert.match(fn, /masterPanelRelaunchBtn/);
      assert.match(fn, /relaunchBtn\.classList\.toggle\('hidden', status === 'down'\);/);
    });
  });

  describe('Admin Fleet rename, governed Wrap & Relaunch, attachments (#3137)', () => {
    it('relabels the static Master surfaces from script rather than editing index.html', () => {
      assert.match(masterSection, /function renameMasterSurfacesToAdminFleet\(\)/);
      assert.match(masterSection, /document\.getElementById\('masterToggle'\)/);
      assert.match(masterSection, /node\.textContent\.replace\('Master', 'Admin Fleet'\)/);
      assert.match(masterSection, /panel\.setAttribute\('aria-label', 'Admin Fleet'\)/);
      assert.match(js, /addMasterRelaunchButton\('masterPanel'\);[\s\S]*renameMasterSurfacesToAdminFleet\(\);/);
    });

    it('the shared bar\'s own (newly un-pended) Wrap/Upload buttons are wired to this page\'s handlers via deps', () => {
      // #3137 — the look (the button, the file input) lives in the shared
      // `tcCreateMasterControlBar` component now (public/api-helper.js), same
      // "shared NOW" rule Kill/Launch already follow; this page supplies only
      // the behaviour, through `onWrap`/`onUpload`, same delegation shape
      // `onRetry` already has for Launch.
      assert.match(js, /onWrap: wrapAndRelaunchMaster,/);
      assert.match(js, /onUpload: uploadMasterAttachment/);
    });

    it('wrapAndRelaunchMaster POSTs /api/master/wrap behind a confirm, re-entrant-guarded', () => {
      const fn = masterSection.slice(
        masterSection.indexOf('function wrapAndRelaunchMaster'),
        masterSection.indexOf('async function fetchMasterAttachmentThumb')
      );
      assert.match(fn, /if \(state\.masterEnsuring\) return;/);
      assert.match(fn, /window\.confirm\(/);
      assert.match(fn, /api\('\/api\/master\/wrap', \{ method: 'POST' \}\)/);
      assert.match(fn, /api\.lastError \|\| 'Failed to wrap and relaunch Admin-PM'/);
      // Repaints the banner from fresh state after a successful wrap, rather
      // than assuming the critical reading cleared.
      assert.match(fn, /refreshMasterDot\(\);/);
    });

    it('the low-context banner reads continuity.status from the SAME /api/master/status fetch refreshMasterDot already makes — no new poll', () => {
      const fn = masterSection.slice(
        masterSection.indexOf('async function refreshMasterDot'),
        masterSection.length
      );
      assert.match(fn, /setMasterLowContextBanner\(status\.continuity \|\| null\);/);
      assert.ok(!/setInterval/.test(fn), 'no timer-driven polling added (no-UI-timers rule)');
      assert.match(masterSection, /const critical = Boolean\(continuity && continuity\.status === 'critical'\);/);
    });

    it('utility seats paint from status.adminFleet.utilitySeats; Admin-Advisor links to the real Advisor panel', () => {
      assert.match(masterSection, /function renderMasterUtilitySeats\(seats\)/);
      assert.match(masterSection, /if \(status\.adminFleet\) renderMasterUtilitySeats\(status\.adminFleet\.utilitySeats\);/);
      assert.match(masterSection, /if \(!state\.advisorOpen\) toggleAdvisor\(\);/);
    });

    it('attachments: uploadMasterAttachment base64-encodes the file and POSTs it', () => {
      // The file PICKER itself (#3137) is the shared bar's own un-pended
      // Upload button (`public/api-helper.js`); this page owns what happens
      // once a file is chosen, reached via `deps.onUpload`.
      const fn = masterSection.slice(
        masterSection.indexOf('async function uploadMasterAttachment'),
        masterSection.indexOf('function addMasterAttachmentStrip')
      );
      assert.match(fn, /apiMutate\('\/api\/master\/attachments', 'POST', \{/);
      assert.match(fn, /readAsDataURL\(file\)/);
    });

    it('paste and drag-and-drop on the panel both route through uploadMasterAttachment', () => {
      assert.match(masterSection, /panel\.addEventListener\('drop', /);
      assert.match(masterSection, /panel\.addEventListener\('paste', /);
      // #3218: any pasted file, not just an image — the all-file upload
      // support this car adds applies to paste too.
      assert.match(masterSection, /item\.kind === 'file'/);
      assert.doesNotMatch(masterSection, /item\.kind === 'file' && item\.type\.startsWith\('image\/'\)/,
        'the image-only restriction on paste must be gone');
    });

    // #3218 R-Gate R2 BLOCKING 1: the fallback listeners must be the ELSE of
    // the feature-detect, never installed alongside the real binder — both
    // live on the same `panel` element, so a single paste or drop would
    // otherwise fire both handlers and upload every file twice.
    it('binds the iframe-safe dropzone helper when another car provides it; the fallback listeners are its else, not unconditional (#3218)', () => {
      assert.match(masterSection, /typeof window\.tcBindMasterDropzone === 'function'/);
      assert.match(masterSection, /window\.tcBindMasterDropzone\(\{/);
      assert.match(masterSection, /doc: document, panelEl: panel, frameEl: document\.getElementById\('masterFrame'\)/);
      assert.match(masterSection, /prefix: 'masterPanel', onUpload: uploadMasterAttachment/);
      const fn = masterSection.slice(
        masterSection.indexOf('function addMasterAttachmentStrip'),
        masterSection.indexOf('function appendMasterChatTurn')
      );
      assert.match(fn, /\}\s*else\s*\{\s*\n\s*panel\.addEventListener\('dragover'/,
        'the fallback dragover/drop/paste listeners must be the else branch of the tcBindMasterDropzone feature-detect');
    });

    it('BLOCKING 1 behavioral: with the real tcBindMasterDropzone present, a drop (or paste) uploads each file exactly once', () => {
      const G = loadApiHelperGlobals();
      const { doc, ids } = makeDocument(['masterPanel', 'masterFrame', 'masterUtilitySeatsRow']);
      withStyleAndInsertBeforeStub(doc, ids);
      const panelHandlers = {};
      const realAdd = ids.masterPanel.addEventListener.bind(ids.masterPanel);
      ids.masterPanel.addEventListener = (type, fn) => {
        (panelHandlers[type] = panelHandlers[type] || []).push(fn);
        realAdd(type, fn);
      };
      const uploaded = [];
      const addMasterAttachmentStrip = new Function('document', 'window', 'uploadMasterAttachment', 'refreshMasterAttachments', `
        ${liftDeclaration(js, 'function addMasterAttachmentStrip(')}
        return addMasterAttachmentStrip;
      `)(doc, G, (f) => uploaded.push(f), () => {});
      addMasterAttachmentStrip();

      assert.ok(panelHandlers.drop && panelHandlers.drop.length >= 1, 'tcBindMasterDropzone must have registered its own drop listener on the panel');
      assert.equal(panelHandlers.drop.length, 1, 'ui.js must not ALSO register its own drop listener on the panel when the real binder is present');

      // Fire every registered 'drop' listener once, the same way a browser
      // fires every listener bound to the same element+type for one event.
      const dropEvt = { preventDefault() {}, dataTransfer: { files: [{ name: 'a.png' }] } };
      (panelHandlers.drop || []).forEach((fn) => fn(dropEvt));
      assert.equal(uploaded.length, 1, 'exactly one upload for one dropped file, never two');

      uploaded.length = 0;
      const pasteEvt = { clipboardData: { items: [{ kind: 'file', type: 'text/plain', getAsFile: () => ({ name: 'notes.txt' }) }] } };
      (panelHandlers.paste || []).forEach((fn) => fn(pasteEvt));
      assert.equal(uploaded.length, 1, 'exactly one upload for one pasted file, never two');
    });

    it('BLOCKING 1 behavioral: without the real tcBindMasterDropzone, the fallback listeners still upload exactly once per file', () => {
      const { doc, ids } = makeDocument(['masterPanel', 'masterFrame', 'masterUtilitySeatsRow']);
      withStyleAndInsertBeforeStub(doc, ids);
      const panelHandlers = {};
      const realAdd = ids.masterPanel.addEventListener.bind(ids.masterPanel);
      ids.masterPanel.addEventListener = (type, fn) => {
        (panelHandlers[type] = panelHandlers[type] || []).push(fn);
        realAdd(type, fn);
      };
      const uploaded = [];
      const addMasterAttachmentStrip = new Function('document', 'window', 'uploadMasterAttachment', 'refreshMasterAttachments', `
        ${liftDeclaration(js, 'function addMasterAttachmentStrip(')}
        return addMasterAttachmentStrip;
      `)(doc, {}, (f) => uploaded.push(f), () => {});
      addMasterAttachmentStrip();

      assert.equal(panelHandlers.drop.length, 1);
      const dropEvt = { preventDefault() {}, dataTransfer: { files: [{ name: 'a.png' }] } };
      (panelHandlers.drop || []).forEach((fn) => fn(dropEvt));
      assert.equal(uploaded.length, 1, 'the fallback itself must still work when no other car has loaded');
    });

    it('sanitizes the filename via the shared helper when present, falling back to an equivalent inline sanitizer (#3218)', () => {
      const fn = masterSection.slice(
        masterSection.indexOf('async function uploadMasterAttachment'),
        masterSection.indexOf('function addMasterAttachmentStrip')
      );
      assert.match(fn, /typeof window\.tcSanitizeMasterAttachmentFilename === 'function'/);
      assert.match(fn, /window\.tcSanitizeMasterAttachmentFilename\(rawName\)/);
      assert.match(fn, /_tcMasterFallbackSanitizeFilename\(rawName\)/);
      assert.match(fn, /apiMutate\('\/api\/master\/attachments', 'POST', \{ filename, content \}\)/);
    });

    // #3218 R-Gate R2 WARNING 1: the fallback must match
    // tcSanitizeMasterAttachmentFilename's edge cases, not just its
    // character class — lib/secure-clipboard.js's SAFE_FILENAME_RE
    // explicitly refuses a bare "." or "..", and a name over 128 chars.
    it('_tcMasterFallbackSanitizeFilename rejects dot-only names, empty stems and names over 128 chars (#3218)', () => {
      const fn = new Function(`
        ${liftDeclaration(js, 'function _tcMasterFallbackSanitizeFilename(')}
        return _tcMasterFallbackSanitizeFilename;
      `)();
      assert.equal(fn('.'), 'attachment');
      assert.equal(fn('..'), 'attachment');
      assert.equal(fn(''), 'attachment');
      assert.equal(fn('###'), '___', 'a disallowed character is replaced with _, never stripped to empty');
      assert.equal(fn('a'.repeat(200)), 'a'.repeat(128));
      assert.equal(fn('photo.png'), 'photo.png');
    });

    it('refreshMasterAttachments renders a non-image chip alongside a raster-image thumbnail (#3218)', () => {
      const fn = masterSection.slice(
        masterSection.indexOf('async function refreshMasterAttachments'),
        masterSection.indexOf('async function uploadMasterAttachment')
      );
      assert.match(fn, /isMasterAttachmentImage\(file\.filename\)/);
      assert.match(fn, /master-attachment-chip/);
      assert.match(fn, /master-attachment-name/);
    });

    // #3218 R-Gate R2 BLOCKING 2: must match lib/secure-clipboard.js's own
    // IMAGE_TYPES exactly — png/jpg/jpeg/webp/gif only, NOT bmp or svg,
    // which GET /api/master/attachments/:filename refuses with 415.
    it('isMasterAttachmentImage accepts exactly the extensions the preview route serves, case-insensitively (#3218)', () => {
      const isMasterAttachmentImage = new Function(`
        ${liftDeclaration(js, 'function isMasterAttachmentImage(')}
        return isMasterAttachmentImage;
      `)();
      for (const ext of ['png', 'PNG', 'jpg', 'JPEG', 'webp', 'gif']) {
        assert.equal(isMasterAttachmentImage(`photo.${ext}`), true, ext);
      }
      for (const name of ['photo.bmp', 'diagram.svg', 'notes.md', 'report.pdf', 'data.json']) {
        assert.equal(isMasterAttachmentImage(name), false, name);
      }
    });

    it('deleting a thumbnail uses apiMutate\'s (url, method) signature, not a fetch-options object', () => {
      assert.match(masterSection, /apiMutate\(`\/api\/master\/attachments\/\$\{encodeURIComponent\(file\.filename\)\}`, 'DELETE'\)/);
    });

    it('thumbnails are fetched as blob: URLs with operator-proof headers, never a bare <img src>', () => {
      assert.match(masterSection, /window\.tcOperatorProofHeaders\(api\)/);
      assert.match(masterSection, /window\.tcFetch\(`\/api\/master\/attachments\/\$\{encodeURIComponent\(filename\)\}`, \{ headers \}\)/);
      assert.match(masterSection, /URL\.createObjectURL\(await res\.blob\(\)\)/);
    });
  });

  describe('terminal parity with the session page', () => {
    it('delegates frame wiring to the shared pipeline (theme + #431 + #443 + #445)', () => {
      // Since UI-4C7R the pane carries no wiring of its own: api-helper.js's
      // tcWireTerminalFrame owns the readiness retry and applies the theme,
      // the ⌥+drag local-selection override, the touch-scroll shim, and
      // drag-copy — identically on every terminal surface.
      assert.match(masterSection, /window\.tcWireTerminalFrame\(window, frame,/);
      assert.ok(!/MASTER_XTERM_THEMES/.test(js),
        'the per-pane palette copy (UI-4C7R) must not return');
      assert.ok(!/function wireMasterTouchScroll\(/.test(masterSection),
        'the dead per-pane shim (#443) must not return');
    });

    it('passes the operator theme lazily so config loaded after attach still wins', () => {
      assert.match(masterSection, /\(\) => \(state\.config && state\.config\.theme\) \|\| 'dark'/);
    });
  });

  describe('status dot', () => {
    it('a one-shot load probe colors the dot from /api/master/status — no polling', () => {
      assert.match(masterSection, /api\('\/api\/master\/status'\)/);
      assert.ok(!/setInterval/.test(masterSection), 'no timer-driven polling in the master section (no-UI-timers rule)');
    });

    it('toggle + dot wiring is bound', () => {
      assert.match(js, /\$\('masterToggle'\)\.addEventListener\('click', toggleMaster\)/);
      assert.match(js, /refreshMasterDot\(\);/);
    });
  });

  describe('styling + service worker', () => {
    it('the panel uses the standard collapsible pattern and the dot has all three states', () => {
      assert.match(css, /\.master-panel\.open \{/);
      assert.match(css, /\.master-frame \{/);
      assert.match(css, /\.master-dot\.live \{/);
      assert.match(css, /\.master-dot\.pending \{/);
      assert.match(css, /\.master-dot\.down \{/);
    });
  });

  // #3218 Req 1 — Admin Fleet's own V6-style chat workspace (stream,
  // collapsible Under the Hood terminal, composer), mounted into
  // #masterPanel right after addMasterAttachmentStrip() the same way that
  // function and its siblings already inject plain DOM (no new file, no
  // style.css dependency beyond the real V6 classes those already provide).
  describe('Admin Fleet V6 chat workspace (#3218)', () => {
    it('addMasterChatWorkspace injects the stream, Under the Hood bar and composer', () => {
      assert.match(masterSection, /function addMasterChatWorkspace\(\)/);
      assert.match(masterSection, /workspace\.id = 'masterChatWorkspace'/);
      assert.match(masterSection, /id="masterChatStream"[^>]*role="log"[^>]*aria-label="Admin-PM Conversation Stream"/);
      assert.match(masterSection, /id="masterUnderHoodToggle"[^>]*aria-expanded="true"[^>]*aria-controls="masterFrame"/);
      assert.match(masterSection, /id="masterChatComposer"/);
      assert.match(masterSection, /id="masterChatInput"/);
      assert.match(masterSection, /id="masterChatAttachBtn"/);
      assert.match(masterSection, /id="masterChatSendBtn"/);
    });

    it('is mounted right after addMasterAttachmentStrip() in the init sequence', () => {
      assert.match(js, /addMasterAttachmentStrip\(\);\s*\n\s*addMasterChatWorkspace\(\);/);
    });

    it('the Under the Hood toggle hides/shows the already-attached #masterFrame, never re-pointing its src', () => {
      const fn = masterSection.slice(
        masterSection.indexOf('function addMasterChatWorkspace'),
        masterSection.indexOf('── Advisor (Morpheus) panel')
      );
      assert.match(fn, /frame\.classList\.toggle\('hidden', !next\)/);
      assert.doesNotMatch(fn, /frame\.src\s*=/, 'must not re-point #masterFrame — attachMasterFrame owns that');
    });

    it('sendMasterChatMessage appends the user turn and routes it to the terminal, not a new server route', () => {
      assert.match(masterSection, /async function sendMasterChatMessage\(\)/);
      assert.match(masterSection, /appendMasterChatTurn\('user', text\)/);
      assert.match(masterSection, /term\.paste\(`\$\{text\}\\r`\)/);
      assert.match(masterSection, /term\.input\(`\$\{text\}\\r`\)/);
    });

    it('Enter sends (without Shift); the attach button delegates to the shared bar\'s upload input', () => {
      assert.match(masterSection, /e\.key === 'Enter' && !e\.shiftKey/);
      assert.match(masterSection, /document\.getElementById\('masterPanelUploadInput'\)/);
    });

    // #3218 R-Gate R6 BLOCKING 1 — _partitionMasterTerminalDelta's own
    // check-order fix, exercised DIRECTLY with a 2-turn array. The live
    // app never actually calls it with more than one turn any more (the
    // serialized send queue guarantees _masterActiveTurns never exceeds
    // length 1 — see _dispatchNextQueuedMasterSend's own doc), but the
    // function is still a general-purpose utility whose own correctness
    // for a multi-turn input is worth pinning directly, independent of
    // whether today's only caller happens to exercise that branch.
    describe('_partitionMasterTerminalDelta — direct, multi-turn (#3218 R-Gate R6 BLOCKING 1)', () => {
      /** Built lazily (not at describe-registration time, before the outer before() hook has read `js`). */
      function partition(delta, turns) {
        return new Function(`
          ${liftDeclaration(js, 'function isMasterTerminalEchoLine(')}
          ${liftDeclaration(js, 'function _partitionMasterTerminalDelta(')}
          return _partitionMasterTerminalDelta;
        `)()(delta, turns);
      }

      it('two turns with DIFFERENT sentText partition correctly', () => {
        const turns = [{ sentText: 'first' }, { sentText: 'second' }];
        const buckets = partition(['first', 'first-reply', 'second', 'second-reply'], turns);
        assert.deepEqual(buckets, [['first-reply'], ['second-reply']]);
      });

      it('two turns with the SAME sentText still partition correctly — R5\'s bug checked the NEXT turn\'s echo before confirming the CURRENT turn\'s own echo was consumed', () => {
        const turns = [{ sentText: 'status' }, { sentText: 'status' }];
        const buckets = partition(['status', 'first-reply', 'status', 'second-reply'], turns);
        assert.deepEqual(buckets, [['first-reply'], ['second-reply']],
          'turn 1 must get its own reply and echo consumed BEFORE the identical "status" line is ever considered turn 2\'s echo');
      });

      // Documents a genuine, UNRESOLVED residual limitation at this
      // function's own level: a line identical to the NEXT turn's
      // sentText is indistinguishable from that turn's real echo once
      // the CURRENT turn's own echo has already been consumed — a raw
      // line buffer carries no sequence metadata telling "reply" apart
      // from "echo" beyond text equality. This is exactly why the live
      // app never actually calls this function with more than one turn
      // any more (R6 BLOCKING 1's OTHER half): the serialized send queue
      // (_dispatchNextQueuedMasterSend) never pastes a second turn's text
      // into the terminal until the first has fully retired, so this
      // ambiguity never arises in practice, even though fixing the check
      // ORDER alone cannot make it vanish at the function level.
      it('a turn\'s own reply line identical to the NEXT turn\'s sentText IS still mistaken for that turn\'s echo — a known, documented limit of this function alone', () => {
        const turns = [{ sentText: 'foo' }, { sentText: 'bar' }];
        const buckets = partition(['foo', 'bar', 'bar', 'bar-reply'], turns);
        assert.deepEqual(buckets, [[], ['bar', 'bar-reply']],
          'the ambiguity is real at this level; only the serialized send queue upstream prevents it from ever mattering');
      });
    });

    // #3218 R-Gate R2 BLOCKING 3: a behavioral run of the whole send/readback
    // path against a DOM harness + a fake xterm `term`, not a source regex —
    // the dispatch's own ask. `.v6-conversation-event.is-user`/`is-assistant`
    // are the REAL classes (public/style.css), not the `.v6-chat-turn--*`
    // ones an earlier dispatch guessed and this car already corrected in R2;
    // kept here rather than reintroduced.
    describe('sendMasterChatMessage + terminal readback, run for real (#3218)', () => {
      /** A minimal fake xterm.js Terminal: a mutable line buffer, paste()/input() recorders, and one onWriteParsed hook. */
      function makeFakeTerm(initialLines) {
        let lines = (initialLines || []).slice();
        const term = {
          pasted: [],
          paste(text) { term.pasted.push(text); },
          buffer: {
            active: {
              get length() { return lines.length; },
              getLine(i) {
                const text = lines[i];
                return text === undefined ? null : { translateToString: () => text };
              }
            }
          },
          setLines(next) { lines = next; },
          _hooks: [],
          onWriteParsed(fn) { term._hooks.push(fn); return { dispose() { term._hooks = term._hooks.filter((h) => h !== fn); } }; },
          fireWrite() { term._hooks.slice().forEach((fn) => fn()); }
        };
        return term;
      }

      function mountChatWorkspace(frameTerm) {
        const { doc, ids } = makeDocument(['masterPanel', 'masterFrame', 'masterUtilitySeatsRow', 'masterAttachmentStrip']);
        withStyleAndInsertBeforeStub(doc, ids);
        ids.masterFrame.contentWindow = frameTerm ? { term: frameTerm } : {};
        const sandbox = new Function('document', `
          ${liftDeclaration(js, 'function appendMasterChatTurn(')}
          ${liftDeclaration(js, 'function readMasterTerminalSnapshot(')}
          let _masterSendQueue = [];
          let _masterActiveTurns = [];
          let _masterActiveBaseline = [];
          let _masterActiveDispose = null;
          ${liftDeclaration(js, 'function _masterTerminalLineDelta(')}
          ${liftDeclaration(js, 'function isMasterTerminalEchoLine(')}
          ${liftDeclaration(js, 'function _partitionMasterTerminalDelta(')}
          ${liftDeclaration(js, 'function syncMasterAssistantTurnsFromTerminal(')}
          ${liftDeclaration(js, 'function _dispatchNextQueuedMasterSend(')}
          ${liftDeclaration(js, 'async function sendMasterChatMessage(')}
          ${liftDeclaration(js, 'function addMasterChatWorkspace(')}
          return { addMasterChatWorkspace, sendMasterChatMessage };
        `)(doc);
        sandbox.addMasterChatWorkspace();
        return { doc, ids, sandbox };
      }

      it('a) sends text + "\\r" to term.paste and renders a .is-user bubble', async () => {
        const term = makeFakeTerm([]);
        const { doc, sandbox } = mountChatWorkspace(term);
        doc.getElementById('masterChatInput').value = 'hello admin-pm';
        await sandbox.sendMasterChatMessage();
        assert.deepEqual(term.pasted, ['hello admin-pm\r']);
        const stream = doc.getElementById('masterChatStream');
        const userTurn = stream.childNodes.find((li) => li.classList.contains('is-user'));
        assert.ok(userTurn, 'a .v6-conversation-event.is-user bubble must be rendered');
        assert.equal(userTurn.querySelector('.v6-conversation-content').text, 'hello admin-pm');
      });

      it('b) a new line in term.buffer.active renders a .is-assistant bubble with the reply text', async () => {
        const term = makeFakeTerm(['$ ']);
        const { doc, sandbox } = mountChatWorkspace(term);
        doc.getElementById('masterChatInput').value = 'status?';
        await sandbox.sendMasterChatMessage();
        // The pty echoes the sent line, then the real reply arrives — fired
        // via the same onWriteParsed hook sendMasterChatMessage subscribed,
        // never a poll.
        term.setLines(['$ ', 'status?', 'All systems nominal.']);
        term.fireWrite();
        const stream = doc.getElementById('masterChatStream');
        const assistantTurns = stream.childNodes.filter((li) => li.classList.contains('is-assistant'));
        assert.equal(assistantTurns.length, 1, 'exactly one assistant bubble, not one per write event');
        assert.equal(assistantTurns[0].querySelector('.v6-conversation-content').text, 'All systems nominal.');
      });

      it('c) with no attached terminal, renders the delivery-failure notice instead', async () => {
        const { doc, sandbox } = mountChatWorkspace(null);
        doc.getElementById('masterChatInput').value = 'hello?';
        await sandbox.sendMasterChatMessage();
        const stream = doc.getElementById('masterChatStream');
        const assistantTurns = stream.childNodes.filter((li) => li.classList.contains('is-assistant'));
        assert.equal(assistantTurns.length, 1);
        assert.match(assistantTurns[0].querySelector('.v6-conversation-content').text, /Could not deliver/);
      });

      // #3218 R-Gate R4 BLOCKING 3 — a Set-based diff drops a genuinely new
      // reply line the moment an identical string had EVER appeared earlier
      // in scrollback. The multiset delta must not have that blind spot.
      it('d) a reply line identical to one already in scrollback is still rendered as new (multiset diff, not Set)', async () => {
        const term = makeFakeTerm(['OK', '$ ']);
        const { doc, sandbox } = mountChatWorkspace(term);
        doc.getElementById('masterChatInput').value = 'check';
        await sandbox.sendMasterChatMessage();
        term.setLines(['OK', '$ ', 'check', 'OK']);
        term.fireWrite();
        const stream = doc.getElementById('masterChatStream');
        const assistantTurns = stream.childNodes.filter((li) => li.classList.contains('is-assistant'));
        assert.equal(assistantTurns.length, 1);
        assert.equal(assistantTurns[0].querySelector('.v6-conversation-content').text, 'OK',
          'the new "OK" must render even though an older "OK" already sat in scrollback');
      });

      it('e) a prompt-prefixed echo of the sent text is stripped; a later line is not mistaken for one', async () => {
        const term = makeFakeTerm(['$ ']);
        const { doc, sandbox } = mountChatWorkspace(term);
        doc.getElementById('masterChatInput').value = 'status?';
        await sandbox.sendMasterChatMessage();
        term.setLines(['$ ', 'Admin-PM > status?', 'All systems green']);
        term.fireWrite();
        const stream = doc.getElementById('masterChatStream');
        const assistantTurns = stream.childNodes.filter((li) => li.classList.contains('is-assistant'));
        assert.equal(assistantTurns.length, 1);
        assert.equal(assistantTurns[0].querySelector('.v6-conversation-content').text, 'All systems green',
          'the echoed "Admin-PM > status?" prompt line must be stripped, leaving only the real reply');
      });

      it('f) rapid/overlapping sends finalize turn 1 into its own bubble and attribute turn 2 to a separate one', async () => {
        const term = makeFakeTerm(['$ ']);
        const { doc, sandbox } = mountChatWorkspace(term);
        const input = doc.getElementById('masterChatInput');

        input.value = 'first';
        await sandbox.sendMasterChatMessage();
        // turn 1's reply lands, and the real terminal's own write event
        // fires for it (#3218 R-Gate R6: a real terminal can't put bytes
        // into the buffer without ALSO firing the write event that notifies
        // this), before the operator sends a second message.
        term.setLines(['$ ', 'first', 'first-reply']);
        term.fireWrite();
        // A second, quiet write (no new lines) idle-settles turn 1,
        // retiring it and dispatching turn 2 to the terminal for real.
        term.fireWrite();

        input.value = 'second';
        await sandbox.sendMasterChatMessage();
        term.setLines(['$ ', 'first', 'first-reply', 'second', 'second-reply']);
        term.fireWrite();

        const stream = doc.getElementById('masterChatStream');
        const assistantTurns = stream.childNodes.filter((li) => li.classList.contains('is-assistant'));
        assert.equal(assistantTurns.length, 2, 'two separate assistant bubbles, one per send, never one shared bubble');
        assert.equal(assistantTurns[0].querySelector('.v6-conversation-content').text, 'first-reply');
        assert.equal(assistantTurns[1].querySelector('.v6-conversation-content').text, 'second-reply');
      });

      // #3218 R-Gate R6 BLOCKING 1 — the delayed-overlapping-sends repro,
      // updated for the serialized-queue model: a send made while another
      // is still in flight queues rather than pasting into the terminal
      // immediately, so there is never more than one turn's text actually
      // sitting in the terminal's own input stream unresolved at once.
      it('g) two sends before ANY output arrives still land in two separate bubbles, the second dispatched only once the first retires', async () => {
        const term = makeFakeTerm(['$ ']);
        const { doc, sandbox } = mountChatWorkspace(term);
        const input = doc.getElementById('masterChatInput');

        input.value = 'first';
        await sandbox.sendMasterChatMessage();
        // The operator sends a second message before ANY output has
        // arrived for the first — it queues rather than pasting immediately.
        input.value = 'second';
        await sandbox.sendMasterChatMessage();
        assert.deepEqual(term.pasted, ['first\r'], 'the second send has not reached the terminal yet');

        term.setLines(['$ ', 'first', 'first-reply']);
        term.fireWrite();
        term.fireWrite(); // idle settle: turn 1 retires, turn 2 is dispatched for real
        assert.deepEqual(term.pasted, ['first\r', 'second\r'], 'turn 2 only reaches the terminal once turn 1 retires');

        term.setLines(['$ ', 'first', 'first-reply', 'second', 'second-reply']);
        term.fireWrite();

        const stream = doc.getElementById('masterChatStream');
        const assistantTurns = stream.childNodes.filter((li) => li.classList.contains('is-assistant'));
        assert.equal(assistantTurns.length, 2, 'two separate assistant bubbles, neither echo leaked into either');
        assert.equal(assistantTurns[0].querySelector('.v6-conversation-content').text, 'first-reply');
        assert.equal(assistantTurns[1].querySelector('.v6-conversation-content').text, 'second-reply');
      });

      it('h) a third overlapping send is also correctly attributed, not just the first two', async () => {
        const term = makeFakeTerm(['$ ']);
        const { doc, sandbox } = mountChatWorkspace(term);
        const input = doc.getElementById('masterChatInput');

        input.value = 'one';
        await sandbox.sendMasterChatMessage();
        input.value = 'two';
        await sandbox.sendMasterChatMessage();
        input.value = 'three';
        await sandbox.sendMasterChatMessage();
        assert.deepEqual(term.pasted, ['one\r'], 'two and three are queued, not yet pasted');

        term.setLines(['$ ', 'one', 'one-reply']);
        term.fireWrite();
        term.fireWrite(); // retires "one", dispatches "two"
        assert.deepEqual(term.pasted, ['one\r', 'two\r']);

        term.setLines(['$ ', 'one', 'one-reply', 'two', 'two-reply']);
        term.fireWrite();
        term.fireWrite(); // retires "two", dispatches "three"
        assert.deepEqual(term.pasted, ['one\r', 'two\r', 'three\r']);

        term.setLines(['$ ', 'one', 'one-reply', 'two', 'two-reply', 'three', 'three-reply']);
        term.fireWrite();

        const stream = doc.getElementById('masterChatStream');
        const assistantTurns = stream.childNodes.filter((li) => li.classList.contains('is-assistant'));
        assert.equal(assistantTurns.length, 3);
        assert.equal(assistantTurns[0].querySelector('.v6-conversation-content').text, 'one-reply');
        assert.equal(assistantTurns[1].querySelector('.v6-conversation-content').text, 'two-reply');
        assert.equal(assistantTurns[2].querySelector('.v6-conversation-content').text, 'three-reply');
      });

      // #3218 R-Gate R6 BLOCKING 1 — the exact repro named in the dispatch:
      // two back-to-back IDENTICAL commands. R5's partition order checked
      // the NEXT turn's echo before confirming the CURRENT turn's own echo
      // had even been consumed, so the first "status" (turn 1's own echo)
      // was mistaken for turn 2's, skipping turn 1's echo consumption
      // entirely. Also exercises the serialized queue: turn 2's identical
      // "status" is never pasted until turn 1 retires, so there is no
      // actual overlap in the terminal stream for the fixed check order to
      // even need to resolve.
      it('i) two back-to-back IDENTICAL commands still produce two separate, correctly attributed bubbles', async () => {
        const term = makeFakeTerm(['$ ']);
        const { doc, sandbox } = mountChatWorkspace(term);
        const input = doc.getElementById('masterChatInput');

        input.value = 'status';
        await sandbox.sendMasterChatMessage();
        term.setLines(['$ ', 'status', 'first-reply']);
        term.fireWrite();
        term.fireWrite(); // idle settle: retires turn 1, dispatches turn 2

        input.value = 'status';
        await sandbox.sendMasterChatMessage();
        term.setLines(['$ ', 'status', 'first-reply', 'status', 'second-reply']);
        term.fireWrite();

        const stream = doc.getElementById('masterChatStream');
        const assistantTurns = stream.childNodes.filter((li) => li.classList.contains('is-assistant'));
        assert.equal(assistantTurns.length, 2);
        assert.equal(assistantTurns[0].querySelector('.v6-conversation-content').text, 'first-reply');
        assert.equal(assistantTurns[1].querySelector('.v6-conversation-content').text, 'second-reply');
      });

      // #3218 R-Gate R6 — the named architectural ambiguity: turn 1's own
      // reply text happens to read EXACTLY the same as turn 2's about-to-
      // be-sent command. A raw PTY stream genuinely cannot tell these
      // apart if both turns were ever live in it at once; the serialized
      // queue sidesteps the ambiguity by construction instead — turn 2's
      // "bar" is never pasted until turn 1 (whose own reply happens to
      // read "bar") has already retired, so there is only ever one turn's
      // text in the stream to interpret at any moment.
      it('j) turn 1\'s reply text equal to turn 2\'s command text is never cross-attributed', async () => {
        const term = makeFakeTerm(['$ ']);
        const { doc, sandbox } = mountChatWorkspace(term);
        const input = doc.getElementById('masterChatInput');

        input.value = 'foo';
        await sandbox.sendMasterChatMessage();
        term.setLines(['$ ', 'foo', 'bar']);
        term.fireWrite();
        term.fireWrite(); // idle settle: retires turn 1 before turn 2 is ever sent

        input.value = 'bar';
        await sandbox.sendMasterChatMessage();
        term.setLines(['$ ', 'foo', 'bar', 'bar', 'bar-reply']);
        term.fireWrite();

        const stream = doc.getElementById('masterChatStream');
        const assistantTurns = stream.childNodes.filter((li) => li.classList.contains('is-assistant'));
        assert.equal(assistantTurns.length, 2);
        assert.equal(assistantTurns[0].querySelector('.v6-conversation-content').text, 'bar',
          'turn 1\'s own reply, unaffected by turn 2\'s later identical command text');
        assert.equal(assistantTurns[1].querySelector('.v6-conversation-content').text, 'bar-reply');
      });

      // #3218 R-Gate R6 BLOCKING 2 — turn retirement, baseline advancement
      // and listener disposal: the shared listener must not keep listening
      // forever once the conversation goes idle with nothing queued, and a
      // LATER send must take a fresh baseline rather than reuse a stale one
      // left over from a retired turn (what actually bounds memory and
      // protects a later turn's delta from scrollback rollover corrupting
      // it, since a retired turn's lines are baked into history and never
      // recomputed again).
      it('k) a retired turn disposes the shared listener; a later send re-arms it with a FRESH baseline', async () => {
        const term = makeFakeTerm(['$ ']);
        const { doc, sandbox } = mountChatWorkspace(term);
        const input = doc.getElementById('masterChatInput');

        input.value = 'first';
        await sandbox.sendMasterChatMessage();
        assert.equal(term._hooks.length, 1, 'the first send arms the shared listener');
        term.setLines(['$ ', 'first', 'first-reply']);
        term.fireWrite();
        term.fireWrite(); // idle settle: turn 1 retires; queue is empty, so the listener disposes
        assert.equal(term._hooks.length, 0, 'the shared listener disposes once idle with nothing queued');

        // The buffer changes shape entirely while nothing is listening —
        // scrollback rollover, or simply time passing.
        term.setLines(['$ ']);

        input.value = 'second';
        await sandbox.sendMasterChatMessage();
        assert.equal(term._hooks.length, 1, 'a new send re-arms a fresh listener');
        term.setLines(['$ ', 'second', 'second-reply']);
        term.fireWrite();

        const stream = doc.getElementById('masterChatStream');
        const assistantTurns = stream.childNodes.filter((li) => li.classList.contains('is-assistant'));
        assert.equal(assistantTurns.length, 2);
        assert.equal(assistantTurns[0].querySelector('.v6-conversation-content').text, 'first-reply');
        assert.equal(assistantTurns[1].querySelector('.v6-conversation-content').text, 'second-reply',
          'the second turn\'s content came from the buffer AT SEND TIME, not a stale baseline left over from turn 1');
      });
    });
  });
});
