'use strict';

const { describe, it, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const store = require('../lib/store');
const methodologies = require('../lib/methodologies');

let tmpDir;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tc-meth-test-'));
  store._setBasePath(tmpDir);
  store.init();
});

after(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Template Validation ──

describe('validateTemplate', () => {
  it('accepts a valid minimal template', () => {
    const result = methodologies.validateTemplate({
      id: 'test',
      name: 'Test',
      description: 'A test methodology',
      type: 'methodology',
      version: '1.0.0'
    });
    assert.equal(result.valid, true);
    assert.equal(result.errors.length, 0);
  });

  it('accepts a full template with all fields', () => {
    const template = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'data', 'templates', 'prawduct', 'template.json'), 'utf8')
    );
    const result = methodologies.validateTemplate(template);
    assert.equal(result.valid, true, `Errors: ${result.errors.join(', ')}`);
  });

  it('rejects null input', () => {
    const result = methodologies.validateTemplate(null);
    assert.equal(result.valid, false);
    assert.ok(result.errors[0].includes('non-null object'));
  });

  it('rejects missing required fields', () => {
    const result = methodologies.validateTemplate({});
    assert.equal(result.valid, false);
    assert.ok(result.errors.length >= 5);
    assert.ok(result.errors.some((e) => e.includes('id')));
    assert.ok(result.errors.some((e) => e.includes('name')));
    assert.ok(result.errors.some((e) => e.includes('description')));
    assert.ok(result.errors.some((e) => e.includes('type')));
    assert.ok(result.errors.some((e) => e.includes('version')));
  });

  it('rejects invalid type', () => {
    const result = methodologies.validateTemplate({
      id: 'test', name: 'Test', description: 'Test', type: 'scaffold', version: '1.0.0'
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('type must be "methodology"')));
  });

  it('rejects invalid version format', () => {
    const result = methodologies.validateTemplate({
      id: 'test', name: 'Test', description: 'Test', type: 'methodology', version: 'abc'
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('semver')));
  });

  it('rejects duplicate phase ids', () => {
    const result = methodologies.validateTemplate({
      id: 'test', name: 'Test', type: 'methodology', version: '1.0.0',
      phases: [
        { id: 'build', name: 'Build' },
        { id: 'build', name: 'Build Again' }
      ]
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('Duplicate phase id')));
  });

  it('rejects invalid phase weight', () => {
    const result = methodologies.validateTemplate({
      id: 'test', name: 'Test', type: 'methodology', version: '1.0.0',
      phases: [{ id: 'build', name: 'Build', weight: 'heavy' }]
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('weight')));
  });

  it('rejects phases without id', () => {
    const result = methodologies.validateTemplate({
      id: 'test', name: 'Test', type: 'methodology', version: '1.0.0',
      phases: [{ name: 'Build' }]
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('phases[0].id')));
  });

  it('rejects invalid detection strategy', () => {
    const result = methodologies.validateTemplate({
      id: 'test', name: 'Test', type: 'methodology', version: '1.0.0',
      detection: { strategy: 'magic', target: '.foo' }
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('detection.strategy')));
  });

  it('rejects detection without target', () => {
    const result = methodologies.validateTemplate({
      id: 'test', name: 'Test', type: 'methodology', version: '1.0.0',
      detection: { strategy: 'directory' }
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('detection.target')));
  });

  it('rejects statusContract requiring field without it', () => {
    const result = methodologies.validateTemplate({
      id: 'test', name: 'Test', type: 'methodology', version: '1.0.0',
      statusContract: { command: 'echo test', parse: 'json', badge: 'status' }
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some((e) => e.includes('statusContract.field')));
  });

  it('validates all bundled templates', () => {
    const templateIds = ['minimal', 'prawduct', 'tilt'];
    for (const id of templateIds) {
      const template = store.templates.get(id);
      assert.ok(template, `Template "${id}" should exist`);
      const result = methodologies.validateTemplate(template);
      assert.equal(result.valid, true, `Template "${id}" validation failed: ${result.errors.join(', ')}`);
    }
  });
});

// ── Detection ──

