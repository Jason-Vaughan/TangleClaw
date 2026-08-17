# Feature Ideas for Late 5.x.x Development (TangleClaw)

## 1. Model‑Usage Pill in the Banner

- **Location**: To the right of the model name / status displayed in the top‑level banner of the TangleClaw UI.
- **Purpose**: Show real‑time usage statistics for the currently active LLM model on the host machine, regardless of which project is open.
- **Metrics per model** (example for *Antigravity*):
  - **5‑hour quota** – percentage or absolute hours used out of the daily limit.
  - **Weekly quota** – percentage/absolute usage of the weekly token/compute allowance.
  - **Monthly quota** – percentage/absolute usage of the monthly allowance.
- **Design**:
  - Render as a small, rounded *pill* component with a subtle background (e.g., glass‑morphism) and a concise text like `5h 45% | wk 30% | mo 12%`.
  - Use a colour‑coded scheme (green → amber → red) to indicate low/medium/high consumption.
  - Tooltip on hover shows detailed numbers and timestamps of the last refresh.
- **Data Source**:
  - Query the model‑specific usage API or CLI (`antigravity status --json` or equivalent) on the host.
  - Cache the response for a short interval (e.g., 30 s) to avoid excessive calls.
  - The UI component should abstract the model type so that any future model (Claude, GPT‑4, etc.) can expose its own stats via a common interface.
- **Implementation Steps**:
  1. Define a **ModelUsageProvider** interface in the frontend code that returns `{hourUsed, hourLimit, weekUsed, weekLimit, monthUsed, monthLimit}`.
  2. Implement concrete providers for each supported model (Antigravity, Claude, etc.).
  3. Create a **UsagePill** React/Vue component (or vanilla‑JS if the app is plain) that consumes the provider and renders the pill.
  4. Integrate the pill into the banner layout, positioned right of the model name.
  5. Add unit tests for the provider parsing and UI rendering.

## 2. TangleScan – Security Scanning System

### Vision
A local security‑analysis agent (`SecurityClaw`) that runs on the developer’s machine, orchestrates language‑specific vulnerability scanners, aggregates results, and leverages a local LLM to explain findings and suggest fixes.

### Core Capabilities
- **Dependency Manifest Parsing**: Detect `package.json`, `package-lock.json`, `uv.lock`, `Cargo.lock`, `go.mod`, `Gemfile.lock`, etc.
- **SBOM Generation**: Produce a Software Bill of Materials for the entire workspace.
- **Vulnerability Feeds Integration**:
  - GitHub Security Advisories
  - OSV (Open Source Vulnerabilities)
  - npm audit, uv audit, cargo audit, pip‑audit, etc.
- **Local LLM Reasoning**:
  - Explain each finding (e.g., *"Keyv 6.0.0 is vulnerable to CVE‑2026‑12345"*).
  - Provide context: dev‑dependency, unused, unreachable code, etc.
  - Suggest patches or mitigations.
- **Reporting Dashboard**:
  - Consolidated view of all findings across ecosystems.
  - Severity‑colored list with quick‑action buttons (open file, apply patch).

### Architecture Sketch
```
TangleClaw Security Agent
│
├─ Local LLM (Monad‑1)          ← reasoning, natural‑language explanations
│
└─ Vulnerability Feeds
   ├─ GitHub Advisories
   ├─ OSV
   ├─ npm audit
   ├─ uv audit
   └─ cargo audit
```

### Implementation Roadmap (Late 5.x.x)
| Phase | Milestones |
|------|------------|
| **5.8‑alpha** | • Scaffold `securityclaw` CLI wrapper. <br>• Integrate `npm audit` and `cargo audit` as proof‑of‑concept scanners. |
| **5.9‑beta**  | • Add OSV and GitHub Advisory fetchers. <br>• Build SBOM generator (using `syft` or custom parser). |
| **5.10‑rc**   | • Hook local LLM (Antigravity) for explanation generation. <br>• UI dashboard component in TangleClaw UI. |
| **5.11‑final**| • Full multi‑ecosystem coverage (pip/uv, Homebrew, Go). <br>• Performance optimisations & caching of feed data. |

### User Experience
- **One‑click scan** button in the TangleClaw toolbar.
- **Live notifications** when a high‑severity CVE is discovered.
- **Contextual suggestions** directly in the code editor (e.g., auto‑generate a patch file).

---
*This document captures the feature ideas for inclusion in the upcoming 5.x.x roadmap. Feedback and additional requirements are welcome.*
