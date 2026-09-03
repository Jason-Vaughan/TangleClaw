'use strict';
/* ── TangleClaw v3 — Landing Page: Core & Data ── */
/* State management, API helpers, data loading, project actions. */
/* Loaded before ui.js which handles rendering and interactions. */

// ── State ──

const state = {
  projects: [],
  // Whether the projects list is the WHOLE list, and why not when it isn't.
  // `GET /api/projects` always carries this; null only before the first load.
  // Without it a directory that could not be read shows up as a shorter list
  // and nothing else, which states a completeness the server never claimed.
  projectsScan: null,
  engines: [],
  config: null,
  filterText: '',
  activeTag: null,
  showUnregistered: false,
  activeEngine: null,
  allTags: [],
  connected: true,
  statsOpen: true,
  ports: [],
  portsOpen: false,
  portGroupsOpen: {},
  rulesOpen: false,
  globalRulesContent: '',
  modelStatus: {},
  awareness: {},
  groups: [],
  groupsOpen: false,
  groupItemsOpen: {},
  openclawConnections: [],
  openclawOpen: false,
  openclawItemsOpen: {},
  openclawTunnelStatus: {},
  auditOpen: false,
  auditSummaries: {},
  auditLoaded: false,
  orphanHooks: null,
  orphanHooksRepairInFlight: false,
  // #235 — cached restart-mechanism token from /api/server-info. `null`
  // means no mechanism available on this host (button hidden);
  // `'launchctl'` enables the macOS path. Read by both the stale-server
  // banner and the global settings modal Diagnostics section.
  restartMechanism: null,
  restartInFlight: false,
  // The `startedAt` of the process this page has been talking to. A change means
  // the server restarted without this page driving it (a CLI update, launchctl,
  // a launchd respawn), so anything cached from the old process is now suspect.
  serverStartedAt: null
};

// ── API Helpers ──
// Bound from the shared factory in /api-helper.js (loaded before this file).
// `setConnected` is a function declaration below and is hoisted, so the
// factory captures the live reference. See PR for #82 for rationale.

const api = window.tcCreateApi({ setConnected });
const apiMutate = window.tcCreateApiMutate(api);

// The one restart implementation this page has. Both the #235 stale-server
// restart and the beacon's apply-and-restart drive it, and both share
// `state.restartInFlight` so neither can fire while the other is running.
const restartFlow = window.tcCreateRestartFlow({ api, apiMutate, win: window });

// The update beacon (#931) — the single surface that announces an available
// update, identical here and on the session page.
const updateBeacon = window.tcCreateUpdateBeacon({
  doc: document,
  anchorId: 'updateBeacon',
  api,
  apiMutate,
  restart: restartFlow,
  getInFlight: () => state.restartInFlight,
  setInFlight: (v) => { state.restartInFlight = v; }
});

// ── Connection State ──

// The service worker serves the app shell from cache with the server
// completely dead, so this page can render healthy-looking while nothing
// behind it answers. The toast alone claimed "Retrying…" identically after
// one failure and after two hundred; past the policy's ceiling the claim of a
// transient blip becomes dishonest and the real unreachable state takes over.
// Retrying continues underneath it — recovery stays automatic — the ceiling
// only changes what the operator is TOLD.
//
// The ceiling and the retry cadence live in the shared policy so this page and
// the session page cannot drift apart about when a server counts as gone; the
// page supplies only how to probe and what to render.
const reconnectPolicy = tcCreateReconnectPolicy({
  probe: () => loadProjects(),
  onEscalate: () => renderUnreachableState(),
  onRecover: () => hideUnreachableState()
});

/**
 * Replace the ambiguous retry toast with a state that says what is actually
 * known: the server at this page's own origin has stopped answering, this
 * page may be a cached shell, and here is where to look on the host machine.
 * The overlay is created on first need — a healthy install never carries it.
 *
 * Explicitly NOT a reload or redirect: the no-UI-timers norm (#98, #268)
 * applies, so the only navigation out of this state is the operator's.
 */
function renderUnreachableState() {
  const toast = document.getElementById('toast');
  if (toast) toast.classList.remove('visible');
  let el = document.getElementById('unreachableState');
  if (!el) {
    el = document.createElement('div');
    el.id = 'unreachableState';
    el.className = 'unreachable-state';
    el.setAttribute('role', 'alert');
    el.innerHTML = `
      <div class="unreachable-card">
        <h2>TangleClaw isn't responding</h2>
        <p>The server at <strong>${esc(location.origin)}</strong> has stopped answering.
        This page may have loaded from the browser's offline cache, so what it shows can be
        stale. It will reconnect by itself the moment the server is back.</p>
        <p>On the machine that runs TangleClaw, check whether the service is up and what it
        last logged:</p>
        <pre>launchctl list | grep tangleclaw
tail -50 ~/.tangleclaw/logs/server.err.log</pre>
        <button id="unreachableRetryBtn" class="btn btn-primary" onclick="retryConnectionNow()">Retry now</button>
      </div>`;
    document.body.appendChild(el);
  }
  el.classList.add('visible');
}

/** Dismiss the unreachable state (the server answered again). */
function hideUnreachableState() {
  const el = document.getElementById('unreachableState');
  if (el) el.classList.remove('visible');
}

/**
 * The explicit retry the unreachable state offers. The background loop keeps
 * running regardless; this exists so the operator has an action that answers
 * NOW, not in up to five seconds.
 *
 * The button shows the attempt in flight (operator feedback, 2026-08-14 live
 * smoke: the pause between press and answer read as a dead button). On
 * recovery the whole card dismisses, so the reset in `finally` matters only
 * when the server is still gone and the card stays up for another press.
 * @returns {Promise<void>}
 */
async function retryConnectionNow() {
  const btn = document.getElementById('unreachableRetryBtn');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Retrying…';
  }
  try {
    await reconnectPolicy.retryNow();
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Retry now';
    }
  }
}

function setConnected(connected) {
  if (state.connected === connected) return;
  state.connected = connected;
  const toast = document.getElementById('toast');
  if (!connected) {
    toast.textContent = 'Connection lost. Retrying\u2026';
    toast.className = 'toast toast-warn visible';
    reconnectPolicy.begin();
  } else {
    // `end()` dismisses the unreachable state through `onRecover`.
    reconnectPolicy.end();
    toast.textContent = 'Reconnected';
    toast.className = 'toast toast-ok visible';
    setTimeout(() => { toast.classList.remove('visible'); }, 3000);
  }
}

// ── Data Loading ──

async function loadVersion() {
  const data = await api('/api/version');
  if (data) {
    document.getElementById('version').textContent = `v${data.version}`;
  }
}

/**
 * Fetch server-info, cache the restart mechanism (#235), and render the
 * stale-server banner (#199) when the running process's startup SHA
 * differs from the current on-disk HEAD — or the cannot-determine variant
 * (#1118) when the server reports `isStale: null`. No-op on the no-git
 * fallback (`isStale: false` with null SHAs) or when the endpoint isn't
 * available (older server without the route).
 *
 * `restartMechanism` is cached on `state` even when the banner doesn't
 * fire — the global settings modal Diagnostics section reads it
 * independently. Older servers without #235 return undefined here,
 * which falls through to `null` and hides the button cleanly.
 */
