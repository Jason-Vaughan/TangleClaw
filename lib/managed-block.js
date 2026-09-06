'use strict';

/**
 * Splicing TangleClaw's generated content into a file it co-owns with another
 * writer — the operator, `next dev`, a plugin — by delimiting one region with a
 * marker pair and never touching a byte outside it.
 *
 * Deliberately marker-agnostic, and deliberately a leaf module with no imports.
 * Two callers splice a managed block: the engine-config layer, which derives
 * its pair from the host file's comment syntax, and the wrap pipeline's priming
 * roll, which carries its own literal pair. They need the SAME answer to "what
 * does a broken marker set mean", and they only get it by sharing this code
 * rather than by review — for a while they disagreed, one refusing where the
 * other appended. Having no imports is what lets a `lib/wrap-steps/` handler
 * require it at module top: routing through the engine layer would close the
 * `projects → sessions → wrap-pipeline → wrap-steps` require cycle.
 *
 * Note that "is this file provably ours?" is a different question with a
 * deliberately stricter answer, and does not belong here: a containment check
 * refuses everything it cannot establish, where a splice has to leave the file
 * writable.
 */

/**
 * Why a marker pair cannot delimit a region at all.
 *
 * A caller mistake, not a file condition — the scan below walks occurrences of
 * two distinct strings, so a pair that is identical or that nests would make it
 * silently unsound rather than wrong in a visible way.
 *
 * @param {{begin: string, end: string}} markers - Candidate marker pair
 * @returns {string|null} The fault, or null when the pair is usable
 */
function _markerFault(markers) {
  if (!markers || !markers.begin || !markers.end) {
    return 'managed-block markers are missing a begin or end form';
  }
  if (markers.begin === markers.end) {
    return 'managed-block begin and end markers are identical, so no region can be delimited';
  }
  if (markers.begin.includes(markers.end) || markers.end.includes(markers.begin)) {
    return 'managed-block markers overlap — one contains the other, so a scan cannot tell them apart';
  }
  return null;
}

/**
 * Locate every span of `text` that belongs to TangleClaw, in document order.
 *
 * A span is either a COMPLETE region (a begin and the end that closes it, with
 * the generated body between them) or a STRAY marker — a begin nothing closed,
 * or an end nothing opened. The distinction is what makes repair safe: a
 * complete region's body is ours to replace, while the text around a stray
 * marker belongs to whoever else writes this file and is never ours to touch.
 *
 * @param {string} text - File contents to scan
 * @param {{begin: string, end: string}} markers - The pair delimiting our region
 * @returns {Array<{start: number, stop: number, complete: boolean}>} Spans in
 *   document order; `start`/`stop` bound the marker text and, for a complete
 *   region, everything between the two markers.
 */
function _managedSpans(text, markers) {
  const events = [];
  for (const kind of ['begin', 'end']) {
    const marker = markers[kind];
    let at = text.indexOf(marker);
    while (at !== -1) {
      events.push({ kind, start: at, stop: at + marker.length });
      at = text.indexOf(marker, at + marker.length);
    }
  }
  events.sort((a, b) => a.start - b.start);

  const spans = [];
  let open = null;
  for (const event of events) {
    if (event.kind === 'begin') {
      // A second begin arriving before any end means the first never closed.
      // Only the marker itself is ours; what followed it is someone's content.
      if (open) spans.push({ start: open.start, stop: open.stop, complete: false });
      open = event;
    } else if (open) {
      spans.push({ start: open.start, stop: event.stop, complete: true });
      open = null;
    } else {
      spans.push({ start: event.start, stop: event.stop, complete: false });
    }
  }
  if (open) spans.push({ start: open.start, stop: open.stop, complete: false });
  return spans;
}

/**
 * Read back the body currently inside a well-formed managed region.
 *
 * @param {string} text - File contents
 * @param {{begin: string, end: string}} markers - The pair delimiting our region
 * @returns {string|null} The body between the first complete pair's markers, or
 *   null when the file holds no complete pair. Null is "no block established
 *   here", never an empty block — a caller comparing bodies to detect drift
 *   must be able to tell those apart.
 */
