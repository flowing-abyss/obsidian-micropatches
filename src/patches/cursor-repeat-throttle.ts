import { EditorSelection, Prec } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Plugin } from "obsidian";
import type { Patch, PatchHandle } from "../patch";

type MoveType = "char" | "line";

interface Move {
  type: MoveType;
  forward: boolean;
  extend: boolean;
}

interface PendingMove extends Move {
  count: number;
}

const MOVE_KEYS: Record<string, { type: MoveType; forward: boolean }> = {
  ArrowLeft: { type: "char", forward: false },
  ArrowRight: { type: "char", forward: true },
  ArrowUp: { type: "line", forward: false },
  ArrowDown: { type: "line", forward: true },
};

// Both are undocumented/internal Obsidian APIs — not in obsidian.d.ts, so we
// cast defensively rather than assume the shape. Optional chaining means a
// future shape change degrades to "not detected" (we throttle as before)
// instead of throwing.
interface WorkspaceWithSuggest {
  editorSuggest?: { currentSuggest?: unknown };
}

interface VaultWithConfig {
  getConfig?: (key: string) => unknown;
}

function isSuggesterActive(plugin: Plugin, view: EditorView): boolean {
  const workspace = plugin.app.workspace as unknown as WorkspaceWithSuggest;
  if (workspace.editorSuggest?.currentSuggest) return true;

  try {
    return view.dom.win.document.querySelector(".suggestion-container") !== null;
  } catch {
    return false;
  }
}

function isVimModeOn(plugin: Plugin): boolean {
  const vault = plugin.app.vault as unknown as VaultWithConfig;
  return Boolean(vault.getConfig?.("vimMode"));
}

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
 *
 * We only intercept the plain arrow keys (optionally with Shift, to extend a
 * selection) and only their *repeat* events — the first press of every key
 * combo always goes through CodeMirror/Obsidian's normal handling untouched.
 * We explicitly stay out of the way of anything that gives arrow keys a
 * different meaning: an open suggester/autocomplete popup, vim mode (visual
 * selection, counts, pending operators), and IME composition.
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
        const newRanges = sel.ranges.map((range) => {
          let cur = EditorSelection.cursor(range.head, range.assoc, undefined, range.goalColumn);
          for (let i = 0; i < entry.count; i++) {
            const next =
              entry.type === "char" ? view.moveByChar(cur, entry.forward) : view.moveVertically(cur, entry.forward);
            // No progress (e.g. hit a document boundary, or the target line
            // isn't rendered/measurable yet) — stop instead of repeating a
            // no-op, which would otherwise let goalColumn drift.
            if (next.head === cur.head && next.goalColumn === cur.goalColumn) break;
            cur = next;
          }
          return entry.extend ? EditorSelection.range(range.anchor, cur.head, undefined, cur.goalColumn) : cur;
        });

        view.dispatch({
          selection: EditorSelection.create(newRanges, sel.mainIndex),
          scrollIntoView: true,
          userEvent: entry.extend ? "select.extend" : "select",
        });
      } catch (error) {
        console.error("Micropatches (cursor-repeat-throttle): flush failed", error);
      }
    };

    const queueMove = (view: EditorView, move: Move): void => {
      let entry = pending.get(view);
      if (entry && (entry.type !== move.type || entry.forward !== move.forward || entry.extend !== move.extend)) {
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

    // A closed popout's EditorView never gets another keydown, so a pending
    // move or scheduled rAF for it would otherwise sit in these maps until
    // the whole plugin unloads (flush() already no-ops safely via
    // isConnected, but the entry itself — and the rAF — would leak).
    const forgetWindow = (win: Window): void => {
      for (const [view] of pending) {
        if (view.dom.win === win) pending.delete(view);
      }
      for (const [view, sched] of scheduled) {
        if (sched.win === win) {
          sched.win.cancelAnimationFrame(sched.id);
          scheduled.delete(view);
        }
      }
    };
    plugin.registerEvent(
      plugin.app.workspace.on("window-close", (_workspaceWindow, win) => {
        forgetWindow(win);
      }),
    );

    plugin.registerEditorExtension(
      Prec.highest(
        EditorView.domEventHandlers({
          keydown: (event, view) => {
            if (!isEnabled()) return false;
            if (!event.repeat) return false;
            if (event.ctrlKey || event.metaKey || event.altKey) return false;
            if (event.isComposing) return false;

            const base = MOVE_KEYS[event.key];
            if (!base) return false;

            if (isVimModeOn(plugin)) return false;
            if (isSuggesterActive(plugin, view)) return false;

            event.preventDefault();
            queueMove(view, { ...base, extend: event.shiftKey });
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
