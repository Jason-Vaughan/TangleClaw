with open("/Users/jasonvaughan/Documents/Projects/Shared/TangleClaw-Shared/MASTER_ROADMAP.md", "r") as f:
    text = f.read()

import re

text = re.sub(
    r"  - ⏳ \*\*Chunk 05:\*\* Handoff state injection & Crash Recovery[^\n]+",
    r"  - ✅ **Chunk 05:** Handoff state injection & Crash Recovery (#1680 merged, #1673 closed) — (PR #1694 - Merged)",
    text
)

text = re.sub(
    r"  - ⏳ \*\*Chunk 06:\*\* #1669[^\n]+",
    r"  - ⏳ **Chunk 06:** #1685 (Wrap prompt-delivery blocking timeout) - *Fresh Builder1 Session*\n  - ⏳ **Chunk 07:** #1589 (Train 21 final serial prep)\n  - ⏳ **Chunk 08:** #1590/ADR0017 (Finalize Train 21 candidate/whole-trajectory gates)\n  - ⏳ **Chunk 09:** #1669 (Extract the shared pane-writer behind launch-unready and launch-kickoff)",
    text
)

with open("/Users/jasonvaughan/Documents/Projects/Shared/TangleClaw-Shared/MASTER_ROADMAP.md", "w") as f:
    f.write(text)
