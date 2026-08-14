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
  allTags: [],
  connected: true,
  statsOpen: true,
  ports: [],
  portsOpen: false,
  portGroupsOpen: {},
  rulesOpen: false,
  globalRulesContent: '',
  modelStatus: {},
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

// ── Connection State ──

let reconnectTimer = null;

// #709 — consecutive reconnect attempts that still found the server gone.
// The service worker serves the app shell from cache with the server
// completely dead, so this page can render healthy-looking while nothing
// behind it answers. The toast alone claimed "Retrying…" identically after
// one failure and after two hundred; past this ceiling the claim of a
// transient blip becomes dishonest and the real unreachable state takes over.
// Retrying continues underneath it — recovery stays automatic — the ceiling
// only changes what the operator is TOLD.
let reconnectFailures = 0;
const UNREACHABLE_AFTER = 4;

/**
 * One background reconnect attempt, and the honesty ceiling.
 *
 * `loadProjects` flips `state.connected` back through `setConnected(true)` on
 * success, which resets the counter and dismisses the unreachable state. While
 * the server stays gone, count — and once the ceiling passes, stop calling it
 * a blip.
 *
 * @returns {Promise<void>}
 */
async function attemptReconnect() {
  await loadProjects();
  if (state.connected) return;
  reconnectFailures++;
  if (reconnectFailures >= UNREACHABLE_AFTER) renderUnreachableState();
}

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
        <button class="btn btn-primary" onclick="retryConnectionNow()">Retry now</button>
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
 * @returns {Promise<void>}
 */
async function retryConnectionNow() {
  await attemptReconnect();
}

function setConnected(connected) {
  if (state.connected === connected) return;
  state.connected = connected;
  const toast = document.getElementById('toast');
  if (!connected) {
    toast.textContent = 'Connection lost. Retrying\u2026';
    toast.className = 'toast toast-warn visible';
    if (!reconnectTimer) {
      reconnectTimer = true; // sentinel
      (function reconnectLoop() {
        if (!reconnectTimer) return;
        reconnectTimer = setTimeout(async () => {
          if (!reconnectTimer) return;
          await attemptReconnect();
          reconnectLoop();
        }, 5000);
      })();
    }
  } else {
    reconnectFailures = 0;
    hideUnreachableState();
    toast.textContent = 'Reconnected';
    toast.className = 'toast toast-ok visible';
    if (reconnectTimer) {
      if (reconnectTimer !== true) clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
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
 * differs from the current on-disk HEAD. No-op on the no-git fallback
 * (`startupSha === null`) or when the endpoint isn't available (older
 * server without the route).
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

  // A new `startedAt` means a different process is answering. The update pill
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
  let hint;
  // `unknown` = never measured, `failed` = measured and could not answer. Both
  // must be VISIBLE, not tooltip-only: `title` and `:hover` do not exist on a
  // touch device, and this dashboard is read mostly from a phone, so a
  // tooltip-only signal renders both states identically to "you are current" —
  // exactly the indistinguishability this work exists to remove.
  let mark = null;
  if (!data) {
    hint = "Couldn't reach the server to check for updates — tap to retry";
    mark = 'check-failed';
  } else if (!data.checkedAt) {
    hint = 'Not checked for updates yet — tap to check now';
    mark = 'check-unknown';
  } else if (data.checkOk === false) {
    hint = `Update check failed ${_agoLabel(data.checkedAt)} — tap to retry`;
    mark = 'check-failed';
  } else if (data.updateAvailable) {
    hint = `v${data.latestVersion} available — checked ${_agoLabel(data.checkedAt)}`;
  } else {
    hint = `Up to date — checked ${_agoLabel(data.checkedAt)}. Tap to check now`;
  }
  el.title = hint;
  el.classList.remove('check-unknown', 'check-failed');
  if (mark) el.classList.add(mark);
}

/**
 * Make the header version an explicit "check for updates now" control.
 *
 * The update pill only exists when an update exists, so before this there was
 * no way to tell a measured "you are current" from a check that never ran — the
 * absence of a pill was unfalsifiable from the UI, and an operator who suspected
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
      // No answer and a failed measurement are the same thing to an operator:
      // the question was not resolved. `api()` already returns null rather than
      // throwing for the first.
      if (!data || data.checkOk === false) {
        _showVersionLabel("couldn't check", true);
      } else if (data.updateAvailable) {
        // The pill is the real answer here and it has just been rendered, so the
        // label goes straight back to the version rather than duplicating it.
        _showVersionLabel(`v${_lastRenderedVersion || data.currentVersion}`, true);
      } else {
        _showVersionLabel('up to date ✓', true);
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

  // #235 — toggle the restart button visibility based on the
  // restart-mechanism token captured in loadServerInfo. The button is
  // hidden when no mechanism is available (e.g. Linux today,
  // bare-node), so operators on those hosts see text-only guidance
  // rather than an action that would 501.
  const restartBtn = document.getElementById('staleServerRestartBtn');
  if (restartBtn) {
    const mech = (typeof info.restartMechanism === 'string' && info.restartMechanism.length > 0)
      ? info.restartMechanism
      : null;
    if (mech) {
      restartBtn.classList.remove('hidden');
    } else {
      restartBtn.classList.add('hidden');
    }
  }
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
/**
 * POST /api/server/restart through the #583 wrap guard. The server
 * refuses (409 WRAP_RESTART_BLOCKED) while a wrap pipeline is mid-flight —
 * restarting then kills the wrap and orphans its AI content steps (the
 * 2026-07-16 incident). On that refusal, ask the operator explicitly and
 * retry with {force:true} only on a yes. Shared by the stale-server
 * restart (#235) and the update-and-restart flow (#229) so both gates
 * behave identically.
 *
 * @returns {Promise<object|null>} The restart response, or null when the
 *   POST failed / the operator declined to force.
 */
async function postServerRestart() {
  let resp = await apiMutate('/api/server/restart', 'POST', {});
  if (!resp && api.lastErrorCode === 'WRAP_RESTART_BLOCKED') {
    const proceed = window.confirm(
      `${api.lastError}\n\nForce the restart anyway? The running wrap will be killed mid-pipeline.`
    );
    if (!proceed) return null;
    resp = await apiMutate('/api/server/restart', 'POST', { force: true });
  }
  return resp;
}

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
    postResp = await postServerRestart();
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

  pollServerBackAndReload(oldStartedAt, () => {
    state.restartInFlight = false;
    setBtnState('Restart TangleClaw', false);
  });
}

