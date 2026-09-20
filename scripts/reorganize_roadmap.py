import re
import sys

roadmap_path = "/Users/jasonvaughan/Documents/Projects/TangleClaw-Builder1/ROADMAP.md"

with open(roadmap_path, 'r') as f:
    lines = f.readlines()

issues = []

# Regex to match table rows with issues
issue_regex = re.compile(r'^\|\s*(\[\#\d+\]\([^\)]+\))\s*\|\s*([^|]+)\s*\|\s*([^|]+)\s*\|\s*(.*?)\s*\|$')

for line in lines:
    match = issue_regex.match(line.strip())
    if match:
        issue = {
            'link': match.group(1).strip(),
            'type': match.group(2).strip(),
            'state': match.group(3).strip(),
            'title': match.group(4).strip(),
            'original': line.strip()
        }
        # clean up title if it has ~~
        title_clean = issue['title'].replace('~~', '').lower()
        issue['title_clean'] = title_clean
        issues.append(issue)

categories = {
    "Management": {"keywords": ["master", "plan", "govern", "train", "roadmap", "project"], "issues": []},
    "Architecture": {"keywords": ["architect", "reason", "design", "api contract"], "issues": []},
    "Engineering": {"keywords": ["engine", "session", "builder", "aider", "claude", "antigravity", "terminal", "wrap", "launch"], "issues": []},
    "Communication": {"keywords": ["medusa", "switchboard", "message", "comms", "broadcast"], "issues": []},
    "Quality": {"keywords": ["critic", "eval", "audit", "adversarial"], "issues": []},
    "Code Review": {"keywords": ["review", "code review"], "issues": []},
    "Release": {"keywords": ["release", "version", "bump", "update", "publish"], "issues": []},
    "Dependency management": {"keywords": ["depend", "registry"], "issues": []},
    "Operations": {"keywords": ["health", "idle", "wedge", "porthub", "service", "supervis", "daemon", "server"], "issues": []},
    "Security": {"keywords": ["auth", "token", "ingress", "secure", "scan", "password", "credential"], "issues": []},
    "Uncategorized": {"keywords": [], "issues": []}
}

for issue in issues:
    placed = False
    for cat, data in categories.items():
        if cat == "Uncategorized":
            continue
        for kw in data["keywords"]:
            if kw in issue['title_clean']:
                data["issues"].append(issue)
                placed = True
                break
        if placed:
            break
    if not placed:
        # Check if it fits anywhere else, maybe Engineering as fallback
        categories["Uncategorized"]["issues"].append(issue)

# Let's distribute Uncategorized evenly or put them in Engineering
categories["Engineering"]["issues"].extend(categories["Uncategorized"]["issues"])
del categories["Uncategorized"]

new_content = [
    "# TangleClaw — Roadmap Board\n",
    "\n",
    "> **SDLC Orchestration Platform Roadmap.** This document outlines the roadmap across the foundational departments of our AI-native SDLC orchestration platform.\n",
    "\n"
]

for cat, data in categories.items():
    new_content.append(f"## {cat}\n")
    if len(data["issues"]) > 0:
        new_content.append("| Issue | Type | State | Title |")
        new_content.append("|---|---|---|---|")
        for issue in data["issues"]:
            new_content.append(issue['original'])
    else:
        new_content.append("_No pending items._")
    new_content.append("\n")

with open(roadmap_path, 'w') as f:
    f.write('\n'.join(new_content))

print(f"Processed {len(issues)} issues.")
