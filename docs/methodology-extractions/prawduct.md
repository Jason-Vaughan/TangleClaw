# Prawduct — Reference (Not Extracted)

[Prawduct](https://github.com/brookstalley/prawduct) is the most complete methodology template supported by TangleClaw. Unlike TiLT v2 and OnDeck-V2 — which grew organically as prose rules — Prawduct was designed from the ground up as a portable, tooled framework. It doesn't need extraction because it already *is* the reference implementation.

**Prawduct is installed separately** — TangleClaw detects Prawduct projects and integrates with the framework's session hooks. See the [Prawduct README](https://github.com/brookstalley/prawduct) for installation.

## Location

- **Framework**: [brookstalley/prawduct](https://github.com/brookstalley/prawduct) (installed locally, e.g., `~/Documents/Projects/prawduct/`)
- **TangleClaw template**: `data/templates/prawduct/template.json` — integration config (hooks, phases, detection, status contract)
- **Session hook**: Each product repo gets its own `tools/product-hook` via framework sync

## Scale

| Category | Lines | Components |
|----------|-------|------------|
| Python tools | 2,793 | prawduct-init, prawduct-sync, prawduct-migrate, product-hook |
| Methodology docs | 671 | discovery, planning, building, reflection |
| Agent definitions | 475 | Critic (independent reviewer), PR reviewer |
| Artifact templates | ~110 KB | 27 templates (product specs, UI/UX, ops, examples) |
| Tests | 8,987 | 13 test files + 4 scenario docs |

## What Makes It Different

- **Tooling, not prose.** TiLT and OnDeck enforce rules by telling the AI what to do. Prawduct enforces via Python tools — session gates (reflection gate, critic review gate), staleness detection, framework sync.
- **Portable products.** Initialized repos carry their own governance (CLAUDE.md, product-hook, templates). No runtime dependency on TangleClaw or the framework.
- **Zero external dependencies.** All Python tools use stdlib only.
- **Proportional rigor.** Discovery depth, artifact requirements, and review intensity scale with detected project risk.
- **Framework sync.** Updates propagate to products without overwriting user edits (hash-based comparison, merge strategies).

## Key Patterns (For TangleMeth Reference)

1. **Structural gates** — reflection and critic review aren't suggestions, they block session completion
2. **Independent Critic agent** — separate agent with limited context (code + tests + specs only, no builder reasoning)
3. **Risk-calibrated discovery** — 5–8 questions for family utilities, 15–25 for financial platforms
4. **Artifact dependency order** — planning produces specs in the order they'll be consumed
5. **Sync manifest** — tracks which files are framework-managed vs user-owned, enables non-destructive updates
6. **Version migration** — idempotent migration paths (v1→v5) so older products can adopt newer framework versions

## Why Not Extracted

Extracting Prawduct into a dissection doc would be documenting a software project, not identifying patterns. The framework itself *is* the documentation. For TangleMeth purposes, Prawduct is the target output — TangleMeth should produce methodology frameworks that look like this.
