# Terminal clipboard

In a Windows browser, focus the terminal and use Ctrl+V to paste. On a Mac, use Command+V. This applies to project terminals, the dashboard Master pane, and the Master drawer. Reload an already-open page after installing the fix.

The Windows handler lets the browser deliver its native paste event before xterm can interpret Ctrl+V as the SYN control character. xterm continues to own paste delivery and bracketed-paste framing. The keyboard path does not require navigator.clipboard or HTTPS. The project Paste button remains a separate path.

This change detects the browser device, not the server OS. If using remote desktop into a Mac browser, use the remote desktop client's mapping for Command+V; Windows Ctrl+V is not automatically a Mac paste shortcut.

Regression checks: `node --test test/terminal-windows-paste.test.js test/terminal-frame-wiring.test.js test/paste-affordance.test.js`. End-to-end acceptance: copy multiline text on Windows, focus each terminal surface, and confirm Ctrl+V inserts it exactly once without submitting it.
