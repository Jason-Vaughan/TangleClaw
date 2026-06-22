#!/usr/bin/env node
/**
 * CC-7 Slice B1 capture-back spike (DIAGNOSTIC — safe to delete after the run).
 *
 * The B1 blocker: we don't know what the ClawBridge `/v2/session/output` stream
 * preserves for a remote OpenClaw (Claude Code TUI) turn. Specifically:
 *   1. Does a `## Heading` survive, or does the PTY render `##` away (#287)?
 *   2. Does a `<<TC:nextAction>>…<<END>>` sentinel block survive verbatim?
 * Whichever survives decides the render-surviving parser for tier-1/2 capture.
 *
 * This script resolves the bridge port/token from TC's own store (same path B1
 * will use), confirms a live session, sends a prompt that asks the AI to echo
 * four distinct markers, long-polls the output stream, and dumps every raw event
 * to a JSON file plus a human-readable survival verdict.
 *
 * Usage (run on the TC host, where the bridge tunnel is on localhost):
 *   node scripts/cc7-capture-spike.js --project <bridgeProjectName> --start   # self-contained
 *   node scripts/cc7-capture-spike.js --project <bridgeProjectName> [--conn <connId>]
 *   node scripts/cc7-capture-spike.js --list        # show bridge connections, then exit
 *
 * --start  : own the full session lifecycle (start → auto-approve the trust
 *            prompt → run → end). Without it, expects a session already live
 *            (started in the UI) for <project>.
 * Prereq   : the bridge tunnel must be up on localhost (TC opens it when the
 *            connection is active; RESULT 2026-06-20 confirmed ## headings and
 *            <<…>> sentinels are mangled in the response — use plain tokens).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const store = require('../lib/store');
const clawbridge = require('../lib/clawbridge');

// Distinct, greppable markers the AI is asked to echo verbatim.
const MARKERS = {
  heading: '## TC_SPIKE_HEADING_7F3A',
  sentinel: '<<TC:nextAction>>ship-slice-c<<END>>',
  plain: 'TC_SPIKE_PLAIN_7F3A',
  bold: '**TC_SPIKE_BOLD_7F3A**'
};

const SPIKE_PROMPT = [
  'Automated capture test — reply with EXACTLY these four lines, verbatim, each on',
  'its own line, and nothing else before, after, or between them:',
  MARKERS.heading,
  MARKERS.sentinel,
  MARKERS.plain,
  MARKERS.bold
].join('\n');

/**
 * Parse `--flag value` / `--flag` argv into a plain object.
 * @returns {{project?: string, conn?: string, list?: boolean, start?: boolean}}
 */
function parseArgs() {
  const out = {};
  const a = process.argv.slice(2);
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '--list') out.list = true;
    else if (a[i] === '--start') out.start = true;
    else if (a[i] === '--project') out.project = a[++i];
    else if (a[i] === '--conn') out.conn = a[++i];
  }
  return out;
}

/**
 * Strip ANSI / VT control sequences so marker checks see plain text. The bridge
 * relays the raw rendered PTY (escape codes, cursor moves, OSC title sets), so
 * un-stripped concatenation is unreadable and hides what actually rendered.
 * @param {string} s
 * @returns {string}
 */
function stripAnsi(s) {
  return String(s)
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '') // CSI sequences
    .replace(/\x1b[\]P^_][^\x07\x1b]*(?:\x07|\x1b\\)?/g, '') // OSC/DCS/PM/APC
    .replace(/\x1b[@-Z\\-_]/g, '') // single-char escapes
    .replace(/\r/g, '');
}

/**
 * Isolate Claude Code's *response* region from the captured stream, dropping the
 * input echo. The spike prompt itself contains the markers verbatim, so checking
 * the whole stream measures the echo, not what the render preserved (the bug that
 * produced the false "all SURVIVED verbatim" verdict on 2026-06-20). Claude Code
 * prints a `⏺` bullet before each assistant text block — anchor on the LAST one.
 * @param {string} strippedFullText - ANSI-stripped concatenation of all events
 * @returns {{response: string, anchored: boolean}}
 */
