with open("/Users/jasonvaughan/Documents/Projects/Shared/TangleClaw-Shared/MASTER_ROADMAP.md", "r") as f:
    lines = f.readlines()

new_lines = []
in_train_21 = False
for line in lines:
    if "**Train 21: Engine-Agnostic Phased Launch**" in line:
        in_train_21 = True
    elif in_train_21 and line.startswith("**Train 22:"):
        in_train_21 = False
        
    if "Chunk 05: Handoff state injection & Crash Recovery" in line:
        new_lines.append("  - ✅ **Chunk 05:** Handoff state injection & Crash Recovery (#1680 merged, #1673 closed) — (PR #1694 - Merged)\n")
    elif "Chunk 06: #1669" in line:
        new_lines.append("  - ⏳ **Chunk 06:** #1685 (Wrap prompt-delivery blocking timeout) - *Fresh Builder1 Session*\n")
        new_lines.append("  - ⏳ **Chunk 07:** #1589 (Train 21 final serial prep)\n")
        new_lines.append("  - ⏳ **Chunk 08:** #1590/ADR0017 (Finalize Train 21 candidate/whole-trajectory gates)\n")
        new_lines.append("  - ⏳ **Chunk 09:** #1669 (Extract the shared pane-writer behind launch-unready and launch-kickoff)\n")
    else:
        new_lines.append(line)

with open("/Users/jasonvaughan/Documents/Projects/Shared/TangleClaw-Shared/MASTER_ROADMAP.md", "w") as f:
    f.writelines(new_lines)
