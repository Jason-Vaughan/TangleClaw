import test from 'node:test';
import assert from 'node:assert';
import { processMilestones, GithubMilestone } from '../src/lib/milestones';

// Helper to create mock milestones
const createMilestone = (overrides: Partial<GithubMilestone>): GithubMilestone => ({
  number: 1,
  title: 'Test Milestone',
  description: '',
  state: 'open',
  open_issues: 0,
  closed_issues: 0,
  html_url: 'https://github.com',
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  closed_at: null,
  ...overrides
});

test('One valid current milestone', () => {
  const data = processMilestones([
    createMilestone({ description: '<!-- tangleclaw:website current -->\nSome text' })
  ]);
  assert.ok(data.current);
  assert.strictEqual(data.current?.description, 'Some text');
});

test('No current milestone', () => {
  const data = processMilestones([
    createMilestone({ description: 'Just text' })
  ]);
  assert.strictEqual(data.current, null);
});

test('Two current milestones fail closed rather than selecting one', () => {
  const data = processMilestones([
    createMilestone({ number: 1, description: '<!-- tangleclaw:website current -->' }),
    createMilestone({ number: 2, description: '<!-- tangleclaw:website current -->' })
  ]);
  assert.strictEqual(data.current, null);
});

test('Valid featured milestones sort by explicit completion date, not closed_at', () => {
  const data = processMilestones([
    createMilestone({ 
      number: 1, 
      state: 'closed', 
      description: '<!-- tangleclaw:website featured completed=2026-09-01 -->' 
    }),
    createMilestone({ 
      number: 2, 
      state: 'closed', 
      description: '<!-- tangleclaw:website featured completed=2026-09-10 -->' 
    })
  ]);
  assert.ok(data.latestCompleted);
  assert.strictEqual(data.latestCompleted?.number, 2);
});

test('Valid featured milestones tie-break by milestone number', () => {
  const data = processMilestones([
    createMilestone({ 
      number: 1, 
      state: 'closed', 
      description: '<!-- tangleclaw:website featured completed=2026-09-01 -->' 
    }),
    createMilestone({ 
      number: 2, 
      state: 'closed', 
      description: '<!-- tangleclaw:website featured completed=2026-09-01 -->' 
    })
  ]);
  assert.ok(data.latestCompleted);
  assert.strictEqual(data.latestCompleted?.number, 2);
});

test('A newly closed legacy milestone without a tag is ignored', () => {
  const data = processMilestones([
    createMilestone({ state: 'closed', description: 'Just a closed milestone' })
  ]);
  assert.strictEqual(data.latestCompleted, null);
});

test('Featured milestone with open issues is rejected', () => {
  const data = processMilestones([
    createMilestone({ 
      state: 'closed', 
      open_issues: 1, 
      description: '<!-- tangleclaw:website featured completed=2026-09-01 -->' 
    })
  ]);
  assert.strictEqual(data.latestCompleted, null);
});

test('Current tag on a closed milestone is rejected', () => {
  const data = processMilestones([
    createMilestone({ 
      state: 'closed', 
      description: '<!-- tangleclaw:website current -->' 
    })
  ]);
  assert.strictEqual(data.current, null);
});

test('Malformed tags are rejected', () => {
  const data = processMilestones([
    createMilestone({ description: '<!-- tangleclaw:website current-- >' })
  ]);
  assert.strictEqual(data.current, null);
});

test('Duplicate tags in same description are rejected', () => {
  const data = processMilestones([
    createMilestone({ description: '<!-- tangleclaw:website current --><!-- tangleclaw:website current -->' })
  ]);
  assert.strictEqual(data.current, null);
});

test('Both current and featured tags in same description are rejected', () => {
  const data = processMilestones([
    createMilestone({ description: '<!-- tangleclaw:website current --><!-- tangleclaw:website featured completed=2026-09-01 -->' })
  ]);
  assert.strictEqual(data.current, null);
});

test('The tag is stripped and untrusted description content is sanitized', () => {
  const data = processMilestones([
    createMilestone({ 
      description: '<!-- tangleclaw:website current -->Hello <script>alert("xss")</script><iframe src="evil"></iframe><div onmouseover="alert()">hover</div>' 
    })
  ]);
  assert.ok(data.current);
  assert.strictEqual(data.current?.description, 'Hello <div >hover</div>');
});
