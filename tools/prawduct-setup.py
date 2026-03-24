#!/usr/bin/env python3
"""
prawduct-setup.py — Unified tool for Prawduct product repos.

Handles initialization, migration, sync, and validation of product repos.
Replaces the former prawduct-init.py, prawduct-migrate.py, and prawduct-sync.py.

Subcommands:
  setup     Auto-detect repo state and init/migrate/sync as needed
  sync      Sync product repo with framework template updates
  validate  Health check — verify repo structure and configuration

Usage:
  python3 tools/prawduct-setup.py setup <target> [--name NAME]
  python3 tools/prawduct-setup.py sync <product_dir> [--framework-dir <dir>]
  python3 tools/prawduct-setup.py validate <target> [--json]
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import stat
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

FRAMEWORK_DIR = Path(__file__).resolve().parent.parent
TEMPLATES_DIR = FRAMEWORK_DIR / "templates"


# =============================================================================
# Constants
# =============================================================================

try:
    PRAWDUCT_VERSION = (FRAMEWORK_DIR / "VERSION").read_text().strip()
except FileNotFoundError:
    PRAWDUCT_VERSION = "dev"

BLOCK_BEGIN = "<!-- PRAWDUCT:BEGIN -->"
BLOCK_END = "<!-- PRAWDUCT:END -->"

# Canonical list of framework-managed files. Used by create_manifest (at init)
# and run_sync (to backfill files added after a product was initialized).
# "description" is shown to the user when a file is backfilled (new capability onboarding).
MANAGED_FILES = {
    "CLAUDE.md": {
        "template": "templates/product-claude.md",
        "strategy": "block_template",
        "description": "Core principles and methodology instructions",
    },
    ".prawduct/critic-review.md": {
        "template": "templates/critic-review.md",
        "strategy": "template",
        "description": "Independent Critic review instructions (7 quality goals + coordinator pattern)",
    },
    ".prawduct/pr-review.md": {
        "template": "templates/pr-review.md",
        "strategy": "template",
        "description": "PR reviewer instructions for release-readiness assessment",
    },
    ".claude/skills/pr/SKILL.md": {
        "template": "templates/skill-pr.md",
        "strategy": "template",
        "description": "/pr skill — PR lifecycle management (create, update, merge, status). Configure PR behavior in project-preferences.md",
    },
    ".claude/skills/janitor/SKILL.md": {
        "template": "templates/skill-janitor.md",
        "strategy": "template",
        "description": "/janitor skill — Periodic codebase maintenance (encapsulation, deduplication, cleanup)",
    },
    ".claude/skills/prawduct-doctor/SKILL.md": {
        "template": "templates/skill-prawduct-doctor.md",
        "strategy": "template",
        "description": "/prawduct-doctor skill — Product repo setup, health check, and repair",
    },
    "tools/product-hook": {
        "source": "tools/product-hook",
        "strategy": "always_update",
        "description": "Session governance hooks (reflection gate, Critic gate, session briefing)",
    },
    ".claude/settings.json": {
        "template": "templates/product-settings.json",
        "strategy": "merge_settings",
        "description": "Claude Code settings with hook configuration",
    },
}

# Maps old file paths to new file paths. Applied during sync before the
# MANAGED_FILES loop, so product repos get file moves automatically.
FILE_RENAMES: dict[str, str] = {
    ".claude/commands/pr.md": ".claude/skills/pr/SKILL.md",
    ".claude/commands/janitor.md": ".claude/skills/janitor/SKILL.md",
    ".claude/skills/prawduct-setup/SKILL.md": ".claude/skills/prawduct-doctor/SKILL.md",
}

# Session files that should be gitignored in product repos
GITIGNORE_ENTRIES = [
    ".claude/settings.local.json",
    ".prawduct/.critic-findings.json",
    ".prawduct/.pr-reviews/",
    ".prawduct/.session-git-baseline",
    ".prawduct/.session-handoff.md",
    ".prawduct/.session-reflected",
    ".prawduct/.session-start",
    ".prawduct/.subagent-briefing.md",
    ".prawduct/reflections.md",
    ".prawduct/sync-manifest.json",
    "__pycache__/",
]

# Migration-era gitignore constants
V4_GITIGNORE_ENTRIES = [
    ".claude/settings.local.json",
    ".prawduct/.critic-findings.json",
    ".prawduct/.session-git-baseline",
    ".prawduct/.session-reflected",
    ".prawduct/.session-start",
    ".prawduct/.subagent-briefing.md",
    ".prawduct/reflections.md",
    ".prawduct/sync-manifest.json",
    "__pycache__/",
]

V3_GITIGNORE_ENTRIES = [
    ".claude/settings.local.json",
    ".prawduct/.critic-findings.json",
    ".prawduct/.session-reflected",
    ".prawduct/.session-start",
    "__pycache__/",
]

V1_GITIGNORE_ENTRIES = [
    ".prawduct/traces/",
    ".prawduct/framework-observations/",
    ".prawduct/.cross-repo-edits",
    ".prawduct/.session-governance.json",
    ".prawduct/.orchestrator-activated",
]

V1_SESSION_FILES = [
    ".prawduct/.session-governance.json",
    ".prawduct/.orchestrator-activated",
    ".prawduct/.skill-context.json",
    ".prawduct/.active-skill",
]


# =============================================================================
# Core utilities
# =============================================================================


def log(msg: str) -> None:
    """Print status to stderr."""
    print(msg, file=sys.stderr)


def ensure_dir(path: Path) -> bool:
    """Create directory if missing. Returns True if created."""
    if path.is_dir():
        return False
    path.mkdir(parents=True, exist_ok=True)
    return True


def compute_hash(path: Path) -> str | None:
    """Compute SHA-256 hex digest of a file's contents. Returns None if file missing."""
    if not path.is_file():
        return None
    return hashlib.sha256(path.read_bytes()).hexdigest()


def extract_block(content: str) -> tuple[str | None, str, str]:
    """Extract content between PRAWDUCT markers.

    Returns (block, before, after) where before + block + after == content.
    Returns (None, content, "") if markers are missing or malformed
    (e.g. BEGIN without END, or END before BEGIN).
    """
    begin_idx = content.find(BLOCK_BEGIN)
    end_idx = content.find(BLOCK_END)

    if begin_idx == -1 or end_idx == -1 or end_idx <= begin_idx:
        return (None, content, "")

    before = content[:begin_idx]
    block = content[begin_idx : end_idx + len(BLOCK_END)]
    after = content[end_idx + len(BLOCK_END) :]

    return (block, before, after)


def compute_block_hash(content: str) -> str | None:
    """SHA-256 of just the block content between markers. None if no markers."""
    block, _, _ = extract_block(content)
    if block is None:
        return None
    return hashlib.sha256(block.encode()).hexdigest()


def render_template(template_path: Path, subs: dict[str, str]) -> str:
    """Read a template file and apply variable substitutions."""
    content = template_path.read_text()
    for key, value in subs.items():
        content = content.replace(key, value)
    return content


def merge_settings(dst: Path, template_path: Path, subs: dict[str, str] | None = None) -> bool:
    """Create or merge .claude/settings.json.

    Merges hooks and companyAnnouncements from template into existing settings.
    Preserves user hooks and other settings keys. Applies subs to template before
    parsing (for banner {{PRODUCT_NAME}} substitution).

    Returns True if file was written.
    """
    template_text = template_path.read_text()
    if subs:
        for key, value in subs.items():
            template_text = template_text.replace(key, value)
    template = json.loads(template_text)

    if not dst.is_file():
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(json.dumps(template, indent=2) + "\n")
        return True

    try:
        existing = json.loads(dst.read_text())
    except json.JSONDecodeError:
        log(f"  ! Could not parse {dst.name} — skipping merge")
        return False

    # Collect prawduct hook commands from template
    our_commands: set[str] = set()
    template_hooks = template.get("hooks", {})
    for entries in template_hooks.values():
        for entry in entries:
            for hook in entry.get("hooks", []):
                if hook.get("type") == "command":
                    our_commands.add(hook["command"])

    # Merge: start with template hooks, add non-prawduct user hooks
    merged_hooks: dict = dict(template_hooks)
    for event, entries in existing.get("hooks", {}).items():
        if event not in merged_hooks:
            merged_hooks[event] = entries
            continue

        user_entries = []
        for entry in entries:
            is_ours = any(
                hook.get("command") in our_commands
                for hook in entry.get("hooks", [])
                if hook.get("type") == "command"
            )
            if not is_ours:
                user_entries.append(entry)

        if user_entries:
            merged_hooks[event] = merged_hooks[event] + user_entries

    # Preserve other settings keys, but always update banner from template
    merged = dict(existing)
    merged["hooks"] = merged_hooks

    # Always update companyAnnouncements from template (framework-managed)
    if "companyAnnouncements" in template:
        merged["companyAnnouncements"] = template["companyAnnouncements"]

    if json.dumps(merged, sort_keys=True) == json.dumps(existing, sort_keys=True):
        return False

    dst.write_text(json.dumps(merged, indent=2) + "\n")
    return True


def create_manifest(
    product_dir: Path,
    framework_dir: Path,
    product_name: str,
    file_hashes: dict[str, str | None],
) -> dict:
    """Build a sync manifest from the given file hashes.

    file_hashes maps relative file paths to their SHA-256 hex digests (or None).
    """
    files: dict[str, dict] = {}

    for rel_path, config in MANAGED_FILES.items():
        entry = dict(config)
        entry["generated_hash"] = file_hashes.get(rel_path)
        files[rel_path] = entry

    return {
        "format_version": 2,
        "framework_source": str(framework_dir),
        "product_name": product_name,
        "auto_pull": True,
        "last_sync": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "files": files,
    }


# =============================================================================
# Framework resolution
# =============================================================================


