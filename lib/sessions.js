'use strict';

const store = require('./store');
const tmux = require('./tmux');
const engines = require('./engines');
const methodologies = require('./methodologies');
const { createLogger } = require('./logger');

const log = createLogger('sessions');

// ── Session Launch ──

/**
 * Launch a new session for a project.
 * Generates prime prompt, starts tmux session, injects prime, records in SQLite.
 * @param {string} projectName - Project directory name
 * @param {object} [options]
 * @param {boolean} [options.primePrompt] - Generate and inject prime prompt (default true)
 * @param {string} [options.engineOverride] - Use different engine for this session only
 * @returns {{ session: object|null, primePrompt: string|null, ttydUrl: string, error: string|null }}
 */
function launchSession(projectName, options = {}) {
  const project = store.projects.getByName(projectName);
  if (!project) {
    return { session: null, primePrompt: null, ttydUrl: null, error: `Project "${projectName}" not found` };
  }

  // Check for existing active session
  const existing = store.sessions.getActive(project.id);
  if (existing) {
    return { session: null, primePrompt: null, ttydUrl: null, error: `Session already active for "${projectName}"` };
  }

  // Resolve engine
  const engineId = options.engineOverride || project.engineId;
  const engineProfile = store.engines.get(engineId);
  if (!engineProfile) {
    return { session: null, primePrompt: null, ttydUrl: null, error: `Engine "${engineId}" not found` };
  }

  // Check engine availability
  const det = engines.detectEngine(engineProfile);
  if (!det.available) {
    return { session: null, primePrompt: null, ttydUrl: null, error: `Engine "${engineId}" not available (binary not found)` };
  }

  // Generate prime prompt
  let primeText = null;
  if (options.primePrompt !== false) {
    primeText = generatePrimePrompt(project, engineProfile);
  }

  // Get methodology phase
  const projConfig = store.projectConfig.load(project.path);
  const methodologyPhase = projConfig.methodologyPhase || null;

  // Start tmux session (sanitize name for tmux — spaces not allowed)
  const tmuxName = tmux.toSessionName(projectName);
  const launchCmd = _buildLaunchCommand(engineProfile);

  // If an orphaned tmux session exists (no DB record but tmux session present), adopt it
  if (tmux.hasSession(tmuxName)) {
    log.info('Adopting orphaned tmux session', { name: tmuxName });

    const session = store.sessions.start({
      projectId: project.id,
      engineId,
      tmuxSession: tmuxName,
      primePrompt: primeText,
      methodologyPhase
    });

    log.info('Session adopted', { project: projectName, engine: engineId, session: session.id });

    return {
      session,
      primePrompt: primeText,
      ttydUrl: '/terminal/',
      error: null
    };
  }

  try {
    const created = tmux.createSession(tmuxName, {
      cwd: project.path,
      command: launchCmd,
      env: engineProfile.launch ? engineProfile.launch.env : {}
    });

    if (!created) {
      return { session: null, primePrompt: null, ttydUrl: null, error: `Failed to create tmux session "${tmuxName}"` };
    }
  } catch (err) {
    return { session: null, primePrompt: null, ttydUrl: null, error: `tmux error: ${err.message}` };
  }

  // Inject prime prompt if engine supports it
  if (primeText && engineProfile.capabilities && engineProfile.capabilities.supportsPrimePrompt) {
    try {
      // Wait briefly for engine to start
      _sleep(500);
      tmux.sendKeys(tmuxName, primeText, { enter: true });
    } catch (err) {
      log.warn('Failed to inject prime prompt', { project: projectName, error: err.message });
    }
  }

  // Record session in store
  const session = store.sessions.start({
    projectId: project.id,
    engineId,
    tmuxSession: tmuxName,
    primePrompt: primeText,
    methodologyPhase
  });

  // Regenerate engine config (ensures it's up-to-date)
  const methodologyTemplate = store.templates.get(project.methodology);
  const configContent = engines.generateConfig(engineId, projConfig, methodologyTemplate);
  if (configContent && engineProfile.configFormat) {
    try {
      const fs = require('node:fs');
      const path = require('node:path');
      const configFilePath = path.join(project.path, engineProfile.configFormat.filename);
      fs.mkdirSync(path.dirname(configFilePath), { recursive: true });
      fs.writeFileSync(configFilePath, configContent);
    } catch (err) {
      log.warn('Failed to write engine config', { error: err.message });
    }
  }

  // Sync engine hooks to match methodology (ensures hooks stay current)
  try {
    engines.syncEngineHooks(project.path, methodologyTemplate);
  } catch (err) {
    log.warn('Failed to sync engine hooks during session launch', { error: err.message });
  }

  log.info('Session launched', { project: projectName, engine: engineId, session: session.id });

  return {
    session,
    primePrompt: primeText,
    ttydUrl: '/terminal/',
    error: null
  };
}