async function loadServerInfo() {
  const data = await api('/api/server-info');
  if (!data) return;
  state.restartMechanism = (typeof data.restartMechanism === 'string' && data.restartMechanism.length > 0)
    ? data.restartMechanism
    : null;
  // AUTH-3: show "Logged in as <user>" when behind the Caddy login gate.
  // `currentUser` is null unless the gate is live (the server-side trust gate
  // never honors a direct-mode header), so this is hidden in direct mode.
  renderAuthUser(data.currentUser);
  // AUTH-2K9D: warn when auth is configured but not actually enforcing.
  renderAuthStatus(data.authStatus);
  renderBindNotice(data.bindNotice);
  renderBindNotice(data.ttydNotice, 'ttydNotice');

  // The version label is written on every tick, not only when something looks
  // wrong. It was previously set once at page load, so a restart this page did
  // not drive — a terminal `apply-update.js`, `launchctl kickstart`, a launchd
  // respawn — left the header naming a version the server had stopped running,
  // with no signal that would ever correct it.
  renderRunningVersion(data.runningVersion);

  // A new `startedAt` means a different process is answering. The update beacon
  // is derived from the old one and can now be advertising an update that has
  // already been applied, so re-ask instead of leaving it up.
  if (data.startedAt) {
    const restarted = state.serverStartedAt && data.startedAt !== state.serverStartedAt;
    state.serverStartedAt = data.startedAt;
    if (restarted) await loadUpdateStatus();
  }

  // Hiding is as load-bearing as showing. The banner had no hide path at all,
  // so a page open across the restart that resolved the staleness kept telling
  // the operator to restart a server that had already come back.
  //
  // `isStale` is three-state (#1118): `null` means the server cannot tell —
  // a git probe failed where it should have worked. That is NOT all-clear
  // (the bare-falsy check here is how an undetectable server read as
  // healthy), so it gets its own banner instead of the hide path.
  if (data.isStale === null) {
    renderStaleUnknownBanner(data);
    return;
  }
  if (!data.isStale) {
    hideStaleServerBanner();
    return;
  }
  renderStaleServerBanner(data);
}

/**
 * Write the running server's version into the header label.
 *
 * Takes the version the server reports for the process that is answering, not
 * the one on disk — during the window between a self-update's checkout and the
 * restart that loads it those differ, and the header claiming the new one is
 * how an operator concludes an update landed when it has not.
 *
 * A missing value leaves the existing label alone rather than blanking it: an
 * older server that predates the field should read as "unchanged", not as
 * "version unknown".
 *
 * @param {string|null|undefined} version - `runningVersion` from /api/server-info
 * @returns {void}
 */
function renderRunningVersion(version) {
  if (typeof version !== 'string' || !version) return;
  _lastRenderedVersion = version;
  const el = document.getElementById('version');
  if (!el || _versionLabelHeld) return; // a check result is occupying the label
  // Only write on a real change. This runs on every 60s poll and the label sits
  // next to a live region; a no-op rewrite is pointless DOM churn at best, and
  // assistive tech that re-reads on mutation would narrate the version forever.
  const next = `v${version}`;
  if (el.textContent !== next) el.textContent = next;
}

// The newest version the server has reported, so a transient check result can
// restore the label without re-fetching.
let _lastRenderedVersion = null;

// True while a manual check's outcome is occupying the version label.
let _versionLabelHeld = false;

// Handle for the pending restore, so back-to-back taps don't stack restores.
let _versionLabelRestore = null;

// How long a manual check's outcome stays in the label before it reverts to the
// version. Purely a text swap — the authoritative result also lands in the
// element's `title`, which persists, so nothing is lost when this fires. (The
// no-timer-driven-lifecycle rule from #98/#268 governs dismiss / redirect /
// close actions; restoring a label is none of those.)
const VERSION_RESULT_HOLD_MS = 4000;

/**
 * Put text in the version label and hold it there briefly, then restore the
 * version. Used for the in-flight and result states of a manual check.
 * @param {string} text - What to show
 * @param {boolean} hold - Whether to schedule a restore (false for "checking…",
 *   which ends when the request resolves rather than on a clock)
 * @returns {void}
 */
function _showVersionLabel(text, hold) {
  const el = document.getElementById('version');
  if (!el) return;
  if (_versionLabelRestore) {
    clearTimeout(_versionLabelRestore);
    _versionLabelRestore = null;
  }
  _versionLabelHeld = true;
  el.textContent = text;
  // Announce from a dedicated live region rather than the button itself: the
  // button's text is its accessible name, so a live button would re-announce on
  // every version poll and double-announce when activated.
  const live = document.getElementById('versionCheckLive');
  if (live) live.textContent = text;
  if (!hold) return;
  _versionLabelRestore = setTimeout(() => {
    _versionLabelRestore = null;
    _versionLabelHeld = false;
    if (_lastRenderedVersion) el.textContent = `v${_lastRenderedVersion}`;
    // Clear rather than restate: the restore is housekeeping, not news, and
    // narrating the version again 4s after the result is noise.
    if (live) live.textContent = '';
  }, VERSION_RESULT_HOLD_MS);
}

/**
 * Render a compact "how long ago" for an ISO timestamp.
 * @param {string} iso - ISO-8601 instant
 * @returns {string} e.g. "just now", "3m ago", "2h ago"
 */
function _agoLabel(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  return `${Math.floor(mins / 60)}h ago`;
}

/**
 * Keep the version control's tooltip describing the real state of update
 * checking. This is what makes "no pill" falsifiable: the label alone cannot
 * distinguish "checked, you are current" from "never checked" from "the check
 * failed", and those are three different facts an operator acts on differently.
 *
 * @param {object|null} data - An update-status payload, or null if the request failed
 * @returns {void}
 */
function renderVersionCheckHint(data) {
  const el = document.getElementById('version');
  if (!el) return;
  // `unknown` = never measured, `failed` = measured and could not answer. Both
  // must be VISIBLE, not tooltip-only: `title` and `:hover` do not exist on a
  // touch device, and this dashboard is read mostly from a phone, so a
  // tooltip-only signal renders both states identically to "you are current" —
  // exactly the indistinguishability this work exists to remove.
  //
  // The state comes from the one shared ladder (`tcUpdateAnswerState`), so this
  // tooltip, the click label beside it and the beacon cannot disagree about
  // what a payload means (#1061).
  const { state, cached } = window.tcUpdateAnswerState(data);
  const ago = data && data.checkedAt ? _agoLabel(data.checkedAt) : null;
  const restartRemedy = 'the running server predates re-checking; restart it to check now';
  let hint;
  let mark = null;
  if (state === 'unreachable') {
    hint = "Couldn't reach the server to check for updates — tap to retry";
    mark = 'check-failed';
  } else if (state === 'never-checked') {
    hint = cached ? `Not checked for updates yet — ${restartRemedy}` : 'Not checked for updates yet — tap to check now';
    mark = 'check-unknown';
  } else if (state === 'check-failed') {
    hint = `Update check failed ${ago} — tap to retry`;
    mark = 'check-failed';
  } else if (state === 'cached-unverified') {
    hint = `Cached answer from ${ago} — ${restartRemedy}`;
    mark = 'check-unknown';
  } else if (state === 'update') {
    // "or newer": the applier resolves its target live, so the polled number
    // is a floor, not the version a click will install (#994).
    hint = `v${data.latestVersion} or newer available — checked ${ago}${cached ? ` (cached; ${restartRemedy})` : ''}`;
  } else {
    hint = `Up to date — checked ${ago}. Tap to check now`;
  }
  el.title = hint;
  el.classList.remove('check-unknown', 'check-failed');
  if (mark) el.classList.add(mark);
}

/**
 * Make the header version an explicit "check for updates now" control.
 *
 * The update announcement only exists when an update exists, so before this there was
 * no way to tell a measured "you are current" from a check that never ran — its
 * absence was unfalsifiable from the UI, and an operator who suspected
 * a release existed had nothing to press. The version label is the natural home:
 * it is already the update-adjacent thing on screen and already re-renders when
 * the running version changes.
 *
 * @returns {void}
 */
function wireVersionCheck() {
  const el = document.getElementById('version');
  if (!el) return;
  el.addEventListener('click', async () => {
    if (_versionCheckInFlight) return;
    _versionCheckInFlight = true;
    _showVersionLabel('checking…', false);
    try {
      const data = await loadUpdateStatus({ refresh: true, manual: true });
      // One state per payload, from the shared ladder the tooltip and the
      // beacon read too — so this label cannot say "up to date" for a payload
      // the marker beside it calls unknown (#1061).
      const { state } = window.tcUpdateAnswerState(data);
      if (state === 'update') {
        // The pill is the real answer here and it has just been rendered, so the
        // label goes straight back to the version rather than duplicating it.
        _showVersionLabel(`v${_lastRenderedVersion || data.currentVersion}`, true);
      } else if (state === 'current') {
        _showVersionLabel('up to date ✓', true);
      } else if (state === 'cached-unverified') {
        // The POST fell back to an older server's cached GET: the answer is
        // real but no check ran on this click, and "up to date ✓" claimed a
        // measurement that did not happen.
        _showVersionLabel(`cached ${_agoLabel(data.checkedAt)} — not re-checked`, true);
      } else if (state === 'never-checked') {
        // The marker already says "Not checked yet"; say the same thing.
        _showVersionLabel('not checked yet', true);
      } else {
        _showVersionLabel("couldn't check", true);
      }
    } catch (err) { // prawduct:allow prawduct/broad-except -- a throw anywhere in the render path must not strand the label
      // Without this the label stays on "checking…" forever AND, because the
      // hold flag is still set, renderRunningVersion can never correct it again
      // — one unlucky exception would freeze the header for the life of the
      // page. Report the failure honestly and let the hold expire.
      console.error('update check failed:', err);
      _showVersionLabel("couldn't check", true);
      // The tooltip is the durable half of this control — the label reverts
      // after the hold, the title does not. A throw at or before
      // renderVersionCheckHint leaves the previous answer in place, so the
      // tooltip would outlive the label still claiming "Up to date" for a
      // check that never completed.
      renderVersionCheckHint(null);
    } finally {
      _versionCheckInFlight = false;
    }
  });
}