/**
 * Poll `/api/server-info` until the process reports a `startedAt` different from
 * `oldStartedAt` (the new process is up), then full-reload so the browser picks
 * up any fresh static assets. Shared by `triggerServerRestart` (#235) and
 * `applyUpdateAndRestart` (UB, #228/#229).
 *
 * **No timer-driven blind reload** (no-UI-timers rule, #98/#268): without a
 * baseline `startedAt` we can't detect when the new process is actually up, so
 * we abort honestly (let the operator refresh) rather than reload onto a
 * possibly-dead server. `restore` clears the in-flight flag and restores the
 * caller's button on any give-up path.
 *
 * 30 polls at 500ms = 15s of patience; the restart itself typically takes ~3s.
 * Each poll tolerates a failed fetch (the in-between window when the old process
 * is dead but the new one hasn't bound the port yet).
 *
 * @param {string|null} oldStartedAt - Pre-restart `startedAt` baseline
 * @param {() => void} restore - Clears `restartInFlight` + restores the caller's button
 */
function pollServerBackAndReload(oldStartedAt, restore) {
  if (!oldStartedAt) {
    restore();
    window.alert('Could not read server state to confirm the restart. The server may still be coming back — refresh the page in a moment to check.');
    return;
  }
  const POLL_INTERVAL_MS = 500;
  const POLL_MAX_ATTEMPTS = 30;
  let attempt = 0;
  const poll = setInterval(async () => {
    attempt++;
    try {
      const info = await api('/api/server-info');
      if (info && info.startedAt && info.startedAt !== oldStartedAt) {
        clearInterval(poll);
        window.location.reload();
        return;
      }
    } catch { /* expected during the dead window */ }
    if (attempt >= POLL_MAX_ATTEMPTS) {
      clearInterval(poll);
      restore();
      window.alert('Restart did not complete within 15 seconds. The server may still be coming back — refresh in a moment.');
    }
  }, POLL_INTERVAL_MS);
}

