Micropatches

A collection of small, targeted patches for specific Obsidian core-editor bugs and performance issues. Each patch targets one measured problem — no broad settings, no UI, nothing to configure.

Patches included

1. Cursor repeat throttle
   Holding an arrow key fires a stream of OS auto-repeat keydown events. Each one normally runs a full CodeMirror dispatch cycle (dispatchTransactions -> updateSelection -> native Selection.collapse()). If that cycle costs more than the OS's repeat interval, events queue up faster than they drain and the backlog grows on itself — a few ms of lag can escalate into a multi-second freeze the longer the key is held.
   This coalesces auto-repeat events (plain or Shift-extend) into at most one real CodeMirror update per animation frame, computed with CodeMirror's own moveByChar / moveVertically helpers so wrapped lines, unicode clusters etc. are still handled correctly. The first (non-repeat) keydown is always handled immediately and normally, and the patch steps aside entirely for anything that gives arrow keys a different meaning: an open suggester popup, vim mode, or IME composition.

2. Hide traffic lights (macOS)
   Obsidian on macOS reserves layout space in the tab bar for the native traffic-light window controls even when they're not wanted. This moves them off-screen via Electron's setWindowButtonPosition and removes the reserved space with a small stylesheet, for every open window (main window + popouts). macOS only — a no-op elsewhere.

3. Instant UI (skip animations) — off by default
   Collapses CSS transition/animation durations to near-zero across Obsidian's UI instead of removing them outright, so `transitionend`/`animationend` still fire and `animation-fill-mode` still applies — Notice, sidebar reveals, folder collapse, and the several community plugins that depend on those events keep working, they just happen instantly. Spinners, progress bars, and CodeMirror's blinking cursor are allowlisted to keep actually animating. This changes how the UI feels, not just fixes something broken, so it's opt-in.

Each patch can be toggled independently in Settings -> Micropatches, without reloading the plugin.

Installation / update

1. Disable the plugin in Obsidian.
2. Replace the folder:
   <your-vault>/.obsidian/plugins/micropatches/
   with the folder from this repo.
3. Restart or reload Obsidian.
4. Enable the plugin again.