// Guards against a second check starting while one is in flight.
let _versionCheckInFlight = false;

/**
 * Hide the stale-server banner once the condition it reports has cleared.
 * @returns {void}
 */
function hideStaleServerBanner() {
  const banner = document.getElementById('staleServerBanner');
  if (banner) banner.classList.add('hidden');
}

/**
 * Human-readable warning for an auth config-vs-live mismatch (AUTH-2K9D), or null
 * for the healthy/expected states (`off`, `live`, `configured-bypassed` — a
 * direct-loopback load that never traversed the gate says nothing about gate
 * health, so it deliberately renders no warning — or an older server that omits
 * `authStatus`). Text carries the meaning so the chip is not color-only (a11y).
 * @param {string|null|undefined} authStatus
 * @returns {string|null}
 */
function _authStatusWarning(authStatus) {
  if (authStatus === 'configured-inert') {
    return '⚠ Auth enabled but direct mode is not enforcing it — run the Caddy cutover to activate the login gate.';
  }
  if (authStatus === 'configured-no-identity') {
    return '⚠ Auth gate is up but no identity is arriving — the live Caddyfile may be missing "header_up X-Auth-User".';
  }
  return null;
}

/**
 * Show or hide the auth config-vs-live mismatch warning chip (AUTH-2K9D). Purely
 * state-driven: it mirrors the latest `/api/server-info` poll and self-clears when
 * the mismatch resolves (cutover runs / header fixed). No dismiss control and no
 * timer — removing the cause removes the chip on the next poll.
 * @param {string|null|undefined} authStatus
 */