// ── Prime Prompt Generation ──

/**
 * Generate a prime prompt from methodology + project state + learnings + last session.
 * @param {object} project - Project record from store
 * @param {object} engineProfile - Engine profile
 * @returns {string}
 */
function generatePrimePrompt(project, engineProfile) {
  const template = store.templates.get(project.methodology);
  const projConfig = store.projectConfig.load(project.path);
  const sections = [];

  // Header
  sections.push(`# Session Start — ${project.name}`);
  sections.push('');

  // Methodology info
  if (template) {
    sections.push(`## Methodology: ${template.name}`);
    if (template.description) {
      sections.push(template.description);
    }
    sections.push('');

    // Current phase
    if (projConfig.methodologyPhase && template.phases) {
      const phase = template.phases.find((p) => p.id === projConfig.methodologyPhase);
      if (phase) {
        sections.push(`## Current Phase: ${phase.name}`);
        if (phase.description) sections.push(phase.description);
        sections.push('');
      }
    }
  }

  // Previous methodology archives
  if (projConfig.methodologyArchives && projConfig.methodologyArchives.length > 0) {
    sections.push('## Previous Methodology Archives');
    sections.push('Archived methodology state is preserved at:');
    for (const archive of projConfig.methodologyArchives) {
      sections.push(`- \`${archive.archivePath}/\` (${archive.methodology})`);
    }
    sections.push('Review learnings and reflections there for context on prior work.');
    sections.push('');
  }

  // Active learnings
  try {
    const learnings = store.learnings.getActive(project.id);
    if (learnings.length > 0) {
      sections.push('## Active Learnings');
      for (const learning of learnings) {
        sections.push(`- ${learning.content}`);
      }
      sections.push('');
    }
  } catch {
    // Learnings might not be available — skip
  }

  // Last session summary
  const lastSession = store.sessions.getLatest(project.id);
  if (lastSession && lastSession.wrapSummary) {
    sections.push('## Last Session Summary');
    sections.push(lastSession.wrapSummary);
    sections.push('');
  }

  // Rules summary
  if (projConfig.rules) {
    const activeExtensions = Object.entries(projConfig.rules.extensions || {})
      .filter(([, v]) => v === true);
    if (activeExtensions.length > 0) {
      sections.push('## Active Extension Rules');
      for (const [rule] of activeExtensions) {
        sections.push(`- ${rule}`);
      }
      sections.push('');
    }
  }

  let prompt = sections.join('\n');

  // Respect maxTokens from template prime config (rough character estimate)
  if (template && template.prime && template.prime.maxTokens) {
    const maxChars = template.prime.maxTokens * 4; // rough token-to-char ratio
    if (prompt.length > maxChars) {
      prompt = prompt.slice(0, maxChars) + '\n\n[Prime prompt truncated]';
    }
  }

  return prompt;
}

// ── Session Status ──

/**
 * Get session status for a project, including idle detection.
 * @param {string} projectName - Project directory name
 * @returns {{ active: boolean, sessionId?: number, project: string, engine?: string,
 *             tmuxSession?: string, startedAt?: string, durationSeconds?: number,
 *             idle?: boolean, lastOutputAge?: number, lastSession?: object }|null}
 */
function getSessionStatus(projectName) {
  const project = store.projects.getByName(projectName);
  if (!project) return null;

  const active = store.sessions.getActive(project.id);
  if (active) {
    // Check idle status via tmux
    let idle = false;
    let lastOutputAge = 0;

    if (active.tmuxSession && tmux.hasSession(active.tmuxSession)) {
      const idleInfo = detectIdle(active.tmuxSession);
      idle = idleInfo.idle;
      lastOutputAge = idleInfo.lastOutputAge;
    }

    const now = new Date();
    const started = new Date(active.startedAt);
    const durationSeconds = Math.floor((now - started) / 1000);

    return {
      active: true,
      sessionId: active.id,
      project: projectName,
      engine: active.engineId,
      tmuxSession: active.tmuxSession,
      startedAt: active.startedAt,
      durationSeconds,
      idle,
      lastOutputAge
    };
  }

  // No DB session but tmux session exists (launched outside v3 or DB out of sync)
  const tmuxName = tmux.toSessionName(projectName);
  if (tmux.hasSession(tmuxName)) {
    return {
      active: true,
      project: projectName,
      engine: null,
      tmuxSession: tmuxName,
      startedAt: null,
      durationSeconds: null,
      idle: false,
      lastOutputAge: 0,
      untracked: true
    };
  }

  // No active session — return last session info
  const lastSession = store.sessions.getLatest(project.id);
  const result = {
    active: false,
    project: projectName,
    lastSession: null
  };

  if (lastSession) {
    result.lastSession = {
      sessionId: lastSession.id,
      status: lastSession.status,
      endedAt: lastSession.endedAt,
      durationSeconds: lastSession.durationSeconds,
      wrapSummary: lastSession.wrapSummary
    };
  }

  return result;
}

