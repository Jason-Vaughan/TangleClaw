'use strict';

/*
 * Fixture-based integration tests for `data/hooks/strip-ai-coauthors.sh`
 * (issue #247). Spawns the actual shell script against tmp commit-message
 * fixtures and asserts what survives.
 *
 * Tests at the script boundary, not the regex pattern in isolation — this
 * catches portability bugs (BSD vs GNU grep, tmp-file handling) that a
 * pure-regex test would miss.
 */

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'data', 'hooks', 'strip-ai-coauthors.sh');

/**
 * Write `body` to a tmp file, run the hook script against it, return the
 * resulting file content. Cleans up the tmp file regardless of outcome.
 * @param {string} body - Commit message body
 * @returns {string}
 */
function runHook(body) {
  const tmp = path.join(os.tmpdir(), `tc-hook-test-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.msg`);
  fs.writeFileSync(tmp, body);
  try {
    const result = spawnSync('sh', [SCRIPT, tmp], { encoding: 'utf8' });
    if (result.status !== 0) {
      throw new Error(`hook exited ${result.status}: ${result.stderr}`);
    }
    return fs.readFileSync(tmp, 'utf8');
  } finally {
    try { fs.unlinkSync(tmp); } catch (_) { /* already cleaned */ }
  }
}

describe('strip-ai-coauthors.sh (#247) — AI vendor patterns are removed', () => {
  const subject = 'Add foo feature\n\nBody paragraph explaining the change.\n\n';

  it('strips Claude Opus trailer (canonical Claude Code form)', () => {
    const out = runHook(subject + 'Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>\n');
    assert.equal(out, subject);
  });

  it('strips Claude Sonnet trailer', () => {
    const out = runHook(subject + 'Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>\n');
    assert.equal(out, subject);
  });

  it('strips Claude Haiku trailer', () => {
    const out = runHook(subject + 'Co-Authored-By: Claude Haiku 4.5 <noreply@anthropic.com>\n');
    assert.equal(out, subject);
  });

  it('strips ChatGPT trailer', () => {
    const out = runHook(subject + 'Co-Authored-By: ChatGPT <noreply@openai.com>\n');
    assert.equal(out, subject);
  });

  it('strips GPT-4 trailer', () => {
    const out = runHook(subject + 'Co-Authored-By: GPT-4 <bot@openai.com>\n');
    assert.equal(out, subject);
  });

  it('strips Gemini trailer', () => {
    const out = runHook(subject + 'Co-Authored-By: Gemini <noreply@google.com>\n');
    assert.equal(out, subject);
  });

  it('strips Copilot trailer', () => {
    const out = runHook(subject + 'Co-Authored-By: GitHub Copilot <copilot@github.com>\n');
    assert.equal(out, subject);
  });

  it('strips Cursor trailer', () => {
    const out = runHook(subject + 'Co-Authored-By: Cursor <bot@cursor.sh>\n');
    assert.equal(out, subject);
  });

  it('strips Aider trailer', () => {
    const out = runHook(subject + 'Co-Authored-By: Aider <ai@aider.chat>\n');
    assert.equal(out, subject);
  });

  it('handles case variants on the Co-Authored-By prefix', () => {
    const out = runHook(subject + 'co-authored-by: Claude Opus 4.7 <noreply@anthropic.com>\n');
    assert.equal(out, subject);
  });

  it('strips multiple AI trailers in one message', () => {
    const out = runHook(
      subject +
      'Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>\n' +
      'Co-Authored-By: ChatGPT <noreply@openai.com>\n'
    );
    assert.equal(out, subject);
  });
});

describe('strip-ai-coauthors.sh (#247) — human co-authors are preserved', () => {
  const subject = 'Add foo feature\n\nBody paragraph.\n\n';

  it('preserves a plain human co-author', () => {
    const body = subject + 'Co-Authored-By: Jane Doe <jane@example.com>\n';
    assert.equal(runHook(body), body);
  });

  it('preserves a human at an AI vendor email domain (anthropic.com)', () => {
    const body = subject + 'Co-Authored-By: Alex Engineer <alex@anthropic.com>\n';
    assert.equal(runHook(body), body);
  });

  it('preserves a human at an AI vendor email domain (openai.com)', () => {
    const body = subject + 'Co-Authored-By: Maria Rivera <maria@openai.com>\n';
    assert.equal(runHook(body), body);
  });

  it('preserves a mix: human kept, AI stripped', () => {
    const body = subject +
      'Co-Authored-By: Jane Doe <jane@example.com>\n' +
      'Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>\n';
    assert.equal(runHook(body), subject + 'Co-Authored-By: Jane Doe <jane@example.com>\n');
  });
});

describe('strip-ai-coauthors.sh (#247) — message integrity', () => {
  it('passes through a clean message unchanged (no trailers at all)', () => {
    const body = 'Subject\n\nBody text.\n\nMore body.\n';
    assert.equal(runHook(body), body);
  });

  it('preserves Signed-off-by trailers', () => {
    const body = 'Subject\n\nBody.\n\nSigned-off-by: Jane Doe <jane@example.com>\n';
    assert.equal(runHook(body), body);
  });

  it('preserves Fixes / Closes trailers', () => {
    const body = 'Subject\n\nBody.\n\nFixes #42\nCloses #43\n';
    assert.equal(runHook(body), body);
  });

  it('preserves body text that mentions an AI assistant name in prose', () => {
    // Prose like "...uses the Claude API..." must not trigger the strip —
    // the regex is anchored to `Co-Authored-By:` line starts, so prose is
    // safe even when it contains the AI vendor token.
    const body = 'Subject\n\nThis change updates the Claude API client to handle\nthe new chatgpt-style streaming response.\n';
    assert.equal(runHook(body), body);
  });

  it('exits 0 (does not block commit) when message file is missing', () => {
    const result = spawnSync('sh', [SCRIPT, '/nonexistent/path/that/does/not/exist'], { encoding: 'utf8' });
    assert.equal(result.status, 0, 'missing file must not block the commit');
  });

  it('exits 0 (does not block commit) when no arg is passed', () => {
    const result = spawnSync('sh', [SCRIPT], { encoding: 'utf8' });
    assert.equal(result.status, 0, 'missing arg must not block the commit');
  });
});