function renderAuthStatus(authStatus) {
  const el = document.getElementById('authStatusWarning');
  if (!el) return;
  const msg = _authStatusWarning(authStatus);
  if (msg) {
    el.textContent = msg;
    el.title = msg;
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
}

/**
 * Show or hide the notice that this install is still accepting connections from
 * the whole network with no password (#710). Sent only to installs that predate
 * the setting and have not yet chosen, so an operator who has decided never sees
 * it. It is a live-exposure warning, not an after-the-fact upgrade note.
 *
 * State-driven like the auth chip: it mirrors the latest `/api/server-info` poll
 * and self-clears once the operator sets the setting either way and restarts.
 * No dismiss control and no timer — removing the cause removes the chip.
 *
 * Anyone who lost REMOTE access cannot see this, by definition; the boot log is
 * their copy. This is for the operator sitting at the machine, whose dashboard
 * still works and who would otherwise have no idea anything changed.
 *
 * @param {{message: string, setting: string}|null|undefined} notice
 * @param {string} [elementId] - Which chip to render into. The terminal
 *   listener has its own, because the two exposures are independent: one can be
 *   resolved while the other is still open, and a shared slot would hide that.
 */
function renderBindNotice(notice, elementId) {
  const el = document.getElementById(elementId || 'bindNotice');
  if (!el) return;
  const msg = notice && typeof notice.message === 'string' ? notice.message : null;
  if (msg) {
    el.textContent = `⚠ ${msg}`;
    el.title = msg;
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
}

/**
 * Show or hide the "Logged in as <user>" chip in the dashboard bar (AUTH-3).
 * Hidden whenever there is no authenticated user (direct mode / gate off).
 * The username is escaped before it reaches innerHTML.
 * @param {string|null|undefined} user
 */
function renderAuthUser(user) {
  const el = document.getElementById('authUser');
  if (!el) return;
  if (typeof user === 'string' && user.length > 0) {
    el.innerHTML = `&#128100; ${esc(user)}`;  // 👤 logged-in user
    el.classList.remove('hidden');
  } else {
    el.textContent = '';
    el.classList.add('hidden');
  }
}

/**
 * Format a non-negative integer of seconds as a compact "Xh Ym" /
 * "Xm Ys" / "Xs" string. Used by the stale-server banner so the
 * operator sees at a glance how long the running process has been
 * out of date.
 * @param {number} totalSec
 * @returns {string}
 */
function formatUptime(totalSec) {
  const s = Math.max(0, Number(totalSec) | 0);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

/**
 * Populate + reveal the stale-server banner. Defensive-by-default:
 * every value that ends up in `innerHTML` is either passed through
 * `esc()` (strings) or cast to a clamped integer (numerics). The
 * server-side source already produces sane shapes, but the boundary
 * cast here matches the broader rest-of-file convention so a future
 * server bug that leaks a non-numeric `commitsAhead` cannot inject
 * markup.
 *
 * @param {{startupSha: string|null, currentDiskSha: string|null, commitsAhead: number, uptimeSeconds: number|null}} info
 */
function renderStaleServerBanner(info) {
  const banner = document.getElementById('staleServerBanner');
  const textEl = document.getElementById('staleServerBannerText');
  if (!banner || !textEl) return;

  const commitsAhead = Math.max(0, Number(info.commitsAhead) | 0);
  const aheadStr = commitsAhead > 0
    ? `${commitsAhead} new commit${commitsAhead === 1 ? '' : 's'} on disk`
    : 'newer code on disk';
  const shortStartup = info.startupSha ? esc(info.startupSha.slice(0, 7)) : '?';
  const shortDisk = info.currentDiskSha ? esc(info.currentDiskSha.slice(0, 7)) : '?';
  const uptimeStr = (typeof info.uptimeSeconds === 'number' && info.uptimeSeconds >= 0)
    ? ` Running for ${esc(formatUptime(info.uptimeSeconds))}.`
    : '';

  // When the on-disk version differs from the running one, lead with that
  // rather than SHAs. It is the form an operator can act on — it names the
  // release they were trying to install and says plainly that the download
  // succeeded and only the restart is outstanding, instead of leaving them
  // to infer it from a version number that appears not to have changed.
  const runningVer = typeof info.runningVersion === 'string' ? info.runningVersion : null;
  const diskVer = typeof info.diskVersion === 'string' ? info.diskVersion : null;

  if (runningVer && diskVer && runningVer !== diskVer) {
    textEl.innerHTML =
      `⚠ <strong>v${esc(diskVer)} is downloaded — restart to finish.</strong> ` +
      `This server is still running v${esc(runningVer)}.${uptimeStr} ` +
      'The update is already on disk; restarting is the last step.';
  } else {
    textEl.innerHTML =
      '⚠ <strong>TC server is out of date.</strong> ' +
      `Running <code>${shortStartup}</code>; <code>${shortDisk}</code> on disk ` +
      `(${aheadStr}).${uptimeStr} Restart TC to load the latest code.`;
  }
  banner.classList.remove('hidden');

  toggleStaleRestartBtn(info);
}

/**
 * #235 — toggle the stale-banner restart button visibility based on the
 * restart-mechanism token. The button is hidden when no mechanism is
 * available (e.g. Linux today, bare-node), so operators on those hosts see
 * text-only guidance rather than an action that would 501. Shared by the
 * stale and cannot-determine (#1118) banner renderers.
 *
 * @param {{restartMechanism?: string|null}} info
 * @returns {void}
 */
function toggleStaleRestartBtn(info) {
  const restartBtn = document.getElementById('staleServerRestartBtn');
  if (!restartBtn) return;
  const mech = (typeof info.restartMechanism === 'string' && info.restartMechanism.length > 0)
    ? info.restartMechanism
    : null;
  if (mech) {
    restartBtn.classList.remove('hidden');
  } else {
    restartBtn.classList.add('hidden');
  }
}

/**
 * Render the "cannot determine" variant of the stale-server banner (#1118).
 * Shown when the server reports `isStale: null` — a git probe failed where
 * it was expected to work, so staleness is unknown rather than absent.
 * Saying nothing here is how an undetectable server reads as healthy; the
 * update beacon applies the same rule (a failed check is never "up to
 * date"). Reuses the stale banner element so the two states cannot both
 * show at once.
 *
 * @param {{staleUnknownReason?: string|null, uptimeSeconds?: number|null, restartMechanism?: string|null}} info
 * @returns {void}
 */
function renderStaleUnknownBanner(info) {
  const banner = document.getElementById('staleServerBanner');
  const textEl = document.getElementById('staleServerBannerText');
  if (!banner || !textEl) return;

  const reason = (typeof info.staleUnknownReason === 'string' && info.staleUnknownReason)
    ? ` (${esc(info.staleUnknownReason)})`
    : '';
  const uptimeStr = (typeof info.uptimeSeconds === 'number' && info.uptimeSeconds >= 0)
    ? ` Running for ${esc(formatUptime(info.uptimeSeconds))}.`
    : '';
  textEl.innerHTML =
    '⚠ <strong>Cannot tell whether this server is up to date.</strong> ' +
    `Git state is unreadable${reason}, so newer code on disk would go unnoticed.${uptimeStr} ` +
    'Restart TC if in doubt.';
  banner.classList.remove('hidden');
  toggleStaleRestartBtn(info);
}

/**
 * Trigger a TC server restart (#235) and poll /api/server-info until
 * the new process is up. On success, full-page reload so the browser
 * picks up any fresh static assets. On failure, restore the button
 * and surface an alert.
 *
 * Idempotent — guarded by `state.restartInFlight` so double-clicks
 * (banner + modal + accidental retry) coalesce to one POST.
 *
 * @returns {Promise<void>}
 */
async function triggerServerRestart() {
  if (state.restartInFlight) return;
  state.restartInFlight = true;

  // Re-query inside setBtnState rather than capturing references at
  // function entry — if the user opens the global settings modal
  // *after* clicking the banner restart, the modal button (`gsRestartBtn`)
  // won't exist at capture time but DOES exist later. Re-querying
  // every call keeps both surfaces in sync. Critic-caught on #235 PR.
  const setBtnState = (label, disabled) => {
    for (const id of ['staleServerRestartBtn', 'gsRestartBtn']) {
      const btn = document.getElementById(id);
      if (!btn) continue;
      btn.textContent = label;
      btn.disabled = disabled;
    }
  };

  setBtnState('Restarting…', true);

  // Confirm dialog so an accidental click doesn't kill the operator's
  // browser session mid-task.
  const proceed = window.confirm(
    'Restart TangleClaw?\n\n' +
    'Active tmux sessions will survive the restart; the browser will reconnect when the server returns (~3 seconds).'
  );
  if (!proceed) {
    state.restartInFlight = false;
    setBtnState('Restart TangleClaw', false);
    return;
  }

  // Capture the startup SHA we expect to be replaced. After restart
  // the new process will have a fresh `startedAt`, which is what
  // signals "we're back" — comparing startedAt is more reliable than
  // comparing SHA (the SHA might happen to match if the operator
  // restarted without pulling new code).
  //
  // Bail out if the pre-fetch fails. Without a baseline `startedAt`,
  // the poll comparison `info.startedAt !== null` would be trivially
  // true on the first successful response, causing a false-positive
  // page reload that hides whatever connectivity problem prevented
  // the pre-fetch. Critic-caught on #235 PR.
  let oldStartedAt = null;
  try {
    const pre = await api('/api/server-info');
    if (pre && pre.startedAt) oldStartedAt = pre.startedAt;
  } catch { /* fall through to the null-baseline check below */ }
  if (!oldStartedAt) {
    state.restartInFlight = false;
    setBtnState('Restart TangleClaw', false);
    window.alert('Could not read server state before restart. Aborting — check that TC is reachable, then try again.');
    return;
  }

  let postResp;
  try {
    postResp = await restartFlow.postServerRestart();
  } catch (err) {
    state.restartInFlight = false;
    setBtnState('Restart TangleClaw', false);
    window.alert(`Restart failed: ${err && err.message ? err.message : 'request did not complete'}`);
    return;
  }
  if (!postResp || !postResp.ok) {
    state.restartInFlight = false;
    setBtnState('Restart TangleClaw', false);
    const msg = (postResp && postResp.error) || api.lastError || 'unknown error';
    window.alert(`Restart not started: ${msg}`);
    return;
  }

  restartFlow.pollServerBackAndReload(oldStartedAt, () => {
    state.restartInFlight = false;
    setBtnState('Restart TangleClaw', false);
  });
}

/**
 * Fetch update status and render it onto the beacon (#931), which decides
 * everything about how an available update looks — here and on the session
 * page, from the same module.
 *
 * Two modes. Plain (`opts` omitted) reads the server's cached answer — cheap,
 * no network. `{refresh: true}` asks the server to measure again, which is what
 * makes an update visible within minutes of it existing rather than whenever
 * the periodic timer next happens to fire. `{manual: true}` additionally marks
 * the request as operator-initiated, which earns a much shorter staleness floor
 * server-side; throttling and coalescing live there, so callers here cannot
 * cause a poll loop against origin no matter how often they fire.
 *
 * @param {{refresh?: boolean, manual?: boolean}} [opts]
 * @returns {Promise<object|null>} The status payload, or null if the request failed
 */
async function loadUpdateStatus(opts) {
  const refresh = !!(opts && opts.refresh);
  const manual = !!(opts && opts.manual);
  let data = null;
  if (refresh) {
    data = await apiMutate('/api/update/check', 'POST', { manual });
    // A server older than these assets does not have this route. That window is
    // not hypothetical: this repo IS the live install, so a merge or a
    // self-update puts new client files on disk while the running process keeps
    // serving the old routes until it restarts. Without this fallback the page
    // would read the 404 as "the check failed" and raise the failure marker on
    // every load until the restart — a false alarm from the very feature built
    // to stop misreporting update state. Fall back to the cached answer, which
    // every server has, and let the marker mean what it says.
    if (!data && api.lastErrorCode === 'NOT_FOUND') {
      data = await api('/api/update-status');
    }
  } else {
    data = await api('/api/update-status');
  }
  renderVersionCheckHint(data);
  updateBeacon.render(data);
  return data;
}

async function loadStats() {
  const data = await api('/api/system');
  if (!data) return;

  const cpuPct = typeof data.cpu.usage === 'number' ? data.cpu.usage : 0;
  const memPct = typeof data.memory.percent === 'number' ? data.memory.percent : 0;
  const diskPct = typeof data.disk.percent === 'number' ? data.disk.percent : 0;

  setStatValue('statCpu', `${Math.round(cpuPct)}%`, cpuPct, 'statCpuBar');
  setStatValue('statMem', `${Math.round(memPct)}%`, memPct, 'statMemBar');
  setStatValue('statDisk', `${Math.round(diskPct)}%`, diskPct, 'statDiskBar');
  document.getElementById('statUptime').textContent = data.uptimeFormatted || formatUptime(data.uptime);
}

function setStatValue(valueId, text, pct, barId) {
  const el = document.getElementById(valueId);
  const bar = document.getElementById(barId);
  const colorClass = pct > 85 ? 'stat-red' : pct > 65 ? 'stat-amber' : 'stat-green';
  const fillClass = pct > 85 ? 'fill-red' : pct > 65 ? 'fill-amber' : 'fill-green';
  el.textContent = text;
  el.className = `stat-value ${colorClass}`;
  if (bar) {
    bar.style.width = `${Math.min(pct, 100)}%`;
    bar.className = `stat-bar-fill ${fillClass}`;
  }
}

function formatUptime(seconds) {
  if (typeof seconds !== 'number') return '--';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  if (d > 0) return `${d}d ${h}h`;
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

async function loadPorts() {
  const data = await api('/api/ports');
  if (!data) return;
  state.ports = data.leases || [];
  document.getElementById('portsCount').textContent = state.ports.length;
  renderPorts();
}

/**
 * Load global rules content from the API.
 */
async function loadGlobalRules() {
  const data = await api('/api/rules/global');
  if (data) {
    state.globalRulesContent = data.content || '';
    const editor = document.getElementById('rulesEditor');
    if (editor) editor.value = state.globalRulesContent;
  }
}

/**
 * Save global rules to the API.
 */
async function saveGlobalRules() {
  const editor = document.getElementById('rulesEditor');
  const content = editor.value;
  const data = await apiMutate('/api/rules/global', 'PUT', { content });
  const status = document.getElementById('rulesStatus');
  if (data) {
    state.globalRulesContent = content;
    status.textContent = 'Saved';
    status.className = 'rules-status rules-status-ok';
  } else {
    status.textContent = api.lastError || 'Save failed';
    status.className = 'rules-status rules-status-err';
  }
  status.classList.remove('hidden');
  setTimeout(() => { status.classList.add('hidden'); }, 3000);
}

/**
 * Load project groups from the API.
 */
async function loadGroups() {
  const data = await api('/api/groups');
  if (!data) return;
  state.groups = data.groups || [];
  document.getElementById('groupsCount').textContent = state.groups.length;
  renderGroups();
}

/**
 * Load OpenClaw connections from the API and fetch tunnel status for each.
 */
async function loadOpenclawConnections() {
  const data = await api('/api/openclaw/connections');
  if (!data) return;
  state.openclawConnections = data.connections || [];
  const countEl = document.getElementById('openclawCount');
  if (countEl) countEl.textContent = state.openclawConnections.length;

  // Fetch tunnel status for each connection in parallel
  const statusPromises = state.openclawConnections.map(async (conn) => {
    const status = await api(`/api/openclaw/connections/${conn.id}/tunnel`);
    if (status) state.openclawTunnelStatus[conn.id] = status;
  });
  await Promise.all(statusPromises);

  renderOpenclawConnections();
}

/**
 * Load upstream model status for all engines.
 */
async function loadModelStatus() {
  const data = await api('/api/models/status');
  if (data && data.status) {
    state.modelStatus = data.status;
    renderProjects();
  }
}

async function loadEngines() {
  const data = await api('/api/engines');
  if (!data) return;
  state.engines = data.engines || [];
  // Whether the server could actually look, or only saw the PATH launchd gave
  // it (#346). The setup wizard refuses to wall an operator in on an answer
  // this flag says is a guess, so it has to arrive with the FIRST load and not
  // only after a re-check.
  state.engineDetectionCertain = data.detectionCertain !== false;
}

async function loadConfig() {
  const data = await api('/api/config');
  if (data) state.config = data;
}

// ── Boot beacon (#817) ──
// A dashboard whose shell never initializes is server-invisible: the document
// and the non-precached scripts load over the network, the precached shell
// scripts (landing.js, ui.js — cache-first, see sw.js STATIC_ASSETS) never
// execute, and no API call follows. Every server signal stays green. The only
// server-side proxy was the absence of `GET /api/projects`, and that is
// ambiguous — an operator who opened a session page directly leaves the same
// gap. This beacon is the positive signal: it is sent ONCE per page load, only
// after the first successful projects fetch has rendered, so its presence in
// the access log means "the shell booted" and its absence after a `GET /`
// means it did not.
let bootBeaconSent = false;

/**
 * Name the TangleClaw cache generations present in this origin's Cache
 * Storage, so the beacon records which service-worker precache the page booted
 * against. Read from Cache Storage rather than asked of the worker: it is the
 * same store the runbook has an operator inspect by hand, and it answers even
 * when the worker is between versions (both generations are then listed).
 *
 * @returns {Promise<string|null>} Comma-joined `tangleclaw-*` cache names, or
 *   null when Cache Storage is unavailable, unreadable, or holds none.
 */
async function readSwCacheName() {
  if (typeof caches === 'undefined' || !caches || typeof caches.keys !== 'function') return null;
  try {
    const keys = await caches.keys();
    const mine = keys.filter((k) => typeof k === 'string' && k.startsWith('tangleclaw-'));
    return mine.length ? mine.join(',') : null;
  } catch (err) {
    console.error('boot beacon: Cache Storage could not be read:', err);
    return null;
  }
}

/**
 * Tell the server the dashboard shell booted. Fires at most once per page
 * load; its only caller invokes it after the projects list has rendered, so it
 * can never claim a boot that did not happen. A bare `fetch`, not `api()`: the
 * reply is an empty 204 (no JSON to parse) and a failed beacon must not touch
 * the connection state or the toast — it is a log line, not a dependency.
 *
 * @returns {Promise<void>} Resolves whether or not the beacon reached the server.
 */
async function sendBootBeacon() {
  if (bootBeaconSent) return;
  bootBeaconSent = true;
  const cacheName = await readSwCacheName();
  const controlled = typeof navigator !== 'undefined'
    && !!(navigator.serviceWorker && navigator.serviceWorker.controller);
  try {
    const res = await fetch('/api/dashboard/boot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cacheName, controlled })
    });
    // A refusal (an unserved Host, a pre-restart 404) returns before the
    // server's access-log line, so from the log it is indistinguishable from
    // a shell that never ran. Say so where the browser side can see it.
    if (!res.ok) console.error(`boot beacon refused: HTTP ${res.status}`);
  } catch (err) {
    console.error('boot beacon failed:', err);
  }
}

async function loadProjects() {
  const data = await api('/api/projects?archived=true');
  if (!data) return;
  state.projects = (data.projects || []).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  // Awareness view (ambient-awareness Chunk 05) — fetched on the same poll so
  // the cards render with it in one pass. A failed fetch keeps the previous
  // answer rather than blanking every badge: an unreachable endpoint is not
  // evidence the fleet became aware.
  const aw = await api('/api/awareness');
  if (aw && aw.projects) {
    state.awareness = Object.fromEntries(aw.projects.map((p) => [p.projectId, p]));
  }
  // Kept as sent, including on the healthy path — a field that only appears on
  // failure makes every reader probe for its existence instead of reading its
  // value. `renderRootPanel` decides what to draw; this only stops the answer
  // being discarded, which is what made a short list indistinguishable from a
  // complete one.
  state.projectsScan = data.scan || null;
  collectTags();
  collectEngines();
  renderProjects();
  renderSessionCount();
  updateUnregisteredToggle();
  // The shell is on screen: this is the moment "the dashboard booted" becomes
  // true, and the only place it is said (#817). Not awaited — the beacon is a
  // side channel and must not hold up the poll or the banners below.
  sendBootBeacon();

  // Update audit incident count badge
  const totalIncidents = state.projects.reduce((sum, p) =>
    sum + ((p.evalAudit && p.evalAudit.openIncidents) || 0), 0);
  const countEl = document.getElementById('auditIncidentCount');
  if (countEl) countEl.textContent = totalIncidents;

  // Refresh the orphan-hooks banner (#145, chunk 2). Skip while a repair is
  // in flight so the polling tick can't briefly flash pre-repair state back
  // (Critic N3). Console-log on failure rather than silently swallow so a
  // permanent failure is visible without breaking the dashboard.
  if (!state.orphanHooksRepairInFlight) {
    loadOrphanHooksInventory().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('orphan-hooks scan failed', err);
    });
  }
}

// ── Orphan Hooks Banner (#145, chunk 2) ──
// The Stop-hook infinite-loop incident that prompted chunk 2 lives in
// projects whose .claude/settings.json points at a hook runtime that was
// never installed. The banner gives users a one-click escape hatch
// without waiting for each project's next session-launch sync to self-heal.

async function loadOrphanHooksInventory() {
  const data = await api('/api/projects/orphan-hooks-scan');
  state.orphanHooks = data || { projectsWithOrphans: [] };
  renderOrphanHooksBanner();
}

function renderOrphanHooksBanner() {
  const banner = document.getElementById('orphanHooksBanner');
  const textEl = document.getElementById('orphanHooksBannerText');
  if (!banner || !textEl) return;
  const list = (state.orphanHooks && state.orphanHooks.projectsWithOrphans) || [];
  if (list.length === 0) {
    banner.classList.add('hidden');
    return;
  }
  const noun = list.length === 1 ? 'project has' : 'projects have';
  textEl.textContent = `${list.length} ${noun} orphan Stop/SessionStart hooks (likely cause of infinite-loop session errors).`;
  banner.classList.remove('hidden');
}

async function repairAllOrphanHooks() {
  const list = (state.orphanHooks && state.orphanHooks.projectsWithOrphans) || [];
  if (list.length === 0) return;
  const names = list.map((p) => p.name).join(', ');
  if (!window.confirm(`Strip orphan hook entries from ${list.length} project(s)?\n\n${names}\n\nNon-orphan hooks and all other settings keys are preserved.`)) return;
  const toast = document.getElementById('toast');
  // Gate the polling-driven scan refresh so it can't race the in-flight repair
  // POST and briefly flash the pre-repair banner state back (Critic N3).
  state.orphanHooksRepairInFlight = true;
  try {
    const data = await apiMutate('/api/projects/repair-orphan-hooks', 'POST', {});
    if (!data) {
      if (toast) {
        toast.textContent = `Repair failed: ${api.lastError || 'unknown error'}`;
        toast.className = 'toast toast-warn visible';
        setTimeout(() => { toast.className = 'toast'; }, 4000);
      }
      return;
    }
    const repairedN = Array.isArray(data.repaired) ? data.repaired.length : 0;
    const errorN = Array.isArray(data.errors) ? data.errors.length : 0;
    if (toast) {
      if (errorN > 0) {
        toast.textContent = `Repaired ${repairedN}, ${errorN} error${errorN > 1 ? 's' : ''}`;
        toast.className = 'toast toast-warn visible';
      } else {
        toast.textContent = `Repaired ${repairedN} project(s)`;
        toast.className = 'toast toast-ok visible';
      }
      setTimeout(() => { toast.className = 'toast'; }, 3000);
    }
    await loadProjects();
  } finally {
    state.orphanHooksRepairInFlight = false;
  }
}

function showOrphanHooksDetails() {
  const list = (state.orphanHooks && state.orphanHooks.projectsWithOrphans) || [];
  if (list.length === 0) return;
  const lines = list.map((p) => {
    const orphans = p.orphans.map((o) => `  • ${o.event}${o.matcher ? ` (matcher: "${o.matcher}")` : ''} → missing: ${o.missing.join(', ')}`).join('\n');
    return `${p.name}\n${orphans}`;
  });
  window.alert(`Orphan hooks detected:\n\n${lines.join('\n\n')}`);
}

function wireOrphanHooksBanner() {
  const repairBtn = document.getElementById('orphanHooksRepairBtn');
  const detailsBtn = document.getElementById('orphanHooksDetailsBtn');
  if (repairBtn) {
    repairBtn.addEventListener('click', () => {
      repairAllOrphanHooks().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('orphan-hooks repair failed', err);
        const toast = document.getElementById('toast');
        if (toast) {
          toast.textContent = `Repair failed: ${err && err.message ? err.message : 'unknown error'}`;
          toast.className = 'toast toast-warn visible';
          setTimeout(() => { toast.className = 'toast'; }, 4000);
        }
      });
    });
  }
  if (detailsBtn) detailsBtn.addEventListener('click', showOrphanHooksDetails);
}

