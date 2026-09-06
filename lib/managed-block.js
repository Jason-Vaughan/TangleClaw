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
 * A caller mistake, not a file condition — the counting below walks occurrences
 * of two distinct strings, so a pair that is identical or that nests would make
 * it silently unsound rather than wrong in a visible way.
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
 * Count non-overlapping occurrences of `needle` in `text`.
 *
 * @param {string} text - Text to search
 * @param {string} needle - Literal to count
 * @returns {number} How many times it occurs
 */
function _countOccurrences(text, needle) {
  return text.split(needle).length - 1;
}

/**
 * Whether a file carries any trace of our marker pair.
 *
 * The ownership question, asked once so no call site holds a private idea of
 * it. A single unmatched marker still counts: the file is not one we may treat
 * as marker-free, and a caller that concludes "no managed markers here" from a
 * both-markers test will take a whole-file path over a file that has one.
 *
 * @param {string} text - File contents
 * @param {{begin: string, end: string}} markers - The pair delimiting our region
 * @returns {boolean} True when either marker occurs at least once
 */
function hasManagedMarkers(text, markers) {
  if (_markerFault(markers)) return false;
  return text.includes(markers.begin) || text.includes(markers.end);
}

/**
 * Read back the body currently inside the managed markers.
 *
 * @param {string} text - File contents
 * @param {{begin: string, end: string}} markers - The pair delimiting our region
 * @returns {string|null} The body between the markers, or null when the file
 *   carries no usable pair. Null is "no block established here", never an empty
 *   block — a caller comparing bodies to detect drift must tell those apart.
 */
function extractManagedBlock(text, markers) {
  if (_markerFault(markers)) return null;
  const start = text.indexOf(markers.begin);
  const stop = text.indexOf(markers.end);
  if (start === -1 || stop === -1 || stop < start) return null;
  return text.slice(start + markers.begin.length, stop);
}

/**
 * Splice generated content into a file another writer also owns, touching only
 * the region between our markers.
 *
 * Everything outside our region is returned byte for byte — that is the whole
 * contract, and the reason this exists: a whole-file write destroyed a
 * hand-written `AGENTS.md` and would fight `next dev`, which re-adds its own
 * block to the same file on every run.
 *
 * **The marker counts decide, because they are the only thing that can.** A
 * marker literal is not proof the marker is ours: an operator documenting this
 * mechanism inside the very file it edits writes both literals in their own
 * prose, and nothing in the text distinguishes those from a real region. So
 * only two counts are actionable, and everything else is refused:
 *
 *   - **None of either** — append a fresh block after the existing content.
 *   - **Exactly one of each** — that is our region. In order, its body is
 *     replaced in place. Out of order, it is REPAIRED: one well-formed block
 *     lands where the first marker sat, and the text that was between the
 *     misordered markers is kept after it, as the operator's. Repair is what
 *     the counts license — the pair is unambiguously ours, only its order is
 *     wrong — and it is idempotent, so a second pass is byte-identical.
 *
 * Refusing every other count is not timidity, it is the only honest answer.
 * Appending around a broken set grows the file by one stale block every run,
 * forever; adopting the first of several pairs, or dropping later ones as
 * "stale copies of our own output", deletes an operator's prose whenever the
 * extra markers were theirs. A refusal leaves the file byte-identical and names
 * the counts, which a human can act on.
 *
 * @param {string} existing - Current file contents (may be empty)
 * @param {string} blockBody - Generated content to place inside the markers
 * @param {{begin: string, end: string}} markers - The pair delimiting our region
 * @param {{bodySourceHint?: string}} [options] - `bodySourceHint` is appended to
 *   the marker-literal refusal to name where a caller's body comes from, since
 *   only the caller knows which of its inputs could have carried a marker.
 * @returns {{merged: string|null, error: string|null, repaired: boolean}}
 *   `merged` is the full new file contents; `error` is set instead when nothing
 *   may be written. `repaired` is true only when a misordered pair was rewritten
 *   — a mutation outside the managed region, which a caller must report rather
 *   than perform quietly.
 */
function spliceManagedBlock(existing, blockBody, markers, options = {}) {
  const refuse = (error) => ({ merged: null, error, repaired: false });

  const fault = _markerFault(markers);
  if (fault) return refuse(fault);

  // The body is not always ours alone: the engine-config generator embeds
  // `global-rules.md` and whole shared-document bodies verbatim, and the
  // priming roll embeds chunk titles read out of an operator's plan. A marker
  // literal arriving from there would land in the file as a real boundary, and
  // the next run would read the operator's prose as our own region and delete
  // it. Refuse at the door, where the file is still intact and the cause is
  // still nameable.
  if (blockBody.includes(markers.begin) || blockBody.includes(markers.end)) {
    const hint = options.bodySourceHint ? ` (${options.bodySourceHint})` : '';
    return refuse('generated content contains a managed-block marker literal — splicing it '
      + `would make the next run read surrounding content as ours and delete it${hint}`);
  }

  const block = `${markers.begin}\n${blockBody.replace(/\s+$/, '')}\n${markers.end}`;
  const beginCount = _countOccurrences(existing, markers.begin);
  const endCount = _countOccurrences(existing, markers.end);

  if (beginCount === 0 && endCount === 0) {
    // Separate the appended block from whatever the file already says by one
    // blank line, without leaving the file's own trailing whitespace behind it.
    const base = existing.replace(/\s+$/, '');
    return {
      merged: base ? `${base}\n\n${block}\n` : `${block}\n`,
      error: null,
      repaired: false
    };
  }

  if (beginCount !== 1 || endCount !== 1) {
    return refuse(
      `managed-block markers are malformed (${beginCount} begin, ${endCount} end — expected 1 each)`
    );
  }

  const start = existing.indexOf(markers.begin);
  const stop = existing.indexOf(markers.end);

  if (stop > start) {
    const before = existing.slice(0, start);
    const after = existing.slice(stop + markers.end.length);
    return { merged: `${before}${block}${after}`, error: null, repaired: false };
  }

  // End before begin. Both markers are ours — the counts say so — but the text
  // they enclose is not: nothing was ever generated between a closing marker
  // and an opening one, so it is content someone wrote into the middle of a
  // half-written region. Keep it, after the repaired block, and put the block
  // where the first marker sat so our region does not migrate to the end of a
  // file whose other sections are the point.
  const head = existing.slice(0, stop);
  const between = existing.slice(stop + markers.end.length, start);
  const tail = existing.slice(start + markers.begin.length);
  return { merged: `${head}${block}${between}${tail}`, error: null, repaired: true };
}

module.exports = {
  spliceManagedBlock,
  extractManagedBlock,
  hasManagedMarkers,
  _markerFault,
  _countOccurrences
};
