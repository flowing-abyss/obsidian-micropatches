import type { Plugin, SettingGroupItem } from "obsidian";
import type { Patch, PatchContext, PatchHandle } from "../patch";

const INLINE_CODE_BODY_CLASS = "micropatches-inline-code-copy";
const HIGHLIGHT_BODY_CLASS = "micropatches-highlight-copy";
const COPY_HIGHLIGHTS_KEY = "copyHighlights";
const READING_CODE_SELECTOR = ".markdown-rendered :not(pre) > code";
const READING_HIGHLIGHT_SELECTOR = ".markdown-rendered mark";
const EDITOR_CODE_SELECTOR = ".markdown-source-view.mod-cm6 .cm-inline-code";
const EDITOR_CONTENT_SELECTOR = ".cm-inline-code:not(.cm-formatting-code)";
const EDITOR_HIGHLIGHT_SELECTOR = ".markdown-source-view.mod-cm6 .cm-highlight";

interface WindowState {
  onClick: (event: MouseEvent) => void;
}

function inlineCodeText(target: Element): string | null {
  const readingCode = target.closest(READING_CODE_SELECTOR);
  if (readingCode !== null) return readingCode.textContent;

  const segment = target.closest(EDITOR_CODE_SELECTOR);
  if (segment === null) return null;
  if (!segment.classList.contains("cm-formatting-code")) return segment.textContent;

  // With the cursor inside inline code, CodeMirror exposes each backtick as
  // its own formatting span. Clicking either marker should still copy the
  // content between them, never the Markdown delimiters themselves.
  const next = segment.nextElementSibling;
  if (next?.matches(EDITOR_CONTENT_SELECTOR)) return next.textContent;
  const previous = segment.previousElementSibling;
  if (previous?.matches(EDITOR_CONTENT_SELECTOR)) return previous.textContent;
  return null;
}

function highlightedText(target: Element): string | null {
  const readingHighlight = target.closest(READING_HIGHLIGHT_SELECTOR);
  if (readingHighlight !== null) return readingHighlight.textContent;

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
  for (let part: Element | null = first; part !== null; part = adjacentHighlight(part, "next")) {
    if (!part.classList.contains("cm-formatting")) text += part.textContent ?? "";
  }
  return text;
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
    const copyHighlights = (): boolean => ctx.getConfig(COPY_HIGHLIGHTS_KEY, false);

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

        const text = inlineCodeText(target) ?? (copyHighlights() ? highlightedText(target) : null);
        if (text === null) return;

        void win.navigator.clipboard.writeText(text).catch((error: unknown) => {
          console.error("Micropatches (inline-code-copy): clipboard write failed", error);
        });
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