/**
 * Fetch update status and show notification pill if an update is available.
 * Dismissed state is persisted in localStorage keyed by version. The version
 * text is wrapped in an anchor to the GitHub release page (#149) when the
 * backend supplies a `releaseUrl` — falls back to plain text otherwise so
 * pre-#149 servers or non-GitHub remotes still surface the notification.
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
  const pill = document.getElementById('updatePill');
  renderVersionCheckHint(data);

  // A failed request, and a server that has not run its first check yet, are
  // both "no answer" — not "no update". `startChecker` waits 60s before its
  // first check and reports `{updateAvailable: false, checkedAt: null}` until
  // then, which is precisely the window the restart-triggered re-check lands
  // in. Hiding on that takes down a pill for an update that is still genuinely
  // available. `checkedAt` is the discriminator, and the payload already
  // carries it.
  if (!data || !data.checkedAt) return data;

  // Past that, "no update" is a real answer and every path that reaches it must
  // take down a pill that is showing — this function re-runs after a restart,
  // and the state it most often re-runs into is "the update you were offering
  // is now installed".
  if (!data.updateAvailable || !data.latestVersion) {
    if (pill) pill.classList.add('hidden');
    return data;
  }

  const dismissKey = `tc_updateDismissed_${data.latestVersion}`;
  if (localStorage.getItem(dismissKey)) {
    if (pill) pill.classList.add('hidden');
    return data;
  }

  if (!pill) return data;

  const versionLabel = `v${esc(data.latestVersion)}`;
  const versionHtml = data.releaseUrl
    ? `<a class="update-pill-link" href="${esc(data.releaseUrl)}" target="_blank" rel="noopener noreferrer" title="View release notes">${versionLabel}</a>`
    : versionLabel;

  pill.innerHTML = `${versionHtml} available `
    + `<button class="update-pill-apply" id="updateApplyBtn">Update &amp; restart</button> `
    + `<button class="update-pill-dismiss" aria-label="Dismiss">&times;</button>`;
  pill.classList.remove('hidden');

  // UB (#228/#229): the actionable self-update. The git fetch+checkout is the
  // server-side action this button adds; the restart half reuses the proven
  // #235 path. The data closure carries the target version for the confirm.
  const applyBtn = pill.querySelector('#updateApplyBtn');
  if (applyBtn) {
    applyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      applyUpdateAndRestart(data);
    });
  }

  pill.querySelector('.update-pill-dismiss').addEventListener('click', (e) => {
    e.stopPropagation();
    pill.classList.add('hidden');
    localStorage.setItem(dismissKey, '1');
  });

  return data;
}

/**
 * UB (#228/#229): apply the latest release, then restart onto it — one operator
 * gesture. `POST /api/update/apply` (fetch + checkout the tag) → on success
 * `POST /api/server/restart` (the existing #235 path) → poll `/api/server-info`
 * until the new process is up → full reload onto the fresh assets. A refused
 * safety guard (409: dirty tree / no update / wrong ref / no git) surfaces its
 * reason and restores the button; the working tree is never touched on a refusal.
 *
 * Idempotent via `state.restartInFlight` (shared with the #235 stale-server
 * restart, so the two paths can't fire concurrently).
 *
 * @param {object} data - The /api/update-status payload (carries latestVersion)
 * @returns {Promise<void>}
 */
async function applyUpdateAndRestart(data) {
  if (state.restartInFlight) return;

  const setBtn = (label, disabled) => {
    const btn = document.getElementById('updateApplyBtn');
    if (btn) { btn.textContent = label; btn.disabled = disabled; }
  };

  const proceed = window.confirm(
    `Update TangleClaw to v${data.latestVersion} and restart?\n\n` +
    'TC fetches the release, switches the checkout to it, and restarts. Active tmux ' +
    'sessions survive; the browser reconnects when the server returns (~3 seconds).'
  );
  if (!proceed) return;

  state.restartInFlight = true;
  setBtn('Updating…', true);

  // 1. Apply — fetch + checkout the latest tag (no restart yet).
  let applyResp;
  try {
    applyResp = await apiMutate('/api/update/apply', 'POST', {});
  } catch (err) {
    state.restartInFlight = false;
    setBtn('Update & restart', false);
    window.alert(`Update failed: ${err && err.message ? err.message : 'request did not complete'}`);
    return;
  }
  if (!applyResp || !applyResp.ok) {
    state.restartInFlight = false;
    setBtn('Update & restart', false);
    const msg = (applyResp && applyResp.error) || api.lastError || 'unknown error';
    window.alert(`Update not applied: ${msg}`);
    return;
  }

  // 2. Capture the baseline startedAt, then restart onto the new code.
  setBtn('Restarting…', true);
  const appliedLabel = applyResp.toRef || `v${data.latestVersion}`;
  let oldStartedAt = null;
  try {
    const pre = await api('/api/server-info');
    if (pre && pre.startedAt) oldStartedAt = pre.startedAt;
  } catch { /* fall through to the manual-restart message below */ }

  let restartResp;
  try {
    restartResp = await postServerRestart();
  } catch (err) {
    restartResp = null;
    api.lastError = err && err.message;
  }
  if (!restartResp || !restartResp.ok) {
    // The code IS updated on disk; only the auto-restart didn't fire (e.g. no
    // restart mechanism on this host). Degrade honestly to the #199 stale path.
    state.restartInFlight = false;
    setBtn('Update & restart', false);
    const msg = (restartResp && restartResp.error) || api.lastError || 'no restart mechanism';
    window.alert(`Updated to ${appliedLabel} on disk, but auto-restart didn't run (${msg}). Restart TangleClaw to finish.`);
    return;
  }

  // 3. Poll until the new process reports a fresh startedAt, then reload —
  // via the shared helper (no timer-driven blind reload; #98/#268).
  pollServerBackAndReload(oldStartedAt, () => {
    state.restartInFlight = false;
    setBtn('Update & restart', false);
  });
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
    status.textContent = 'Save failed';
    status.className = 'rules-status rules-status-err';
  }
  status.classList.remove('hidden');
  setTimeout(() => { status.classList.add('hidden'); }, 3000);
}

