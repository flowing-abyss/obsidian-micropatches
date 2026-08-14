Micropatches

A collection of small, targeted patches for specific Obsidian core-editor bugs and performance issues. Each patch targets one measured problem — no broad settings, no UI, nothing to configure.

Patches included

1. Cursor repeat throttle
   Holding an arrow key fires a stream of OS auto-repeat keydown events. Each one normally runs a full CodeMirror dispatch cycle (dispatchTransactions -> updateSelection -> native Selection.collapse()). If that cycle costs more than the OS's repeat interval, events queue up faster than they drain and the backlog grows on itself — a few ms of lag can escalate into a multi-second freeze the longer the key is held.
   This coalesces auto-repeat events into at most one real CodeMirror update per animation frame, computed with CodeMirror's own moveByChar / moveVertically helpers so wrapped lines, unicode clusters etc. are still handled correctly. The first (non-repeat) keydown is always handled immediately and normally — this only changes behavior while a key is being held down.

Installation / update
1. Disable the plugin in Obsidian.
2. Replace the folder:
   <your-vault>/.obsidian/plugins/micropatches/
   with the folder from this repo.
3. Restart or reload Obsidian.
4. Enable the plugin again.
