#!/usr/bin/env python3
"""Generate canonical TangleClaw v5.71.0 Sprint Executive Report (Charter A505 v1.0)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from generators.a505_report_builder import build_single_version_report


def generate():
    out = Path(__file__).resolve().parent.parent / "v5.71.0" / "index.html"
    out.parent.mkdir(parents=True, exist_ok=True)
    html = build_single_version_report("v5.71.0")
    out.write_text(html, encoding="utf-8")
    print(f"Wrote {out} ({len(html)} bytes)")


if __name__ == "__main__":
    generate()