// ── Idle Detection ──

// Cache of last captured output per session, for change detection
const _lastOutput = new Map();

/**
 * Detect if a tmux session is idle (no output changes).
 * @param {string} tmuxSession - tmux session name
 * @returns {{ idle: boolean, lastOutputAge: number }}
 */
function detectIdle(tmuxSession) {
  try {
    const lines = tmux.capturePane(tmuxSession, { lines: 3 });
    const currentOutput = lines.join('\n');

    const cached = _lastOutput.get(tmuxSession);
    const now = Date.now();

    if (!cached || cached.output !== currentOutput) {
      _lastOutput.set(tmuxSession, { output: currentOutput, timestamp: now });
      return { idle: false, lastOutputAge: 0 };
    }

    const age = Math.floor((now - cached.timestamp) / 1000);
    return { idle: age > 10, lastOutputAge: age };
  } catch {
    return { idle: false, lastOutputAge: 0 };
  }
}

/**
 * Clear idle detection cache for a session.
 * @param {string} tmuxSession - tmux session name
 */
function clearIdleCache(tmuxSession) {
  _lastOutput.delete(tmuxSession);
}

// ── Command Injection ──

/**
 * Inject a command into an active session.
 * @param {string} projectName - Project name
 * @param {string} command - Text to inject
 * @param {object} [options]
 * @param {boolean} [options.enter] - Send Enter after text (default true)
 * @returns {{ ok: boolean, error: string|null }}
 */