/**
 * Wire the stale-server banner's restart button (#235). Idempotent —
 * called once at page init. The button visibility is managed
 * separately in `renderStaleServerBanner()` based on the server's
 * `restartMechanism` capability.
 */
function wireStaleServerBanner() {
  const btn = document.getElementById('staleServerRestartBtn');
  if (btn) {
    btn.addEventListener('click', () => {
      triggerServerRestart().catch((err) => {
        // eslint-disable-next-line no-console
        console.error('server restart failed', err);
      });
    });
  }
}


  state.activeEngine = null;

  function collectEngines() {
    const engines = new Set();
    for (const p of state.projects) {
      if (p.engine && p.engine.name) {
        engines.add(p.engine.name);
      }
    }
    const select = document.getElementById('engineFilter');
    if (!select) return;
    
    // Only show if there are engines
    if (engines.size === 0) {
      select.style.display = 'none';
      return;
    }
    
    select.style.display = 'inline-block';
    
    const current = select.value;
    select.innerHTML = '<option value="">All Engines</option>';
    
    Array.from(engines).sort().forEach(e => {
      const opt = document.createElement('option');
      opt.value = e;
      opt.textContent = e;
      select.appendChild(opt);
    });
    
    if (engines.has(current)) {
      select.value = current;
    }
  }

