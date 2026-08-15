'use strict';
/* ── TangleClaw — the update beacon (#931) ── */
/* One update surface for every page. Loaded as a plain script before the  */
/* page script, exposing one factory on `window`.                          */

(function (global) {
  // How long the first pop stays up, and how long its fade takes. Both are
  // CSS-class flips on the toast and nothing else — see the timer rule below.
  const POP_VISIBLE_MS = 3000;
  const FADE_MS = 450;

  /**
   * Create the update beacon for a page.
   *
   * TangleClaw used to announce an update two different ways: a pill in the
   * dashboard header, and a much quieter badge in the session banner whose
   * single un-confirmed tap fired agent instructions. The dashboard pill is
   * the real control and is invisible from the session page, which is where
   * an operator actually works — so the surface that could act was the one
   * nobody saw. Field installs learn that a release exists through this
   * surface, so it has to be the same thing in both places (#931).
   *
   * The beacon is that one thing: a toast that pops from the logo once per
   * detected version, fades on its own, and leaves a red dot on the logo
   * that persists until the update is applied. Clicking the dot re-opens the
   * toast, so the fade loses nothing.
   *
   * **The timer rule.** `feedback_no_ui_timers` (#98/#268) bans timer-driven
   * UI lifecycle, and the auto-fade is inside that ban's boundary rather than
   * an exception to it: a timer here may only change the visibility of a
   * notification whose state is preserved elsewhere. The dot is that
   * elsewhere — set at the same moment the toast pops, never touched by a
   * timer. No timer navigates, dismisses durable state, or invokes an action.
   * `test/update-beacon.test.js` asserts this by inspecting what every
   * scheduled callback touches, rather than trusting this paragraph.
   *
   * @param {object} deps
   * @param {Document} deps.doc - The page document.
   * @param {string} deps.anchorId - Id of the positioned element wrapping the
   *   logo. Resolved on every use, never captured: the dashboard's logo has an
   *   `onerror` swap, and the #235 lesson is that a reference captured at wire
   *   time goes stale under exactly the surfaces that replace themselves.
   * @param {Function} deps.api - The page's `api()` from `tcCreateApi`.
   * @param {Function} deps.apiMutate - The page's `apiMutate()`.
   * @param {() => boolean} deps.getInFlight - Reads the page's restart latch.
   * @param {(v: boolean) => void} deps.setInFlight - Writes it. The dashboard
   *   passes accessors over `state.restartInFlight`, which the #235
   *   stale-server restart also holds, so the two paths still cannot fire
   *   concurrently. A latch owned in here would have silently unbound that.
   * @param {{postServerRestart: Function, pollServerBackAndReload: Function}}
   *   deps.restart - The page's restart plumbing from `tcCreateRestartFlow`.
   *   Injected rather than owned: the dashboard's stale-server restart (#235)
   *   drives those same two functions and is not the beacon.
   * @param {(data: object) => string} [deps.confirmText] - The update confirm's
   *   body, so each page can say what its own surface does during the restart.
   * @param {{label: string, run: (data: object) => void}} [deps.secondaryAction] -
   *   An extra action offered ONLY in the re-opened toast (the session page's
   *   "Ask the agent", #730). The first pop stays single-action deliberately:
   *   the badge it replaces fired agent instructions on one mis-tappable chip.
   * @returns {{render: Function, reopen: Function, apply: Function}}
   */
  function tcCreateUpdateBeacon(deps) {
    const doc = deps.doc;
    const api = deps.api;
    const apiMutate = deps.apiMutate;
    // No defaults, deliberately. A page that forgets these would get a beacon
    // whose apply is no longer idempotent — the exact property the injected
    // latch exists to preserve — and nothing would say so. A TypeError at
    // construction is the honest failure.
    const getInFlight = deps.getInFlight;
    const setInFlight = deps.setInFlight;
    const restart = deps.restart;
    const secondary = deps.secondaryAction || null;
    const confirmText = deps.confirmText || ((data) =>
      `Update TangleClaw to v${data.latestVersion} and restart?\n\n`
      + 'TC fetches the release, switches the checkout to it, and restarts. Active tmux '
      + 'sessions survive; the browser reconnects when the server returns (~3 seconds).');

    // The version the toast has already popped for, so a 60s poll re-rendering
    // the same answer does not re-pop it every minute. Per page load by
    // design: a reload is a fresh chance to be told, and the dot is what
    // carries the fact across the quiet in between.
    let poppedVersion = null;
    // The payload the dot currently stands for — the beacon's durable state,
    // and what `reopen` re-renders from. Null means no dot is showing.
    let current = null;
    let fadeTimer = null;
    let removeTimer = null;
    // One warning, not one per poll: `render` runs every 5 minutes on the
    // dashboard and a per-call warn would bury the console.
    let warnedMissingAnchor = false;

    /** @returns {Element|null} The wrapper the dot and toast live in. */
    function anchorEl() {
      return doc.getElementById(deps.anchorId);
    }

    /** @returns {Element|null} The toast element, if it exists yet. */
    function toastEl() {
      const a = anchorEl();
      return a ? a.querySelector('.beacon-toast') : null;
    }

    /** Cancel the pop's fade timers. Called before any state change. */
    function clearTimers() {
      if (fadeTimer) global.clearTimeout(fadeTimer);
      if (removeTimer) global.clearTimeout(removeTimer);
      fadeTimer = null;
      removeTimer = null;
    }

    /** Take the toast down now, leaving the dot alone. */
    function hideToast() {
      clearTimers();
      const t = toastEl();
      if (t) t.remove();
    }

    /**
     * Show or hide the dot for a version.
     * @param {object|null} data - The update-status payload, or null to clear.
     */
    function setDot(data) {
      const a = anchorEl();
      if (!a) return;
      let dot = a.querySelector('.beacon-dot');
      if (!data) {
        if (dot) dot.remove();
        return;
      }
      if (!dot) {
        dot = doc.createElement('button');
        dot.type = 'button';
        dot.className = 'beacon-dot';
        dot.addEventListener('click', (e) => {
          e.stopPropagation();
          reopen();
        });
        a.appendChild(dot);
      }
      // A real button with a real name: the dot is the only thing left on
      // screen once the toast fades, so it has to be reachable by keyboard and
      // announced as actionable — the badge it replaces was neither.
      dot.setAttribute('aria-label',
        `Update available: v${data.latestVersion}. Show details.`);
      dot.title = `v${data.latestVersion} available`;
    }

    /**
     * Only http(s) release URLs become links.
     *
     * The href is server-supplied and `esc()` — what the pill used — escapes
     * markup without constraining the scheme, so a `javascript:` value would
     * have survived it. Cheap to refuse here, and a missing link degrades to
     * plain text exactly as it does for a non-GitHub remote (#149).
     *
     * @param {string} url - Candidate release URL.
     * @returns {boolean}
     */
    function isSafeReleaseUrl(url) {
      return typeof url === 'string' && /^https?:\/\//i.test(url);
    }

    /**
     * Build and show the toast.
     *
     * Composed from DOM nodes rather than an HTML string: the version and the
     * release URL come off the wire, and `textContent` cannot be made to
     * render markup the way a hand-escaped template can be got wrong.
     *
     * @param {object} data - The update-status payload.
     * @param {boolean} reopened - True for the dot-driven re-open, which earns
     *   a ✕ and the secondary action and does NOT auto-fade; false for the
     *   first pop, which fades and stays single-action.
     */
    function showToast(data, reopened) {
      const a = anchorEl();
      if (!a) return;
      hideToast();

      const toast = doc.createElement('div');
      toast.className = 'beacon-toast';
      // `status`, not `alert`: an available update is information, and an
      // assertive live region would interrupt whatever a screen-reader user
      // was doing to say so.
      toast.setAttribute('role', 'status');

      const label = doc.createElement('span');
      label.className = 'beacon-toast-version';
      const versionText = `v${data.latestVersion}`;
      if (isSafeReleaseUrl(data.releaseUrl)) {
        const link = doc.createElement('a');
        link.href = data.releaseUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.title = 'View release notes';
        link.textContent = versionText;
        label.appendChild(link);
      } else {
        label.textContent = versionText;
      }
      const rest = doc.createElement('span');
      rest.textContent = ' update available';
      label.appendChild(rest);
      toast.appendChild(label);

      const applyBtn = doc.createElement('button');
      applyBtn.type = 'button';
      applyBtn.className = 'beacon-toast-apply';
      // Rendered FROM the latch, not as a constant. A toast re-opened during
      // an update would otherwise offer an enabled "Update now" whose handler
      // returns immediately on the in-flight guard — no alert, no label
      // change, so the operator cannot tell whether anything is happening.
      applyBtn.textContent = getInFlight() ? 'Updating…' : 'Update now';
      applyBtn.disabled = getInFlight();
      applyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        applyUpdateAndRestart(data);
      });
      toast.appendChild(applyBtn);

      if (reopened && secondary) {
        const link = doc.createElement('button');
        link.type = 'button';
        link.className = 'beacon-toast-secondary';
        link.textContent = secondary.label;
        link.addEventListener('click', (e) => {
          e.stopPropagation();
          secondary.run(data);
        });
        toast.appendChild(link);
      }

      if (reopened) {
        const close = doc.createElement('button');
        close.type = 'button';
        close.className = 'beacon-toast-close';
        close.setAttribute('aria-label', 'Dismiss');
        close.textContent = '×';
        close.addEventListener('click', (e) => {
          e.stopPropagation();
          hideToast();
        });
        toast.appendChild(close);
      }

      a.appendChild(toast);

      if (reopened) return;
      // The two timers, and the whole of what they are allowed to do: add a
      // class, then remove the element. The dot is untouched by both, which is
      // what makes the fade lossless.
      fadeTimer = global.setTimeout(() => {
        fadeTimer = null;
        const t = toastEl();
        if (t) t.classList.add('fading');
      }, POP_VISIBLE_MS);
      removeTimer = global.setTimeout(() => {
        removeTimer = null;
        const t = toastEl();
        if (t) t.remove();
      }, POP_VISIBLE_MS + FADE_MS);
    }

    /**
     * Re-open (or close) the toast from the dot.
     *
     * A no-op when no dot is showing: without a live update there is nothing
     * to re-open, and clicking a logo that is not announcing anything should
     * do nothing at all.
     *
     * @returns {void}
     */
    function reopen() {
      if (!current) return;
      if (toastEl()) {
        // While an update is running the toast is not a notice to toggle — it
        // is the only place "Updating…" and "Restarting…" appear. Letting a
        // tap tear it down leaves a 3-15s operation with no surface at all.
        if (getInFlight()) return;
        hideToast();
        return;
      }
      showToast(current, true);
    }

    /**
     * Render an `/api/update-status` payload onto the beacon.
     *
     * @param {object|null} data - The payload, or null when the request failed.
     * @returns {void}
     */
    function render(data) {
      // THREE ways a payload can fail to be an answer, and all three must
      // leave the beacon exactly as it is. Only the third was obvious:
      //
      //   no payload      — the request itself did not complete.
      //   no `checkedAt`  — `startChecker` waits 60s before its first check
      //                     and reports `{updateAvailable: false,
      //                     checkedAt: null}` until then (#716).
      //   `checkOk: false`— a check that RAN and could not measure. It carries
      //                     a real `checkedAt` and `updateAvailable: false`,
      //                     so discriminating on `checkedAt` alone reads an
      //                     offline box as "you are up to date" and takes the
      //                     dot down for an update that is genuinely there.
      //                     `lib/update-checker.js#_buildStatus` says the rule
      //                     outright: a check that failed and a check that
      //                     succeeded and found nothing are different facts.
      //                     Reachable from the 4-hour checker's cached failure
      //                     on every later GET, and from a focus/reconnect
      //                     re-check.
      //
      // Unknown is not a fact. Nothing here may render it as one.
      if (!data || !data.checkedAt || data.checkOk === false) return;

      // An anchor that is not there is not "nothing to do" — it is this
      // feature failing exactly the way #931 exists to prevent, reached by a
      // new door: renamed in a header refactor, and the beacon renders nothing
      // forever with nothing in the console. Every other consumer of
      // `anchorEl()` returns quietly by design (a throw at page-script load
      // takes the rest of the page's wiring with it); this says so once.
      if (!anchorEl() && !warnedMissingAnchor) {
        warnedMissingAnchor = true;
        console.warn(
          `update beacon: no #${deps.anchorId} in this page — an available `
          + 'update cannot be shown. The logo wrapper was probably renamed or removed.'
        );
      }

      if (!data.updateAvailable || !data.latestVersion) {
        // A real answer, and every path that reaches it must clear a beacon
        // that is showing — this re-runs after a restart, and the state it
        // most often re-runs into is "the update you were offering is now
        // installed".
        current = null;
        poppedVersion = null;
        hideToast();
        setDot(null);
        return;
      }

      current = data;
      setDot(data);
      if (poppedVersion === data.latestVersion) return;
      poppedVersion = data.latestVersion;
      showToast(data, false);
    }

    /**
     * Set the apply button's label and disabled state, re-querying it each
     * time. The toast can be re-rendered or removed mid-flight (the fade, a
     * re-open), so a reference captured at click time goes stale — the same
     * re-query rule the #235 restart button learned.
     *
     * @param {string} labelText - Button label.
     * @param {boolean} disabled - Whether to disable it.
     */
    function setApplyLabel(labelText, disabled) {
      const a = anchorEl();
      const btn = a ? a.querySelector('.beacon-toast-apply') : null;
      if (btn) {
        btn.textContent = labelText;
        btn.disabled = disabled;
      }
    }

    /**
     * Apply the latest release, then restart onto it — one operator gesture
     * (#228/#229). `POST /api/update/apply` (fetch + checkout the tag) → on
     * success `POST /api/server/restart` (the #235 path) → poll
     * `/api/server-info` until the new process is up → full reload onto the
     * fresh assets. A refused safety guard (409: dirty tree / no update /
     * wrong ref / no git) surfaces its reason and restores the button; the
     * working tree is never touched on a refusal.
     *
     * Idempotent via the page's in-flight latch, which on the dashboard is the
     * same one the #235 stale-server restart holds.
     *
     * @param {object} data - The `/api/update-status` payload (carries
     *   `latestVersion`).
     * @returns {Promise<void>}
     */
    async function applyUpdateAndRestart(data) {
      if (getInFlight()) return;

      const proceed = global.confirm(confirmText(data));
      if (!proceed) return;

      // The toast stops being a notice the moment the operator accepts: it is
      // now the only place "Updating…" and "Restarting…" are shown. Left alone,
      // the first pop's fade would take it off screen three seconds in — the
      // operator would watch the thing they just pressed disappear with the
      // update still running. Declining does NOT come here, so a declined
      // confirm still fades on its original schedule, which is right: they
      // have seen it and answered it.
      clearTimers();

      setInFlight(true);
      setApplyLabel('Updating…', true);

      // 1. Apply — fetch + checkout the latest tag (no restart yet).
      let applyResp;
      try {
        applyResp = await apiMutate('/api/update/apply', 'POST', {});
      } catch (err) {
        setInFlight(false);
        setApplyLabel('Update now', false);
        global.alert(`Update failed: ${err && err.message ? err.message : 'request did not complete'}`);
        return;
      }

      // A dirty tree blocked only by TangleClaw's own files (#711): the
      // structured refusal names them, and the operator can discard-and-update
      // in one confirmed step. One real-work path anywhere keeps the hard
      // refusal — then the honest move is showing WHICH files, so "commit or
      // stash" stops being advice about invisible things. `api()` returns null
      // for a 409, so the refusal body arrives through the `api.lastBody` side
      // channel — reading `applyResp.dirty` instead was dead code (#928 R-1).
      const refusal = applyResp || (api.lastErrorCode === 'dirty-tree' ? api.lastBody : null);
      if (refusal && !refusal.ok && refusal.code === 'dirty-tree' && refusal.dirty) {
        const d = refusal.dirty;
        if (d.realWork.length === 0 && d.discardable.length > 0) {
          const proceedDiscard = global.confirm(
            'The update is blocked only by files TangleClaw itself wrote:\n\n'
            + d.discardable.map((f) => `  ${f}`).join('\n')
            + '\n\nDiscard these files and update? Nothing of yours is in this list — '
            + 'anything TangleClaw could not prove it wrote would have blocked instead.'
          );
          if (proceedDiscard) {
            try {
              applyResp = await apiMutate('/api/update/apply', 'POST', { discardDirty: true });
            } catch (err) {
              setInFlight(false);
              setApplyLabel('Update now', false);
              global.alert(`Update failed: ${err && err.message ? err.message : 'request did not complete'}`);
              return;
            }
          }
        } else if (d.realWork.length > 0) {
          setInFlight(false);
          setApplyLabel('Update now', false);
          global.alert(
            'Update not applied: the checkout has local changes that might be someone\'s work, '
            + 'so nothing was touched.\n\nIn the way:\n'
            + d.realWork.map((f) => `  ${f}`).join('\n')
            + (d.discardable.length
              ? '\n\nAlso present (TangleClaw-written, discardable once the above are resolved):\n'
                + d.discardable.map((f) => `  ${f}`).join('\n')
              : '')
            + '\n\nCommit or stash them in the install directory, then update again.'
          );
          return;
        }
      }

      if (!applyResp || !applyResp.ok) {
        setInFlight(false);
        setApplyLabel('Update now', false);
        const msg = (applyResp && applyResp.error) || api.lastError || 'unknown error';
        global.alert(`Update not applied: ${msg}`);
        return;
      }

      // Provisioning this update cannot do for you (#711): deploy assets are
      // never applied from the server (re-running install steps walks into the
      // Full-Disk-Access silent hang), and a dependency manifest appearing
      // means the release reversed the zero-npm-dep norm — the updater reports
      // it, it does not become an npm executor. The one honest move is to say
      // so BEFORE the restart, while the operator is watching. The alert
      // blocks until acknowledged; the restart then proceeds.
      const prov = applyResp.provisioning;
      if (prov && prov.action === 'manual') {
        const lines = [];
        if (prov.assetsChanged && prov.assetsChanged.length > 0) {
          lines.push('Deploy assets changed — after the restart, re-run the matching deploy steps '
            + 'on the server machine (see deploy/install.sh):');
          for (const f of prov.assetsChanged) lines.push(`  ${f}`);
        }
        if (prov.manifestChanged) {
          lines.push('This release introduced or changed a dependency manifest (package.json). '
            + 'TangleClaw does not run npm for you — install dependencies manually in the repo '
            + 'before relying on the new version.');
        }
        global.alert('This release needs manual steps the update does not perform itself:\n\n'
          + lines.join('\n'));
      }

      // 2. Capture the baseline startedAt, then restart onto the new code.
      setApplyLabel('Restarting…', true);
      const appliedLabel = applyResp.toRef || `v${data.latestVersion}`;
      let oldStartedAt = null;
      try {
        const pre = await api('/api/server-info');
        if (pre && pre.startedAt) oldStartedAt = pre.startedAt;
      } catch { /* fall through to the manual-restart message below */ }

      let restartResp;
      let restartErr = null;
      try {
        restartResp = await restart.postServerRestart();
      } catch (err) {
        restartResp = null;
        // A local, not `api.lastError`. That field is an OUTPUT of the api
        // helper, cleared on every success; writing it from a consumer means a
        // later reader can be shown a message no `api()` call produced. It was
        // survivable while this lived in landing.js beside the helper's only
        // other readers — not now that a shared module does it on both pages.
        restartErr = err && err.message;
      }
      if (!restartResp || !restartResp.ok) {
        // The code IS updated on disk; only the auto-restart didn't fire (e.g.
        // no restart mechanism on this host). Degrade honestly to the #199
        // stale path.
        setInFlight(false);
        setApplyLabel('Update now', false);
        const msg = (restartResp && restartResp.error) || restartErr || api.lastError || 'no restart mechanism';
        global.alert(`Updated to ${appliedLabel} on disk, but auto-restart didn't run (${msg}). Restart TangleClaw to finish.`);
        return;
      }

      // 3. Poll until the new process reports a fresh startedAt, then reload —
      // on the observed change, never on a timer alone (#98/#268).
      restart.pollServerBackAndReload(oldStartedAt, () => {
        setInFlight(false);
        setApplyLabel('Update now', false);
      });
    }

    return { render, reopen, apply: applyUpdateAndRestart };
  }

  global.tcCreateUpdateBeacon = tcCreateUpdateBeacon;
})(typeof window !== 'undefined' ? window : globalThis);
