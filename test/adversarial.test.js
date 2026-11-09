'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const adversarial = require('../lib/adversarial');
const {
  CATEGORIES,
  SEVERITIES,
  DISPOSITIONS,
  DEFAULT_CONSTITUTION,
  DEFAULT_PERSONAS,
  runAdversarialPass,
  validateAdversarialOutput,
  filterAndPrioritizeFindings,
  recordAdversarialDispositions
} = adversarial;

function sampleFinding(overrides = {}) {
  return {
    id: 'f1',
    category: 'boundary',
    severity: 'high',
    scenario: 'call paginate(items, -1)',
    why_it_breaks: 'negative page size is not validated, producing an infinite loop',
    suggested_test: "assert.throws(() => paginate(items, -1))",
    ...overrides
  };
}

describe('module exports — schema constants', () => {
  it('exports the documented category/severity/disposition vocab and defaults', () => {
    assert.ok(CATEGORIES.includes('security'));
    assert.ok(CATEGORIES.includes('malformed_input'));
    assert.deepEqual(SEVERITIES, ['critical', 'high', 'medium', 'low']);
    assert.deepEqual(DISPOSITIONS, ['regression_test', 'defensive_code', 'documented_non_issue', 'follow_up_issue']);
    assert.equal(typeof DEFAULT_CONSTITUTION, 'string');
    assert.ok(DEFAULT_CONSTITUTION.length > 0);
    assert.ok(Array.isArray(DEFAULT_PERSONAS) && DEFAULT_PERSONAS.length >= 3);
  });
});

