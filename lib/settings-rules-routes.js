'use strict';

/**
 * The library/route adapter surface for `#2852` (Architect Ruling
 * A503-R1, `Car 66-C`): composed route/controller handlers over
 * `lib/adr-viewer.js`, `lib/rules-compress-preview.js`,
 * `lib/session-rules-bulk.js`, and `lib/team-templates.js` -- the exact
 * call shapes a future `lib/routes/*.js` handler needs. Mounting these
 * behind the real Settings UI (`server.js`, `lib/routes/sessions.js`,
 * `public/index.html`) is `Milestone #54` per Ruling A503-R1; this module
 * is what that mount will call unchanged.
 *
 * @module lib/settings-rules-routes
 */

const adrViewer = require('./adr-viewer');
const rulesCompressPreview = require('./rules-compress-preview');
const sessionRulesBulk = require('./session-rules-bulk');
const teamTemplates = require('./team-templates');

/**
 * @see module:lib/adr-viewer.projectRulesView
 */
function getProjectAdrRulesView(records, options) {
  return adrViewer.projectRulesView(records, options);
}

/**
 * The shareable rules/ADR snapshot, built and rendered to Markdown in one
 * call rather than making every route caller chain
 * `buildShareableRulesView` into `renderShareableRulesMarkdown` itself.
 * @param {object[]} records
 * @param {object} [options] - As {@link module:lib/adr-viewer.projectRulesView}'s own `options`.
 * @returns {{ok: true, payload: object, markdown: string}|{ok: false, code: string, message: string}}
 */
function getShareableRulesMarkdown(records, options) {
  const built = adrViewer.buildShareableRulesView(records, options);
  if (!built.ok) return built;
  const rendered = adrViewer.renderShareableRulesMarkdown(built.payload);
  if (!rendered.ok) return rendered;
  return { ok: true, payload: built.payload, markdown: rendered.markdown };
}

/**
 * @see module:lib/rules-compress-preview.buildRulesCompressPreview
 */
function previewRulesCompression(input) {
  return rulesCompressPreview.buildRulesCompressPreview(input);
}

/**
 * @see module:lib/session-rules-bulk.decideSessionRuleProposal
 */
function decideRuleProposal(input) {
  return sessionRulesBulk.decideSessionRuleProposal(input);
}

/**
 * @see module:lib/session-rules-bulk.bulkDecideSessionRuleProposals
 */
function bulkDecideRuleProposals(input) {
  return sessionRulesBulk.bulkDecideSessionRuleProposals(input);
}

/**
 * @see module:lib/session-rules-bulk.editRuleInPlace
 */
function editSessionRuleInPlace(input) {
  return sessionRulesBulk.editRuleInPlace(input);
}

/**
 * @see module:lib/team-templates.previewTeamTemplateApplication
 */
function validateAndPreviewTeamTemplate(templatePkg, currentSeats) {
  return teamTemplates.previewTeamTemplateApplication(templatePkg, currentSeats);
}

module.exports = {
  getProjectAdrRulesView,
  getShareableRulesMarkdown,
  previewRulesCompression,
  decideRuleProposal,
  bulkDecideRuleProposals,
  editSessionRuleInPlace,
  validateAndPreviewTeamTemplate
};
