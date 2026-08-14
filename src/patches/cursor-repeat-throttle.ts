import { EditorSelection, Prec, type SelectionRange } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Plugin } from "obsidian";
import type { Patch, PatchHandle } from "../patch";

type MoveType = "char" | "line";

interface Move {
  type: MoveType;
  forward: boolean;
}

interface PendingMove extends Move {
  count: number;
}

const MOVE_KEYS: Record<string, Move> = {
  ArrowLeft: { type: "char", forward: false },
  ArrowRight: { type: "char", forward: true },
  ArrowUp: { type: "line", forward: false },
  ArrowDown: { type: "line", forward: true },
};

/**
 * Holding an arrow key fires a stream of OS auto-repeat keydown events. Each
 * one normally runs a full CodeMirror dispatch cycle (dispatchTransactions ->
 * updateSelection -> native Selection.collapse()). If that cycle costs more
 * than the OS's repeat interval, events queue up faster than they drain and
 * the backlog grows on itself — a few ms of lag can escalate into a
 * multi-second freeze the longer the key is held.
 *
 * This coalesces repeat events: the first (non-repeat) keydown is always
 * handled immediately and normally. Repeats are accumulated and resolved to
 * a single position update via CodeMirror's own (dispatch-free) moveByChar /
 * moveVertically helpers, then flushed as one dispatch per animation frame —
 * so CodeMirror never receives more than one real update per frame no matter
 * how fast the OS sends repeat events.
 */
export const cursorRepeatThrottle: Patch = {
  id: "cursor-repeat-throttle",
  name: "Cursor repeat throttle",
  description:
    "Coalesces held-arrow-key auto-repeat into at most one CodeMirror update per animation frame, preventing the input queue from snowballing into multi-second freezes.",

  register(plugin: Plugin, isEnabled: () => boolean): PatchHandle {
    const pending = new Map<EditorView, PendingMove>();
    const scheduled = new Map<EditorView, { id: number; win: Window }>();

    const flush = (view: EditorView): void => {
      const entry = pending.get(view);
      if (!entry) return;
      pending.delete(view);
      if (!isEnabled()) return;
      if (!view.dom.isConnected) return;

      try {
        const sel = view.state.selection;
        const newRanges = sel.ranges.map((range: SelectionRange) => {
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
      } catch (error) {
        console.error("Micropatches (cursor-repeat-throttle): flush failed", error);
      }
    };

    const queueMove = (view: EditorView, move: Move): void => {
      let entry = pending.get(view);
      if (entry && (entry.type !== move.type || entry.forward !== move.forward)) {
        flush(view);
        entry = undefined;
      }
      if (!entry) {
        entry = { ...move, count: 0 };
        pending.set(view, entry);
      }
      entry.count++;

      if (!scheduled.has(view)) {
        const win = view.dom.win;
        const id = win.requestAnimationFrame(() => {
          scheduled.delete(view);
          flush(view);
        });
        scheduled.set(view, { id, win });
      }
    };

    plugin.registerEditorExtension(
      Prec.highest(
        EditorView.domEventHandlers({
          keydown: (event, view) => {
            if (!isEnabled()) return false;
            if (!event.repeat) return false;
            if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;

            const move = MOVE_KEYS[event.key];
            if (!move) return false;

            event.preventDefault();
            queueMove(view, move);
            return true;
          },
        }),
      ),
    );

    return {
      cleanup: (): void => {
        for (const { id, win } of scheduled.values()) win.cancelAnimationFrame(id);
        scheduled.clear();
        pending.clear();
      },
    };
  },
};
