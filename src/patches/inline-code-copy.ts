import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { EditorView } from "@codemirror/view";
import { sanitizeHTMLToDom, type Plugin, type SettingGroupItem } from "obsidian";
import type { Patch, PatchContext, PatchHandle } from "../patch";

const INLINE_CODE_BODY_CLASS = "micropatches-inline-code-copy";
const HIGHLIGHT_BODY_CLASS = "micropatches-highlight-copy";
const BOLD_BODY_CLASS = "micropatches-bold-copy";
const ITALIC_BODY_CLASS = "micropatches-italic-copy";
const COPY_FEEDBACK_CLASS = "is-micropatches-copy-confirmed";
const COPY_FEEDBACK_MS = 160;
const MAX_FEEDBACK_ELEMENTS = 64;
const COPY_HIGHLIGHTS_KEY = "copyHighlights";
const COPY_BOLD_KEY = "copyBold";
const COPY_ITALIC_KEY = "copyItalic";
const READING_CODE_SELECTOR = ".markdown-rendered :not(pre) > code";
const EDITOR_CODE_SELECTOR = ".markdown-source-view.mod-cm6 .cm-inline-code";
const EDITOR_CONTENT_SELECTOR = ".cm-inline-code:not(.cm-formatting-code)";
const EDITOR_FORMAT_SELECTOR = ".markdown-source-view.mod-cm6 :is(.cm-highlight, .cm-strong, .cm-em)";
const INTERACTIVE_SELECTOR = "a, button, input, textarea, select, .cm-link, .cm-hmd-internal-link, .cm-url";

type Format = "highlight" | "strong" | "em";

const FORMATS: Array<{ format: Format; key: string; tag: string; bodyClass: string }> = [
  { format: "highlight", key: COPY_HIGHLIGHTS_KEY, tag: "mark", bodyClass: HIGHLIGHT_BODY_CLASS },
  { format: "strong", key: COPY_BOLD_KEY, tag: "strong", bodyClass: BOLD_BODY_CLASS },
  { format: "em", key: COPY_ITALIC_KEY, tag: "em", bodyClass: ITALIC_BODY_CLASS },
];

// The part of CodeMirror's SyntaxNode used here. Keeping the boundary walker
// independent of the editor lets tests exercise tokens captured from Obsidian.
interface FormatToken {
  name: string;
  from: number;
  to: number;
  prevSibling: FormatToken | null;
  nextSibling: FormatToken | null;
  parent?: FormatToken | null;
  firstChild?: FormatToken | null;
  lastChild?: FormatToken | null;
  html?: boolean;
}

interface TextSource {
  sliceString(from: number, to: number): string;
}

interface TextRange {
  from: number;
  to: number;
  text: string;
  complete: boolean;
}

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

// The element beside `from`, past only empty nodes such as widgets for
// hidden syntax; null if visible text comes first.
function adjacentElement(from: Element, direction: "previous" | "next"): Element | null {
  let node: ChildNode | null = direction === "previous" ? from.previousSibling : from.nextSibling;
  while (node !== null && node.textContent === "") {
    node = direction === "previous" ? node.previousSibling : node.nextSibling;
  }
  return node?.nodeType === Node.ELEMENT_NODE ? (node as Element) : null;
}

export function inlineCodeTarget(target: Element): CopyTarget | null {
  const readingCode = target.closest(READING_CODE_SELECTOR);
  if (readingCode !== null) return { text: readingCode.textContent, elements: [readingCode] };

  const segment = target.closest(EDITOR_CODE_SELECTOR);
  if (segment === null) return null;

  // With the cursor inside inline code, CodeMirror exposes each backtick as
  // its own formatting span. Clicking either marker should still copy the
  // content between them, never the Markdown delimiters themselves.
  // Only right beside it: the code before may have its backticks hidden,
  // with just a space between.
  const content = segment.classList.contains("cm-formatting-code")
    ? [adjacentElement(segment, "previous"), adjacentElement(segment, "next")].find(
        (sibling) => sibling?.matches(EDITOR_CONTENT_SELECTOR) === true,
      )
    : segment;
  if (content === undefined || content === null) return null;

  const elements = [content];
  const opening = adjacentElement(content, "previous");
  if (opening?.matches(".cm-formatting-code.cm-inline-code") === true) elements.unshift(opening);
  const closing = adjacentElement(content, "next");
  if (closing?.matches(".cm-formatting-code.cm-inline-code") === true) elements.push(closing);
  return { text: content.textContent, elements };
}