function collectTags() {
  const tags = new Set();
  for (const p of state.projects) {
    if (Array.isArray(p.tags)) p.tags.forEach(t => tags.add(t));
  }
  state.allTags = Array.from(tags).sort();
  renderTagRow();
}

// ── Filtering ──

/**
 * Filter projects based on text, tag, and registered state.
 * @returns {object[]}
 */
function filterProjects() {
  let list = state.projects.filter(p => !p.archived);
  if (!state.showUnregistered) {
    list = list.filter(p => p.registered !== false);
  }
  const text = state.filterText.toLowerCase();
  if (text) {
    list = list.filter(p => {
      const haystack = [
        p.name,
        p.engine ? p.engine.name : '',
        ...(p.tags || [])
      ].join(' ').toLowerCase();
      return haystack.includes(text);
    });
  }
  if (state.activeTag) {
    list = list.filter(p => (p.tags || []).includes(state.activeTag));
  }
  if (state.activeEngine) {
    list = list.filter(p => p.engine && p.engine.name === state.activeEngine);
  }
  return list;
}

function toggleTag(tag) {
  state.activeTag = tag;
  renderTagRow();
  renderProjects();
}

/**
 * Toggle visibility of unregistered projects and persist preference.
 */
function toggleUnregistered() {
  state.showUnregistered = !state.showUnregistered;
  try { localStorage.setItem('tc_showUnregistered', JSON.stringify(state.showUnregistered)); } catch (e) { /* ignore */ }
  updateUnregisteredToggle();
  renderProjects();
}

/**
 * Update the unregistered toggle button state by re-rendering the tag row.
 */
function updateUnregisteredToggle() {
  renderTagRow();
}

// ── Project Actions ──

function navigateToSession(name, opts) {
  const suffix = opts && opts.launched ? '?launched=1' : '';
  window.location.href = `/session/${encodeURIComponent(name)}${suffix}`;
}

let continuityLaunchTarget = null;
let pendingContinuityMode = null;

function closeContinuityLaunchModal() {
  document.getElementById('continuityLaunchModal').classList.remove('open');
}

function confirmContinuityLaunch() {
  const mode = document.querySelector('input[name="continuityMode"]:checked').value;
  pendingContinuityMode = mode;
  closeContinuityLaunchModal();
  const name = continuityLaunchTarget;
  const project = state.projects.find(p => p.name === name);
  proceedWithLaunchModeCheck(name, project, mode);
}

function proceedWithLaunchModeCheck(name, project, continuityMode) {
  if (project && project.showLaunchModePicker === false) {
    return doLaunchProject(name, null, continuityMode);
  }

  const engineId = project ? (project.engineId || (state.config && state.config.defaultEngine) || 'claude') : 'claude';
  const engine = (state.engines || []).find(e => e.id === engineId);
  if (engine && engine.launchModes) {
    const enabledModes = Object.values(engine.launchModes).filter(m => !m.disabled);
    if (enabledModes.length > 1) {
      openLaunchModeModal(name, engine, continuityMode);
      return;
    }
  }

  doLaunchProject(name, null, continuityMode);
}

async function launchProject(name) {
  const project = state.projects.find(p => p.name === name);
  if (project && project.session && project.session.active) {
    return navigateToSession(name);
  }

  if (project && project.continuityIndex && project.continuityIndex.nextAction) {
    continuityLaunchTarget = name;
    document.getElementById('continuityLaunchText').innerHTML =
      `Launch <strong>${esc(name)}</strong>?`;
    document.getElementById('continuityLaunchModal').classList.add('open');
    return;
  }

  proceedWithLaunchModeCheck(name, project, null);
}

