'use strict';

const store = require('./store');
const { createLogger } = require('./logger');

const log = createLogger('skills');

/**
 * Synthesize a legacy `{command, steps, captureFields}` wrap shape from a
 * methodology template, preferring the new `wrap_pipeline` schema (#139
 * Chunk 2) and falling back to the legacy `wrap` block for installs that
 * haven't yet picked up the bundled migration.
 *
 * The legacy shape is what `lib/sessions.js:triggerWrap` and
 * `lib/eval-audit.js:scoreWrapQuality` consume — exporting a single shim
 * means callers don't grow asymmetric reads of the two schemas (ADR 0001).
 *
 * @param {object|null} template
 * @returns {{ command: string|null, steps: string[], captureFields: string[] }|null}
 */
function wrapShapeFromTemplate(template) {
  if (!template) return null;

  const pipeline = template.wrap_pipeline;
  if (pipeline && Array.isArray(pipeline.steps)) {
    const steps = pipeline.steps
      .map((s) => (s && typeof s.id === 'string' ? s.id : null))
      .filter((id) => id !== null);
    const captureSet = new Set();
    for (const step of pipeline.steps) {
      if (step && Array.isArray(step.captureFields)) {
        for (const field of step.captureFields) captureSet.add(field);
      }
    }
    return {
      command: null,
      steps,
      captureFields: Array.from(captureSet)
    };
  }

  if (template.wrap) {
    return {
      command: template.wrap.command || null,
      steps: template.wrap.steps || [],
      captureFields: template.wrap.captureFields || []
    };
  }

  return null;
}

/**
 * Load available skills from a methodology template.
 * @param {string} methodologyId - Methodology template id
 * @returns {{ skills: object[], error: string|null }}
 */
function loadSkills(methodologyId) {
  const template = store.templates.get(methodologyId);
  if (!template) {
    return { skills: [], error: `Methodology "${methodologyId}" not found` };
  }

  const skills = [];

  // Session-wrap skill — surfaced when either the new wrap_pipeline schema
  // or the legacy wrap block declares the methodology supports a wrap.
  const wrapConfig = wrapShapeFromTemplate(template);
  if (wrapConfig) {
    skills.push({
      id: 'session-wrap',
      name: 'Session Wrap',
      description: 'Wrap the current session with methodology-defined steps',
      type: 'lifecycle',
      config: wrapConfig
    });
  }

  // Custom actions from methodology as skills
  if (template.actions && Array.isArray(template.actions)) {
    for (const action of template.actions) {
      skills.push({
        id: `action-${action.label.toLowerCase().replace(/\s+/g, '-')}`,
        name: action.label,
        description: action.description || `Execute: ${action.command}`,
        type: 'action',
        config: action
      });
    }
  }

  log.debug('Skills loaded', { methodology: methodologyId, count: skills.length });
  return { skills, error: null };
}

/**
 * Get all available skills for a project (methodology skills + core skills).
 * @param {string} projectName - Project name
 * @returns {{ skills: object[], error: string|null }}
 */
function getProjectSkills(projectName) {
  const project = store.projects.getByName(projectName);
  if (!project) {
    return { skills: [], error: `Project "${projectName}" not found` };
  }

  return loadSkills(project.methodology);
}

module.exports = {
  loadSkills,
  getProjectSkills,
  wrapShapeFromTemplate
};