describe('validateAdversarialOutput — valid output', () => {
  it('accepts a well-formed object with findings and top_5_prioritized', () => {
    const result = validateAdversarialOutput({
      findings: [sampleFinding()],
      top_5_prioritized: ['f1']
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
    assert.equal(result.output.findings.length, 1);
    assert.equal(result.output.findings[0].id, 'f1');
    assert.deepEqual(result.output.top_5_prioritized, ['f1']);
  });

  it('accepts a JSON string (parses it) and assigns a fallback id when missing', () => {
    const raw = JSON.stringify({ findings: [sampleFinding({ id: undefined })], top_5_prioritized: [] });
    const result = validateAdversarialOutput(raw);
    assert.equal(result.valid, true);
    assert.equal(result.output.findings[0].id, 'finding_1');
  });

  it('drops top_5_prioritized ids that are not strings, keeps the rest', () => {
    const result = validateAdversarialOutput({
      findings: [sampleFinding()],
      top_5_prioritized: ['f1', 42, null]
    });
    assert.equal(result.valid, true);
    assert.deepEqual(result.output.top_5_prioritized, ['f1']);
  });
});

describe('validateAdversarialOutput — declines (never throws) on malformed input', () => {
  it('declines null/undefined/non-object/array top-level shapes', () => {
    for (const bad of [null, undefined, 'nope', 7, [], ['a']]) {
      const result = validateAdversarialOutput(bad);
      assert.equal(result.valid, false);
      assert.equal(result.output, null);
      assert.ok(result.errors.length > 0);
    }
  });

  it('declines a non-JSON string instead of throwing', () => {
    const result = validateAdversarialOutput('{not json');
    assert.equal(result.valid, false);
    assert.match(result.errors[0], /not valid JSON/);
  });

  it('declines when findings is missing or not an array', () => {
    assert.equal(validateAdversarialOutput({}).valid, false);
    assert.equal(validateAdversarialOutput({ findings: 'nope' }).valid, false);
    assert.equal(validateAdversarialOutput({ findings: {} }).valid, false);
  });

  it('declines a finding with a bad category, severity, or missing required string field', () => {
    assert.equal(validateAdversarialOutput({ findings: [sampleFinding({ category: 'nonsense' })] }).valid, false);
    assert.equal(validateAdversarialOutput({ findings: [sampleFinding({ severity: 'ludicrous' })] }).valid, false);
    assert.equal(validateAdversarialOutput({ findings: [sampleFinding({ scenario: '' })] }).valid, false);
    assert.equal(validateAdversarialOutput({ findings: [sampleFinding({ why_it_breaks: 42 })] }).valid, false);
    assert.equal(validateAdversarialOutput({ findings: [sampleFinding({ suggested_test: null })] }).valid, false);
    assert.equal(validateAdversarialOutput({ findings: [null] }).valid, false);
  });

  it('declines duplicate finding ids', () => {
    const result = validateAdversarialOutput({
      findings: [sampleFinding({ id: 'dup' }), sampleFinding({ id: 'dup' })]
    });
    assert.equal(result.valid, false);
    assert.match(result.errors.join(';'), /duplicate id/);
  });
});

describe('filterAndPrioritizeFindings', () => {
  const output = {
    findings: [
      sampleFinding({ id: 'low1', severity: 'low' }),
      sampleFinding({ id: 'crit1', severity: 'critical' }),
      sampleFinding({ id: 'med1', severity: 'medium' }),
      sampleFinding({ id: 'high1', severity: 'high' })
    ],
    top_5_prioritized: ['crit1', 'low1', 'nonexistent']
  };

  it('keeps everything at the default low threshold, sorted by severity descending', () => {
    const { findings } = filterAndPrioritizeFindings(output, {});
    assert.deepEqual(findings.map((f) => f.id), ['crit1', 'high1', 'med1', 'low1']);
  });

  it('filters out findings below severityThreshold', () => {
    const { findings } = filterAndPrioritizeFindings(output, { severityThreshold: 'high' });
    assert.deepEqual(findings.map((f) => f.id), ['crit1', 'high1']);
  });

  it('caps the result at maxFindings, keeping the highest severity first', () => {
    const { findings } = filterAndPrioritizeFindings(output, { maxFindings: 2 });
    assert.deepEqual(findings.map((f) => f.id), ['crit1', 'high1']);
  });

  it('trims top5 to ids that survived filtering, dropping unknown ids', () => {
    const { top5 } = filterAndPrioritizeFindings(output, { severityThreshold: 'medium' });
    assert.deepEqual(top5, ['crit1']);
  });

  it('declines (returns empty) rather than throwing on an unrecognized severityThreshold', () => {
    assert.deepEqual(filterAndPrioritizeFindings(output, { severityThreshold: 'ludicrous' }), { findings: [], top5: [] });
  });

  it('tolerates a missing/malformed output object without throwing', () => {
    assert.deepEqual(filterAndPrioritizeFindings(null, {}), { findings: [], top5: [] });
    assert.deepEqual(filterAndPrioritizeFindings({}, {}), { findings: [], top5: [] });
  });
});

describe('runAdversarialPass — input guards (never throws)', () => {
  it('rejects a missing/malformed surface without calling spawnSubagent', async () => {
    let called = false;
    const spawnSubagent = async () => { called = true; return '{}'; };
    const result = await runAdversarialPass({ spawnSubagent });
    assert.equal(result.ok, false);
    assert.match(result.error, /requires options.surface/);
    assert.equal(called, false);
  });

  it('rejects a missing spawnSubagent', async () => {
    const result = await runAdversarialPass({ surface: { files: ['a.js'] } });
    assert.equal(result.ok, false);
    assert.match(result.error, /requires options.spawnSubagent/);
  });

  it('rejects an unrecognized severityThreshold', async () => {
    const result = await runAdversarialPass({
      surface: { files: ['a.js'] },
      severityThreshold: 'ludicrous',
      spawnSubagent: async () => '{}'
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /severityThreshold must be one of/);
  });
});

describe('runAdversarialPass — happy path with an injected spawnSubagent', () => {
  it('passes the surface/personas into the prompt and returns filtered findings', async () => {
    let receivedPrompt = null;
    const spawnSubagent = async (prompt) => {
      receivedPrompt = prompt;
      return JSON.stringify({
        findings: [
          sampleFinding({ id: 'off-by-one', category: 'boundary', severity: 'high' }),
          sampleFinding({ id: 'noise', severity: 'low' })
        ],
        top_5_prioritized: ['off-by-one']
      });
    };

    const result = await runAdversarialPass({
      surface: { files: ['lib/paginate.js'], symbols: ['paginate'] },
      personas: ['A power user automating this at 1000 req/sec.'],
      severityThreshold: 'medium',
      spawnSubagent
    });

    assert.equal(result.ok, true);
    assert.equal(result.error, null);
    assert.deepEqual(result.output.findings.map((f) => f.id), ['off-by-one']);
    assert.deepEqual(result.output.top5PrioritizedIds, ['off-by-one']);
    assert.match(receivedPrompt, /lib\/paginate\.js/);
    assert.match(receivedPrompt, /paginate/);
    assert.match(receivedPrompt, /1000 req\/sec/);
  });

  it('uses DEFAULT_CONSTITUTION and DEFAULT_PERSONAS when the caller supplies neither', async () => {
    let receivedPrompt = null;
    const spawnSubagent = async (prompt) => {
      receivedPrompt = prompt;
      return { findings: [], top_5_prioritized: [] };
    };
    const result = await runAdversarialPass({ surface: { endpoints: ['/api/x'] }, spawnSubagent });
    assert.equal(result.ok, true);
    assert.ok(receivedPrompt.startsWith(DEFAULT_CONSTITUTION));
    assert.match(receivedPrompt, new RegExp(DEFAULT_PERSONAS[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});

describe('runAdversarialPass — rejects malformed subagent output gracefully', () => {
  it('returns ok:false (never throws) when spawnSubagent returns unparsable JSON', async () => {
    const result = await runAdversarialPass({
      surface: { files: ['a.js'] },
      spawnSubagent: async () => 'not json at all'
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /malformed adversarial subagent output/);
  });

  it('returns ok:false when spawnSubagent returns a findings array with a bad entry', async () => {
    const result = await runAdversarialPass({
      surface: { files: ['a.js'] },
      spawnSubagent: async () => ({ findings: [{ category: 'nonsense' }] })
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /malformed adversarial subagent output/);
  });

  it('returns ok:false (never throws) when spawnSubagent itself throws', async () => {
    const result = await runAdversarialPass({
      surface: { files: ['a.js'] },
      spawnSubagent: async () => { throw new Error('engine crashed'); }
    });
    assert.equal(result.ok, false);
    assert.match(result.error, /spawnSubagent threw: engine crashed/);
  });
});

describe('recordAdversarialDispositions — forbids silent ignoring', () => {
  it('rejects an empty/non-array dispositions list', () => {
    for (const bad of [null, undefined, [], 'nope']) {
      const result = recordAdversarialDispositions(bad, { store: () => {} });
      assert.equal(result.ok, false);
    }
  });

  it('requires either store or auditLogPath', () => {
    const result = recordAdversarialDispositions([{ findingId: 'f1', disposition: 'regression_test', rationale: 'added test/x.test.js' }], {});
    assert.equal(result.ok, false);
    assert.match(result.error, /requires options.store or options.auditLogPath/);
  });

  it('rejects an unrecognized disposition value', () => {
    const result = recordAdversarialDispositions(
      [{ findingId: 'f1', disposition: 'shrug', rationale: 'eh' }],
      { store: () => {} }
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /disposition "shrug" must be one of/);
  });

  it('rejects a missing/empty rationale — the forbidden silent-ignore shape', () => {
    const result = recordAdversarialDispositions(
      [{ findingId: 'f1', disposition: 'documented_non_issue', rationale: '' }],
      { store: () => {} }
    );
    assert.equal(result.ok, false);
    assert.match(result.error, /rationale must be a non-empty string/);
  });

  it('records valid dispositions via an injected store function', () => {
    const calls = [];
    const result = recordAdversarialDispositions(
      [
        { findingId: 'f1', disposition: 'regression_test', rationale: 'added test/paginate.test.js', ref: 'test/paginate.test.js' },
        { findingId: 'f2', disposition: 'follow_up_issue', rationale: 'out of scope for this chunk', ref: '#999' }
      ],
      { store: (records) => calls.push(records) }
    );
    assert.equal(result.ok, true);
    assert.equal(result.recorded.length, 2);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0].findingId, 'f1');
    assert.equal(calls[0][1].ref, '#999');
    assert.ok(result.recorded.every((r) => typeof r.recordedAt === 'string'));
  });

  it('appends JSON lines to auditLogPath when no store is supplied', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adversarial-audit-'));
    const auditLogPath = path.join(dir, 'audit.jsonl');
    try {
      const first = recordAdversarialDispositions(
        [{ findingId: 'f1', disposition: 'defensive_code', rationale: 'added input guard' }],
        { auditLogPath }
      );
      assert.equal(first.ok, true);
      const second = recordAdversarialDispositions(
        [{ findingId: 'f2', disposition: 'documented_non_issue', rationale: 'not in our threat model' }],
        { auditLogPath }
      );
      assert.equal(second.ok, true);

      const lines = fs.readFileSync(auditLogPath, 'utf8').trim().split('\n');
      assert.equal(lines.length, 2);
      assert.equal(JSON.parse(lines[0]).findingId, 'f1');
      assert.equal(JSON.parse(lines[1]).findingId, 'f2');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('structural guard — TC never calls an LLM API itself', () => {
  it('the module imports no HTTP/LLM client; spawnSubagent is always caller-injected', () => {
    const src = fs.readFileSync(require.resolve('../lib/adversarial.js'), 'utf8');
    assert.doesNotMatch(src, /require\(['"](node:)?(http|https|net|undici)['"]\)/);
    assert.doesNotMatch(src, /\bfetch\s*\(/);
  });
});
