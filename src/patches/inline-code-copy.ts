import type { Plugin, SettingGroupItem } from "obsidian";
import type { Patch, PatchContext, PatchHandle } from "../patch";

const INLINE_CODE_BODY_CLASS = "micropatches-inline-code-copy";
const HIGHLIGHT_BODY_CLASS = "micropatches-highlight-copy";
const COPY_FEEDBACK_CLASS = "is-micropatches-copy-confirmed";
const COPY_FEEDBACK_MS = 160;
const COPY_HIGHLIGHTS_KEY = "copyHighlights";
const READING_CODE_SELECTOR = ".markdown-rendered :not(pre) > code";
const READING_HIGHLIGHT_SELECTOR = ".markdown-rendered mark";
const EDITOR_CODE_SELECTOR = ".markdown-source-view.mod-cm6 .cm-inline-code";
const EDITOR_CONTENT_SELECTOR = ".cm-inline-code:not(.cm-formatting-code)";
const EDITOR_HIGHLIGHT_SELECTOR = ".markdown-source-view.mod-cm6 .cm-highlight";

interface WindowState {
  onClick: (event: MouseEvent) => void;
}

interface CopyTarget {
  text: string;
  elements: Element[];
}

interface FeedbackTimer {
  id: number;
  win: Window;
}

function inlineCodeTarget(target: Element): CopyTarget | null {
  const readingCode = target.closest(READING_CODE_SELECTOR);
  if (readingCode !== null) return { text: readingCode.textContent ?? "", elements: [readingCode] };

  const segment = target.closest(EDITOR_CODE_SELECTOR);
  if (segment === null) return null;

  // With the cursor inside inline code, CodeMirror exposes each backtick as
  // its own formatting span. Clicking either marker should still copy the
  // content between them, never the Markdown delimiters themselves.
  const content = segment.classList.contains("cm-formatting-code")
    ? [segment.previousElementSibling, segment.nextElementSibling].find((sibling) =>
        sibling?.matches(EDITOR_CONTENT_SELECTOR),
      )
    : segment;
  if (content === undefined || content === null) return null;

  const elements = [content];
  if (content.previousElementSibling?.matches(".cm-formatting-code.cm-inline-code")) {
    elements.unshift(content.previousElementSibling);
  }
  if (content.nextElementSibling?.matches(".cm-formatting-code.cm-inline-code")) {
    elements.push(content.nextElementSibling);
  }
  return { text: content.textContent ?? "", elements };
}

function highlightedTarget(target: Element): CopyTarget | null {
  const readingHighlight = target.closest(READING_HIGHLIGHT_SELECTOR);
  if (readingHighlight !== null) return { text: readingHighlight.textContent ?? "", elements: [readingHighlight] };

  const segment = target.closest(EDITOR_HIGHLIGHT_SELECTOR);
  if (segment === null) return null;

  // Nested Markdown splits one highlight into several top-level spans, with
  // empty CodeMirror widgets between them while the syntax is hidden. Walk
  // across only those invisible bridges, then concatenate semantic content
  // spans while excluding every revealed formatting marker (`==`, `**`, …).
  const adjacentHighlight = (from: Element, direction: "previous" | "next"): Element | null => {
    let node: ChildNode | null = direction === "previous" ? from.previousSibling : from.nextSibling;
    while (node !== null && node.textContent === "") {
      node = direction === "previous" ? node.previousSibling : node.nextSibling;
    }
    return node?.nodeType === Node.ELEMENT_NODE && (node as Element).matches(".cm-highlight")
      ? (node as Element)
      : null;
  };

  let first = segment;
  for (let previous = adjacentHighlight(first, "previous"); previous !== null;) {
    first = previous;
    previous = adjacentHighlight(first, "previous");
  }

  let text = "";
  const elements: Element[] = [];
  for (let part: Element | null = first; part !== null; part = adjacentHighlight(part, "next")) {
    elements.push(part);
    if (!part.classList.contains("cm-formatting")) text += part.textContent ?? "";
  }
  return { text, elements };
}

/**
 * Copies inline code on a primary click in reading mode and the editor.
 *
 * One delegated listener per Obsidian window covers existing and future
 * Markdown views without post-processors, MutationObservers, DOM scans or a
 * CodeMirror extension. The handler does constant work only after a click.
 * It deliberately leaves the event alone, so Live Preview still places the
 * caret normally and remains editable.
 */
