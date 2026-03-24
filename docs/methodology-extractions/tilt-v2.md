# TiLT v2 Methodology Dissection

Extracted from the organic methodology that grew across 83 sessions of TiLT v2 development (Nov 2025 – Mar 2026). This serves as the first extraction target for TangleMeth — formalizing what works into a reproducible template.

## Source Files

| File | Lines | Role |
|------|-------|------|
| `tilt-v2/.cursor/rules/tiltv2-cursorrules.mdc` | ~1,095 | Primary rule set (Cursor engine) |
| `tilt-v2/CLAUDE.md` | ~278 | Project-specific rules (Claude Code engine) |
| `CLAUDE.md` (parent) | ~90 | TangleClaw-generated global rules |
| `tilt-v2/docs/session-wraps/` | 83 files | Session wrap archive |

## Pattern 1: Identity Sentries

**What it does:** Named personas ("Lord JSON" for the user, "Atlas" for the AI) act as trust signals. If the AI uses the names, it proves the rules were loaded. If it doesn't, the user knows something is wrong.

**How it's defined:**
```
- ALWAYS refer to the user as "Lord JSON" — Confirms proper rule injection
- AI Assistant Name: "Atlas" — Reliable, strong partnership
- Working Partnership: Collaboration between equals
```

**Why it works:** Simple, zero-cost verification that governance is active. The user doesn't have to ask "did you read the rules?" — the name usage proves it immediately.

**What a template needs:**
- Configurable persona names (or opt-out)
- Prime prompt injection point for identity confirmation
- Partnership framing text (tone-setting for the AI relationship)

## Pattern 2: Session Wrap Protocol

**What it does:** A mandatory 9-step checklist executed when the user says "session wrap" or "let's wrap." Produces a session wrap document and ensures all project artifacts are current before ending work.

**Steps:**
1. Run data backup (`npx tsx scripts/backup-dev.ts`)
2. Update VERSION.json (if significant changes)
3. Update CHANGELOG.md (detailed entry)
4. Update ROADMAP.md (progress on phases)
5. Update PROJECT_FILE_REFERENCE.md (new files)
6. Run technical debt cleanup script
7. Git commit (`git add -A && git commit`)
8. Create session wrap document → `docs/session-wraps/SESSION_WRAP_YYYY-MM-DD_DESCRIPTION.md`
9. Provide 8-section summary:
   - Session Summary (accomplishments, breakthroughs)
   - Next Session Priorities (roadmap, critical path)
   - Documentation Maintenance (updates needed)
   - Technical Debt Cleanup (scan for issues)
   - Configuration Validation (settings, .env)
   - Comprehensive Git Commit (descriptive message)
   - Handoff Notes (start points, known issues)
   - Project Health Report (feature completion)

**Evolution observed:** Early wraps (Nov 2025) were comprehensive, 7–8 KB with detailed health reports. By Mar 2026, wraps had streamlined to 1.8–2.5 KB, narrative-first (what happened, fixes, next steps). The format adapted to the project's maturity.

**What a template needs:**
- Configurable wrap steps (which artifacts to update)
- Session wrap document template with required sections
- Archive directory convention
- Optional backup/cleanup scripts (project-specific)

## Pattern 3: Learning Sentry Protocol

**What it does:** A living section in CLAUDE.md where the AI logs learnings mid-session as they happen — not deferred to session wrap. Each learning is timestamped and cross-referenced to code locations.

**How it's defined:**
```
ACTIVE self-improvement directive — 50+ logged learnings
Real-time visible "📓 LEARNING LOGGED" blocks mid-session
```

**Example learnings cover:** Data flow bugs, schema mismatches, infrastructure quirks, team preferences, deployment gotchas.

**Why it works:** Institutional memory that persists across sessions and grows organically. The AI in the next session inherits all prior learnings without the user re-explaining them.