function hasFormat(node: FormatToken, format: Format): boolean {
  return node.name.split("_").includes(format);
}

function isBoundary(node: FormatToken, format: Format): boolean {
  const tags = node.name.split("_");
  // HyperMD represents *** and ___ as a strong marker with two em tags.
  return (
    tags.includes(`formatting-${format}`) ||
    (format === "em" && tags.includes("formatting-strong") && tags.filter((tag) => tag === "em").length === 2)
  );
}

function isContent(node: FormatToken): boolean {
  const tags = node.name.split("_");
  return (
    !tags.some((tag) => tag === "formatting" || tag.startsWith("formatting-")) &&
    !(tags.includes("url") && tags.includes("string")) &&
    !tags.includes("comment") &&
    !tags.includes("hmd-list-indent") &&
    !tags.includes("link-has-alias") &&
    !tags.includes("link-alias-pipe")
  );
}

function adjacentToken(node: FormatToken, direction: "previous" | "next"): FormatToken | null {
  let current = node;
  for (;;) {
    const sibling = direction === "previous" ? current.prevSibling : current.nextSibling;
    if (sibling !== null) {
      let leaf = sibling;
      for (;;) {
        const child = direction === "previous" ? leaf.lastChild : leaf.firstChild;
        if (child == null) return leaf;
        leaf = child;
      }
    }
    const parent = current.parent;
    if (parent == null || parent.name === "Document") return null;
    current = parent;
  }
}

function adjacentPart(
  node: FormatToken,
  direction: "previous" | "next",
  format: Format,
  deadline: number,
): FormatToken | null {
  const adjacent = adjacentToken(node, direction);
  if (adjacent === null) return null;
  if (!adjacent.name.includes("hmd-html-")) return adjacent;
  const opening = direction === "next" ? "hmd-html-begin" : "hmd-html-end";
  const closing = direction === "next" ? "hmd-html-end" : "hmd-html-begin";
  if (!adjacent.name.split("_").includes(opening)) return adjacent;

  // HyperMD suspends Markdown styles inside an HTML widget. Treat its whole
  // source range as one part, using Obsidian's sanitizer to read plain text.
  let depth = 1;
  let current = adjacent;
  let steps = 0;
  while (depth > 0) {
    const next = adjacentToken(current, direction);
    if (next === null || (++steps % 64 === 0 && performance.now() > deadline)) return null;
    const tags = next.name.split("_");
    if (tags.includes(opening)) depth++;
    if (tags.includes(closing)) depth--;
    current = next;
  }
  const first = direction === "next" ? adjacent : current;
  const last = direction === "next" ? current : adjacent;
  return {
    name: format,
    from: first.from,
    to: last.to,
    html: true,
    prevSibling: adjacentToken(first, "previous"),
    nextSibling: adjacentToken(last, "next"),
  };
}

