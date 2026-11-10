'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ADR_0026_PATH = path.join(
  ROOT,
  'docs',
  'adr',
  '0026-native-conversation-layer-and-open-hood-contract.md'
);
const ADR_0008_PATH = path.join(
  ROOT,
  'docs',
  'adr',
  '0008-project-master-session-model.md'
);

test('ADR 0026 exists and records ratified status amending ADR 0008 Decision 6', () => {
  assert.equal(fs.existsSync(ADR_0026_PATH), true, 'ADR 0026 file must exist');
  const adr0026 = fs.readFileSync(ADR_0026_PATH, 'utf8');

  assert.match(adr0026, /^# ADR 0026:/m);
  assert.match(adr0026, /\*\*Status:\*\*\s*Ratified — 2026-11-10/);
  assert.match(adr0026, /OP-GO-V6-GATE0-20261110/);
  assert.match(adr0026, /supersedes Decision 6/i);
  assert.match(adr0026, /preserving Decisions 1–5/i);
});

test('ADR 0026 enforces all Rev 5 security, privacy, interruption, adapter, and Open Hood invariants', () => {
  const adr0026 = fs.readFileSync(ADR_0026_PATH, 'utf8');

  // 1. Verbatim Open Hood Core Rule
  assert.ok(
    adr0026.includes(
      'Opening, closing, hiding, or switching views must never independently affect the lifecycle of the underlying AI session.'
    ),
    'ADR 0026 must contain the verbatim Open Hood non-interference core rule'
  );

  // 2. Ledger Security, Privacy & SQLite Secure Deletion vs Cryptographic Deletion + 4 Residual-Copy Disclosures
  assert.match(adr0026, /403 CONVERSATION_CROSS_PROJECT_DENIED/);
  assert.match(adr0026, /lib\/secret-redactor\.js/);
  assert.match(adr0026, /PRAGMA secure_delete = ON/);
  assert.match(adr0026, /PRAGMA wal_checkpoint\(TRUNCATE\)/);
  assert.match(adr0026, /database page-overwrite deletion, NOT true cryptographic deletion/);
  assert.match(adr0026, /residual_locations\[\]/);
  assert.match(adr0026, /tmux clear-history/);

  // 3. Queue Prioritization vs Active Turn Interruption
  assert.match(adr0026, /POST \/api\/sessions\/:scope\/conversation\/messages\/:id\/prioritize/);
  assert.match(adr0026, /POST \/api\/sessions\/:scope\/conversation\/interrupt/);
  assert.match(adr0026, /interruptContract/);
  assert.match(adr0026, /native-rpc-cancel/);
  assert.match(adr0026, /verified-sigint-turn-cancel/);
  assert.match(adr0026, /409 INTERRUPT_UNSUPPORTED_BY_ENGINE/);

  // 4. Tier-A vs Tier-B Adapter Non-Fabrication & Deduplication
  assert.match(adr0026, /source: 'pane-derived'/);
  assert.match(adr0026, /Terminal-Derived \(Degraded Fidelity\)/);
  assert.match(adr0026, /pane_cursor_watermark/);
});

test('ADR 0008 cross-references ADR 0026 as superseding Decision 6 while retaining Decisions 1–5', () => {
  const adr0008 = fs.readFileSync(ADR_0008_PATH, 'utf8');
  assert.match(adr0008, /0026-native-conversation-layer-and-open-hood-contract\.md/);
  assert.match(adr0008, /Decision 6[\s\S]*superseded by \[ADR 0026\]/i);
  assert.match(adr0008, /Decisions 1–5[\s\S]*remain 100% binding/i);
});