function isolateResponse(strippedFullText) {
  const bullet = '⏺'; // ⏺ Claude Code assistant-output marker
  const idx = strippedFullText.lastIndexOf(bullet);
  if (idx === -1) return { response: strippedFullText, anchored: false };
  return { response: strippedFullText.slice(idx), anchored: true };
}

/**
 * Concatenate the text-bearing fields of an event into one string for marker
 * grepping. Bridge event shapes vary, so we scan common text fields defensively.
 * @param {object} ev - One event from getOutput().events
 * @returns {string}
 */
function eventText(ev) {
  if (!ev || typeof ev !== 'object') return '';
  const parts = [];
  for (const k of ['text', 'content', 'data', 'message', 'value', 'delta']) {
    const v = ev[k];
    if (typeof v === 'string') parts.push(v);
  }
  return parts.join('');
}

/**
 * List bridge-capable OpenClaw connections (those with a bridgePort).
 * @returns {Array<object>}
 */
function bridgeConnections() {
  return store.openclawConnections.list().filter((c) => c.bridgePort);
}

/**
 * Resolve the connection to spike against from args (or the sole bridge conn).
 * @param {{conn?: string}} args
 * @returns {object|null}
 */
function resolveConn(args) {
  const conns = bridgeConnections();
  if (args.conn) return conns.find((c) => String(c.id) === String(args.conn)) || null;
  if (conns.length === 1) return conns[0];
  return null;
}