/** Walk just the clicked formatted run in Obsidian's existing syntax tree. */
export function formattedTextRange(
  node: FormatToken,
  source: TextSource,
  format: Format,
  position = node.from,
  deadline = Infinity,
): TextRange | null {
  if (!hasFormat(node, format)) return null;
  const isPart = (part: FormatToken | null): part is FormatToken =>
    part !== null &&
    !isBoundary(part, format) &&
    (hasFormat(part, format) || part.name.split("_").includes("hmd-list-indent") || part.name === "link_url");
  const gap = (left: FormatToken, right: FormatToken): string => source.sliceString(left.to, right.from);
  const connected = (left: FormatToken, right: FormatToken): boolean => /^\n?$/.test(gap(left, right));
  const textOf = (part: FormatToken): string => {
    if (!isContent(part)) return "";
    const text = source.sliceString(part.from, part.to);
    return part.html === true ? sanitizeHTMLToDom(text).textContent : text;
  };

  let content = node;
  if (isBoundary(content, format)) {
    const previous = adjacentPart(content, "previous", format, deadline);
    const next = adjacentPart(content, "next", format, deadline);
    const marker = source.sliceString(content.from, content.to);
    // Adjacent differently delimited runs can share a token: **__ or *_ .
    const switchesMarker = /\*_|_\*/.exec(marker);
    const preferNext = switchesMarker !== null && position > content.from + switchesMarker.index;
    // HTML has no inherited Markdown styles in HyperMD's public tree. It can
    // bridge a known run, but cannot prove which side of a marker is formatted.
    if (!preferNext && isPart(previous) && previous.html !== true && previous.to === content.from) content = previous;
    else if ((switchesMarker === null || preferNext) && isPart(next) && next.html !== true && next.from === content.to)
      content = next;
    else return null;
  }
  if (!isPart(content)) return null;

  let first = content;
  let opened = false;
  let steps = 0;
  for (;;) {
    const previous = adjacentPart(first, "previous", format, deadline);
    if (!isPart(previous) || !connected(previous, first)) {
      opened = previous !== null && isBoundary(previous, format) && connected(previous, first);
      break;
    }
    if (++steps % 64 === 0 && performance.now() > deadline) return null;
    first = previous;
  }

  let last = first;
  let closed = false;
  let text = textOf(first);
  for (;;) {
    const next = adjacentPart(last, "next", format, deadline);
    if (!isPart(next) || !connected(last, next)) {
      closed = next !== null && isBoundary(next, format) && connected(last, next);
      break;
    }
    if (++steps % 64 === 0 && performance.now() > deadline) return null;
    text += gap(last, next);
    text += textOf(next);
    last = next;
  }
  return { from: first.from, to: last.to, text, complete: opened && closed };
}

export function formattedTarget(target: Element, formats: readonly Format[], event?: MouseEvent): CopyTarget | null {
  if (formats.length === 0 || target.closest("pre") !== null) return null;
  const selector = FORMATS.filter(({ format }) => formats.includes(format))
    .map(({ tag }) => `.markdown-rendered ${tag}`)
    .join(", ");
  const reading = target.closest(selector);
  if (reading !== null) return { text: reading.textContent, elements: [reading] };

  const segment = target.closest<HTMLElement>(EDITOR_FORMAT_SELECTOR);
  if (segment === null || !formats.some((format) => segment.classList.contains(`cm-${format}`))) return null;
  const view = EditorView.findFromDOM(segment);
  if (view === null) return null;
  const start = view.posAtDOM(segment);
  const end = view.posAtDOM(segment, segment.childNodes.length);
  const point =
    event === undefined || !segment.classList.contains("cm-formatting")
      ? null
      : view.posAtCoords({ x: event.clientX, y: event.clientY });
  const position = point !== null && point >= start && point < end ? point : start;
  let tree = syntaxTree(view.state);
  let range: TextRange | null = null;
  const deadline = performance.now() + 25;
  for (;;) {
    const node = tree.resolveInner(position, 1);
    range = null;
    for (const format of formats) {
      const candidate = formattedTextRange(node, view.state.doc, format, position, deadline);
      if (candidate !== null && (range === null || candidate.to - candidate.from < range.to - range.from))
        range = candidate;
    }
    if (range === null || performance.now() > deadline) return null;
    if (range.complete) break;
    // Stream parsers may also skip part of a very long line while reporting
    // the full document length. Only matching delimiters prove completeness.
    if (tree.length >= view.state.doc.length) return null;
    // A newly opened long note may only be partially parsed. Extend the
    // existing parse on demand; never copy a silently truncated fragment or
    // hold the UI indefinitely while parsing an enormous one.
    const remaining = deadline - performance.now();
    if (remaining <= 0) return null;
    const complete = ensureSyntaxTree(
      view.state,
      Math.min(view.state.doc.length, Math.max(tree.length * 2, tree.length + 4096)),
      remaining,
    );
    if (complete === null) return null;
    tree = complete;
  }

  // Read only visible intersections for feedback and cap DOM lookups. A long
  // line can mount thousands of spans; marking all of them would stall a click.
  const elements = new Set<Element>([segment]);
  let lookups = 0;
  for (const visible of view.visibleRanges) {
    const from = Math.max(range.from, visible.from);
    const to = Math.min(range.to, visible.to);
    if (from >= to || lookups >= MAX_FEEDBACK_ELEMENTS) continue;
    const cursor = tree.cursorAt(from, 1);
    do {
      if (cursor.from >= to || lookups >= MAX_FEEDBACK_ELEMENTS) break;
      if (cursor.from < from || cursor.to > to) continue;
      lookups++;
      const dom = view.domAtPos(cursor.from).node;
      const el = (dom.nodeType === Node.ELEMENT_NODE ? (dom as Element) : dom.parentElement)?.closest(
        EDITOR_FORMAT_SELECTOR,
      );
      if (el !== undefined && el !== null) elements.add(el);
    } while (cursor.next());
  }
  return { text: range.text, elements: Array.from(elements) };
}

