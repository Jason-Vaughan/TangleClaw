'use strict';

const { execSync } = require('child_process');

const SESSION_NAME_RE = /^[a-zA-Z0-9_-]+$/;
// Use | as field delimiter — safe because session names are [a-zA-Z0-9_-]
const SEP = '|';

function validateSessionName(name) {
  if (!SESSION_NAME_RE.test(name)) {
    throw new Error('Invalid session name');
  }
}

function toSessionName(projectName) {
  return projectName.replace(/[^a-zA-Z0-9_-]/g, '-');
}

function getSessions() {
  try {
    const fmt = `#{session_name}${SEP}#{session_windows}${SEP}#{session_attached}${SEP}#{session_activity}${SEP}#{session_created}`;
    const output = execSync(`tmux list-sessions -F "${fmt}"`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const sessions = {};
    output.trim().split('\n').filter(Boolean).forEach(line => {
      const [name, windows, attached, activity, created] = line.split(SEP);
      sessions[name] = {
        windows: parseInt(windows, 10),
        attached: parseInt(attached, 10) > 0,
        lastActivity: parseInt(activity, 10),
        created: parseInt(created, 10),
      };
    });
    return sessions;
  } catch {
    return {};
  }
}

function getSessionDetail(sessionName) {
  validateSessionName(sessionName);
  try {
    const fmt = `#{session_windows}${SEP}#{session_attached}${SEP}#{session_activity}${SEP}#{session_created}${SEP}#{pane_current_path}`;
    const output = execSync(`tmux list-panes -t "${sessionName}" -F "${fmt}"`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    const lines = output.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return null;

    const first = lines[0].split(SEP);
    const windowList = getWindowList(sessionName);

    return {
      windows: parseInt(first[0], 10),
      attached: parseInt(first[1], 10) > 0,
      lastActivity: parseInt(first[2], 10),
      created: parseInt(first[3], 10),
      currentPath: first[4] || '',
      paneCount: lines.length,
      windowList,
    };
  } catch {
    return null;
  }
}

function getWindowList(sessionName) {
  validateSessionName(sessionName);
  try {
    const output = execSync(`tmux list-windows -t "${sessionName}" -F "#{window_index}${SEP}#{window_name}${SEP}#{window_active}"`, {
      encoding: 'utf-8',
      timeout: 5000,
    });
    return output.trim().split('\n').filter(Boolean).map(line => {
      const [index, name, active] = line.split(SEP);
      return { index: parseInt(index, 10), name, active: active === '1' };
    });
  } catch {
    return [];
  }
}

function killSession(sessionName) {
  validateSessionName(sessionName);
  execSync(`tmux kill-session -t "${sessionName}"`, { timeout: 5000 });
}

function peek(sessionName, lineCount = 5) {
  validateSessionName(sessionName);
  try {
    const output = execSync(
      `tmux capture-pane -t "${sessionName}" -p -S -${lineCount}`,
      { encoding: 'utf-8', timeout: 5000 }
    );
    return output.trimEnd();
  } catch {
    return '';
  }
}

function sendKeys(sessionName, command) {
  validateSessionName(sessionName);
  if (typeof command !== 'string' || command.length > 1000) {
    throw new Error('Invalid command');
  }
  execSync(`tmux send-keys -t "${sessionName}" -l ${escapeShellArg(command)}`, { timeout: 5000 });
  execSync(`tmux send-keys -t "${sessionName}" Enter`, { timeout: 5000 });
}

function escapeShellArg(arg) {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

module.exports = {
  toSessionName,
  getSessions,
  getSessionDetail,
  getWindowList,
  killSession,
  peek,
  sendKeys,
  validateSessionName,
};
