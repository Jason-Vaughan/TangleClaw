'use strict';

const { describe, it, before, after, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');

describe('store.globalRules', () => {
  let tempDir;

  before(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tangleclaw-globalrules-test-'));
    store._setBasePath(tempDir);
    store.init();
  });

  after(() => {
    store.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should load defaults when no user file exists', () => {
    const content = store.globalRules.load();
    assert.ok(content.includes('Global Rules'), 'Should contain default header');
    assert.ok(content.length > 0);
  });

  it('should create user file from defaults on first load', () => {
    const userFile = path.join(tempDir, 'global-rules.md');
    assert.ok(fs.existsSync(userFile), 'User file should be created');
  });

  it('should return saved content on subsequent loads', () => {
    const custom = '# My Custom Rules\n\n- Rule one\n- Rule two\n';
    store.globalRules.save(custom);
    const loaded = store.globalRules.load();
    assert.equal(loaded, custom);
  });

  it('should reset to bundled defaults', () => {
    store.globalRules.save('# Totally custom stuff');
    const defaults = store.globalRules.reset();
    assert.ok(defaults.includes('Global Rules'), 'Reset should restore default header');
    const loaded = store.globalRules.load();
    assert.equal(loaded, defaults);
  });

  it('should save empty content', () => {
    store.globalRules.save('');
    const loaded = store.globalRules.load();
    assert.equal(loaded, '');
  });

  it('should handle unicode content', () => {
    const unicode = '# Rules\n\n- Use proper encoding: \u00e9\u00e0\u00fc\u00f1\n';
    store.globalRules.save(unicode);
    assert.equal(store.globalRules.load(), unicode);
  });
});

