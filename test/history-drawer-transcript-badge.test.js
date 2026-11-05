'use strict';

/*
 * #2881 (#2074 Slice 3): public/history-drawer.js#openHistorySession now
 * calls public/session-history-ui.js#transcriptSourceBadge and includes its
 * result in the rendered detail. Source-level structural assertions, same
 * convention test/history-drawer-uploads.test.js already uses for this
 * exact file: openHistorySession builds DOM from an innerHTML template with
 * page-level globals (esc, api), so it is not cheaply liftable/runnable the
 * way the pure render functions in public/governed-wrap-ui.js are.
 */

const { describe, it, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

describe('history drawer -- transcript provenance badge (#2881)', () => {
  let drawerJs;
  let badgeJs;
  let serverJs;

  before(() => {
    drawerJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'history-drawer.js'), 'utf8');
    badgeJs = fs.readFileSync(path.join(__dirname, '..', 'public', 'session-history-ui.js'), 'utf8');
    serverJs = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  });

  it('guards the call the same way every other optional cross-file panel call in this codebase does', () => {
    const openFn = drawerJs.slice(drawerJs.indexOf('async function openHistorySession('));
    assert.match(openFn, /typeof transcriptSourceBadge === 'function'/,
      'a worker that has not yet learned session-history-ui.js must degrade to no badge, never a ReferenceError');
  });

  it('openHistorySession calls transcriptSourceBadge and renders its result into transcriptHtml', () => {
    const openFn = drawerJs.slice(drawerJs.indexOf('async function openHistorySession('));
    assert.match(openFn, /transcriptSourceBadge\(/, 'the drawer must call the shared badge renderer');
    // The call site is inside the `if (!t)`/`else` branch that builds
    // transcriptHtml, not some other, unrelated template string.
    const elseIdx = openFn.indexOf('} else {');
    const transcriptHtmlIdx = openFn.indexOf('transcriptHtml = `', elseIdx);
    const badgeCallIdx = openFn.indexOf('transcriptSourceBadge(');
    assert.ok(badgeCallIdx > elseIdx && badgeCallIdx < transcriptHtmlIdx,
      'transcriptSourceBadge must be called before building transcriptHtml, in the "transcript exists" branch');
    assert.match(openFn.slice(transcriptHtmlIdx), /\$\{sourceBadge\}|\$\{transcriptSourceBadge\(/,
      'the badge\'s own HTML must actually be interpolated into transcriptHtml, not just computed and discarded');
  });

  it('maps the server\'s own `harness` field name to the badge function\'s `engine` parameter', () => {
    // The producer side: server.js's _publicTranscriptMeta names it `harness`
    // (kept for backward compat with the pre-#2881 response shape).
    assert.match(serverJs, /harness:\s*result\.engine/, 'server.js must still name the field harness');
    // The consumer side (session-history-ui.js) reads `.engine`, never `.harness` --
    // derived from its own real source, not re-typed here.
    assert.match(badgeJs, /transcript\.engine\b/, 'transcriptSourceBadge must read .engine');
    assert.doesNotMatch(badgeJs, /transcript\.harness\b/, 'transcriptSourceBadge has no reason to read .harness directly');
    // So the drawer's own call site is where the rename must be bridged.
    const openFn = drawerJs.slice(drawerJs.indexOf('async function openHistorySession('));
    const call = openFn.match(/transcriptSourceBadge\(\{[^}]*\}\)/)[0];
    assert.match(call, /engine:\s*t\.harness\b/, 'the call site must map t.harness to the engine parameter');
  });

  it('transcriptSourceBadge is loaded on index.html before history-drawer.js, which calls it', () => {
    const indexHtml = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
    // The actual <script> TAGS, not a bare filename substring -- a comment
    // mentioning "history-drawer.js" earlier in the file (as this very
    // wiring's own comment does) would otherwise give a false match.
    const badgeScriptIdx = indexHtml.indexOf('<script src="/session-history-ui.js">');
    const drawerScriptIdx = indexHtml.indexOf('<script src="/history-drawer.js">');
    assert.ok(badgeScriptIdx !== -1 && drawerScriptIdx !== -1, 'both scripts must be loaded on index.html');
    assert.ok(badgeScriptIdx < drawerScriptIdx, 'session-history-ui.js must load before history-drawer.js');
  });
});