function extractManagedBlock(text, markers) {
  if (_markerFault(markers)) return null;
  const span = _managedSpans(text, markers).find((candidate) => candidate.complete);
  if (!span) return null;
  return text.slice(span.start + markers.begin.length, span.stop - markers.end.length);
}

/**
 * Splice generated content into a file another writer also owns, touching only
 * the region between our markers.
 *
 * Everything outside a complete region is returned byte for byte — that is the
 * whole contract, and the reason this exists: a whole-file write destroyed a
 * hand-written `AGENTS.md` and would fight `next dev`, which re-adds its own
 * block to the same file on every run.
 *
 * **A marker set that is not one begin followed by one end is REPAIRED.** The
 * result always holds exactly one well-formed pair, so a second pass over it is
 * byte-identical. That idempotence is the point. Appending a fresh block around
 * a malformed pair grows the file by one stale block every run, forever;
 * refusing leaves the region silently frozen until a human notices. Repair
 * needs neither, and it guesses nothing:
 *
 *   - The first complete region carries the new body; any later one is a stale
 *     copy of our own output and is dropped, markers and all.
 *   - A stray marker is ours, so the marker text goes, but the content on
 *     either side of it is someone else's and survives untouched.
 *
 * The one thing repair deletes is the body of a complete region — content
 * between our own markers, which every caller already documents as regenerated
 * on each run. Anything an operator wants to keep belongs outside them.
 *
 * @param {string} existing - Current file contents (may be empty)
 * @param {string} blockBody - Generated content to place inside the markers
 * @param {{begin: string, end: string}} markers - The pair delimiting our region
 * @param {{bodySourceHint?: string}} [options] - `bodySourceHint` is appended to
 *   the marker-literal refusal to name where a caller's body comes from, since
 *   only the caller knows which of its inputs could have carried a marker.
 * @returns {{merged: string|null, error: string|null}} `merged` is the full new
 *   file contents; `error` is set instead when the splice cannot be attempted,
 *   and then nothing should be written.
 */
function spliceManagedBlock(existing, blockBody, markers, options = {}) {
  const fault = _markerFault(markers);
  if (fault) return { merged: null, error: fault };

  // The body is not always ours alone: the engine-config generator embeds
  // `global-rules.md` and whole shared-document bodies verbatim, and the
  // priming roll embeds chunk titles read out of an operator's plan. A marker
  // literal arriving from there would land in the file as a real boundary, and
  // the next run would read the operator's prose as our own region and delete
  // it. Refuse at the door, where the file is still intact and the cause is
  // still nameable.
  if (blockBody.includes(markers.begin) || blockBody.includes(markers.end)) {
    const hint = options.bodySourceHint ? ` (${options.bodySourceHint})` : '';
    return {
      merged: null,
      error: 'generated content contains a managed-block marker literal — splicing it '
        + `would make the next run read surrounding content as ours and delete it${hint}`
    };
  }

  const block = `${markers.begin}\n${blockBody.replace(/\s+$/, '')}\n${markers.end}`;
  const spans = _managedSpans(existing, markers);

  if (spans.length === 0) {
    // Separate the appended block from whatever the file already says by one
    // blank line, without leaving the file's own trailing whitespace behind it.
    const base = existing.replace(/\s+$/, '');
    return { merged: base ? `${base}\n\n${block}\n` : `${block}\n`, error: null };
  }

  // The new block takes the position of the FIRST span, so a repaired file
  // keeps our region roughly where it already sat rather than migrating to the
  // end — the point of a managed block is that it lives among the other
  // writers' sections, not after them.
  let merged = '';
  let cursor = 0;
  let placed = false;
  for (const span of spans) {
    merged += existing.slice(cursor, span.start);
    if (!placed) {
      merged += block;
      placed = true;
    }
    cursor = span.stop;
  }
  return { merged: merged + existing.slice(cursor), error: null };
}

module.exports = {
  spliceManagedBlock,
  extractManagedBlock,
  _markerFault,
  _managedSpans
};