/**
 * Sleep helper for the poll loop.
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Run the spike. */
async function main() {
  const args = parseArgs();
  store.init();

  const conns = bridgeConnections();
  if (args.list || (!args.project)) {
    if (!conns.length) {
      console.log('No OpenClaw connections with a bridgePort are configured.');
    } else {
      console.log('Bridge-capable OpenClaw connections:');
      for (const c of conns) {
        console.log(`  conn id=${c.id}  name=${c.name || '(unnamed)'}  bridgePort=${c.bridgePort}  token=${c.bridgeToken ? 'set' : 'none'}`);
      }
    }
    console.log('\nRun: node scripts/cc7-capture-spike.js --project <bridgeProjectName> [--conn <id>]');
    console.log('(--project is the project name as the BRIDGE knows it — the one with a live session)');
    process.exit(args.project ? 0 : 1);
  }

  const conn = resolveConn(args);
  if (!conn) {
    console.error(conns.length > 1
      ? 'Multiple bridge connections — specify --conn <id> (see --list).'
      : 'No matching bridge connection (see --list).');
    process.exit(1);
  }

  // `permissionMode` is intentionally omitted: a bare echo turn needs no tools, so
  // letting Claude use its own default keeps the bridge's permission parser out of
  // the loop. The only prompt that appears is the one-time "trust this folder?",
  // which the auto-approve poll below clears via /v2/session/respond.
  const base = { localPort: conn.bridgePort, token: conn.bridgeToken, project: args.project };
  console.log(`Spiking conn id=${conn.id} (${conn.name || 'unnamed'}) localPort=${conn.bridgePort} project=${args.project}\n`);

  // 1. Ensure a live, writable session and grab the starting cursor.
  //    With --start the spike owns the whole lifecycle (start → auto-approve the
  //    "trust this folder?" prompt → wait for input-ready → … → end). Without it,
  //    it expects a session already started in the UI.
  let startedByUs = false;
  if (args.start) {
    const r = await clawbridge.startSession({ ...base, timeoutMs: 25000 });
    if (!r.ok) {
      console.error(`startSession failed (status=${r.status}): ${r.error}`);
      process.exit(1);
    }
    startedByUs = !r.attached;
    console.log(`startSession ok (sessionId=${r.sessionId}, attached=${r.attached})`);
  }

  let status = await clawbridge.getStatus(base);
  if (!status.ok) {
    console.error(`getStatus failed (status=${status.status}): ${status.error}`);
    console.error('Is the bridge tunnel up on localhost? Is --project the bridge project name?');
    process.exit(1);
  }

  // Boot can park at `waiting_for_permission` on Claude Code's trust prompt.
  // Auto-approve it (B1's automated flow needs this) and wait for input-ready.
  for (let i = 0; i < 12 && status.ok && status.state !== 'failed' && status.state !== 'ended'; i++) {
    if (status.state === 'waiting_for_permission' && status.pendingPermissionId) {
      console.log(`  approving pending permission ${status.pendingPermissionId} (likely the trust prompt)…`);
      await clawbridge._requestJson({
        localPort: base.localPort, token: base.token, method: 'POST', path: '/v2/session/respond',
        body: { project: base.project, permissionId: status.pendingPermissionId, decision: 'approve_once' },
        timeoutMs: 10000
      });
    } else if (status.active && status.inputReady) {
      break;
    }
    await sleep(2500);
    status = await clawbridge.getStatus(base);
  }

  if (!status.active) {
    console.error(`No live session for project "${args.project}" (status.active=false).`);
    console.error(args.start ? 'Session failed to reach a live state.' : 'Start a session (or pass --start), then re-run.');
    process.exit(1);
  }
  let startCursor = typeof status.cursor === 'number' ? status.cursor : 0;
  console.log(`Live session: state=${status.state} inputReady=${status.inputReady} cursor=${startCursor} sessionId=${status.sessionId}`);

  // 1b. Drain boot chrome until the TUI is QUIET before sending. On a fresh start,
  //     `inputReady` flips true while Claude Code is still rendering its banner /
  //     async auto-update check; a prompt sent then lands mid-boot and is never
  //     processed (no `⏺` response — the 2026-06-20 --start flake). Wait for two
  //     consecutive empty polls, then send from the settled cursor.
  let quiet = 0;
  const settleDeadline = Date.now() + 45_000;
  while (quiet < 2 && Date.now() < settleDeadline) {
    const o = await clawbridge.getOutput({ ...base, cursor: startCursor, waitMs: 3000, maxEvents: 200 });
    if (!o.ok) break;
    if (typeof o.cursorEnd === 'number') startCursor = o.cursorEnd;
    quiet = o.events.length === 0 ? quiet + 1 : 0;
  }
  console.log(`TUI settled at cursor=${startCursor}; sending prompt…\n`);

  // 2. Send the marker-echo prompt.
  const sent = await clawbridge.send({ ...base, message: SPIKE_PROMPT });
  if (!sent.ok || !sent.accepted) {
    console.error(`send failed (status=${sent.status}, accepted=${sent.accepted}): ${sent.error}`);
    process.exit(1);
  }
  console.log(`Sent spike prompt (accepted=${sent.accepted}, state=${sent.state}). Polling output…\n`);

  // 3. Long-poll the output stream until Claude's RESPONSE arrives and drains.
  //    The stop condition must NOT key on seeing a marker — every marker shows up
  //    in the prompt echo almost immediately, so that exits before the AI replies
  //    (the 2026-06-20 flake: 14 events, no response captured). Anchor on the `⏺`
  //    assistant bullet (response started), then stop on the first empty poll.
  const collected = [];
  let cursor = typeof sent.cursor === 'number' ? sent.cursor : startCursor;
  const deadline = Date.now() + 90_000;
  let lastState = sent.state;
  let pending = null;
  let sawResponse = false;

  while (Date.now() < deadline) {
    const out = await clawbridge.getOutput({ ...base, cursor, waitMs: 5000, maxEvents: 200 });
    if (!out.ok) {
      console.error(`getOutput failed (status=${out.status}): ${out.error}`);
      break;
    }
    for (const ev of out.events) collected.push(ev);
    if (typeof out.cursorEnd === 'number') cursor = out.cursorEnd;
    lastState = out.state || lastState;

    // A permission can re-appear mid-turn (the spike echoes text only, but stay
    // robust). Auto-approve and keep going rather than bailing.
    if (out.pendingPermission && out.pendingPermission.id) {
      pending = out.pendingPermission;
      await clawbridge._requestJson({
        localPort: base.localPort, token: base.token, method: 'POST', path: '/v2/session/respond',
        body: { project: base.project, permissionId: out.pendingPermission.id, decision: 'approve_once' },
        timeoutMs: 10000
      });
      continue;
    }

    // `⏺` (assistant bullet) marks the start of Claude's response, distinct from
    // the `❯` prompt echo. Only after we've seen it do empty polls mean "drained".
    if (stripAnsi(collected.map(eventText).join('')).includes('⏺')) sawResponse = true;
    if (sawResponse && out.events.length === 0) break;
  }
  if (!sawResponse) {
    console.log('⚠ No assistant response (`⏺`) captured before the deadline — verdict may be unreliable.');
  }

  // 4. Dump raw events + verdict. Written to the OS temp dir (NOT the repo) —
  // the raw events can carry session/AI content and the bridge token is sensitive
  // (rotation outstanding per project memory), so it must never land in a git tree.
  const outFile = path.join(os.tmpdir(), `cc7-spike-output-${conn.id}.json`);
  fs.writeFileSync(outFile, JSON.stringify({
    project: args.project, connId: conn.id, lastState, pending,
    startCursor, endCursor: cursor, eventCount: collected.length, events: collected
  }, null, 2));

  // Tally by bridge event KIND (events use `kind`, not `type` — the old `type`
  // read produced a useless `{undefined: N}` tally).
  console.log('── Event kind tally ──');
  const tally = {};
  for (const ev of collected) tally[ev && ev.kind] = (tally[ev && ev.kind] || 0) + 1;
  console.log(tally);

  // THE FIX: survival must be measured against Claude's *response*, not the whole
  // stream. The prompt echo (`❯ …`) contains every marker verbatim, so checking
  // all text falsely reports "SURVIVED" for markers the render actually mangled.
  // Strip ANSI, then isolate the response region (anchored on the `⏺` bullet).
  const strippedFull = stripAnsi(collected.map(eventText).join('\n'));
  const { response, anchored } = isolateResponse(strippedFull);
  if (!anchored) {
    console.log('\n⚠ Could not anchor the response region (no `⏺` bullet found) — verdict falls');
    console.log('  back to the full stream and MAY be contaminated by the input echo. Inspect the raw file.');
  }

  // Compare exact token (incl. markdown chars) vs the bare alphanumeric core, so a
  // stripped-but-present marker reads as "text survived, markup eaten" not "gone".
  const verdict = (label, exact, bare) => {
    const exactOk = response.includes(exact);
    const bareOk = response.includes(bare);
    const v = exactOk ? 'SURVIVED verbatim' : bareOk ? `MANGLED (bare text present, markup eaten)` : 'NOT found';
    console.log(`  ${label.padEnd(16)}: ${v}`);
  };
  console.log('\n── Marker survival in Claude\'s RESPONSE (ANSI-stripped, echo excluded) ──');
  verdict('## heading', MARKERS.heading, 'TC_SPIKE_HEADING_7F3A');
  verdict('<<TC:…>> sentinel', MARKERS.sentinel, 'ship-slice-c');
  verdict('plain marker', MARKERS.plain, MARKERS.plain);
  verdict('**bold** marker', MARKERS.bold, 'TC_SPIKE_BOLD_7F3A');
  console.log('\n  Render-safe contract = use ONLY chars that read "SURVIVED verbatim" above');
  console.log('  (letters/digits/underscore/colon/space). Avoid #, *, and doubled <<>>.');

  console.log(`\nRaw events written to: ${outFile}`);
  console.log('Paste that file (or the marker-survival block above) back into the session to decide the B1 parser.');

  // Clean up the session if --start created it (leave UI-started sessions alone).
  if (startedByUs) {
    await clawbridge._requestJson({
      localPort: base.localPort, token: base.token, method: 'POST', path: '/v2/session/end',
      body: { project: base.project }, timeoutMs: 15000
    });
    console.log('\nEnded the spike-owned session.');
  }
}

main().catch((err) => { console.error('Spike crashed:', err); process.exit(1); });