describe('detect', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(tmpDir, 'project-'));
  });

  it('detects prawduct methodology via .prawduct directory', () => {
    fs.mkdirSync(path.join(projectDir, '.prawduct'));
    const result = methodologies.detect(projectDir);
    assert.ok(result);
    assert.equal(result.id, 'prawduct');
    assert.equal(result.name, 'Prawduct');
  });

  it('detects tilt methodology via .tilt directory', () => {
    fs.mkdirSync(path.join(projectDir, '.tilt'));
    const result = methodologies.detect(projectDir);
    assert.ok(result);
    assert.equal(result.id, 'tilt');
  });

  it('detects minimal methodology via .tangleclaw/project.json file', () => {
    fs.mkdirSync(path.join(projectDir, '.tangleclaw'));
    fs.writeFileSync(path.join(projectDir, '.tangleclaw', 'project.json'), '{}');
    const result = methodologies.detect(projectDir);
    assert.ok(result);
    assert.equal(result.id, 'minimal');
  });

  it('returns null for empty project directory', () => {
    const result = methodologies.detect(projectDir);
    assert.equal(result, null);
  });

  it('returns null for non-existent path', () => {
    const result = methodologies.detect('/nonexistent/path');
    assert.equal(result, null);
  });

  it('returns null for null path', () => {
    const result = methodologies.detect(null);
    assert.equal(result, null);
  });
});

describe('_checkDetection', () => {
  let projectDir;

  before(() => {
    projectDir = fs.mkdtempSync(path.join(tmpDir, 'detect-'));
    fs.mkdirSync(path.join(projectDir, '.prawduct'));
    fs.writeFileSync(path.join(projectDir, 'marker.txt'), 'exists');
  });

  it('detects directory strategy', () => {
    assert.equal(methodologies._checkDetection(projectDir, { strategy: 'directory', target: '.prawduct' }), true);
  });

  it('returns false for missing directory', () => {
    assert.equal(methodologies._checkDetection(projectDir, { strategy: 'directory', target: '.missing' }), false);
  });

  it('detects file strategy', () => {
    assert.equal(methodologies._checkDetection(projectDir, { strategy: 'file', target: 'marker.txt' }), true);
  });

  it('returns false for missing file', () => {
    assert.equal(methodologies._checkDetection(projectDir, { strategy: 'file', target: 'missing.txt' }), false);
  });

  it('returns false for custom strategy', () => {
    assert.equal(methodologies._checkDetection(projectDir, { strategy: 'custom', target: 'anything' }), false);
  });

  it('returns false for unknown strategy', () => {
    assert.equal(methodologies._checkDetection(projectDir, { strategy: 'magic', target: 'anything' }), false);
  });
});

// ── Initialization ──

describe('initialize', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(tmpDir, 'init-'));
  });

  it('initializes prawduct methodology', () => {
    const result = methodologies.initialize(projectDir, 'prawduct', { projectName: 'test-project' });
    assert.equal(result.success, true);
    assert.ok(result.created.length > 0);
    assert.ok(fs.existsSync(path.join(projectDir, '.prawduct')));
    assert.ok(fs.existsSync(path.join(projectDir, '.prawduct', 'artifacts')));
    assert.ok(fs.existsSync(path.join(projectDir, '.prawduct', 'project-state.yaml')));
  });

  it('initializes tilt methodology', () => {
    const result = methodologies.initialize(projectDir, 'tilt');
    assert.equal(result.success, true);
    assert.ok(fs.existsSync(path.join(projectDir, '.tilt')));
    assert.ok(fs.existsSync(path.join(projectDir, '.tilt', 'status.json')));
  });

  it('initializes minimal methodology', () => {
    const result = methodologies.initialize(projectDir, 'minimal');
    assert.equal(result.success, true);
    assert.ok(fs.existsSync(path.join(projectDir, '.tangleclaw')));
  });

  it('does not overwrite existing files', () => {
    fs.mkdirSync(path.join(projectDir, '.tilt'));
    fs.writeFileSync(path.join(projectDir, '.tilt', 'status.json'), '{"custom": true}');

    methodologies.initialize(projectDir, 'tilt');

    const content = JSON.parse(fs.readFileSync(path.join(projectDir, '.tilt', 'status.json'), 'utf8'));
    assert.equal(content.custom, true);
  });

  it('returns error for unknown template', () => {
    const result = methodologies.initialize(projectDir, 'nonexistent');
    assert.equal(result.success, false);
    assert.ok(result.errors[0].includes('not found'));
  });

  it('reports existing directories as not created', () => {
    fs.mkdirSync(path.join(projectDir, '.tilt'));
    const result = methodologies.initialize(projectDir, 'tilt');
    assert.equal(result.success, true);
    assert.ok(!result.created.includes('.tilt'));
  });
});

// ── Switching ──