/**
 * Reset global rules to defaults via the API.
 */
async function resetGlobalRules() {
  const data = await apiMutate('/api/rules/global/reset', 'POST', {});
  const status = document.getElementById('rulesStatus');
  if (data) {
    state.globalRulesContent = data.content || '';
    document.getElementById('rulesEditor').value = state.globalRulesContent;
    status.textContent = 'Reset to defaults';
    status.className = 'rules-status rules-status-ok';
  } else {
    status.textContent = 'Reset failed';
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

async function loadProjects() {
  const data = await api('/api/projects?archived=true');
  if (!data) return;
  state.projects = (data.projects || []).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  // Kept as sent, including on the healthy path — a field that only appears on
  // failure makes every reader probe for its existence instead of reading its
  // value. `renderRootPanel` decides what to draw; this only stops the answer
  // being discarded, which is what made a short list indistinguishable from a
  // complete one.
  state.projectsScan = data.scan || null;
  collectTags();
  renderProjects();
  renderSessionCount();
  updateUnregisteredToggle();

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
        toast.textContent = 'Repair failed (no response)';
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

async function launchProject(name) {
  const project = state.projects.find(p => p.name === name);
  if (project && project.session && project.session.active) {
    return navigateToSession(name);
  }

  // Check if engine has launch modes — show picker if so. Disabled modes
  // (Phase 1 of #210 ships openclaw's launchModes block scaffolded but with
  // every mode marked `disabled: true` until Phase 2 wires the propagation
  // to ClawBridge through the SSH tunnel) don't count toward the picker
  // gate; an engine whose modes are ALL disabled launches with no mode.
  // #459: openclaw engines are pickerHidden and absent from state.engines,
  // so a legacy openclaw-bound project skips the mode picker here and
  // launches with default mode — acceptable degradation for a deprecated
  // binding pattern (zero such projects existed at cutover).
  // Per-project picker opt-out: launch directly with no mode picker. The mode
  // is deliberately NOT sent — the server resolves the project's configured
  // defaultLaunchMode (lib/sessions.js), keeping one resolution path for the
  // UI, ClawBridge, and raw API launches alike.
  if (project && project.showLaunchModePicker === false) {
    return doLaunchProject(name, null);
  }

  const engineId = project ? (project.engineId || (state.config && state.config.defaultEngine) || 'claude') : 'claude';
  const engine = (state.engines || []).find(e => e.id === engineId);
  if (engine && engine.launchModes) {
    const enabledModes = Object.values(engine.launchModes).filter(m => !m.disabled);
    if (enabledModes.length > 1) {
      openLaunchModeModal(name, engine);
      return;
    }
  }

  await doLaunchProject(name, null);
}

/**
 * Execute the actual session launch with optional launch mode.
 * @param {string} name - Project name
 * @param {string|null} launchMode - Launch mode key or null for default
 */
async function doLaunchProject(name, launchMode) {
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
function openLaunchModeModal(name, engine) {
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
  await doLaunchProject(name, mode);
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
      // Failure — surface inline and let `finally` re-enable so the operator
      // can fix (e.g. wrong password) and retry without reopening.
      document.getElementById('wrapError').textContent = 'Wrap failed. Check password.';
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
  // until that timer next fired — up to four hours of a page that had been
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
  // Deliberately still a plain cache read, NOT a re-measurement: turning this
  // into one would mean a `git ls-remote` every five minutes for the life of
  // every open tab. Freshness is event-driven instead — page load and the
  // visibility handler below — with the server's periodic check as the floor.
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
