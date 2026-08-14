const { Plugin } = require("obsidian");
const { EditorView } = require("@codemirror/view");
const { EditorSelection, Prec } = require("@codemirror/state");

const MOVE_KEYS = {
  ArrowLeft: { type: "char", forward: false },
  ArrowRight: { type: "char", forward: true },
  ArrowUp: { type: "line", forward: false },
  ArrowDown: { type: "line", forward: true },
};

/**
 * Fix #1 — cursor repeat throttle.
 *
 * Holding an arrow key makes the OS fire a real "repeat" keydown for every
 * auto-repeat tick. Each one normally runs a full CodeMirror dispatch cycle
 * (dispatchTransactions -> updateSelection -> native Selection.collapse()).
 * If that cycle costs more than the OS's repeat interval, the events queue
 * up faster than they drain and the backlog grows on itself — what starts
 * as a few ms of lag can escalate into a multi-second freeze the longer the
 * key is held.
 *
 * This coalesces repeat events: the first (non-repeat) keydown is always
 * handled immediately and normally. Repeats are accumulated and resolved to
 * a single position update via CodeMirror's own (dispatch-free) moveByChar /
 * moveVertically helpers, then flushed as one dispatch per animation frame —
 * so CodeMirror never receives more than one real update per frame no
 * matter how fast the OS sends repeat events.
 */
function registerCursorRepeatThrottle(plugin) {
  const pending = new Map();
  const scheduled = new Map();

  function flush(view) {
    const entry = pending.get(view);
    if (!entry) return;
    pending.delete(view);
    if (!view.dom.isConnected) return;

    try {
      const sel = view.state.selection;
      const newRanges = sel.ranges.map((range) => {
        let r = range;
        for (let i = 0; i < entry.count; i++) {
          r = entry.type === "char" ? view.moveByChar(r, entry.forward) : view.moveVertically(r, entry.forward);
        }
        return r;
      });

      view.dispatch({
        selection: EditorSelection.create(newRanges, sel.mainIndex),
        scrollIntoView: true,
        userEvent: "select",
      });
    } catch (e) {
      console.error("Micropatches (cursor-repeat-throttle): flush failed", e);
    }
  }

  function queueMove(view, move) {
    let entry = pending.get(view);
    if (entry && (entry.type !== move.type || entry.forward !== move.forward)) {
      flush(view);
      entry = null;
    }
    if (!entry) {
      entry = { type: move.type, forward: move.forward, count: 0 };
      pending.set(view, entry);
    }
    entry.count++;

    if (!scheduled.has(view)) {
      const id = requestAnimationFrame(() => {
        scheduled.delete(view);
        flush(view);
      });
      scheduled.set(view, id);
    }
  }

  plugin.registerEditorExtension(
    Prec.highest(
      EditorView.domEventHandlers({
        keydown: (event, view) => {
          if (!event.repeat) return false;
          if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;

          const move = MOVE_KEYS[event.key];
          if (!move) return false;

          event.preventDefault();
          queueMove(view, move);
          return true;
        },
      })
    )
  );

  return () => {
    for (const id of scheduled.values()) cancelAnimationFrame(id);
    scheduled.clear();
    pending.clear();
  };
}

module.exports = class MicropatchesPlugin extends Plugin {
  onload() {
    this.cleanupFns = [];
    this.cleanupFns.push(registerCursorRepeatThrottle(this));
  }

  onunload() {
    for (const cleanup of this.cleanupFns) cleanup();
    this.cleanupFns = [];
  }
};
