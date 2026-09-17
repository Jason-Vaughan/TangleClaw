'use strict';

/**
 * Finalizing a handoff attempt (Train 21, #1585).
 *
 * The only place the DB rows and the files are moved together. Everything here
 * is named by an exact `publicationId`, so a late finalize can only ever act on
 * its own attempt.
 *
 * The checks run inside one `BEGIN IMMEDIATE` before anything moves, because
 * the question "is this still the newest attempt" has to be answered and acted
 * on without another finalizer slipping between.
 */

const { createLogger } = require('./logger');
const store = require('./store');
const lockfile = require('./handoff-lockfile');

const log = createLogger('handoff-publish');

/**
 * Make a bound attempt the project's current handoff.
 *
 * Refusals are returned, never thrown: the wrap that produced this attempt has
 * already succeeded, and a handoff that cannot be published must not turn a
 * completed wrap into a failed one.
 *
 * @param {object} project - Project record (locates the handoff directory)
 * @param {string} publicationId - The attempt to publish
 * @returns {{published: boolean, reason: string|null, supersededId: string|null}}
 */
function publishHandoff(project, publicationId) {
  const refuse = (reason) => {
    log.warn('Refused to publish a handoff attempt', { project: project.name, publicationId, reason });
    return { published: false, reason, supersededId: null };
  };

  const row = store.handoffs.get(publicationId);
  if (!row) return refuse('no such publication');
  // A replayed finalize for an attempt already published is a no-op SUCCESS —
  // this is what makes a lost finalize response safe to retry.
  if (row.state === 'published') {
    return { published: true, reason: 'already published', supersededId: row.supersededBy || null };
  }
  if (row.state !== 'staged') return refuse(`publication is ${row.state}`);
  if (!row.eligibleAt) return refuse('publication is not eligible: its attempt never completed');

  // The bytes on disk must be the bytes the row attests to. A mismatched file
  // is never published — it is the one case where the record and the document
  // disagree, and publishing it would make the digest meaningless.
  const staged = lockfile.readHandoffFile(lockfile.stagedPath(project, publicationId));
  if (staged.outcome !== 'ok') return refuse(`staged file is ${staged.outcome}: ${staged.reason || 'unreadable'}`);
  if (staged.digest !== row.fileDigest) return refuse('staged file digest does not match the recorded digest');
  if (staged.doc.publicationId !== publicationId) return refuse('staged file names a different publication');
  if (staged.doc.kind !== row.kind) return refuse('staged file kind does not match the recorded kind');

  try {
    return store.handoffs.transaction(() => {
      // Re-read inside the transaction: between the checks above and here,
      // another finalizer may have published.
      const fresh = store.handoffs.get(publicationId);
      if (fresh.state === 'published') {
        return { published: true, reason: 'already published', supersededId: fresh.supersededBy || null };
      }
      if (fresh.state !== 'staged') {
        return { published: false, reason: `publication is ${fresh.state}`, supersededId: null };
      }

      const newer = store.handoffs.newerPublished(row.projectId, row.seq);
      if (newer) {
        // It completed, so it is superseded rather than abandoned, and
        // current.json is left exactly as the newer attempt wrote it.
        store.handoffs.supersedeBeforePublish(publicationId, newer.publicationId, new Date().toISOString());
        return {
          published: false,
          reason: `a newer publication (${newer.publicationId}) is already current`,
          supersededId: null
        };
      }

      const previous = store.handoffs.getPublished(row.projectId);
      const previousId = previous ? previous.publicationId : null;
      // Files first: the rename is what makes these bytes current, and the DB
      // write below is the record that it happened. A crash between them is
      // exactly what reconciliation exists to catch.
      lockfile.promoteStaged(project, publicationId, previousId);
      store.handoffs.recordPublished(publicationId, previousId, new Date().toISOString());
      log.info('Published a handoff', { project: project.name, publicationId, supersededId: previousId });
      return { published: true, reason: null, supersededId: previousId };
    });
  } catch (err) {
    return refuse(`publish failed: ${err.message}`);
  }
}

/**
 * Abandon an attempt that never became eligible.
 *
 * The staged file is deliberately left on disk: it is the forensic record of
 * what the failed attempt was going to say.
 * @param {string} publicationId - The attempt to abandon
 * @param {string} reason - Why, in a few words
 * @returns {boolean} True when the row moved
 */
function abandonHandoff(publicationId, reason) {
  try {
    const moved = store.handoffs.abandon(publicationId, reason, new Date().toISOString());
    if (moved) log.info('Abandoned a handoff attempt', { publicationId, reason });
    return moved;
  } catch (err) {
    log.warn('Could not abandon a handoff attempt', { publicationId, reason, error: err.message });
    return false;
  }
}

module.exports = { publishHandoff, abandonHandoff };