def _resolve_framework_dir(
    manifest: dict, cli_framework_dir: str | None, product_dir: Path | None = None
) -> Path | None:
    """Resolve the framework directory from CLI arg, env var, manifest, or sibling.

    Resolution order:
      1. --framework-dir CLI argument (explicit override; fail if invalid)
      2. PRAWDUCT_FRAMEWORK_DIR env var (explicit override; fail if invalid)
      3. framework_source from manifest (recorded at init; fall through if stale)
      4. Sibling ../prawduct relative to product dir (convention-based discovery)
    """
    # 1. CLI argument
    if cli_framework_dir:
        p = Path(cli_framework_dir).resolve()
        if p.is_dir():
            return p
        return None

    # 2. Environment variable
    env_dir = os.environ.get("PRAWDUCT_FRAMEWORK_DIR")
    if env_dir:
        p = Path(env_dir).resolve()
        if p.is_dir():
            return p
        return None

    # 3. Manifest value
    source = manifest.get("framework_source", "")
    if source:
        p = Path(source).resolve()
        if p.is_dir():
            return p

    # 4. Sibling ../prawduct relative to product dir
    if product_dir:
        sibling = (product_dir.parent / "prawduct").resolve()
        if sibling.is_dir():
            return sibling

    return None


def _try_pull_framework(fw_dir: Path, auto_pull: bool) -> list[str]:
    """Best-effort git pull/fetch of the framework repo before syncing.

    When auto_pull is True: runs ``git pull --ff-only`` (safe fast-forward).
    When auto_pull is False: runs ``git fetch`` and reports if behind upstream.

    Returns a list of human-readable notes (may be empty). Never raises.
    """
    notes: list[str] = []
    try:
        # Verify fw_dir is inside a git repo
        result = subprocess.run(
            ["git", "rev-parse", "--git-dir"],
            capture_output=True,
            text=True,
            cwd=str(fw_dir),
            timeout=30,
        )
        if result.returncode != 0:
            return notes  # Not a git repo — silently skip

        if auto_pull:
            # Check for dirty working tree
            status = subprocess.run(
                ["git", "status", "--porcelain"],
                capture_output=True,
                text=True,
                cwd=str(fw_dir),
                timeout=30,
            )
            if status.returncode == 0 and status.stdout.strip():
                notes.append("Framework has uncommitted changes — skipping pull")
                return notes

            # Fast-forward pull
            pull = subprocess.run(
                ["git", "pull", "--ff-only"],
                capture_output=True,
                text=True,
                cwd=str(fw_dir),
                timeout=30,
            )
            if pull.returncode == 0:
                if "Already up to date" not in pull.stdout:
                    notes.append("Framework updated via git pull")
            else:
                stderr = pull.stderr.strip()
                if "Not possible to fast-forward" in stderr or "fatal" in stderr:
                    notes.append("Framework pull failed (not fast-forwardable) — run git pull manually")
                else:
                    notes.append("Framework pull failed — run git pull manually")
        else:
            # Advisory mode: fetch + check if behind
            fetch = subprocess.run(
                ["git", "fetch", "--quiet"],
                capture_output=True,
                text=True,
                cwd=str(fw_dir),
                timeout=30,
            )
            if fetch.returncode != 0:
                return notes  # Fetch failed — silently skip

            behind = subprocess.run(
                ["git", "rev-list", "--count", "HEAD..@{upstream}"],
                capture_output=True,
                text=True,
                cwd=str(fw_dir),
                timeout=30,
            )
            if behind.returncode == 0:
                count = behind.stdout.strip()
                if count and int(count) > 0:
                    notes.append(f"Framework is {count} commit(s) behind upstream — consider running git pull")

    except FileNotFoundError:
        pass  # git not on PATH
    except subprocess.TimeoutExpired:
        notes.append("Framework git operation timed out")
    except Exception:  # prawduct:ok-broad-except — sync helper must never block session start
        pass

    return notes


# =============================================================================
# Template / file operations
# =============================================================================


def write_template(src: Path, dst: Path, subs: dict[str, str]) -> bool:
    """Copy a template with variable substitution. Skips if dst exists.
    Returns True if file was written."""
    content = render_template(src, subs)

    if dst.is_file():
        if dst.read_text() == content:
            return False  # Already up to date
        return False  # Exists with different content — don't overwrite user edits

    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(content)
    return True


