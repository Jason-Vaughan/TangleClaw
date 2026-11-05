'use strict';

/*
 * Session History UI (#2830, #2074 Slice 2) — a distinct, accessible badge
 * for a session's transcript provenance: filled in afterwards from the
 * harness's native log, or present from the session's own live capture.
 *
 * Depends on the global `esc` from landing.js/ui.js (HTML-escape), the same
 * dependency `public/history-drawer.js` already declares.
 *
 * Wiring this into the actual drawer render call
 * (`public/history-drawer.js`'s "cold" badge) is tracked as a later slice --
 * that file is not in this one's envelope. No new CSS class is introduced
 * either: `badge-git`, the class the drawer's existing "cold" badge already
 * uses for "Transcript captured", is reused here so the two provenance
 * badges stay distinct by their own text and title, not by a new color
 * `public/style.css` (out of this envelope) would otherwise need to define.
 */

/**
 * The provenance badge for a session's transcript, or '' when the session
 * has none at all -- the plain "no transcript" case is the drawer's own to
 * say, as it already does.
 * @param {{captured: boolean, source?: ('native-log-backfill'|'live-pane-capture'),
 *   engine?: string, backfilledAt?: string, capturedAt?: string}|null} transcript -
 *   `lib/session-history-backfill.js#ensureSessionTranscript`'s result
 * @returns {string}
 */
function transcriptSourceBadge(transcript) {
  if (!transcript || !transcript.captured) return '';
  const engine = esc(transcript.engine || 'this harness');
  if (transcript.source === 'native-log-backfill') {
    const when = transcript.backfilledAt ? ` on ${esc(transcript.backfilledAt)}` : '';
    return `<span class="badge badge-git" title="Filled in afterwards from ${engine}'s native log${when} -- not captured live during the session">native-log</span>`;
  }
  if (transcript.source === 'live-pane-capture') {
    const when = transcript.capturedAt ? ` (${esc(transcript.capturedAt)})` : '';
    return `<span class="badge badge-git" title="Captured live during the session${when}">live-capture</span>`;
  }
  return '';
}
