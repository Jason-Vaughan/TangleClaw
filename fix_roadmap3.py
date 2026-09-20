with open("/Users/jasonvaughan/Documents/Projects/Shared/TangleClaw-Shared/MASTER_ROADMAP.md", "r") as f:
    text = f.read()

import re
text = re.sub(
    r"\*\(\(Train 18 is completely executed and LIVE\)\)\.\*",
    r"*(Train 18 is completely executed and LIVE).*\n\n**Sprint v5.28.x (Wrap Overhaul Fast Follow)**\n- **#1707**: [bug] Cancel on a live wrap drawer stops nothing\n- **#1708**: [bug] keepSessionRunning is modal-only, breaking PM cross-session wrap",
    text
)

with open("/Users/jasonvaughan/Documents/Projects/Shared/TangleClaw-Shared/MASTER_ROADMAP.md", "w") as f:
    f.write(text)