/**
 * Execute the actual session launch with optional launch mode.
 * @param {string} name - Project name
 * @param {string|null} launchMode - Launch mode key or null for default
 */
async function doLaunchProject(name, launchMode, continuityMode) {
  // Immediate visual feedback — swap button text to "Launching…" and disable
  const btn = document.querySelector(`button[onclick*="launchProject('${name}')"]`);
  const originalText = btn ? btn.textContent : '';
  if (btn) {
    btn.textContent = 'Launching\u2026';
    btn.disabled = true;
  }

  const toast = document.getElementById('toast');
  const body = {};
  if (launchMode) body.launchMode = launchMode;
  if (continuityMode) body.continuityMode = continuityMode;

  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();

    if (!res.ok) {
      if (btn) { btn.textContent = originalText; btn.disabled = false; }
      toast.textContent = `Launch failed: ${data.error || `HTTP ${res.status}`}`;
      toast.className = 'toast toast-warn visible';
      setTimeout(() => { toast.classList.remove('visible'); }, 6000);
      return;
    }

    setConnected(true);
    navigateToSession(name, { launched: true });
  } catch (err) {
    if (btn) { btn.textContent = originalText; btn.disabled = false; }
    if (err.name === 'TypeError' || err.message === 'Failed to fetch') {
      setConnected(false);
    }
    toast.textContent = `Launch failed: ${err.message}`;
    toast.className = 'toast toast-warn visible';
    setTimeout(() => { toast.classList.remove('visible'); }, 6000);
  }
}

// ── Launch Mode Modal ──

let launchModeTarget = null;
let selectedLaunchMode = null;

/**
 * Open the launch mode picker modal.
 * @param {string} name - Project name
 * @param {object} engine - Engine object with launchModes
 */
function openLaunchModeModal(name, engine, continuityMode = null) {
  pendingContinuityMode = continuityMode;
  launchModeTarget = name;
  selectedLaunchMode = engine.defaultLaunchMode || Object.keys(engine.launchModes)[0];

  document.getElementById('launchModeText').innerHTML =
    `Choose a launch mode for <strong>${esc(name)}</strong>:`;

  const list = document.getElementById('launchModeList');
  let html = '';
  for (const [key, mode] of Object.entries(engine.launchModes)) {
    const checked = key === selectedLaunchMode ? 'checked' : '';
    const warning = mode.warning ? `<span class="launch-mode-warning">${esc(mode.warning)}</span>` : '';
    html += `
      <label class="launch-mode-option">
        <input type="radio" name="launchMode" value="${esc(key)}" ${checked}
               onchange="selectedLaunchMode='${esc(key)}'; updateLaunchModeWarning()">
        <div class="launch-mode-info">
          <span class="launch-mode-label">${esc(mode.label)}</span>
          <span class="launch-mode-desc">${esc(mode.description || '')}</span>
          ${warning}
        </div>
      </label>`;
  }
  list.innerHTML = html;
  updateLaunchModeWarning();
  document.getElementById('launchModeModal').classList.add('open');
}

/**
 * Update the warning display based on selected launch mode.
 */
function updateLaunchModeWarning() {
  // Warning is shown inline per-option, no separate warning needed
  document.getElementById('launchModeWarning').classList.add('hidden');
}

/**
 * Close the launch mode modal.
 */
function closeLaunchModeModal() {
  document.getElementById('launchModeModal').classList.remove('open');
  launchModeTarget = null;
  selectedLaunchMode = null;
}

/**
 * Confirm launch mode selection and launch.
 */
async function confirmLaunchMode() {
  if (!launchModeTarget) return;
  const name = launchModeTarget;
  const mode = selectedLaunchMode;
  closeLaunchModeModal();
  await doLaunchProject(name, mode, pendingContinuityMode);
}

function wrapProject(name) {
  openWrapModal(name);
}

// ── Wrap Modal ──

let wrapTarget = null;

/**
 * True while a wrap `POST` is in flight, so a second confirm can't fire a
 * concurrent wrap and no close path can dismiss the modal mid-wrap. Reset in
 * `confirmWrap`'s `finally`. Mirrors the session-page fix (#519 / UI-3B8N).
 */
let wrapInFlight = false;

function openWrapModal(name) {
  wrapTarget = name;
  document.getElementById('wrapText').innerHTML =
    `Wrap the session for <strong>${esc(name)}</strong>? This sends the wrap command and ends the session.`;
  document.getElementById('wrapError').classList.add('hidden');
  document.getElementById('wrapPassword').value = '';
  const pwGroup = document.getElementById('wrapPasswordGroup');
  if (state.config && state.config.deleteProtected) {
    pwGroup.classList.remove('hidden');
  } else {
    pwGroup.classList.add('hidden');
  }
  document.getElementById('wrapModal').classList.add('open');
}

/**
 * Close the wrap modal. Blocked while a wrap is in flight unless forced:
 * the Cancel handler passes the click Event (not `true`) and the backdrop
 * handler passes nothing, so a strict `force !== true` check stops both from
 * dismissing the modal mid-wrap; `confirmWrap` passes `force:true` on success.
 * @param {boolean} [force] `true` to close past the in-flight guard.
 */
function closeWrapModal(force) {
  if (wrapInFlight && force !== true) return;
  document.getElementById('wrapModal').classList.remove('open');
  wrapTarget = null;
}

/**
 * Confirm and execute a wrap for the targeted project (dashboard trigger).
 * Single-flight: the first click sets an in-flight flag, disables both
 * buttons, and flips the confirm label to "Wrapping…", so a second click
 * (or Cancel / backdrop) is a no-op until the request resolves — preventing
 * a double-click from firing two concurrent wraps. All state is restored in
 * `finally` so a failed or hung wrap re-enables cleanly. No timers — the
 * state tracks the request lifecycle (no timer-driven UI lifecycle).
 */
async function confirmWrap() {
  if (!wrapTarget) return;
  // Re-entrancy guard: ignore a second confirm while the first wrap POST is
  // still in flight, so a double-click can't fire two concurrent wraps.
  if (wrapInFlight) return;

  const pw = document.getElementById('wrapPassword').value;
  const body = {};
  if (pw) body.password = pw;

  const confirmBtn = document.getElementById('wrapConfirmBtn');
  const cancelBtn = document.getElementById('wrapCancelBtn');
  const priorLabel = confirmBtn.textContent;
  wrapInFlight = true;
  confirmBtn.disabled = true;
  cancelBtn.disabled = true;
  confirmBtn.textContent = 'Wrapping…';

  try {
    const data = await apiMutate(`/api/sessions/${encodeURIComponent(wrapTarget)}/wrap`, 'POST', body);
    if (!data) {
      // Failure — surface the server's reason inline and let `finally`
      // re-enable so the operator can fix and retry without reopening.
      document.getElementById('wrapError').textContent = api.lastError || 'Wrap failed.';
      document.getElementById('wrapError').classList.remove('hidden');
      return;
    }
    closeWrapModal(true); // force-close past the in-flight guard on success
    await loadProjects();
  } finally {
    wrapInFlight = false;
    confirmBtn.disabled = false;
    cancelBtn.disabled = false;
    confirmBtn.textContent = priorLabel;
  }
}

// ── Theme ──

/**
 * Apply the current theme to the document.
 * Sets data-theme attribute on <html> for CSS variable overrides.
 */
function applyTheme() {
  const theme = (state.config && state.config.theme) || 'dark';
  if (theme === 'dark') {
    document.documentElement.removeAttribute('data-theme');
  } else {
    document.documentElement.setAttribute('data-theme', theme);
  }
}

// ── Utilities ──

/**
 * Escape HTML special characters to prevent XSS.
 * @param {string} str
 * @returns {string}
 */
