'use strict';

const store = require('./store');
const { createLogger } = require('./logger');

const log = createLogger('skills');

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

  // Session-wrap skill (always available if wrap config exists)
  if (template.wrap) {
    skills.push({
      id: 'session-wrap',
      name: 'Session Wrap',
      description: 'Wrap the current session with methodology-defined steps',
      type: 'lifecycle',
      config: template.wrap
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
 * Get the session-wrap skill configuration for a methodology.
 * @param {string} methodologyId - Methodology template id
 * @returns {{ command: string|null, steps: string[], captureFields: string[] }|null}
 */
function getWrapSkill(methodologyId) {
  const template = store.templates.get(methodologyId);
  if (!template || !template.wrap) return null;

  return {
    command: template.wrap.command || null,
    steps: template.wrap.steps || [],
    captureFields: template.wrap.captureFields || []
  };
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
  getWrapSkill,
  getProjectSkills
};