def copy_hook(src: Path, dst: Path) -> bool:
    """Copy a hook script and make it executable. Updates if content changed.
    Returns True if file was written."""
    src_bytes = src.read_bytes()

    if dst.is_file():
        if dst.read_bytes() == src_bytes:
            return False  # Already up to date
        # Hook content changed — update it (hooks should stay current)
        dst.write_bytes(src_bytes)
        dst.chmod(dst.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
        return True

    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)
    dst.chmod(dst.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return True


def update_gitignore(target: Path) -> bool:
    """Add prawduct entries to .gitignore. Returns True if modified."""
    gitignore = target / ".gitignore"

    if gitignore.is_file():
        content = gitignore.read_text()
        existing_lines = set(content.splitlines())
    else:
        content = ""
        existing_lines = set()

    missing = [e for e in GITIGNORE_ENTRIES if e not in existing_lines]
    if not missing:
        return False

    parts = []
    if content and not content.endswith("\n"):
        parts.append("\n")
    if content.strip():
        parts.append("\n")
    parts.append("# Prawduct session files\n")
    for entry in missing:
        parts.append(entry + "\n")

    gitignore.write_text(content + "".join(parts))
    return True


# =============================================================================
# Version detection
# =============================================================================


def detect_version(target: Path) -> str:
    """Detect repo version. Returns 'v1', 'v3', 'v4', 'v5', 'partial', or 'unknown'."""
    has_framework_path = (target / ".prawduct" / "framework-path").is_file()
    has_product_hook = (target / "tools" / "product-hook").is_file()
    has_sync_manifest = (target / ".prawduct" / "sync-manifest.json").is_file()

    if has_framework_path and not has_product_hook:
        return "v1"
    if has_framework_path and has_product_hook:
        return "partial"
    if has_product_hook and has_sync_manifest:
        # Distinguish v4 from v5 by manifest format_version
        try:
            manifest = json.loads(
                (target / ".prawduct" / "sync-manifest.json").read_text()
            )
            if manifest.get("format_version", 1) >= 2:
                return "v5"
        except (json.JSONDecodeError, OSError):
            pass
        return "v4"
    if has_product_hook and not has_framework_path:
        return "v3"
    return "unknown"


def infer_product_name(target: Path) -> str | None:
    """Read product_identity.name from project-state.yaml via regex.

    No PyYAML dependency — scans line by line for the name field under
    product_identity. Returns None if the file is missing, the field is
    absent, or the value is a template placeholder.
    """
    state_file = target / ".prawduct" / "project-state.yaml"
    if not state_file.is_file():
        return None

    in_product_identity = False
    for line in state_file.read_text().splitlines():
        stripped = line.strip()

        # Track when we're inside product_identity block
        if stripped == "product_identity:" or stripped.startswith("product_identity:"):
            in_product_identity = True
            continue

        # Exit block on unindented line (new top-level key)
        if in_product_identity and line and not line[0].isspace():
            in_product_identity = False
            continue

        if in_product_identity:
            match = re.match(r'\s*name:\s*["\']?([^"\'#\n]+?)["\']?\s*$', line)
            if match:
                name = match.group(1).strip()
                if name and "{{" not in name and name != "null":
                    return name

    return None


def is_v1_repo(target_dir: str) -> bool:
    """Check if target is a v1 Prawduct repo (has .prawduct/framework-path)."""
    return Path(target_dir, ".prawduct", "framework-path").is_file()


# =============================================================================
# Migration operations
# =============================================================================


def write_template_overwrite(src: Path, dst: Path, subs: dict[str, str]) -> bool:
    """Copy a template with variable substitution, overwriting existing content.
    Idempotent via content comparison. Returns True if file was written."""
    content = render_template(src, subs)

    if dst.is_file():
        if dst.read_text() == content:
            return False  # Already up to date

    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(content)
    return True


def write_template_if_missing(src: Path, dst: Path, subs: dict[str, str]) -> bool:
    """Copy a template only if dst doesn't exist. Returns True if file was written."""
    if dst.is_file():
        return False

    content = render_template(src, subs)

    dst.parent.mkdir(parents=True, exist_ok=True)
    dst.write_text(content)
    return True


def replace_settings(dst: Path, template_path: Path, subs: dict[str, str] | None = None) -> bool:
    """Replace v1/v3 hooks with v4 hooks in .claude/settings.json.

    Identifies v1 hooks by checking if command contains 'framework-path',
    'governance-hook', or 'prawduct-statusline'. Identifies v3 hooks by
    checking for product-hook without python3 prefix. Removes v1 statusLine
    if it references prawduct. Adds banner from template. Preserves
    non-prawduct hooks and other settings keys. Returns True if file was written.
    """
    template_text = template_path.read_text()
    if subs:
        for key, value in subs.items():
            template_text = template_text.replace(key, value)
    template = json.loads(template_text)

    if not dst.is_file():
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(json.dumps(template, indent=2) + "\n")
        return True

    try:
        existing = json.loads(dst.read_text())
    except json.JSONDecodeError:
        log(f"  ! Could not parse {dst.name} — skipping")
        return False

    v1_markers = ["framework-path", "governance-hook", "prawduct-statusline"]

    def is_v1_hook_entry(entry: dict) -> bool:
        """Check if a hook entry is a v1 prawduct hook."""
        for hook in entry.get("hooks", []):
            cmd = hook.get("command", "")
            if any(marker in cmd for marker in v1_markers):
                return True
        return False

    # Collect v4 hook commands from template
    v4_commands: set[str] = set()
    template_hooks = template.get("hooks", {})
    for entries in template_hooks.values():
        for entry in entries:
            for hook in entry.get("hooks", []):
                if hook.get("type") == "command":
                    v4_commands.add(hook["command"])

    def is_old_prawduct_hook(entry: dict) -> bool:
        """Check if this is a v1 or v3 (pre-python3) prawduct hook."""
        if is_v1_hook_entry(entry):
            return True
        # v3 bash hooks: product-hook without python3 prefix
        for hook in entry.get("hooks", []):
            cmd = hook.get("command", "")
            if "product-hook" in cmd and not cmd.startswith("python3 "):
                return True
        return False

    # Build merged hooks: start with template hooks, add non-prawduct user hooks
    merged_hooks: dict = dict(template_hooks)
    for event, entries in existing.get("hooks", {}).items():
        if event not in merged_hooks:
            user_entries = [e for e in entries if not is_old_prawduct_hook(e)]
            if user_entries:
                merged_hooks[event] = user_entries
            continue

        user_entries = []
        for entry in entries:
            if is_old_prawduct_hook(entry):
                continue
            is_v4 = any(
                hook.get("command") in v4_commands
                for hook in entry.get("hooks", [])
                if hook.get("type") == "command"
            )
            if not is_v4:
                user_entries.append(entry)

        if user_entries:
            merged_hooks[event] = merged_hooks[event] + user_entries

    # Build merged settings: preserve all non-hook keys
    merged = dict(existing)
    merged["hooks"] = merged_hooks

    # Remove v1 statusLine if it references prawduct
    if "statusLine" in merged:
        status_line = merged["statusLine"]
        if isinstance(status_line, str) and "prawduct" in status_line.lower():
            del merged["statusLine"]
        elif isinstance(status_line, dict):
            cmd = status_line.get("command", "")
            if "prawduct" in cmd.lower():
                del merged["statusLine"]

    # Always update banner from template (framework-managed)
    if "companyAnnouncements" in template:
        merged["companyAnnouncements"] = template["companyAnnouncements"]

    if json.dumps(merged, sort_keys=True) == json.dumps(existing, sort_keys=True):
        return False

    dst.write_text(json.dumps(merged, indent=2) + "\n")
    return True


def delete_v1_files(target: Path) -> list[str]:
    """Remove v1-only marker files. Returns list of deleted file names."""
    v1_files = [
        ".prawduct/framework-path",
        ".prawduct/framework-version",
        ".prawduct/.cross-repo-edits",
    ]
    deleted = []
    for rel in v1_files:
        path = target / rel
        if path.is_file():
            path.unlink()
            deleted.append(rel)
    return deleted


def archive_v1_dirs(target: Path) -> list[str]:
    """Move v1 directories to .prawduct/archive/. Returns list of archived dir names."""
    v1_dirs = [
        ".prawduct/framework-observations",
        ".prawduct/traces",
    ]
    archived = []
    for rel in v1_dirs:
        src = target / rel
        if not src.is_dir():
            continue
        archive_dir = target / ".prawduct" / "archive"
        dst = archive_dir / Path(rel).name
        if dst.exists():
            continue  # Already archived
        archive_dir.mkdir(parents=True, exist_ok=True)
        shutil.move(str(src), str(dst))
        archived.append(rel)
    return archived


def clean_v1_session_files(target: Path) -> list[str]:
    """Remove transient v1 session files. Returns list of deleted file names."""
    deleted = []
    for rel in V1_SESSION_FILES:
        path = target / rel
        if path.is_file():
            path.unlink()
            deleted.append(rel)
    return deleted


def clean_gitignore(target: Path) -> bool:
    """Remove v1-specific entries, add v4 entries. Returns True if modified."""
    gitignore = target / ".gitignore"
    changed = False

    if gitignore.is_file():
        content = gitignore.read_text()
        lines = content.splitlines()
    else:
        content = ""
        lines = []

    # Remove v1 entries
    filtered = []
    for line in lines:
        stripped = line.strip()
        if stripped in V1_GITIGNORE_ENTRIES:
            changed = True
            continue
        filtered.append(line)

    # Add missing v4 entries
    existing_set = set(l.strip() for l in filtered)
    missing = [e for e in V4_GITIGNORE_ENTRIES if e not in existing_set]

    if missing:
        changed = True
        if filtered and filtered[-1].strip():
            filtered.append("")
        filtered.append("# Prawduct session files")
        for entry in missing:
            filtered.append(entry)

    if not changed:
        return False

    gitignore.write_text("\n".join(filtered) + "\n")
    return True


def add_block_markers(target: Path, subs: dict[str, str]) -> bool:
    """Add PRAWDUCT block markers to CLAUDE.md if missing.

    - If already has markers → no-op.
    - Otherwise → wrap the body (everything from the first ## heading onward)
      in markers.

    Returns True if the file was modified.
    """
    claude_path = target / "CLAUDE.md"
    if not claude_path.is_file():
        return False

    content = claude_path.read_text()

    # Already has markers — no-op
    if BLOCK_BEGIN in content and BLOCK_END in content:
        return False

    # Wrap everything from the first ## heading onward in markers
    lines = content.split("\n")
    body_start = 0
    for i, line in enumerate(lines):
        stripped = line.strip()
        if stripped.startswith("## "):
            body_start = i
            break
    else:
        # No section headers found — wrap everything after first non-empty lines
        body_start = min(2, len(lines))

    before_lines = lines[:body_start]
    body_lines = lines[body_start:]

    # Build new content
    before = "\n".join(before_lines)
    if before and not before.endswith("\n"):
        before += "\n"
    before += "\n"

    body = "\n".join(body_lines)
    if body and not body.endswith("\n"):
        body += "\n"

    new_content = before + BLOCK_BEGIN + "\n\n" + body + "\n" + BLOCK_END + "\n"
    claude_path.write_text(new_content)
    return True


def upgrade_manifest_strategy(target: Path) -> bool:
    """Upgrade manifest CLAUDE.md strategy from 'template' to 'block_template'.

    Recomputes the hash as a block hash. Returns True if modified.
    """
    manifest_path = target / ".prawduct" / "sync-manifest.json"
    if not manifest_path.is_file():
        return False

    try:
        manifest = json.loads(manifest_path.read_text())
    except json.JSONDecodeError:
        return False

    files = manifest.get("files", {})
    claude_config = files.get("CLAUDE.md")
    if claude_config is None:
        return False

    if claude_config.get("strategy") == "block_template":
        return False  # Already upgraded

    # Change strategy
    claude_config["strategy"] = "block_template"

    # Recompute hash as block hash
    claude_path = target / "CLAUDE.md"
    if claude_path.is_file():
        content = claude_path.read_text()
        claude_config["generated_hash"] = compute_block_hash(content)

    manifest["files"]["CLAUDE.md"] = claude_config
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    return True


def split_learnings_v5(product_dir: Path) -> list[str]:
    """Create learnings-detail.md as reference backup of learnings.md.

    Part of v4→v5 migration. If learnings.md exists with meaningful content
    and learnings-detail.md doesn't exist yet, copies the content.
    Idempotent: skips if detail file already exists.

    Returns list of actions taken.
    """
    actions: list[str] = []
    learnings = product_dir / ".prawduct" / "learnings.md"
    detail = product_dir / ".prawduct" / "learnings-detail.md"

    if not learnings.is_file():
        return actions
    if detail.is_file():
        return actions  # Already split

    content = learnings.read_text()
    # Only split if there's meaningful content beyond the header
    lines = [l for l in content.strip().splitlines()
             if l.strip() and not l.startswith("#")]
    if not lines:
        return actions

    detail.write_text(content)
    actions.append("Created .prawduct/learnings-detail.md (reference backup)")
    return actions


def migrate_project_state_v5(product_dir: Path) -> list[str]:
    """Add v5 sections to project-state.yaml, remove v4-only fields.

    Adds work_in_progress and health_check sections if missing.
    Removes current_phase if present. Idempotent.

    Returns list of actions taken.
    """
    actions: list[str] = []
    state_path = product_dir / ".prawduct" / "project-state.yaml"

    if not state_path.is_file():
        return actions

    content = state_path.read_text()
    original = content

    # Remove current_phase field (v4 artifact) — top-level key, single line
    if "\ncurrent_phase:" in content or content.startswith("current_phase:"):
        lines = content.split("\n")
        new_lines = [l for l in lines if not l.startswith("current_phase:")]
        content = "\n".join(new_lines)

    # Add work_in_progress section if missing
    if "work_in_progress:" not in content:
        content = content.rstrip("\n") + "\n\n" + (
            "# =============================================================================\n"
            "# WORK IN PROGRESS (branch-scoped)\n"
            "# =============================================================================\n"
            "# Each branch gets its own entry. See project-state.yaml template for format.\n"
            "\n"
            "work_in_progress: {}\n"
        )

    # Add health_check section if missing
    if "health_check:" not in content:
        content = content.rstrip("\n") + "\n\n" + (
            "# =============================================================================\n"
            "# HEALTH CHECK\n"
            "# =============================================================================\n"
            "# Tracks periodic health check state.\n"
            "\n"
            "health_check:\n"
            "  last_full_check: null\n"
            "  last_check_findings: null\n"
        )

    if content != original:
        state_path.write_text(content)
        actions.append("Updated .prawduct/project-state.yaml for v5")

    return actions


def migrate_change_log(product_dir: Path) -> list[str]:
    """Move change_log from project-state.yaml to .prawduct/change-log.md.

    Parses YAML change_log entries, converts to markdown sections, writes
    to change-log.md (appending if it exists), and removes the change_log
    section from project-state.yaml. Idempotent: skips if no change_log
    section exists in project-state.yaml.

    Returns list of actions taken.
    """
    actions: list[str] = []
    state_path = product_dir / ".prawduct" / "project-state.yaml"
    if not state_path.is_file():
        return actions

    content = state_path.read_text()

    # Check if change_log: exists with actual entries (not just [] or {})
    if "\nchange_log:" not in content and not content.startswith("change_log:"):
        return actions

    # Find the change_log section boundaries
    lines = content.split("\n")
    cl_start = None
    cl_end = None
    for i, line in enumerate(lines):
        if line.startswith("change_log:") or line.strip() == "change_log:":
            cl_start = i
        elif cl_start is not None and not line.startswith(" ") and not line.startswith("#") and line.strip() and not line.startswith("change_log"):
            # Hit next top-level key
            cl_end = i
            break
    if cl_start is None:
        return actions

    if cl_end is None:
        cl_end = len(lines)

    # Also capture any comment lines immediately before change_log:
    comment_start = cl_start
    while comment_start > 0 and (lines[comment_start - 1].startswith("#") or lines[comment_start - 1].strip() == ""):
        if lines[comment_start - 1].startswith("# ===") or "CHANGE LOG" in lines[comment_start - 1]:
            comment_start -= 1
        elif lines[comment_start - 1].strip() == "":
            comment_start -= 1
        elif lines[comment_start - 1].startswith("#"):
            comment_start -= 1
        else:
            break

    cl_section = lines[cl_start:cl_end]

    # Parse entries from the YAML section (lightweight, no PyYAML)
    entries: list[dict[str, str]] = []
    current_entry: dict[str, str] = {}
    current_key: str | None = None

    for line in cl_section:
        stripped = line.strip()
        if stripped.startswith("- what:") or stripped.startswith("- what :"):
            if current_entry:
                entries.append(current_entry)
            current_entry = {}
            current_key = "what"
            val = stripped.split(":", 1)[1].strip().strip("\"'")
            if val:
                current_entry["what"] = val
        elif stripped.startswith("why:") and current_entry is not None:
            current_key = "why"
            val = stripped.split(":", 1)[1].strip().strip("\"'")
            if val:
                current_entry["why"] = val
        elif stripped.startswith("blast_radius:") and current_entry is not None:
            current_key = "blast_radius"
            val = stripped.split(":", 1)[1].strip().strip("\"'")
            if val:
                current_entry["blast_radius"] = val
        elif stripped.startswith("classification:") and current_entry is not None:
            current_key = "classification"
            val = stripped.split(":", 1)[1].strip().strip("\"'")
            if val:
                current_entry["classification"] = val
        elif stripped.startswith("date:") and current_entry is not None:
            current_key = "date"
            val = stripped.split(":", 1)[1].strip().strip("\"'")
            if val:
                current_entry["date"] = val
        elif current_key and current_entry is not None and stripped and not stripped.startswith("#") and not stripped.startswith("- "):
            # Continuation line for multiline YAML value
            prev = current_entry.get(current_key, "")
            continuation = stripped.strip("\"'")
            if prev:
                current_entry[current_key] = prev + " " + continuation
            else:
                current_entry[current_key] = continuation

    if current_entry:
        entries.append(current_entry)

    if not entries:
        # change_log: exists but is empty ([] or no entries) — just remove the section
        new_lines = lines[:comment_start] + lines[cl_end:]
        # Clean up double blank lines
        cleaned = "\n".join(new_lines)
        while "\n\n\n" in cleaned:
            cleaned = cleaned.replace("\n\n\n", "\n\n")
        state_path.write_text(cleaned)
        actions.append("Removed empty change_log section from project-state.yaml")
        return actions

    # Convert entries to markdown
    md_entries: list[str] = []
    for entry in entries:
        date = entry.get("date", "unknown")
        what = entry.get("what", "Untitled change")
        md = f"## {date}: {what}"
        if entry.get("why"):
            md += f"\n\n**Why:** {entry['why']}"
        if entry.get("blast_radius"):
            md += f"\n\n**Blast radius:** {entry['blast_radius']}"
        if entry.get("classification"):
            md += f"\n\n**Classification:** {entry['classification']}"
        md_entries.append(md)

    # Write to change-log.md
    cl_path = product_dir / ".prawduct" / "change-log.md"
    product_name = product_dir.name
    if cl_path.is_file():
        existing = cl_path.read_text()
        # Append migrated entries at the end with a separator
        separator = "\n\n<!-- Migrated from project-state.yaml -->\n\n"
        cl_path.write_text(existing.rstrip("\n") + separator + "\n\n".join(md_entries) + "\n")
    else:
        header = f"# Change Log — {product_name}\n\n<!-- Append new entries at the top. -->\n\n"
        cl_path.write_text(header + "\n\n".join(md_entries) + "\n")

    actions.append(f"Migrated {len(entries)} change_log entries to .prawduct/change-log.md")

    # Remove change_log section from project-state.yaml
    # Replace with a pointer comment
    pointer = (
        "# =============================================================================\n"
        "# CHANGE LOG\n"
        "# =============================================================================\n"
        "# Change log moved to .prawduct/change-log.md (separate file for merge-friendliness).\n"
    )
    new_lines = lines[:comment_start] + pointer.split("\n") + lines[cl_end:]
    cleaned = "\n".join(new_lines)
    while "\n\n\n" in cleaned:
        cleaned = cleaned.replace("\n\n\n", "\n\n")
    state_path.write_text(cleaned)
    actions.append("Removed change_log section from project-state.yaml (replaced with pointer)")

    return actions


def generate_sync_manifest(target: Path, product_name: str) -> bool:
    """Generate sync manifest for the product repo. Returns True if created."""
    manifest_path = target / ".prawduct" / "sync-manifest.json"
    if manifest_path.is_file():
        return False

    claude_path = target / "CLAUDE.md"
    if claude_path.is_file():
        claude_hash = compute_block_hash(claude_path.read_text())
        if claude_hash is None:
            claude_hash = compute_hash(claude_path)
    else:
        claude_hash = None

    file_hashes = {
        "CLAUDE.md": claude_hash,
        ".prawduct/critic-review.md": compute_hash(
            target / ".prawduct" / "critic-review.md"
        ),
        "tools/product-hook": compute_hash(target / "tools" / "product-hook"),
        ".claude/settings.json": None,
    }
    manifest = create_manifest(target, FRAMEWORK_DIR, product_name, file_hashes)
    manifest_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    return True


def run_migrate(target_dir: str, product_name: str | None = None) -> dict:
    """Migrate a product repo to v5. Returns a summary of actions taken."""
    target = Path(target_dir).resolve()
    actions: list[str] = []

    version = detect_version(target)

    # Safety: refuse to migrate directories that aren't Prawduct repos
    if version == "unknown":
        return {
            "target": str(target),
            "product_name": product_name or target.name,
            "version_before": version,
            "version_after": version,
            "actions": [],
            "files_changed": 0,
            "error": "Not a Prawduct repo (no .prawduct/framework-path or tools/product-hook found)",
        }

    # Infer product name if not provided
    if product_name is None:
        product_name = infer_product_name(target)
    if product_name is None:
        product_name = target.name

    subs = {"{{PRODUCT_NAME}}": product_name, "{{PRAWDUCT_VERSION}}": PRAWDUCT_VERSION}

    # === V1-specific steps (v1 and partial) ===
    if version in ("v1", "partial"):
        # 1. Overwrite CLAUDE.md with current template
        if write_template_overwrite(
            TEMPLATES_DIR / "product-claude.md", target / "CLAUDE.md", subs
        ):
            actions.append("Overwrote CLAUDE.md with current template")

        # 2. Delete v1 marker files
        deleted = delete_v1_files(target)
        for f in deleted:
            actions.append(f"Deleted {f}")

        # 3. Archive v1 directories
        archived = archive_v1_dirs(target)
        for d in archived:
            actions.append(f"Archived {d} → .prawduct/archive/")

        # 4. Clean v1 session files
        cleaned = clean_v1_session_files(target)
        for f in cleaned:
            actions.append(f"Deleted session file {f}")

    # === Steps for all non-v4 repos (v1, v3, partial) ===

    # Replace hooks in settings.json (handles v1, v3 bash, and adds banner)
    if replace_settings(
        target / ".claude" / "settings.json",
        TEMPLATES_DIR / "product-settings.json",
        subs,
    ):
        actions.append("Updated .claude/settings.json (hooks + banner)")

    # Copy product-hook (Python version)
    if copy_hook(
        FRAMEWORK_DIR / "tools" / "product-hook",
        target / "tools" / "product-hook",
    ):
        actions.append("Installed tools/product-hook (Python)")

    # Create critic-review.md if missing
    if write_template_if_missing(
        TEMPLATES_DIR / "critic-review.md",
        target / ".prawduct" / "critic-review.md",
        subs,
    ):
        actions.append("Created .prawduct/critic-review.md")

    # Create learnings.md if missing
    learnings = target / ".prawduct" / "learnings.md"
    if not learnings.is_file():
        learnings.parent.mkdir(parents=True, exist_ok=True)
        learnings.write_text(
            "# Learnings\n\nAccumulated wisdom from building this product.\n"
        )
        actions.append("Created .prawduct/learnings.md")

    # Generate sync manifest
    if generate_sync_manifest(target, product_name):
        actions.append("Created .prawduct/sync-manifest.json")

    # Clean gitignore
    if clean_gitignore(target):
        actions.append("Updated .gitignore")

    # Add block markers to CLAUDE.md if missing
    if add_block_markers(target, subs):
        actions.append("Added block markers to CLAUDE.md")

    # Upgrade manifest strategy from template to block_template
    if upgrade_manifest_strategy(target):
        actions.append("Upgraded CLAUDE.md sync strategy to block_template")

    # === V5 migration steps (idempotent, applies to all repos) ===

    # Split learnings into active rules + reference detail
    actions.extend(split_learnings_v5(target))

    # Update project-state.yaml (add v5 sections, remove v4 fields)
    actions.extend(migrate_project_state_v5(target))

    # Place boundary-patterns.md if missing
    bp_src = TEMPLATES_DIR / "boundary-patterns.md"
    bp_dst = target / ".prawduct" / "artifacts" / "boundary-patterns.md"
    if bp_src.is_file() and not bp_dst.is_file():
        rendered = render_template(bp_src, subs)
        bp_dst.parent.mkdir(parents=True, exist_ok=True)
        bp_dst.write_text(rendered)
        actions.append("Created .prawduct/artifacts/boundary-patterns.md")

    # Bump manifest version to 2 if needed
    manifest_path = target / ".prawduct" / "sync-manifest.json"
    if manifest_path.is_file():
        try:
            mf = json.loads(manifest_path.read_text())
            if mf.get("format_version", 1) < 2:
                mf["format_version"] = 2
                manifest_path.write_text(json.dumps(mf, indent=2) + "\n")
                actions.append("Bumped manifest to format_version 2 (v5)")
        except json.JSONDecodeError:
            pass

    return {
        "target": str(target),
        "product_name": product_name,
        "version_before": version,
        "version_after": detect_version(target),
        "actions": actions,
        "files_changed": len(actions),
    }


# =============================================================================
# Init
# =============================================================================


def run_init(target_dir: str, product_name: str) -> dict:
    """Initialize a product repo. Returns a summary of actions taken."""
    target = Path(target_dir).resolve()
    actions: list[str] = []

    subs = {
        "{{PRODUCT_NAME}}": product_name,
        "{{PRAWDUCT_VERSION}}": PRAWDUCT_VERSION,
    }

    # 1. .prawduct/ structure
    for subdir in [".prawduct", ".prawduct/artifacts"]:
        path = target / subdir
        if ensure_dir(path):
            actions.append(f"Created {subdir}/")

    # 2. CLAUDE.md — three-way handling for existing repos
    claude_dst = target / "CLAUDE.md"
    if not claude_dst.is_file():
        # New file — write full template
        if write_template(TEMPLATES_DIR / "product-claude.md", claude_dst, subs):
            actions.append("Created CLAUDE.md")
    elif BLOCK_BEGIN not in claude_dst.read_text():
        # Existing file without markers — merge: template + user content below
        existing_content = claude_dst.read_text()
        template_content = render_template(TEMPLATES_DIR / "product-claude.md", subs)
        merged = template_content.rstrip("\n") + "\n\n" + existing_content
        claude_dst.write_text(merged)
        actions.append("Merged framework content into existing CLAUDE.md")
    # else: already has markers — skip (sync handles updates)

    # 3. Critic review instructions
    if write_template(
        TEMPLATES_DIR / "critic-review.md",
        target / ".prawduct" / "critic-review.md",
        subs,
    ):
        actions.append("Created .prawduct/critic-review.md")

    # 4. Project state
    if write_template(
        TEMPLATES_DIR / "project-state.yaml",
        target / ".prawduct" / "project-state.yaml",
        subs,
    ):
        actions.append("Created .prawduct/project-state.yaml")

    # 5. Project preferences template
    if write_template(
        TEMPLATES_DIR / "project-preferences.md",
        target / ".prawduct" / "artifacts" / "project-preferences.md",
        subs,
    ):
        actions.append("Created .prawduct/artifacts/project-preferences.md")

    # 6. Boundary patterns template
    if write_template(
        TEMPLATES_DIR / "boundary-patterns.md",
        target / ".prawduct" / "artifacts" / "boundary-patterns.md",
        subs,
    ):
        actions.append("Created .prawduct/artifacts/boundary-patterns.md")

    # 6.5. PR review evidence directory
    pr_reviews_dir = target / ".prawduct" / ".pr-reviews"
    if ensure_dir(pr_reviews_dir):
        actions.append("Created .prawduct/.pr-reviews/")

    # 6.7. PR review instructions
    if write_template(
        TEMPLATES_DIR / "pr-review.md",
        target / ".prawduct" / "pr-review.md",
        subs,
    ):
        actions.append("Created .prawduct/pr-review.md")

    # 6.8. PR skill
    pr_skill_dir = target / ".claude" / "skills" / "pr"
    if ensure_dir(pr_skill_dir):
        actions.append("Created .claude/skills/pr/")
    pr_skill_src = TEMPLATES_DIR / "skill-pr.md"
    pr_skill_dst = pr_skill_dir / "SKILL.md"
    if pr_skill_src.is_file() and write_template(pr_skill_src, pr_skill_dst, subs):
        actions.append("Created .claude/skills/pr/SKILL.md")

    # 6.9. Janitor skill
    janitor_skill_dir = target / ".claude" / "skills" / "janitor"
    if ensure_dir(janitor_skill_dir):
        actions.append("Created .claude/skills/janitor/")
    janitor_skill_src = TEMPLATES_DIR / "skill-janitor.md"
    janitor_skill_dst = janitor_skill_dir / "SKILL.md"
    if janitor_skill_src.is_file() and write_template(janitor_skill_src, janitor_skill_dst, subs):
        actions.append("Created .claude/skills/janitor/SKILL.md")

    # 6.10. Prawduct-setup skill
    setup_skill_dir = target / ".claude" / "skills" / "prawduct-doctor"
    if ensure_dir(setup_skill_dir):
        actions.append("Created .claude/skills/prawduct-doctor/")
    setup_skill_src = TEMPLATES_DIR / "skill-prawduct-doctor.md"
    setup_skill_dst = setup_skill_dir / "SKILL.md"
    if setup_skill_src.is_file() and write_template(setup_skill_src, setup_skill_dst, subs):
        actions.append("Created .claude/skills/prawduct-doctor/SKILL.md")

    # 7. Test infrastructure (conftest.py — only for Python projects)
    is_python = any(
        (target / f).is_file()
        for f in ("pyproject.toml", "setup.py", "setup.cfg", "Pipfile", "requirements.txt")
    )
    tests_dir = target / "tests"
    if ensure_dir(tests_dir):
        actions.append("Created tests/")
    if is_python:
        conftest_dst = tests_dir / "conftest.py"
        if not conftest_dst.is_file():
            shutil.copy2(TEMPLATES_DIR / "conftest.py", conftest_dst)
            actions.append("Created tests/conftest.py (parallel test support)")

    # 8. Learnings starter
    learnings = target / ".prawduct" / "learnings.md"
    if not learnings.is_file():
        learnings.write_text(
            "# Learnings\n\nAccumulated wisdom from building this product.\n"
        )
        actions.append("Created .prawduct/learnings.md")

    # 9. Product hook
    if copy_hook(
        FRAMEWORK_DIR / "tools" / "product-hook",
        target / "tools" / "product-hook",
    ):
        actions.append("Created tools/product-hook")

    # 10. Settings.json (with subs for banner)
    if merge_settings(
        target / ".claude" / "settings.json",
        TEMPLATES_DIR / "product-settings.json",
        subs,
    ):
        actions.append("Created/updated .claude/settings.json")

    # 11. .gitignore
    if update_gitignore(target):
        actions.append("Updated .gitignore")

    # 12. Sync manifest
    manifest_path = target / ".prawduct" / "sync-manifest.json"
    if not manifest_path.is_file():
        claude_content = (target / "CLAUDE.md").read_text()
        file_hashes = {
            "CLAUDE.md": compute_block_hash(claude_content),
            ".prawduct/critic-review.md": compute_hash(
                target / ".prawduct" / "critic-review.md"
            ),
            ".prawduct/pr-review.md": compute_hash(
                target / ".prawduct" / "pr-review.md"
            ),
            ".claude/skills/pr/SKILL.md": compute_hash(
                target / ".claude" / "skills" / "pr" / "SKILL.md"
            ),
            ".claude/skills/janitor/SKILL.md": compute_hash(
                target / ".claude" / "skills" / "janitor" / "SKILL.md"
            ),
            ".claude/skills/prawduct-doctor/SKILL.md": compute_hash(
                target / ".claude" / "skills" / "prawduct-doctor" / "SKILL.md"
            ),
            "tools/product-hook": compute_hash(target / "tools" / "product-hook"),
            ".claude/settings.json": None,  # merge_settings doesn't use hash
        }
        manifest = create_manifest(target, FRAMEWORK_DIR, product_name, file_hashes)
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
        actions.append("Created .prawduct/sync-manifest.json")

    return {
        "target": str(target),
        "product_name": product_name,
        "actions": actions,
        "files_written": len(actions),
    }


# =============================================================================
# Sync
# =============================================================================


def _bootstrap_manifest(product: Path, fw_dir: Path) -> dict:
    """Create initial sync manifest for a prawduct repo that doesn't have one.

    Computes hashes of existing managed files so sync can track future changes.
    Files that don't exist get None (triggers creation on first sync).
    For files at old rename paths, uses the old path's content for hash computation
    so the rename + sync flow works correctly.
    """
    # Infer product name from project-state.yaml or directory name
    product_name = product.name
    state_path = product / ".prawduct" / "project-state.yaml"
    if state_path.is_file():
        for line in state_path.read_text().splitlines():
            stripped = line.strip()
            if stripped.startswith("product_name:"):
                val = stripped.split(":", 1)[1].strip().strip('"').strip("'")
                if val:
                    product_name = val
                break

    file_hashes: dict[str, str | None] = {}
    for rel_path, config in MANAGED_FILES.items():
        strategy = config.get("strategy", "template")
        file_path = product / rel_path

        # If file doesn't exist at new path, check old rename paths
        if not file_path.is_file():
            for old_rel, new_rel in FILE_RENAMES.items():
                if new_rel == rel_path and (product / old_rel).is_file():
                    file_path = product / old_rel
                    break

        if strategy == "block_template":
            if file_path.is_file():
                file_hashes[rel_path] = compute_block_hash(file_path.read_text())
            else:
                file_hashes[rel_path] = None
        elif strategy == "merge_settings":
            file_hashes[rel_path] = None  # merge_settings doesn't use hash
        else:
            file_hashes[rel_path] = compute_hash(file_path)

    return create_manifest(product, fw_dir, product_name, file_hashes)


def apply_renames(
    product: Path,
    manifest: dict,
    actions: list[str],
) -> None:
    """Apply file renames from FILE_RENAMES. Mutates manifest['files'] in place."""
    files = manifest.get("files", {})

    for old_rel, new_rel in FILE_RENAMES.items():
        old_path = product / old_rel
        new_path = product / new_rel

        old_in_manifest = old_rel in files

        if old_path.is_file() and new_path.is_file():
            # Both exist — delete old (it's a leftover)
            old_path.unlink()
            if old_in_manifest:
                del files[old_rel]
            # Ensure new path uses canonical config if available
            if new_rel in MANAGED_FILES and new_rel in files:
                saved_hash = files[new_rel].get("generated_hash")
                files[new_rel] = dict(MANAGED_FILES[new_rel])
                files[new_rel]["generated_hash"] = saved_hash
            actions.append(f"Removed leftover: {old_rel}")
        elif old_path.is_file():
            # Normal rename: move file, transfer manifest entry
            new_path.parent.mkdir(parents=True, exist_ok=True)
            old_path.rename(new_path)
            if old_in_manifest:
                old_entry = files.pop(old_rel)
                # Use canonical config if available (fixes stale template paths),
                # otherwise transfer the old entry as-is
                if new_rel in MANAGED_FILES:
                    files[new_rel] = dict(MANAGED_FILES[new_rel])
                    files[new_rel]["generated_hash"] = compute_hash(new_path)
                else:
                    files[new_rel] = old_entry
            actions.append(f"Moved: {old_rel} → {new_rel}")
        elif old_in_manifest and not old_path.is_file():
            # Stale manifest entry (file already deleted/moved)
            del files[old_rel]
            actions.append(f"Cleaned stale manifest entry: {old_rel}")
        # else: neither exists — nothing to do

    # Clean up empty parent directories of old paths
    seen_parents: set[Path] = set()
    for old_rel in FILE_RENAMES:
        parent = product / Path(old_rel).parent
        if parent not in seen_parents and parent.is_dir() and parent != product:
            seen_parents.add(parent)
            try:
                parent.rmdir()  # Only succeeds if empty
                actions.append(f"Removed empty directory: {Path(old_rel).parent}")
            except OSError:
                pass  # Not empty — that's fine


def migrate_v4_to_v5(product_dir: Path) -> list[str]:
    """Migrate a v4 product to v5 structure. Called from run_sync().

    Checks manifest format_version; skips if already v5.
    Runs learnings split, project-state update, and version bump.
    Idempotent.

    Returns list of actions taken.
    """
    actions: list[str] = []
    manifest_path = product_dir / ".prawduct" / "sync-manifest.json"

    if not manifest_path.is_file():
        return actions

    try:
        manifest = json.loads(manifest_path.read_text())
    except json.JSONDecodeError:
        return actions

    if manifest.get("format_version", 1) >= 2:
        return actions  # Already v5

    # 1. Split learnings
    actions.extend(split_learnings_v5(product_dir))

    # 2. Update project-state.yaml
    actions.extend(migrate_project_state_v5(product_dir))

    # 3. Bump manifest version
    manifest["format_version"] = 2
    manifest["last_sync"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
    actions.append("Bumped manifest to format_version 2 (v5)")

    return actions


def run_sync(product_dir: str, framework_dir: str | None = None, *, no_pull: bool = False, force: bool = False) -> dict:
    """Run the sync algorithm on a product directory.

    Returns a summary dict with actions taken, notes, and any warnings.
    """
    product = Path(product_dir).resolve()
    manifest_path = product / ".prawduct" / "sync-manifest.json"

    bootstrapped = False

    if not manifest_path.is_file():
        if not (product / ".prawduct").is_dir():
            return {
                "product_dir": str(product),
                "synced": False,
                "reason": "not a prawduct repo",
                "actions": [],
                "notes": [],
            }
        # Bootstrap: create manifest for prawduct repo that doesn't have one
        fw_dir = _resolve_framework_dir({}, framework_dir, product)
        if fw_dir is None:
            return {
                "product_dir": str(product),
                "synced": False,
                "reason": "framework not found",
                "actions": [],
                "notes": [],
            }
        manifest = _bootstrap_manifest(product, fw_dir)
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")
        bootstrapped = True
    else:
        try:
            manifest = json.loads(manifest_path.read_text())
        except json.JSONDecodeError:
            return {
                "product_dir": str(product),
                "synced": False,
                "reason": "invalid manifest JSON",
                "actions": [],
                "notes": [],
            }

    fw_dir = _resolve_framework_dir(manifest, framework_dir, product)
    if fw_dir is None:
        return {
            "product_dir": str(product),
            "synced": False,
            "reason": "framework not found",
            "actions": [],
            "notes": [],
        }

    # Best-effort framework pull before syncing templates
    if not no_pull:
        auto_pull = manifest.get("auto_pull", True)
        pull_notes = _try_pull_framework(fw_dir, auto_pull)
    else:
        pull_notes = []

    product_name = manifest.get("product_name", product.name)
    subs = {"{{PRODUCT_NAME}}": product_name, "{{PRAWDUCT_VERSION}}": PRAWDUCT_VERSION}
    actions: list[str] = []
    notes: list[str] = list(pull_notes)

    if bootstrapped:
        actions.append("Bootstrapped sync manifest (first framework sync for this repo)")

    # V4→V5 migration (if needed)
    v5_actions = migrate_v4_to_v5(product)
    actions.extend(v5_actions)
    if v5_actions:
        # Re-read manifest since migration updated it
        manifest = json.loads(manifest_path.read_text())

    # Migrate change_log from project-state.yaml to change-log.md
    actions.extend(migrate_change_log(product))

    files = manifest.get("files", {})

    # Renames: move files from old paths to new paths (e.g., commands → skills)
    if FILE_RENAMES:
        apply_renames(product, manifest, actions)

    # Backfill: add any managed files missing from the manifest (added after init)
    # Also repair stale config (e.g., old template paths from renamed entries)
    for rel_path, config in MANAGED_FILES.items():
        if rel_path not in files:
            files[rel_path] = dict(config)
            files[rel_path]["generated_hash"] = None  # Forces creation on first sync
            desc = config.get("description", "")
            if desc:
                actions.append(f"New: {rel_path} — {desc}")
            else:
                actions.append(f"New: {rel_path}")
        else:
            # Repair stale config: if template/source/strategy differs from
            # canonical MANAGED_FILES, update it (preserving generated_hash)
            existing = files[rel_path]
            canonical = config
            stale = False
            for key in ("template", "source", "strategy"):
                if key in canonical and existing.get(key) != canonical.get(key):
                    stale = True
                    break
            if stale:
                saved_hash = existing.get("generated_hash")
                files[rel_path] = dict(canonical)
                files[rel_path]["generated_hash"] = saved_hash
                actions.append(f"Repaired manifest config for {rel_path}")

    updated_files = dict(files)

    for rel_path, config in files.items():
        strategy = config.get("strategy", "template")
        dst = product / rel_path

        if strategy == "template":
            template_rel = config.get("template", "")
            template_path = fw_dir / template_rel
            if not template_path.is_file():
                notes.append(f"Template missing: {template_rel}")
                continue

            # Render current template
            rendered = render_template(template_path, subs)
            rendered_hash = hashlib.sha256(rendered.encode()).hexdigest()

            # Check if template has changed since last sync
            stored_hash = config.get("generated_hash")
            if stored_hash == rendered_hash:
                continue  # Template hasn't changed

            # Template changed — check if user edited the file
            current_hash = compute_hash(dst)
            if current_hash is not None and current_hash != stored_hash:
                if force:
                    dst.write_text(rendered)
                    new_hash = compute_hash(dst)
                    updated_files[rel_path] = dict(config)
                    updated_files[rel_path]["generated_hash"] = new_hash
                    actions.append(f"Force-updated {rel_path} (local edits overwritten)")
                    if rel_path in ("CLAUDE.md",):
                        notes.append(f"Updated {rel_path} — re-read to pick up changes")
                else:
                    notes.append(
                        f"Skipped {rel_path} — new template available but file has local edits (re-run with --force to overwrite)"
                    )
                continue

            # Safe to update
            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_text(rendered)
            new_hash = compute_hash(dst)
            updated_files[rel_path] = dict(config)
            updated_files[rel_path]["generated_hash"] = new_hash
            actions.append(f"Updated {rel_path}")
            # CLAUDE.md and settings.json are pre-loaded — flag for restart
            if rel_path in ("CLAUDE.md",):
                notes.append(f"Updated {rel_path} — re-read to pick up changes")

        elif strategy == "block_template":
            template_rel = config.get("template", "")
            template_path = fw_dir / template_rel
            if not template_path.is_file():
                notes.append(f"Template missing: {template_rel}")
                continue

            # Render current template and extract block
            rendered = render_template(template_path, subs)
            rendered_block, _, _ = extract_block(rendered)
            if rendered_block is None:
                notes.append(f"Template {template_rel} has no markers — skipping block sync")
                continue

            rendered_block_hash = hashlib.sha256(rendered_block.encode()).hexdigest()

            # Check if template block has changed since last sync
            stored_hash = config.get("generated_hash")
            if stored_hash == rendered_block_hash:
                # Template hasn't changed — but check if product drifted
                if dst.is_file():
                    product_content = dst.read_text()
                    product_block, _, _ = extract_block(product_content)
                    if product_block is not None:
                        product_block_hash = hashlib.sha256(product_block.encode()).hexdigest()
                        if product_block_hash != stored_hash:
                            # Product drifted from last sync — re-apply
                            before_idx = product_content.find(BLOCK_BEGIN)
                            end_idx = product_content.find(BLOCK_END)
                            before = product_content[:before_idx]
                            after = product_content[end_idx + len(BLOCK_END):]
                            new_content = before + rendered_block + after
                            dst.write_text(new_content)
                            actions.append(f"Restored {rel_path}")
                            notes.append(f"Restored {rel_path} — block had drifted from synced version")
                continue

            # Template changed — check product file
            if not dst.is_file():
                # Product file missing — create from full template
                dst.parent.mkdir(parents=True, exist_ok=True)
                dst.write_text(rendered)
                updated_files[rel_path] = dict(config)
                updated_files[rel_path]["generated_hash"] = rendered_block_hash
                actions.append(f"Created {rel_path}")
                notes.append(f"Created {rel_path} — re-read to pick up changes")
                continue

            product_content = dst.read_text()
            product_block, before, after = extract_block(product_content)

            if product_block is None:
                notes.append(
                    f"Skipped {rel_path} — no markers (add markers to enable sync)"
                )
                continue

            # Check if user edited the block
            product_block_hash = hashlib.sha256(product_block.encode()).hexdigest()
            if product_block_hash != stored_hash:
                if force:
                    new_content = before + rendered_block + after
                    dst.write_text(new_content)
                    updated_files[rel_path] = dict(config)
                    updated_files[rel_path]["generated_hash"] = rendered_block_hash
                    actions.append(f"Force-updated {rel_path} block (local edits overwritten)")
                    notes.append(f"Updated {rel_path} — re-read to pick up changes")
                else:
                    notes.append(
                        f"Skipped {rel_path} — new template available but block has local edits (re-run with --force to overwrite)"
                    )
                continue

            # Safe to replace block in-place, preserving before/after
            new_content = before + rendered_block + after
            dst.write_text(new_content)
            updated_files[rel_path] = dict(config)
            updated_files[rel_path]["generated_hash"] = rendered_block_hash
            actions.append(f"Updated {rel_path}")
            notes.append(f"Updated {rel_path} — re-read to pick up changes")

        elif strategy == "always_update":
            source_rel = config.get("source", "")
            source_path = fw_dir / source_rel
            if not source_path.is_file():
                notes.append(f"Source missing: {source_rel}")
                continue

            source_bytes = source_path.read_bytes()
            if dst.is_file() and dst.read_bytes() == source_bytes:
                continue  # Already up to date

            dst.parent.mkdir(parents=True, exist_ok=True)
            dst.write_bytes(source_bytes)
            # Make executable
            dst.chmod(dst.stat().st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)

            new_hash = compute_hash(dst)
            updated_files[rel_path] = dict(config)
            updated_files[rel_path]["generated_hash"] = new_hash
            actions.append(f"Updated {rel_path}")

        elif strategy == "merge_settings":
            template_rel = config.get("template", "")
            template_path = fw_dir / template_rel
            if not template_path.is_file():
                notes.append(f"Template missing: {template_rel}")
                continue

            if merge_settings(dst, template_path, subs):
                actions.append(f"Merged {rel_path}")
                notes.append(f"Updated {rel_path} — re-read to pick up changes")

    # Place-once files: create if missing, never tracked for ongoing sync
    place_once = {
        ".prawduct/artifacts/project-preferences.md": "templates/project-preferences.md",
        ".prawduct/artifacts/boundary-patterns.md": "templates/boundary-patterns.md",
        ".prawduct/change-log.md": "templates/change-log.md",
    }
    for rel_path, template_rel in place_once.items():
        dst = product / rel_path
        if dst.is_file():
            continue
        template_path = fw_dir / template_rel
        if not template_path.is_file():
            continue
        rendered = render_template(template_path, subs)
        dst.parent.mkdir(parents=True, exist_ok=True)
        dst.write_text(rendered)
        actions.append(f"Created {rel_path}")

    # Place-once binary files: copy if missing (no template rendering)
    place_once_copy = {
        "tests/conftest.py": "templates/conftest.py",
    }
    for rel_path, template_rel in place_once_copy.items():
        dst = product / rel_path
        if dst.is_file():
            continue
        template_path = fw_dir / template_rel
        if not template_path.is_file():
            continue
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(template_path, dst)
        actions.append(f"Created {rel_path}")

    # Update manifest
    if actions:
        manifest["files"] = updated_files
        manifest["last_sync"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        manifest_path.write_text(json.dumps(manifest, indent=2) + "\n")

    return {
        "product_dir": str(product),
        "synced": bool(actions),
        "reason": "ok" if actions else "no updates needed",
        "actions": actions,
        "notes": notes,
    }


# =============================================================================
# Validate
# =============================================================================


def run_validate(target_dir: str, *, framework_dir: str | None = None) -> dict:
    """Health check for a prawduct product repo. No mutations.

    Returns structured results with per-check pass/warn/fail status,
    overall health, restart recommendation, and actionable recommendations.
    """
    target = Path(target_dir).resolve()
    checks: list[dict] = []
    recommendations: list[str] = []
    needs_restart = False

    # --- Basic structure ---
    prawduct_dir = target / ".prawduct"
    if not prawduct_dir.is_dir():
        return {
            "target": str(target),
            "overall": "broken",
            "version": "unknown",
            "checks": [{"name": "prawduct_dir", "status": "fail", "detail": ".prawduct/ directory does not exist"}],
            "needs_restart": False,
            "recommendations": ["Run prawduct-setup.py setup to initialize this repo"],
        }

    version = detect_version(target)

    # --- Managed files ---
    missing_managed = []
    for rel_path in MANAGED_FILES:
        if not (target / rel_path).is_file():
            missing_managed.append(rel_path)
    if missing_managed:
        checks.append({
            "name": "managed_files",
            "status": "fail",
            "detail": f"Missing: {', '.join(missing_managed)}",
        })
        recommendations.append("Run prawduct-setup.py setup to create missing files")
    else:
        checks.append({"name": "managed_files", "status": "pass", "detail": f"All {len(MANAGED_FILES)} managed files present"})

    # --- settings.json hooks ---
    settings_path = target / ".claude" / "settings.json"
    if settings_path.is_file():
        try:
            settings = json.loads(settings_path.read_text())
            hooks = settings.get("hooks", {})
            expected_events = ["SessionStart", "Stop", "SessionEnd"]
            missing_events = [e for e in expected_events if e not in hooks]

            if missing_events:
                checks.append({
                    "name": "settings_hooks",
                    "status": "fail",
                    "detail": f"Missing hook events: {', '.join(missing_events)}",
                })
                recommendations.append("Run prawduct-setup.py setup to fix settings.json hooks")
            else:
                # Verify hooks reference product-hook
                all_point_to_hook = True
                for event in expected_events:
                    entries = hooks.get(event, [])
                    has_product_hook = any(
                        "product-hook" in h.get("command", "")
                        for entry in entries
                        for h in entry.get("hooks", [])
                    )
                    if not has_product_hook:
                        all_point_to_hook = False
                        break

                if all_point_to_hook:
                    checks.append({"name": "settings_hooks", "status": "pass", "detail": "All 3 hook events configured correctly"})
                else:
                    checks.append({
                        "name": "settings_hooks",
                        "status": "warn",
                        "detail": "Some hooks don't reference product-hook",
                    })
        except json.JSONDecodeError:
            checks.append({"name": "settings_hooks", "status": "fail", "detail": "settings.json is not valid JSON"})
            recommendations.append("Fix or regenerate .claude/settings.json")
    else:
        checks.append({"name": "settings_hooks", "status": "fail", "detail": ".claude/settings.json does not exist"})

    # --- product-hook executable ---
    hook_path = target / "tools" / "product-hook"
    if hook_path.is_file():
        is_executable = os.access(str(hook_path), os.X_OK)
        first_line = hook_path.read_text().split("\n", 1)[0] if hook_path.stat().st_size > 0 else ""
        if is_executable and first_line.startswith("#!/usr/bin/env python3"):
            checks.append({"name": "hook_executable", "status": "pass", "detail": "product-hook exists, executable, correct shebang"})
        elif not is_executable:
            checks.append({"name": "hook_executable", "status": "fail", "detail": "product-hook exists but is not executable"})
            recommendations.append("chmod +x tools/product-hook")
        else:
            checks.append({"name": "hook_executable", "status": "warn", "detail": f"Unexpected shebang: {first_line[:50]}"})
    else:
        checks.append({"name": "hook_executable", "status": "fail", "detail": "tools/product-hook does not exist"})

    # --- CLAUDE.md block markers ---
    claude_path = target / "CLAUDE.md"
    if claude_path.is_file():
        content = claude_path.read_text()
        has_begin = BLOCK_BEGIN in content
        has_end = BLOCK_END in content
        if has_begin and has_end:
            begin_idx = content.find(BLOCK_BEGIN)
            end_idx = content.find(BLOCK_END)
            if begin_idx < end_idx:
                checks.append({"name": "claude_md_markers", "status": "pass", "detail": "Block markers present and well-formed"})
            else:
                checks.append({"name": "claude_md_markers", "status": "fail", "detail": "Block markers in wrong order (END before BEGIN)"})
        elif has_begin or has_end:
            checks.append({"name": "claude_md_markers", "status": "fail", "detail": "Only one block marker found (need both BEGIN and END)"})
        else:
            checks.append({"name": "claude_md_markers", "status": "warn", "detail": "No block markers — framework updates won't sync to CLAUDE.md"})
    else:
        checks.append({"name": "claude_md_markers", "status": "fail", "detail": "CLAUDE.md does not exist"})

    # --- Sync manifest ---
    manifest_path = prawduct_dir / "sync-manifest.json"
    if manifest_path.is_file():
        try:
            manifest = json.loads(manifest_path.read_text())
            fmt_ver = manifest.get("format_version", 0)
            if fmt_ver >= 2:
                checks.append({"name": "sync_manifest", "status": "pass", "detail": f"Valid manifest, format_version {fmt_ver}"})
            else:
                checks.append({"name": "sync_manifest", "status": "warn", "detail": f"Manifest format_version {fmt_ver} (expected >= 2, will auto-migrate)"})

            # Check framework reachable
            fw_source = manifest.get("framework_source", "")
            fw_dir = _resolve_framework_dir(manifest, framework_dir, target)
            if fw_dir and fw_dir.is_dir():
                checks.append({"name": "framework_reachable", "status": "pass", "detail": f"Framework at {fw_dir}"})
            else:
                checks.append({
                    "name": "framework_reachable",
                    "status": "warn",
                    "detail": f"Framework not reachable (configured: {fw_source})",
                })
                recommendations.append("Set PRAWDUCT_FRAMEWORK_DIR or clone framework as sibling ../prawduct")

            # Check last sync time
            last_sync = manifest.get("last_sync", "")
            if last_sync:
                checks.append({"name": "last_sync", "status": "pass", "detail": f"Last sync: {last_sync}"})

        except json.JSONDecodeError:
            checks.append({"name": "sync_manifest", "status": "fail", "detail": "sync-manifest.json is not valid JSON"})
    else:
        checks.append({"name": "sync_manifest", "status": "warn", "detail": "No sync manifest — will be bootstrapped on next sync"})

    # --- Template variable residue ---
    template_var_files = []
    for rel_path in MANAGED_FILES:
        file_path = target / rel_path
        if file_path.is_file():
            try:
                content = file_path.read_text()
                if re.search(r"\{\{[A-Z_]+\}\}", content):
                    template_var_files.append(rel_path)
            except Exception:  # prawduct:ok-broad-except — validation must not crash
                pass
    if template_var_files:
        checks.append({
            "name": "template_variables",
            "status": "warn",
            "detail": f"Unresolved template variables in: {', '.join(template_var_files)}",
        })
    else:
        checks.append({"name": "template_variables", "status": "pass", "detail": "No unresolved template variables"})

    # --- Gitignore ---
    gitignore = target / ".gitignore"
    if gitignore.is_file():
        gi_content = gitignore.read_text()
        gi_lines = set(gi_content.splitlines())
        essential = [".prawduct/.critic-findings.json", ".prawduct/.session-start", ".prawduct/sync-manifest.json"]
        missing_gi = [e for e in essential if e not in gi_lines]
        if missing_gi:
            checks.append({"name": "gitignore", "status": "warn", "detail": f"Missing entries: {', '.join(missing_gi)}"})
        else:
            checks.append({"name": "gitignore", "status": "pass", "detail": "Essential prawduct entries present"})
    else:
        checks.append({"name": "gitignore", "status": "warn", "detail": ".gitignore does not exist"})

    # --- Session state (are hooks actually firing?) ---
    session_start = prawduct_dir / ".session-start"
    if session_start.is_file():
        try:
            stamp = session_start.read_text().strip()
            checks.append({"name": "session_state", "status": "pass", "detail": f"Last session start: {stamp}"})
        except Exception:  # prawduct:ok-broad-except — validation must not crash
            checks.append({"name": "session_state", "status": "pass", "detail": "Session start file exists"})
    else:
        checks.append({
            "name": "session_state",
            "status": "warn",
            "detail": "No .session-start file — hooks may not have fired yet (normal for first run)",
        })

    # --- Framework currency (are files up to date?) ---
    try:
        manifest_for_fw = json.loads(manifest_path.read_text()) if manifest_path.is_file() else {}
    except json.JSONDecodeError:
        manifest_for_fw = {}
    fw_dir_resolved = _resolve_framework_dir(
        manifest_for_fw,
        framework_dir,
        target,
    )
    if fw_dir_resolved and fw_dir_resolved.is_dir():
        stale_files = []
        product_name_for_check = "Unknown"
        if manifest_path.is_file():
            try:
                mf = json.loads(manifest_path.read_text())
                product_name_for_check = mf.get("product_name", "Unknown")
            except json.JSONDecodeError:
                pass
        check_subs = {"{{PRODUCT_NAME}}": product_name_for_check, "{{PRAWDUCT_VERSION}}": PRAWDUCT_VERSION}

        for rel_path, config in MANAGED_FILES.items():
            strategy = config.get("strategy", "template")
            dst = target / rel_path
            if not dst.is_file():
                continue

            if strategy == "template":
                template_rel = config.get("template", "")
                template_path = fw_dir_resolved / template_rel
                if template_path.is_file():
                    rendered = render_template(template_path, check_subs)
                    rendered_hash = hashlib.sha256(rendered.encode()).hexdigest()
                    current_hash = compute_hash(dst)
                    if current_hash != rendered_hash:
                        stale_files.append(rel_path)
            elif strategy == "block_template":
                template_rel = config.get("template", "")
                template_path = fw_dir_resolved / template_rel
                if template_path.is_file():
                    rendered = render_template(template_path, check_subs)
                    rendered_block, _, _ = extract_block(rendered)
                    if rendered_block:
                        product_content = dst.read_text()
                        product_block, _, _ = extract_block(product_content)
                        if product_block:
                            if hashlib.sha256(product_block.encode()).hexdigest() != hashlib.sha256(rendered_block.encode()).hexdigest():
                                stale_files.append(rel_path)
            elif strategy == "always_update":
                source_rel = config.get("source", "")
                source_path = fw_dir_resolved / source_rel
                if source_path.is_file():
                    if source_path.read_bytes() != dst.read_bytes():
                        stale_files.append(rel_path)
            # merge_settings: skip — hard to compare without side effects

        if stale_files:
            checks.append({
                "name": "framework_currency",
                "status": "warn",
                "detail": f"Files differ from framework templates: {', '.join(stale_files)}",
            })
            # Check if settings.json or CLAUDE.md are stale — those need restart
            restart_files = [f for f in stale_files if f in ("CLAUDE.md", ".claude/settings.json")]
            if restart_files:
                needs_restart = True
                recommendations.append(f"Run sync then restart Claude Code ({', '.join(restart_files)} will update)")
        else:
            checks.append({"name": "framework_currency", "status": "pass", "detail": "All managed files match framework templates"})

    # --- Compute overall ---
    overall = "healthy"
    for c in checks:
        if c["status"] == "fail":
            overall = "broken"
            break
        if c["status"] == "warn" and overall == "healthy":
            overall = "degraded"

    return {
        "target": str(target),
        "overall": overall,
        "version": version,
        "checks": checks,
        "needs_restart": needs_restart,
        "recommendations": recommendations,
    }


# =============================================================================
# CLI
# =============================================================================


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Prawduct product repo setup, sync, and validation.",
    )
    subparsers = parser.add_subparsers(dest="command")

    # --- setup ---
    setup_parser = subparsers.add_parser(
        "setup",
        help="Auto-detect repo state and init/migrate/sync as needed",
    )
    setup_parser.add_argument("target_dir", help="Target directory for the product repo")
    setup_parser.add_argument("--name", default=None, help="Product name")
    setup_parser.add_argument("--json", action="store_true", dest="json_mode", help="JSON output only")
    setup_parser.add_argument("--force", action="store_true", help="Overwrite locally-edited files with new template versions")

    # --- sync ---
    sync_parser = subparsers.add_parser(
        "sync",
        help="Sync product repo with framework template updates",
    )
    sync_parser.add_argument("product_dir", help="Product repo directory")
    sync_parser.add_argument("--framework-dir", default=None, help="Framework directory (overrides manifest and env var)")
    sync_parser.add_argument("--json", action="store_true", dest="json_mode", help="JSON output only")
    sync_parser.add_argument("--no-pull", action="store_true", dest="no_pull", help="Skip git pull/fetch of the framework repo")
    sync_parser.add_argument("--force", action="store_true", help="Overwrite locally-edited files with new template versions")

    # --- validate ---
    validate_parser = subparsers.add_parser(
        "validate",
        help="Health check — verify repo structure and configuration",
    )
    validate_parser.add_argument("target_dir", help="Product repo directory to validate")
    validate_parser.add_argument("--json", action="store_true", dest="json_mode", help="JSON output only")

    args = parser.parse_args()

    if args.command == "setup":
        target = os.path.abspath(args.target_dir)
        if not os.path.isdir(target):
            os.makedirs(target, exist_ok=True)

        name = args.name

        # Detect state and route
        has_prawduct = os.path.isdir(os.path.join(target, ".prawduct"))
        if has_prawduct:
            version = detect_version(Path(target))
        else:
            version = "unknown"

        if version == "unknown":
            # New, non-prawduct, or partial .prawduct — init
            if name is None:
                name = Path(target).name
            result = run_init(target, name)
        elif version in ("v1", "v3", "v4", "partial"):
            result = run_migrate(target, name)
        elif version == "v5":
            result = run_sync(target, force=args.force)
        else:
            result = {"error": f"Unrecognized state: {version}"}

        if args.json_mode:
            print(json.dumps(result, indent=2))
        else:
            if "error" in result:
                log(f"Error: {result['error']}")
                return 1
            actions = result.get("actions", [])
            notes = result.get("notes", [])
            if actions:
                log(f"Setup complete: {target}")
                for action in actions:
                    log(f"  + {action}")
            else:
                log(f"Already up to date: {target}")
            if notes:
                for note in notes:
                    log(f"  * {note}")
            log("")
            log("Next: Open this directory in a new Claude Code session for full governance.")
        return 0

    elif args.command == "sync":
        result = run_sync(args.product_dir, args.framework_dir, no_pull=args.no_pull, force=args.force)

        if args.json_mode:
            print(json.dumps(result, indent=2))
        else:
            if not result["synced"]:
                if result["reason"] not in ("no manifest", "framework not found", "no updates needed"):
                    log(f"Sync skipped: {result['reason']}")
            else:
                log(f"Synced {result['product_dir']}")
                for action in result["actions"]:
                    log(f"  + {action}")
            for note in result.get("notes", []):
                log(f"  * {note}")
        return 0

    elif args.command == "validate":
        result = run_validate(args.target_dir)

        if args.json_mode:
            print(json.dumps(result, indent=2))
        else:
            status_icon = {"healthy": "OK", "degraded": "WARN", "broken": "FAIL"}
            log(f"Prawduct health: {status_icon.get(result['overall'], '?')} ({result['overall']})")
            log(f"  Version: {result['version']}")
            for check in result["checks"]:
                icon = {"pass": "+", "warn": "~", "fail": "!"}
                log(f"  {icon.get(check['status'], '?')} {check['name']}: {check['detail']}")
            if result["needs_restart"]:
                log("")
                log("  RESTART NEEDED: Some files will update on next sync")
            if result["recommendations"]:
                log("")
                for rec in result["recommendations"]:
                    log(f"  -> {rec}")
        return 0 if result["overall"] != "broken" else 1

    else:
        parser.print_help()
        return 1


if __name__ == "__main__":
    sys.exit(main())