describe('store.globalRules normalization (#100)', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-store-rules-norm-'));
    store._setBasePath(tmpDir);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('_normalize', () => {
    const normalize = store.globalRules._normalize;

    it('strips trailing whitespace from every line', () => {
      const input = '# Title   \n\n- item one  \n- item two\t\n';
      assert.equal(normalize(input), '# Title\n\n- item one\n- item two\n');
    });

    it('skips a leading H1 when detecting body indent (the #100 root cause)', () => {
      // H1 at column 0, body uniformly indented 2 spaces \u2014 exactly the
      // pollution captured in ~/.tangleclaw/global-rules.md.
      const input = [
        '# Global Rules',
        '',
        '  These rules apply.',
        '',
        '  ## General',
        '  - one',
        '  - two',
        ''
      ].join('\n');
      assert.equal(
        normalize(input),
        '# Global Rules\n\nThese rules apply.\n\n## General\n- one\n- two\n'
      );
    });

    it('detects uniform indent when no leading H1 is present', () => {
      assert.equal(normalize('    line a\n    line b\n    line c\n'), 'line a\nline b\nline c\n');
    });

    it('does not dedent when body has any column-0 line (treats indent as intentional)', () => {
      const input = '# Title\n\n  para a\npara b\n';
      assert.equal(normalize(input), '# Title\n\n  para a\npara b\n');
    });

    it('collapses runs of 3+ blank lines to a single blank line', () => {
      assert.equal(normalize('a\n\n\n\n\nb\n'), 'a\n\nb\n');
    });

    it('trims leading and trailing blank lines', () => {
      assert.equal(normalize('\n\n# Title\n\nbody\n\n\n'), '# Title\n\nbody\n');
    });

    it('is idempotent on already-clean content', () => {
      const clean = '# Rules\n\n- one\n- two\n';
      assert.equal(normalize(clean), clean);
      assert.equal(normalize(normalize(clean)), clean);
    });

    it('returns empty string unchanged', () => {
      assert.equal(normalize(''), '');
    });

    it('returns whitespace-only content as empty string', () => {
      assert.equal(normalize('   \n\n  \n'), '');
    });

    it('returns non-string input unchanged (defensive)', () => {
      assert.equal(normalize(undefined), undefined);
      assert.equal(normalize(null), null);
      assert.equal(normalize(42), 42);
    });

    it('preserves nested indentation when stripping uniform body indent', () => {
      const input = '# Title\n\n  - parent\n    - child\n';
      assert.equal(normalize(input), '# Title\n\n- parent\n  - child\n');
    });

    it('normalizes CRLF line endings to LF (Critic BLOCKER)', () => {
      // Windows / GitHub web editor pastes can carry CRLF — without normalization,
      // \r survives and propagates into every regenerated CLAUDE.md.
      const crlf = '# Title\r\n\r\n- item one\r\n- item two\r\n';
      assert.equal(normalize(crlf), '# Title\n\n- item one\n- item two\n');
    });

    it('normalizes lone CR (old Mac line endings) to LF', () => {
      const cr = '# Title\r\rbody\r';
      assert.equal(normalize(cr), '# Title\n\nbody\n');
    });

    it('preserves trailing whitespace inside fenced code blocks (Critic MAJOR)', () => {
      // Inside ```...``` blocks, trailing whitespace can be semantic (diff
      // markers, intentional padding in code samples).
      const input = '# Title\n\n```\nline with trail   \nplain\n```\n';
      assert.equal(normalize(input), '# Title\n\n```\nline with trail   \nplain\n```\n');
    });

    it('preserves trailing whitespace inside ~~~ fenced code blocks', () => {
      const input = '# Title\n\n~~~\ntrail   \n~~~\n';
      assert.equal(normalize(input), '# Title\n\n~~~\ntrail   \n~~~\n');
    });

    it('strips trailing whitespace on the fence line itself but not body', () => {
      // The ``` line with trailing whitespace gets normalized; the content
      // inside the fence does not.
      const input = '```   \n  trail   \n```   \n';
      assert.equal(normalize(input), '```\n  trail   \n```\n');
    });

    it('handles fence + uniform body dedent together (relative indent preserved)', () => {
      const input = '# Title\n\n  ```\n  def foo():\n      pass\n  ```\n';
      // Body uniformly indented 2 → dedent 2. Inside fence, relative indent
      // (4 - 2 = 2) preserved — pass stays at indent 2 relative to def.
      assert.equal(normalize(input), '# Title\n\n```\ndef foo():\n    pass\n```\n');
    });
  });

  describe('save() applies normalization', () => {
    it('strips trailing whitespace before persisting', () => {
      store.globalRules.save('# Rules   \n\n- item  \n');
      const onDisk = fs.readFileSync(path.join(tmpDir, 'global-rules.md'), 'utf8');
      assert.equal(onDisk, '# Rules\n\n- item\n');
    });

    it('strips uniform body indent before persisting', () => {
      store.globalRules.save('# Rules\n\n  - item one\n  - item two\n');
      const onDisk = fs.readFileSync(path.join(tmpDir, 'global-rules.md'), 'utf8');
      assert.equal(onDisk, '# Rules\n\n- item one\n- item two\n');
    });

    it('save \u2192 load round-trip is idempotent', () => {
      const content = '# Rules\n\n- one\n- two\n';
      store.globalRules.save(content);
      assert.equal(store.globalRules.load(), content);
      store.globalRules.save(store.globalRules.load());
      assert.equal(store.globalRules.load(), content);
    });
  });

  describe('load() auto-heals legacy polluted files', () => {
    it('rewrites a polluted file in place on first read', () => {
      const userFile = path.join(tmpDir, 'global-rules.md');
      const dirty = '# Rules   \n\n  - item  \n  - other\n';
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(userFile, dirty, 'utf8');

      const loaded = store.globalRules.load();
      const expected = '# Rules\n\n- item\n- other\n';
      assert.equal(loaded, expected, 'load returns normalized content');
      assert.equal(fs.readFileSync(userFile, 'utf8'), expected, 'load auto-heals the file in place');
    });

    it('does not rewrite a clean file', () => {
      const userFile = path.join(tmpDir, 'global-rules.md');
      const clean = '# Rules\n\n- one\n';
      fs.mkdirSync(tmpDir, { recursive: true });
      fs.writeFileSync(userFile, clean, 'utf8');
      const mtimeBefore = fs.statSync(userFile).mtimeMs;

      const loaded = store.globalRules.load();
      assert.equal(loaded, clean);
      assert.equal(fs.statSync(userFile).mtimeMs, mtimeBefore, 'clean file is not rewritten');
    });
  });

  describe('reset() applies normalization to bundled defaults', () => {
    it('written defaults have no trailing whitespace', () => {
      const out = store.globalRules.reset();
      assert.equal(/[ \t]+\n/.test(out), false);
      const onDisk = fs.readFileSync(path.join(tmpDir, 'global-rules.md'), 'utf8');
      assert.equal(onDisk, out);
    });
  });
});