function esc(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// ── Initialization ──

/**
 * Canonical form for project-name identity comparisons (#221). TC
 * preserves the operator's chosen capitalization for display
 * everywhere; the canonical form is only ever used for set membership
 * and equality checks. Lowercase is chosen because case-insensitive
 * filesystems (macOS HFS+, Windows) collapse to it, and programmatic
 * PortHub registrations conventionally slug-style lowercase.
 *
 * Defensive against non-string input — coerces to '' so map/filter
 * pipelines don't throw on a malformed lease record.
 *
 * @param {string} name
 * @returns {string}
 */
function _canonicalProjectName(name) {
  return String(name == null ? '' : name).toLowerCase();
}

/**
 * Check if any port leases reference projects not registered in TangleClaw.
 * If found, render an import notification banner with details.
 */
function checkPortImports() {
  if (!state.ports.length || !state.projects.length) return;

  // Identity is case-insensitive (#221) — TC's storage layer preserves
  // the operator's chosen capitalization for display, but two names
  // that differ only in case refer to the SAME project. Normalize both
  // sides before comparison so a lease registered as "web-api" against
  // a TC project named "Web-API" doesn't falsely advertise an import.
  const registeredNames = new Set(state.projects.map(p => _canonicalProjectName(p.name)));
  const ignored = new Set([...getIgnoredLeaseProjects()].map(_canonicalProjectName));

  // OpenClaw direct-connect tunnels register under oc-direct-<connId> — not orphan projects
  const ocConnIds = new Set((state.openclawConnections || []).map(c => `oc-direct-${c.id}`));

  // Group ports by unregistered project name. Bucket by the lease's
  // ORIGINAL casing so the banner shows what's actually on the wire,
  // not a normalized form.
  const unregistered = {};
  for (const lease of state.ports) {
    const key = _canonicalProjectName(lease.project);
    if (!registeredNames.has(key) && !ignored.has(key) && !ocConnIds.has(lease.project)) {
      if (!unregistered[lease.project]) unregistered[lease.project] = [];
      unregistered[lease.project].push(lease);
    }
  }

  const importable = Object.entries(unregistered).map(([name, leases]) => ({
    name,
    ports: leases.map(l => ({ port: l.port, service: l.service })),
    // Conflict detection also runs case-insensitively — a registered
    // project Foo holding port 3200 conflicts with a lease foo:3200.
    conflicts: leases.filter(l =>
      state.ports.some(p => p.port === l.port && registeredNames.has(_canonicalProjectName(p.project)))
    ).map(l => l.port)
  }));

  if (importable.length > 0) {
    renderImportBanner(importable);
  }
}

/**
 * Get the set of lease project names permanently ignored by the user.
 * @returns {Set<string>}
 */
function getIgnoredLeaseProjects() {
  try {
    const raw = localStorage.getItem('tc_ignoredLeaseProjects');
    return raw ? new Set(JSON.parse(raw)) : new Set();
  } catch (e) { return new Set(); }
}

/**
 * Add a lease project name to the permanent ignore list.
 * @param {string} name - Project name to ignore
 */
function ignoreLeaseProject(name) {
  const ignored = getIgnoredLeaseProjects();
  ignored.add(name);
  localStorage.setItem('tc_ignoredLeaseProjects', JSON.stringify([...ignored]));
  // Remove banner and re-check
  const el = document.getElementById('importBanner');
  if (el) el.remove();
  checkPortImports();
}

async function init() {
  // Restore persisted preferences
  try {
    const saved = localStorage.getItem('tc_showUnregistered');
    if (saved !== null) state.showUnregistered = JSON.parse(saved);
  } catch (e) { /* ignore */ }

  await Promise.all([loadVersion(), loadConfig(), loadEngines()]);
  applyTheme();

  // Check for first-run setup wizard
  if (typeof checkSetupWizard === 'function' && checkSetupWizard()) {
    // Wizard is showing — don't load projects or start polling yet.
    // Wizard dismissal will trigger loadProjects().
    return;
  }

  wireOrphanHooksBanner();
  wireStaleServerBanner();
  wireVersionCheck();
  await loadProjects();
  // Opening the dashboard is a real measurement, not a cache read. A release
  // published since the server's last periodic check was previously invisible
  // until that timer next fired — a whole interval of a page that had been
  // asked, and answered from memory. Throttled server-side, so a reload loop
  // costs one check per window rather than one per load.
  await Promise.all([loadStats(), loadPorts(), loadGlobalRules(), loadModelStatus(), loadGroups(), loadOpenclawConnections(),
    // `.catch` rather than bare: a rejection inside Promise.all would abandon
    // the rest of init — checkPortImports, maybeShowFilter,
    // updateUnregisteredToggle and startPolling all sit after this await, so a
    // failed update check must not be able to leave the dashboard unpolled.
    loadUpdateStatus({ refresh: true }).catch((err) => {
      console.error('update check on load failed:', err);
      return null;
    }),
    loadServerInfo()]);
  checkPortImports();
  maybeShowFilter();
  updateUnregisteredToggle();
  startPolling();
}

/**
 * Start all landing page polling loops using setTimeout chains.
 * Prevents callback burst storms when browser tabs are backgrounded
 * and then refocused (setInterval queues callbacks during throttling).
 */
function startPolling() {
  function loop(fn, ms) {
    function tick() {
      setTimeout(async () => {
        await fn();
        tick();
      }, ms);
    }
    tick();
  }
  loop(loadStats, 30000);
  loop(loadPorts, 30000);
  loop(loadProjects, 10000);
  loop(loadModelStatus, 120000);
  loop(loadGroups, 30000);
  loop(loadOpenclawConnections, 30000);
  // Stale-server detection (#199) — polls so the banner surfaces mid-session
  // when the operator merges/pulls while a tab is open. Slower cadence than
  // the others because it shells out to git on the server every tick.
  loop(loadServerInfo, 60000);
  // The pill was previously decided once, at page load, and could never
  // change its mind. It now re-asks, because two of its answers are provisional
  // by construction: a restart resets the server's in-memory check to "not
  // checked yet", and a failed request is not an answer at all. Both are
  // deliberately left showing rather than hidden, so without a retry a pill for
  // an update already installed would stay up for the life of the page.
  //
  // Deliberately still a plain cache read here, where the session page's
  // equivalent poll re-measures (#954). The two pages differ because the way an
  // operator ARRIVES at them differs, not because one of them is wrong: this
  // page re-measures on load and on the visibility handler below, and nobody
  // reads a dashboard without having just opened or refocused it — so the
  // event-driven path has already asked. An operator sits INSIDE a session for
  // hours with the tab already focused, firing neither event, which is why that
  // page had to move its freshness onto the poll itself.
  //
  // The cost of re-measuring is bounded server-side either way — `refreshIfStale`
  // throttles and single-flights, so it is one `git ls-remote` per floor per
  // SERVER, not per tab. What it is not is free: at a poll cadence equal to that
  // floor the steady state sits at roughly one measurement per five minutes for
  // as long as a page is open. Worth paying where it buys freshness nothing else
  // provides; not worth paying here, where it duplicates the focus path.
  loop(loadUpdateStatus, 300000);

  // Returning to the tab is the moment an operator is about to trust what the
  // page says, and it is exactly when a page left open for hours is most likely
  // to be stale. Mirrors the service worker's own visibility-driven update poll
  // (see sw-register.js). The server's staleness floor makes rapid tab
  // switching harmless.
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    // Both halves, deliberately. A browser suspends timers in a backgrounded
    // tab, so the 60s poll stops and the header keeps naming whatever version
    // was running when the tab was last awake — observed 2026-07-29, a tab
    // showing 4.36.0 against a server running 4.37.0. Refreshing the update
    // answer without the running version would leave the header contradicting
    // the pill beside it, since "is there an update?" is answered relative to
    // the version actually loaded.
    try {
      // Sequenced, not concurrent. When loadServerInfo sees a restart it
      // re-asks for update status itself — a plain cached GET — so firing both
      // at once lets that stale read land after the fresh measurement and
      // repaint the older answer. Awaiting means the refresh is the last word.
      await loadServerInfo();
      await loadUpdateStatus({ refresh: true });
    } catch (err) { // prawduct:allow prawduct/broad-except -- an async event listener's rejection is unhandled and invisible; logged instead
      // The manual path already reports its own failures in the UI. This one is
      // background work the operator did not ask for, so it stays quiet on
      // screen and loud in the console.
      console.error('refresh on tab focus failed:', err);
    }
  });
}

// Service worker registration + update propagation lives in /sw-register.js
// (loaded before this script in index.html). It was extracted from an inline
// block here so the iOS update-propagation logic (#380) is unit-testable;
// it self-registers on load.

init();