**What a template needs:**
- Learning log section in engine config (or separate file)
- Convention for logging format (timestamp, category, content)
- Mechanism to surface learnings at session start (prime prompt)
- Pruning/archival strategy (the log can't grow forever)

## Pattern 4: Data Safety Rules

**What it does:** Hard rules preventing data loss, born from a real incident where 291 timesheets were auto-deleted (Jan 3, 2026) due to a missing `userId` in a unique constraint.

**Components:**

### V1 Protection (Environment Isolation)
- Never run commands in the V1 directory
- Never connect to port 5432 (V1 database)
- All scripts enforce V1 protection checks
- Explicit port/database validation before operations

### Safe Deletion
- `safeDeleteMany()` wrapper required instead of raw `prisma.deleteMany()`
- All deletions logged to audit system
- PROD protection with confirmation prompt ("type DELETE PROD DATA")
- Never delete from multi-user tables without `userId` filter

### Migration Safety
- `npm run validate-schema` mandatory after any schema.prisma changes
- `npm run pre-migration-backup` mandatory before any migration
- Review migration SQL before applying
- Multi-user tables must include `userId` in unique constraints

### Multi-User Data Awareness
- `@@unique([userId, jobId, date])` not `@@unique([jobId, date])`
- Always filter by `userId` when investigating user data
- Checklist before deleting any user data (4 items)
- Documented cost of the original mistake ($8 API costs, 30 min wasted, trust impact)

**What a template needs:**
- Environment isolation rules (configurable protected paths/ports)
- Safe operation wrappers (project-specific, but pattern is universal)
- Pre-migration checklist (backup, validate, review, test)
- Incident postmortem convention (document mistakes to prevent repeats)

## Pattern 5: PROD vs DEV Separation

**What it does:** Explicit rules governing when code can be pushed to production, with keyword triggers that mean different things.

**Keyword mapping:**
| User says | Meaning |
|-----------|---------|
| "push it", "push", "commit" | Local commit only (DEV) |
| "push to prod", "deploy to Vercel", "publish" | Production deployment |

**Enforcement:**
- Pre-push hook runs TypeScript checks automatically
- PROD database writes strictly prohibited from DEV
- Database sync is one-way: PROD → DEV only (read-only PROD connection)

**Why it works:** Prevents the most dangerous class of mistakes — accidental production deployments. The explicit keyword mapping removes ambiguity.

**What a template needs:**
- Configurable deployment keywords
- Push/deploy permission model (who can say "push to prod")
- Pre-push validation hooks
- Environment isolation rules (which direction data can flow)

## Pattern 6: Documentation Parity

**What it does:** A rule that documentation must stay synchronized with code at all times — not as a follow-up task, but in the same commit.

**Documents that must stay current:**
- VERSION.json + CHANGELOG.md (together, every significant change)
- ROADMAP.md (proactively, not on request)
- Help page (must match features — "if it's visible to users, document it")
- TEST_MASTER_LIST.md (maintained alongside test code)
- PROJECT_FILE_REFERENCE.md (updated when files added/removed)

**8 triggers that mandate automatic version bumps:**
1. New feature added
2. Major bug fix affecting UX or calculations
3. Security enhancement
4. UI/UX improvements users will notice
5. Database schema changes
6. Completing a roadmap phase
7. Any user-facing change
8. System improvements (TypeScript protection, scripts, monitoring)

**What a template needs:**
- List of tracked documents and their update triggers
- Version bump triggers (configurable per project)
- Pre-commit check: "did you update the docs?"
- Version scheme definition (TiLT uses 4-octet: `2.MAJOR.MINOR.PATCH`)

## Pattern 7: Testing Mandate

**What it does:** A non-negotiable rule that calculation, validation, and transformation logic must have tests. Bug fixes require TDD (failing test first, then fix).

**Coverage targets:**
| Category | Target |
|----------|--------|
| Calculation handlers | 100% |
| API routes | 90%+ |
| Helper functions | 80%+ |
| Components | 70%+ |

**Hard rules:**
- Never delete tests without user approval
- Never skip/disable failing tests to make them "pass"
- Run tests before every commit (pre-commit hook)
- Document test failures
- Bug fix = regression test (prevents repeats)

**Context:** This is union payroll software. Test regressions = pay errors = legal issues. The stakes drive the strictness.

**What a template needs:**
- Coverage targets per category (configurable)
- TDD-for-bugs rule (on/off)
- Pre-commit test gate
- Test deletion policy
- Test inventory document convention

## Pattern 8: Decision Framework

**What it does:** 5 questions that must be answered before implementing calculation logic. Forces the developer to think before coding.

**Questions:**
1. Does this match the actual contract text exactly?
2. Will this produce the same result a union member would calculate by hand?
3. Is this auditable if questioned by payroll or union?
4. Does this handle all edge cases (holidays, short turns, etc.)?
5. Will this scale to handle multiple CBAs without conflicts?

**What a template needs:**
- Configurable decision questions (domain-specific)
- When to apply the framework (which types of changes trigger it)
- Documentation requirement (record the answers, not just ask the questions)

## Pattern 9: Mobile Parity

**What it does:** Default assumption that desktop features must also work on mobile. Explicit parity check built into the development workflow.

**Checklist (before and after changes):**
- Does this feature need to work on mobile?
- Are you modifying a page with both desktop AND mobile views?
- Check for mobile equivalents (e.g., `MobileTimesheetEditor.client.tsx`)
- Test on mobile viewport

**What a template needs:**
- Platform parity rule (on/off, configurable platforms)
- Component mapping convention (desktop → mobile equivalents)
- Pre-commit parity check

## Pattern 10: Anti-Bloat Enforcement

**What it does:** Explicit rules against common code quality problems.

**Rules:**
- No unused imports, variables, or functions
- No commented-out code blocks (delete it)
- No duplicate calculation logic (DRY)
- No TODO comments (fix now or create issue)
- No manual calculations where CBA rules should apply

**What a template needs:**
- Configurable anti-patterns list
- Enforcement level (warn vs block)
- Lint rule integration

---

## Enforcement Summary

How each pattern is currently enforced vs how it could be enforced with proper tooling:

| Pattern | Current Enforcement | Template Enforcement |
|---------|-------------------|---------------------|
| Identity sentries | Prose (AI reads it) | Prime prompt injection |
| Session wrap | Prose (9 manual steps) | Wrap skill with gates |
| Learning sentry | Prose (AI convention) | Automated capture + pruning |
| Data safety | Prose + pre-push hook | Path/port validation hook |
| PROD separation | Prose + pre-push hook | Deploy gate with keyword parser |
| Doc parity | Prose (manual) | Pre-commit doc-freshness check |
| Testing mandate | Prose + pre-commit hook | Coverage gate |
| Decision framework | Prose (manual) | Pre-implementation checklist gate |
| Mobile parity | Prose (manual) | Parity check in CI |
| Anti-bloat | Prose (manual) | Lint rules |

## Observations for TangleMeth

1. **Most enforcement is prose.** The AI follows rules because it was told to, not because tooling prevents violations. TangleMeth should turn prose into gates.

2. **The methodology grew from incidents.** Data safety rules exist because of the 291-timesheet deletion. Multi-user awareness exists because of a $8/30-min debugging waste. PROD separation exists because of near-miss deployments. Real methodologies are scar tissue.

3. **Session wraps evolved.** Early wraps were exhaustive. Late wraps were lean. A good template should support both — comprehensive for early project phases, streamlined for mature ones.

4. **Domain specificity matters.** The decision framework and testing targets are deeply tied to union payroll. TangleMeth needs to interview for domain context and generate domain-appropriate rules, not generic ones.

5. **Identity sentries are surprisingly effective.** Simple, zero-cost, immediately verifiable. Every methodology template should offer this.

6. **The 4-octet version scheme is project-specific.** TangleMeth should ask about versioning strategy during the interview, not impose one.