function injectCommand(projectName, command, options = {}) {
  const project = store.projects.getByName(projectName);
  if (!project) {
    return { ok: false, error: `Project "${projectName}" not found` };
  }

  // Enforce command length limit (security-model.md: 4096 chars max)
  if (command.length > 4096) {
    return { ok: false, error: 'Command exceeds maximum length of 4096 characters' };
  }

  const active = store.sessions.getActive(project.id);
  if (!active) {
    return { ok: false, error: `No active session for "${projectName}"` };
  }

  if (!active.tmuxSession || !tmux.hasSession(active.tmuxSession)) {
    return { ok: false, error: `tmux session "${active.tmuxSession}" not found` };
  }

  try {
    tmux.sendKeys(active.tmuxSession, command, { enter: options.enter !== false });
    return { ok: true, error: null };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Peek ──

/**
 * Peek at recent terminal output for a project's active session.
 * @param {string} projectName - Project name
 * @param {number} [lines] - Number of lines (default 5, max 100)
 * @returns {{ lines: string[]|null, tmuxSession: string|null, error: string|null }}
 */
function peek(projectName, lines) {
  const project = store.projects.getByName(projectName);
  if (!project) {
    return { lines: null, tmuxSession: null, error: `Project "${projectName}" not found` };
  }

  const active = store.sessions.getActive(project.id);
  if (!active || !active.tmuxSession) {
    return { lines: null, tmuxSession: null, error: `No active session for "${projectName}"` };
  }

  if (!tmux.hasSession(active.tmuxSession)) {
    return { lines: null, tmuxSession: null, error: `tmux session not found` };
  }

  const lineCount = Math.min(Math.max(lines || 5, 1), 100);
  const output = tmux.capturePane(active.tmuxSession, { lines: lineCount });

  return { lines: output, tmuxSession: active.tmuxSession, error: null };
}

// ── Wrap ──

/**
 * Trigger the session wrap skill. Sends the wrap command and returns immediately.
 * The frontend polls status to detect completion.
 * @param {string} projectName - Project name
 * @returns {{ ok: boolean, sessionId: number|null, wrapCommand: string|null, error: string|null }}
 */
function triggerWrap(projectName) {
  const project = store.projects.getByName(projectName);
  if (!project) {
    return { ok: false, sessionId: null, wrapCommand: null, error: `Project "${projectName}" not found` };
  }

  const active = store.sessions.getActive(project.id);
  if (!active || !active.tmuxSession) {
    return { ok: false, sessionId: null, wrapCommand: null, error: `No active session for "${projectName}"` };
  }

  // Get wrap command from methodology template
  const template = store.templates.get(project.methodology);
  let wrapCommand = '/session-wrap';
  if (template && template.wrap && template.wrap.command) {
    wrapCommand = template.wrap.command;
  }

  // Send wrap command to the session
  try {
    tmux.sendKeys(active.tmuxSession, wrapCommand, { enter: true });
  } catch (err) {
    return { ok: false, sessionId: active.id, wrapCommand, error: `Failed to send wrap command: ${err.message}` };
  }

  log.info('Wrap triggered', { project: projectName, session: active.id, command: wrapCommand });

  return {
    ok: true,
    sessionId: active.id,
    wrapCommand,
    error: null
  };
}

/**
 * Complete a wrap — capture summary, update session record, kill tmux.
 * Called after wrap skill has finished (detected by polling or manually).
 * @param {string} projectName - Project name
 * @param {string} [summary] - Wrap summary text
 * @returns {{ session: object|null, error: string|null }}
 */
function completeWrap(projectName, summary) {
  const project = store.projects.getByName(projectName);
  if (!project) {
    return { session: null, error: `Project "${projectName}" not found` };
  }

  const active = store.sessions.getActive(project.id);
  if (!active) {
    return { session: null, error: `No active session for "${projectName}"` };
  }

  // Update session record
  const session = store.sessions.wrap(active.id, summary);

  // Kill tmux session
  if (active.tmuxSession && tmux.hasSession(active.tmuxSession)) {
    try {
      tmux.killSession(active.tmuxSession);
    } catch (err) {
      log.warn('Failed to kill tmux session during wrap', { error: err.message });
    }
  }

  clearIdleCache(active.tmuxSession);
  log.info('Session wrapped', { project: projectName, session: session.id });

  return { session, error: null };
}

// ── Kill Session ──

/**
 * Kill an active session.
 * @param {string} projectName - Project name
 * @param {string} [reason] - Kill reason
 * @returns {{ session: object|null, error: string|null }}
 */
function killSession(projectName, reason) {
  const project = store.projects.getByName(projectName);
  if (!project) {
    return { session: null, error: `Project "${projectName}" not found` };
  }

  const active = store.sessions.getActive(project.id);
  if (!active) {
    return { session: null, error: `No active session for "${projectName}"` };
  }

  // Update session record
  const session = store.sessions.kill(active.id, reason);

  // Kill tmux session
  if (active.tmuxSession && tmux.hasSession(active.tmuxSession)) {
    try {
      tmux.killSession(active.tmuxSession);
    } catch (err) {
      log.warn('Failed to kill tmux session', { error: err.message });
    }
  }

  clearIdleCache(active.tmuxSession);
  log.info('Session killed', { project: projectName, session: session.id, reason });

  return { session, error: null };
}

// ── Session History ──

/**
 * Get session history for a project.
 * @param {string} projectName - Project name
 * @param {object} [options]
 * @param {number} [options.limit] - Max sessions (default 20)
 * @param {string} [options.status] - Filter by status
 * @returns {{ sessions: object[], total: number, error: string|null }}
 */
function getSessionHistory(projectName, options = {}) {
  const project = store.projects.getByName(projectName);
  if (!project) {
    return { sessions: [], total: 0, error: `Project "${projectName}" not found` };
  }

  const sessionList = store.sessions.list(project.id, {
    limit: options.limit || 20,
    status: options.status
  });

  const total = store.sessions.count(project.id, {
    status: options.status
  });

  return {
    sessions: sessionList.map((s) => ({
      id: s.id,
      engine: s.engineId,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      status: s.status,
      durationSeconds: s.durationSeconds,
      wrapSummary: s.wrapSummary,
      methodologyPhase: s.methodologyPhase
    })),
    total,
    error: null
  };
}

// ── Helpers ──

/**
 * Build the tmux launch command from an engine profile.
 * @param {object} engineProfile - Engine profile
 * @returns {string|undefined}
 */
function _buildLaunchCommand(engineProfile) {
  if (!engineProfile.launch) return undefined;
  let cmd = engineProfile.launch.shellCommand;
  if (engineProfile.launch.args && engineProfile.launch.args.length > 0) {
    cmd += ' ' + engineProfile.launch.args.join(' ');
  }
  return cmd;
}

/**
 * Synchronous sleep using spawnSync to avoid busy-waiting.
 * @param {number} ms - Milliseconds
 */
function _sleep(ms) {
  const { spawnSync } = require('node:child_process');
  spawnSync('sleep', [String(ms / 1000)], { timeout: ms + 1000 });
}

module.exports = {
  launchSession,
  generatePrimePrompt,
  getSessionStatus,
  detectIdle,
  clearIdleCache,
  injectCommand,
  peek,
  triggerWrap,
  completeWrap,
  killSession,
  getSessionHistory,
  _buildLaunchCommand
};