describe('switchMethodology', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(tmpDir, 'switch-'));
  });

  it('archives old methodology and initializes new', () => {
    // Set up prawduct
    fs.mkdirSync(path.join(projectDir, '.prawduct'));
    fs.writeFileSync(path.join(projectDir, '.prawduct', 'state.yaml'), 'test');

    const result = methodologies.switchMethodology(projectDir, 'prawduct', 'tilt');
    assert.equal(result.success, true);
    assert.ok(result.archivePath);
    assert.ok(result.archivePath.includes('.prawduct.archived'));
    assert.ok(!fs.existsSync(path.join(projectDir, '.prawduct')));
    assert.ok(fs.existsSync(path.join(projectDir, '.tilt')));
  });

  it('handles non-existent current methodology gracefully', () => {
    const result = methodologies.switchMethodology(projectDir, 'nonexistent', 'minimal');
    assert.equal(result.success, true);
    assert.equal(result.archivePath, null);
  });

  it('returns error for non-existent new methodology', () => {
    const result = methodologies.switchMethodology(projectDir, 'minimal', 'nonexistent');
    assert.equal(result.success, false);
    assert.ok(result.errors[0].includes('not found'));
  });

  it('handles existing archive by adding timestamp', () => {
    // Set up prawduct and a prior archive
    fs.mkdirSync(path.join(projectDir, '.prawduct'));
    fs.writeFileSync(path.join(projectDir, '.prawduct', 'state.yaml'), 'test');
    fs.mkdirSync(path.join(projectDir, '.prawduct.archived'));

    const result = methodologies.switchMethodology(projectDir, 'prawduct', 'tilt');
    assert.equal(result.success, true);
    assert.ok(result.archivePath);
    assert.ok(result.archivePath.includes('.prawduct.archived-'));
  });
});

// ── Status Contract ──

describe('executeStatusContract', () => {
  let projectDir;

  before(() => {
    projectDir = fs.mkdtempSync(path.join(tmpDir, 'status-'));
  });

  it('returns default for null contract', () => {
    const result = methodologies.executeStatusContract(projectDir, null);
    assert.equal(result.badge, null);
    assert.equal(result.color, null);
    assert.equal(result.detail, null);
  });

  it('returns default for contract without command', () => {
    const result = methodologies.executeStatusContract(projectDir, {
      command: null, parse: null, badge: 'status', colorMap: {}
    });
    assert.equal(result.badge, null);
  });

  it('executes JSON status contract', () => {
    fs.writeFileSync(path.join(projectDir, 'status.json'), '{"status": "active"}');
    const result = methodologies.executeStatusContract(projectDir, {
      command: 'cat status.json',
      parse: 'json',
      field: 'status',
      badge: 'status',
      colorMap: { active: 'green' }
    });
    assert.equal(result.detail, 'active');
    assert.equal(result.color, 'green');
  });

  it('handles failing command gracefully', () => {
    const result = methodologies.executeStatusContract(projectDir, {
      command: 'cat nonexistent_file_xyz',
      parse: 'json',
      field: 'status',
      badge: 'status',
      colorMap: {}
    });
    assert.equal(result.badge, null);
  });
});

describe('_parseYamlField', () => {
  it('parses simple key-value', () => {
    const yaml = 'status: active';
    assert.equal(methodologies._parseYamlField(yaml, 'status'), 'active');
  });

  it('parses nested field', () => {
    const yaml = 'work_in_progress:\n  description: Building chunk 3';
    assert.equal(methodologies._parseYamlField(yaml, 'work_in_progress.description'), 'Building chunk 3');
  });

  it('returns null for missing field', () => {
    const yaml = 'status: active';
    assert.equal(methodologies._parseYamlField(yaml, 'missing'), null);
  });

  it('strips surrounding quotes', () => {
    const yaml = 'status: "active"';
    assert.equal(methodologies._parseYamlField(yaml, 'status'), 'active');
  });

  it('skips comment lines', () => {
    const yaml = '# comment\nstatus: active';
    assert.equal(methodologies._parseYamlField(yaml, 'status'), 'active');
  });

  it('returns null for null fieldPath', () => {
    assert.equal(methodologies._parseYamlField('key: value', null), null);
  });

  it('handles various indentation levels', () => {
    // 2-space indentation works
    const yaml2space = 'work_in_progress:\n  description: two spaces';
    assert.equal(methodologies._parseYamlField(yaml2space, 'work_in_progress.description'), 'two spaces');

    // 4-space indentation also parses (simple depth tracking)
    const yaml4space = 'work_in_progress:\n    description: four spaces';
    assert.equal(methodologies._parseYamlField(yaml4space, 'work_in_progress.description'), 'four spaces');
  });
});

describe('_parseJsonField', () => {
  it('parses simple field', () => {
    assert.equal(methodologies._parseJsonField('{"status": "ok"}', 'status'), 'ok');
  });

  it('parses nested field', () => {
    assert.equal(methodologies._parseJsonField('{"a": {"b": "deep"}}', 'a.b'), 'deep');
  });

  it('returns null for invalid JSON', () => {
    assert.equal(methodologies._parseJsonField('not json', 'field'), null);
  });

  it('returns null for missing field', () => {
    assert.equal(methodologies._parseJsonField('{"a": 1}', 'b'), null);
  });

  it('converts numbers to string', () => {
    assert.equal(methodologies._parseJsonField('{"count": 42}', 'count'), '42');
  });
});

