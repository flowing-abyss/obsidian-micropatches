import { EditorSelection, Prec } from "@codemirror/state";
import { EditorView, ViewPlugin } from "@codemirror/view";
import type { Plugin } from "obsidian";
import type { Patch, PatchContext, PatchHandle } from "../patch";

type MoveType = "char" | "line";

interface Move {
  type: MoveType;
  forward: boolean;
  extend: boolean;
  vim?: VimMove;
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
// future shape change safely falls back to normal Obsidian handling instead
// of throwing or corrupting Vim state.
interface WorkspaceWithSuggest {
  editorSuggest?: { currentSuggest?: unknown };
}

interface VaultWithConfig {
  getConfig?: (key: string) => unknown;
}

interface VimInputState {
  keyBuffer?: unknown;
  motionRepeat?: unknown;
  operator?: unknown;
  prefixRepeat?: unknown;
}

interface VimState {
  inputState?: VimInputState;
  insertMode?: boolean;
}

interface LegacyCodeMirror {
  state?: { vim?: VimState };
}

interface EditorViewWithLegacyCodeMirror {
  cm?: LegacyCodeMirror;
}

interface VimApi {
  handleKey: (cm: LegacyCodeMirror, key: string, origin?: string) => void;
}

interface WindowWithCodeMirror {
  CodeMirror?: { Vim?: VimApi };
}

interface VimMove {
  api: VimApi;
  cm: LegacyCodeMirror;
  key: string;
  state: VimState;
}

type VimMode = "off" | "insert" | VimMove | null;

function isSuggesterActive(plugin: Plugin, view: EditorView): boolean {
  const workspace = plugin.app.workspace as unknown as WorkspaceWithSuggest;
  if (workspace.editorSuggest?.currentSuggest) return true;

  try {
    return view.dom.win.document.querySelector(".suggestion-container") !== null;
  } catch {
    return false;
  }
}

function hasPendingVimInput(state: VimState): boolean {
  const input = state.inputState;
  if (!input) return false;
  const hasValue = (value: unknown): boolean => (Array.isArray(value) ? value.length > 0 : Boolean(value));
  return (
    hasValue(input.keyBuffer) ||
    hasValue(input.motionRepeat) ||
    hasValue(input.operator) ||
    hasValue(input.prefixRepeat)
  );
}

/**
 * `null` means Vim is enabled but its compatibility adapter is unavailable or
 * currently has pending input. In that case normal CodeMirror/Vim handling is
 * safer than guessing. Insert mode can use the normal CM6 movement path;
 * command/visual mode must go through Vim so line boundaries and selections
 * retain Vim semantics.
 */
function getVimMode(plugin: Plugin, view: EditorView, key: string): VimMode {
  const vault = plugin.app.vault as unknown as VaultWithConfig;
  if (!vault.getConfig?.("vimMode")) return "off";

  const cm = (view as unknown as EditorViewWithLegacyCodeMirror).cm;
  const state = cm?.state?.vim;
  if (!cm || !state) return null;
  if (state.insertMode) return "insert";
  if (hasPendingVimInput(state)) return null;

  const api = (view.dom.win as unknown as WindowWithCodeMirror).CodeMirror?.Vim;
  if (!api?.handleKey) return null;
  return { api, cm, key: `<${key.slice("Arrow".length)}>`, state };
}

/**
 * Holding an arrow key fires a stream of OS auto-repeat keydown events. Each
 * one normally runs a full CodeMirror dispatch cycle (dispatchTransactions ->
 * updateSelection -> native Selection.collapse()). If that cycle costs more
 * than the OS's repeat interval, events queue up faster than they drain and
 * the backlog grows on itself — a few ms of lag can escalate into a
 * multi-second freeze the longer the key is held.
 *
 * This coalesces repeat events: an unmodified first keydown is handled
 * immediately and normally. Repeats are accumulated and resolved to a single
 * position update via CodeMirror's own (dispatch-free) moveByChar /
 * moveVertically helpers, then flushed as one dispatch per animation frame —
 * so CodeMirror never receives more than one real update per frame no matter
 * how fast the OS sends repeat events.
 *
 * Vertical Shift+Arrow is handled here as a compatibility fix as well. The
 * CodeMirror commands bundled by current Obsidian lose the selection head's
 * side association at a soft-wrap boundary. The next keypress is then consumed
 * merely restoring that invisible association instead of extending by another
 * visual line. Preserving the association returned by moveVertically makes
 * every keypress advance exactly one visual line; repeated events are still
 * coalesced. Horizontal Shift+Arrow and other modified commands stay native.
 * We also stay out of the way of an open suggester/autocomplete popup, IME
 * composition, and Vim states with pending input. Vim insert mode uses the CM6
 * path. Vim command/visual mode receives one counted Vim command per frame.
 */
export const cursorRepeatThrottle: Patch = {
  id: "cursor-repeat-throttle",
  name: "Cursor repeat throttle",
  description:
    "Coalesces held-arrow-key auto-repeat into at most one CodeMirror update per animation frame, preventing multi-second freezes, and keeps vertical Shift selection moving across soft wraps one visual line per keypress.",

  register(plugin: Plugin, ctx: PatchContext): PatchHandle {
    const pending = new Map<EditorView, PendingMove>();
    const scheduled = new Map<EditorView, { id: number; win: Window }>();

    const flush = (view: EditorView): void => {
      const entry = pending.get(view);
      if (!entry) return;
      pending.delete(view);
      if (!ctx.isEnabled()) return;
      if (!view.dom.isConnected) return;

      try {
        if (entry.vim) {
          const currentState = entry.vim.cm.state?.vim;
          if (currentState !== entry.vim.state || currentState.insertMode || hasPendingVimInput(currentState)) return;

          for (const digit of String(entry.count))
            entry.vim.api.handleKey(entry.vim.cm, digit, "cursor-repeat-throttle");
          entry.vim.api.handleKey(entry.vim.cm, entry.vim.key, "cursor-repeat-throttle");
          return;
        }

        const sel = view.state.selection;
        const newRanges = sel.ranges.map((range) => {
          let cur = entry.extend ? range : EditorSelection.cursor(range.head, range.assoc, undefined, range.goalColumn);
          for (let i = 0; i < entry.count; i++) {
            const next =
              entry.type === "char" ? view.moveByChar(cur, entry.forward) : view.moveVertically(cur, entry.forward);
            // No progress (e.g. hit a document boundary, or the target line
            // isn't rendered/measurable yet) — stop instead of repeating a
            // no-op, which would otherwise let goalColumn drift.
            if (next.head === cur.head && next.goalColumn === cur.goalColumn && next.assoc === cur.assoc) break;
            cur = next;
          }
          return entry.extend
            ? EditorSelection.range(range.anchor, cur.head, cur.goalColumn, cur.bidiLevel ?? undefined, cur.assoc)
            : cur;
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
      if (
        entry &&
        (entry.type !== move.type ||
          entry.forward !== move.forward ||
          entry.extend !== move.extend ||
          entry.vim?.cm !== move.vim?.cm ||
          entry.vim?.key !== move.vim?.key)
      ) {
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

    const handleKeydown = (event: KeyboardEvent, view: EditorView): void => {
      if (!ctx.isEnabled()) return;
      const base = MOVE_KEYS[event.key];
      const extendsVertically = event.shiftKey && base?.type === "line";
      if (
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        event.isComposing ||
        (event.shiftKey && !extendsVertically) ||
        (!event.repeat && !extendsVertically)
      ) {
        // Preserve ordering when a different key arrives before the rAF that
        // owns an already queued movement.
        flush(view);
        return;
      }

      if (!base) {
        flush(view);
        return;
      }

      if (isSuggesterActive(plugin, view)) {
        flush(view);
        return;
      }

      const vimMode = getVimMode(plugin, view, event.key);
      if (vimMode === null || (typeof vimMode === "object" && event.shiftKey)) {
        flush(view);
        return;
      }

      event.preventDefault();
      // Built-in Vim installs its own highest-precedence CodeMirror handler.
      // A capture listener is the only stable way to stop that handler from
      // consuming every repeat before this patch can coalesce it.
      event.stopImmediatePropagation();
      const move: Move = {
        ...base,
        extend: event.shiftKey,
        ...(typeof vimMode === "object" ? { vim: vimMode } : {}),
      };
      if (event.repeat) {
        queueMove(view, move);
      } else {
        flush(view);
        pending.set(view, { ...move, count: 1 });
        flush(view);
      }
    };

    plugin.registerEditorExtension(
      Prec.highest(
        ViewPlugin.fromClass(
          class {
            private readonly onKeydown: (event: KeyboardEvent) => void;
            private readonly view: EditorView;

            constructor(view: EditorView) {
              this.view = view;
              this.onKeydown = (event) => handleKeydown(event, view);
              view.contentDOM.addEventListener("keydown", this.onKeydown, { capture: true });
            }

            destroy(): void {
              // `contentDOM` remains stable for an EditorView's lifetime.
              // CodeMirror calls destroy before releasing the view.
              this.view.contentDOM.removeEventListener("keydown", this.onKeydown, { capture: true });
            }
          },
        ),
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