export const inlineCodeCopy: Patch = {
  id: "inline-code-copy",
  name: "Copy inline code on click",
  description: "Copies inline code on click in the editor and reading mode, without adding buttons or controls.",

  register(plugin: Plugin, ctx: PatchContext): PatchHandle {
    const windows = new Map<Window, WindowState>();
    const feedbackTimers = new Map<Element, FeedbackTimer>();
    const copyHighlights = (): boolean => ctx.getConfig(COPY_HIGHLIGHTS_KEY, false);

    const showCopyFeedback = (win: Window, elements: Element[]): void => {
      for (const element of elements) {
        if (!element.isConnected) continue;
        const previous = feedbackTimers.get(element);
        if (previous) previous.win.clearTimeout(previous.id);

        element.classList.add(COPY_FEEDBACK_CLASS);
        const id = win.setTimeout(() => {
          element.classList.remove(COPY_FEEDBACK_CLASS);
          feedbackTimers.delete(element);
        }, COPY_FEEDBACK_MS);
        feedbackTimers.set(element, { id, win });
      }
    };

    const clearCopyFeedback = (win: Window): void => {
      for (const [element, timer] of feedbackTimers) {
        if (timer.win !== win) continue;
        timer.win.clearTimeout(timer.id);
        element.classList.remove(COPY_FEEDBACK_CLASS);
        feedbackTimers.delete(element);
      }
    };

    const applyState = (win: Window): void => {
      if (!windows.has(win)) return;
      const enabled = ctx.isEnabled();
      win.document.body.classList.toggle(INLINE_CODE_BODY_CLASS, enabled);
      win.document.body.classList.toggle(HIGHLIGHT_BODY_CLASS, enabled && copyHighlights());
    };

    const applyAll = (): void => {
      for (const win of windows.keys()) applyState(win);
    };

    const setupWindow = (win: Window): void => {
      if (windows.has(win)) return;

      const onClick = (event: MouseEvent): void => {
        if (!ctx.isEnabled() || event.button !== 0) return;
        const target = event.target as Element | null;
        if (target?.nodeType !== Node.ELEMENT_NODE) return;

        const copyTarget = inlineCodeTarget(target) ?? (copyHighlights() ? highlightedTarget(target) : null);
        if (copyTarget === null) return;

        void (async (): Promise<void> => {
          try {
            const clipboard = win.navigator.clipboard;
            if (clipboard?.writeText === undefined) throw new Error("Clipboard API is unavailable");
            await clipboard.writeText(copyTarget.text);
            showCopyFeedback(win, copyTarget.elements);
          } catch (error) {
            console.error("Micropatches (inline-code-copy): clipboard write failed", error);
          }
        })();
      };

      windows.set(win, { onClick });
      win.document.addEventListener("click", onClick);
      applyState(win);
    };

    const teardownWindow = (win: Window): void => {
      const state = windows.get(win);
      if (!state) return;
      windows.delete(win);

      try {
        clearCopyFeedback(win);
        win.document.removeEventListener("click", state.onClick);
        win.document.body?.classList.remove(INLINE_CODE_BODY_CLASS, HIGHLIGHT_BODY_CLASS);
      } catch (error) {
        console.error("Micropatches (inline-code-copy): teardown cleanup failed", error);
      }
    };

    setupWindow(window);
    plugin.registerEvent(
      plugin.app.workspace.on("window-open", (_workspaceWindow, win) => {
        setupWindow(win);
      }),
    );
    plugin.registerEvent(
      plugin.app.workspace.on("window-close", (_workspaceWindow, win) => {
        teardownWindow(win);
      }),
    );

    return {
      cleanup: (): void => {
        for (const win of Array.from(windows.keys())) teardownWindow(win);
      },
      onToggle: (): void => applyAll(),
      onConfigChange: (key: string): void => {
        if (key === COPY_HIGHLIGHTS_KEY) applyAll();
      },
    };
  },

  settingDefinitions(_ctx: PatchContext, key: (configKey: string) => string): SettingGroupItem[] {
    return [
      {
        name: "Copy highlighted text",
        desc: "Also copies ==highlighted text== on click. Off by default.",
        control: {
          type: "toggle",
          key: key(COPY_HIGHLIGHTS_KEY),
          defaultValue: false,
        },
      },
    ];
  },
};