describe('_parseRegex', () => {
  it('returns first capture group', () => {
    assert.equal(methodologies._parseRegex('version: 3.0.0', 'version:\\s+(.+)'), '3.0.0');
  });

  it('returns full match without capture group', () => {
    assert.equal(methodologies._parseRegex('hello world', 'hello'), 'hello');
  });

  it('returns null for no match', () => {
    assert.equal(methodologies._parseRegex('hello', 'xyz'), null);
  });

  it('returns null for null pattern', () => {
    assert.equal(methodologies._parseRegex('hello', null), null);
  });

  it('returns null for invalid regex', () => {
    assert.equal(methodologies._parseRegex('hello', '[invalid'), null);
  });
});

describe('_resolveColor', () => {
  it('resolves known color', () => {
    assert.equal(methodologies._resolveColor('building', { building: 'green' }), 'green');
  });

  it('returns null for unknown value', () => {
    assert.equal(methodologies._resolveColor('unknown', { building: 'green' }), null);
  });

  it('returns null for null value', () => {
    assert.equal(methodologies._resolveColor(null, { building: 'green' }), null);
  });

  it('returns null for null colorMap', () => {
    assert.equal(methodologies._resolveColor('building', null), null);
  });
});

// ── Phase Management ──

describe('getPhase', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(tmpDir, 'phase-'));
  });

  it('returns null when no phase is set', () => {
    assert.equal(methodologies.getPhase(projectDir), null);
  });

  it('returns phase from project config', () => {
    fs.mkdirSync(path.join(projectDir, '.tangleclaw'));
    fs.writeFileSync(
      path.join(projectDir, '.tangleclaw', 'project.json'),
      JSON.stringify({ methodologyPhase: 'building' })
    );
    assert.equal(methodologies.getPhase(projectDir), 'building');
  });
});

describe('setPhase', () => {
  let projectDir;

  beforeEach(() => {
    projectDir = fs.mkdtempSync(path.join(tmpDir, 'setphase-'));
  });

  it('sets phase and persists to project config', () => {
    const result = methodologies.setPhase(projectDir, 'building', 'prawduct');
    assert.equal(result.success, true);
    assert.equal(result.error, null);

    const config = store.projectConfig.load(projectDir);
    assert.equal(config.methodologyPhase, 'building');
  });

  it('returns offerContextReset from phase definition', () => {
    const result = methodologies.setPhase(projectDir, 'building', 'prawduct');
    assert.equal(result.offerContextReset, true);

    const result2 = methodologies.setPhase(projectDir, 'discovery', 'prawduct');
    assert.equal(result2.offerContextReset, false);
  });

  it('rejects invalid phase id', () => {
    const result = methodologies.setPhase(projectDir, 'nonexistent', 'prawduct');
    assert.equal(result.success, false);
    assert.ok(result.error.includes('not found'));
  });

  it('rejects unknown template id', () => {
    const result = methodologies.setPhase(projectDir, 'build', 'nonexistent');
    assert.equal(result.success, false);
    assert.ok(result.error.includes('not found'));
  });

  it('sets phase without template validation when templateId omitted', () => {
    const result = methodologies.setPhase(projectDir, 'custom-phase');
    assert.equal(result.success, true);
    assert.equal(result.offerContextReset, false);
  });
});

// ── List/Get ──

describe('listTemplates', () => {
  it('returns all templates with summary fields', () => {
    const list = methodologies.listTemplates();
    assert.ok(Array.isArray(list));
    assert.ok(list.length >= 3); // minimal, prawduct, tilt

    const prawduct = list.find((t) => t.id === 'prawduct');
    assert.ok(prawduct);
    assert.equal(prawduct.name, 'Prawduct');
    assert.ok(Array.isArray(prawduct.phases));
    assert.ok(prawduct.phases.includes('discovery'));
    assert.ok(typeof prawduct.defaultRules === 'object');
  });

  it('includes minimal template', () => {
    const list = methodologies.listTemplates();
    const minimal = list.find((t) => t.id === 'minimal');
    assert.ok(minimal);
    assert.deepEqual(minimal.phases, []);
    assert.deepEqual(minimal.defaultRules, {});
  });
});

describe('getTemplate', () => {
  it('returns full template for valid id', () => {
    const template = methodologies.getTemplate('prawduct');
    assert.ok(template);
    assert.equal(template.id, 'prawduct');
    assert.ok(template.phases);
    assert.ok(template.statusContract);
    assert.ok(template.detection);
    assert.ok(template.init);
  });

  it('returns null for unknown id', () => {
    assert.equal(methodologies.getTemplate('nonexistent'), null);
  });
});