/**
 * Copies inline code on a primary click in reading mode and the editor.
 *
 * One delegated listener per Obsidian window covers existing and future
 * Markdown views without post-processors, MutationObservers or a CodeMirror
 * extension. Only a clicked formatted fragment is read from the syntax tree.
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
    let formats = FORMATS.filter(({ key }) => ctx.getConfig<boolean>(key, false));
    let generation = 0;

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
      for (const { format, bodyClass } of FORMATS) {
        win.document.body.classList.toggle(bodyClass, enabled && formats.some((item) => item.format === format));
      }
    };

    const applyAll = (): void => {
      for (const win of windows.keys()) applyState(win);
    };

    const setupWindow = (win: Window): void => {
      if (windows.has(win)) return;

      const onClick = (event: MouseEvent): void => {
        if (
          !ctx.isEnabled() ||
          event.button !== 0 ||
          event.defaultPrevented ||
          event.detail > 1 ||
          event.shiftKey ||
          event.ctrlKey ||
          event.metaKey ||
          event.altKey ||
          win.getSelection()?.isCollapsed === false
        )
          return;
        const target = event.target as Element | null;
        if (target?.nodeType !== Node.ELEMENT_NODE) return;
        if (target.closest(INTERACTIVE_SELECTOR) !== null) return;

        const copyTarget =
          inlineCodeTarget(target) ??
          formattedTarget(
            target,
            formats.map(({ format }) => format),
            event,
          );
        if (copyTarget === null || copyTarget.text === "") return;
        const copyGeneration = generation;

        const copy = async (): Promise<void> => {
          const clipboard = win.navigator.clipboard as Clipboard | undefined;
          if (typeof clipboard?.writeText !== "function") throw new Error("Clipboard API is unavailable");
          await clipboard.writeText(copyTarget.text);
          if (generation === copyGeneration && windows.has(win) && ctx.isEnabled())
            showCopyFeedback(win, copyTarget.elements);
        };
        copy().catch((error: unknown) => {
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
        clearCopyFeedback(win);
        win.document.removeEventListener("click", state.onClick);
        (win.document.body as HTMLElement | null)?.classList.remove(
          INLINE_CODE_BODY_CLASS,
          ...FORMATS.map(({ bodyClass }) => bodyClass),
        );
      } catch (error) {
        console.error("Micropatches (inline-code-copy): teardown cleanup failed", error);
      }
    };

    setupWindow(window);
    // Popouts that were open before this loaded (the plugin enabled later)
    // fire no "window-open". Once unloaded, not even the main window is set up.
    plugin.app.workspace.onLayoutReady(() => {
      if (!windows.has(window)) return;
      plugin.app.workspace.iterateAllLeaves((leaf) => {
        setupWindow(leaf.view.containerEl.win);
      });
    });
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
        generation++;
        for (const win of Array.from(windows.keys())) teardownWindow(win);
      },
      onToggle: (): void => {
        generation++;
        for (const win of windows.keys()) clearCopyFeedback(win);
        applyAll();
      },
      onConfigChange: (key: string): void => {
        if (!FORMATS.some((format) => format.key === key)) return;
        generation++;
        formats = FORMATS.filter(({ key: configKey }) => ctx.getConfig<boolean>(configKey, false));
        for (const win of windows.keys()) clearCopyFeedback(win);
        applyAll();
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
      {
        name: "Copy bold text",
        desc: "Also copies **bold text** on click. Off by default.",
        control: { type: "toggle", key: key(COPY_BOLD_KEY), defaultValue: false },
      },
      {
        name: "Copy italic text",
        desc: "Also copies *italic text* on click. Off by default.",
        control: { type: "toggle", key: key(COPY_ITALIC_KEY), defaultValue: false },
      },
    ];
  },
};
