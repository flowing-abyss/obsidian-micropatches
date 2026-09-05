import {
  Component,
  editorInfoField,
  editorLivePreviewField,
  MarkdownRenderChild,
  MarkdownRenderer,
  MarkdownView,
  Notice,
  TFile,
} from "obsidian";
import type { MarkdownPostProcessorContext, Plugin, SettingGroupItem } from "obsidian";
import {
  Decoration,
  ViewPlugin,
  WidgetType,
  type DecorationSet,
  type EditorView,
  type ViewUpdate,
} from "@codemirror/view";
import { syntaxTree } from "@codemirror/language";
import type { EditorState } from "@codemirror/state";
import type { Patch, PatchContext, PatchHandle } from "../patch";

type Side = "left" | "right";

interface FootnoteDefinition {
  id: string;
  text: string;
  from: number;
  to: number;
}

interface WindowState {
  style: HTMLStyleElement;
  onResize: () => void;
  mountObserver: MutationObserver;
  pendingMounts: Set<HTMLElement>;
}

interface LayoutCandidate {
  note: HTMLElement;
  top: number;
  bottom: number;
  baseY: number;
}

interface LayoutPlan {
  note: HTMLElement;
  top: number;
  baseY: number;
  width: number;
  x: number;
}

interface ParsedFootnotes {
  definitions: Map<string, FootnoteDefinition>;
  references: FootnoteReference[];
  order: string[];
  idsByLength: string[];
  numberById: Map<string, number>;
}

interface FootnoteReference {
  id: string;
  from: number;
  to: number;
}

interface SourceRange {
  from: number;
  to: number;
}

interface MarkdownLine {
  from: number;
  content: string;
  excluded: boolean;
}

const SIDE_KEY = "side";
const DISTANCE_KEY = "distance";
const DEFAULT_SIDE: Side = "left";
const DEFAULT_DISTANCE = 32;
const MAX_DISTANCE = 240;
const STYLE_ID = "micropatches-footnote-sidenotes-style";
const ANCHOR_CLASS = "micropatches-footnote-anchor";
const NOTE_CLASS = "micropatches-footnote-sidenote";
const NUMBER_CLASS = "micropatches-footnote-number";
const RENDERED_CLASS = "micropatches-footnote-rendered";
const RENDERING_CLASS = "is-rendering";
const VISIBLE_CLASS = "is-visible";
const COLLAPSED_CLASS = "is-collapsed";
const PEEKED_CLASS = "is-peeked";
const PINNED_CLASS = "is-pinned";
const MIN_WIDTH = 152;
const MAX_WIDTH = 244;
const EDGE_GAP = 10;
const VERTICAL_GAP = 8;
const COLLAPSED_GAP = 3;
const COLLAPSED_HEIGHT_EM = 1.55;
let nextContentId = 0;

// Kept here, rather than in the plugin-wide stylesheet, so the patch remains
// one self-contained file: behaviour, presentation and teardown travel
// together and disabling it leaves no CSS state behind in any popout window.
const CSS = `
.${ANCHOR_CLASS} {
  position: relative;
}

.cm-line .${ANCHOR_CLASS} {
  display: inline-block;
  width: 0;
  height: 0;
  vertical-align: baseline;
}

.${NOTE_CLASS} {
  position: absolute;
  top: 0;
  left: 0;
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  column-gap: 0.25em;
  align-items: start;
  box-sizing: border-box;
  width: var(--micropatches-footnote-width);
  margin: 0;
  padding: 0;
  color: var(--text-muted);
  font-family: var(--font-text);
  font-size: calc(var(--font-text-size, 16px) * 0.78);
  font-style: normal;
  font-weight: var(--font-normal);
  line-height: 1.35;
  text-align: left;
  overflow-wrap: anywhere;
  transform: translate(var(--micropatches-footnote-x), var(--micropatches-footnote-y));
  visibility: hidden;
  pointer-events: none;
  z-index: var(--layer-popover, 30);
}

.${NOTE_CLASS}.${VISIBLE_CLASS} {
  visibility: visible;
  pointer-events: auto;
}

/* A collision group becomes a compact citation rail. Every reference stays
   discoverable; peeking or pinning one row makes room for its full text. */
.${NOTE_CLASS}.${COLLAPSED_CLASS} {
  align-items: baseline;
  height: max(24px, ${COLLAPSED_HEIGHT_EM}em);
  overflow: hidden;
  white-space: nowrap;
}

.${NUMBER_CLASS} {
  all: unset;
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  min-height: 24px;
  margin-inline-end: 0;
  border: 0 !important;
  border-radius: 2px;
  padding: 0;
  background: transparent !important;
  color: var(--text-faint);
  box-shadow: none !important;
  cursor: pointer;
  font: inherit;
  font-variant-numeric: tabular-nums;
  font-weight: var(--font-semibold);
  line-height: inherit;
}

.${NUMBER_CLASS}:hover {
  color: var(--text-normal);
}

.${NUMBER_CLASS}:disabled {
  color: var(--text-faint);
  cursor: default;
}

.${NUMBER_CLASS}:focus-visible {
  border-radius: 2px;
  outline: 1px solid var(--background-modifier-border-focus);
  outline-offset: 2px;
}

.${NOTE_CLASS}.${COLLAPSED_CLASS} > .micropatches-footnote-content {
  display: block;
  min-width: 0;
  overflow: hidden;
  text-align: left;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.${NOTE_CLASS}.${COLLAPSED_CLASS}.${PEEKED_CLASS},
.${NOTE_CLASS}.${COLLAPSED_CLASS}.${PINNED_CLASS},
.${NOTE_CLASS}.${COLLAPSED_CLASS}.is-editing {
  display: grid;
  grid-template-columns: 24px minmax(0, 1fr);
  column-gap: 0.25em;
  align-items: start;
  height: auto;
  overflow: visible;
  background: var(--background-primary);
  box-shadow: 0 0 0 2px var(--background-primary);
  white-space: normal;
  z-index: calc(var(--layer-popover, 30) + 1);
}

.${NOTE_CLASS}.${COLLAPSED_CLASS}.${PEEKED_CLASS} > .micropatches-footnote-content,
.${NOTE_CLASS}.${COLLAPSED_CLASS}.${PINNED_CLASS} > .micropatches-footnote-content,
.${NOTE_CLASS}.${COLLAPSED_CLASS}.is-editing > .micropatches-footnote-content {
  display: block;
  min-width: 0;
  overflow: visible;
  text-align: inherit;
  white-space: normal;
}

.${NOTE_CLASS} > .micropatches-footnote-content {
  display: block;
  min-width: 0;
}

.${NOTE_CLASS} > .micropatches-footnote-content a,
.${NOTE_CLASS} > .micropatches-footnote-content a:hover,
.${NOTE_CLASS} > .micropatches-footnote-content a:visited {
  color: var(--link-color);
  font: inherit;
  text-decoration-line: underline;
  text-decoration-style: solid;
  text-decoration-color: currentColor;
  text-decoration-thickness: from-font;
  text-underline-offset: 0.12em;
}

.${NOTE_CLASS} > .micropatches-footnote-content a.external-link,
.${NOTE_CLASS} > .micropatches-footnote-content a.external-link:hover,
.${NOTE_CLASS} > .micropatches-footnote-content a.external-link:visited {
  color: var(--link-external-color, var(--link-color));
}

.${RENDERED_CLASS} {
  display: contents;
}

.${RENDERED_CLASS}.${RENDERING_CLASS} {
  visibility: hidden;
  pointer-events: none;
}

.${NOTE_CLASS} > .micropatches-footnote-content > .${RENDERED_CLASS} > :first-child {
  display: inline;
  margin-top: 0;
}

.${NOTE_CLASS} > .micropatches-footnote-content > .${RENDERED_CLASS} > :last-child {
  margin-bottom: 0;
}

.${NOTE_CLASS}:hover,
.${NOTE_CLASS}.is-editing {
  color: var(--text-normal);
}

.${NOTE_CLASS} textarea {
  display: block;
  width: 100%;
  min-height: 3.2em;
  resize: vertical;
  border: 1px solid var(--background-modifier-border-focus);
  border-radius: var(--radius-s, 4px);
  padding: 0.35em 0.45em;
  background: var(--background-primary);
  color: var(--text-normal);
  font: inherit;
  line-height: inherit;
  text-align: start;
  outline: none;
}

/* Callouts clip their contents to preserve rounded corners. Only relax that
   clipping for a callout that actually owns a sidenote escaping into a margin. */
.markdown-reading-view .callout:has(.${NOTE_CLASS}),
.markdown-reading-view .callout:has(.${NOTE_CLASS}) .callout-content {
  overflow: visible !important;
}

`;

function isSide(value: unknown): value is Side {
  return value === "left" || value === "right";
}

function configuredDistance(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_DISTANCE;
  return Math.min(MAX_DISTANCE, Math.max(0, value));
}

function markdownLines(source: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let from = 0;
  let firstLine = true;
  let inFrontmatter = false;
  let fence: { marker: "`" | "~"; length: number } | null = null;
  let inHtmlComment = false;
  let inObsidianComment = false;

  while (from < source.length) {
    const newline = source.indexOf("\n", from);
    const rawEnd = newline === -1 ? source.length : newline;
    const contentEnd = rawEnd > from && source.charCodeAt(rawEnd - 1) === 13 ? rawEnd - 1 : rawEnd;
    const content = source.slice(from, contentEnd);
    const normalized = firstLine ? content.replace(/^\uFEFF/, "") : content;
    let excluded = false;

    if (firstLine && normalized.trim() === "---") {
      inFrontmatter = true;
      excluded = true;
    } else if (inFrontmatter) {
      excluded = true;
      if (/^(?:---|\.\.\.)[ \t]*$/.test(normalized)) inFrontmatter = false;
    } else if (fence !== null) {
      excluded = true;
      const closing = normalized.match(/^ {0,3}(`+|~+)[ \t]*$/)?.[1];
      if (closing !== undefined && closing[0] === fence.marker && closing.length >= fence.length) fence = null;
    } else {
      const opening = normalized.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
      if (opening !== undefined) {
        fence = { marker: opening[0] as "`" | "~", length: opening.length };
        excluded = true;
      } else {
        excluded = inHtmlComment || inObsidianComment;
        const htmlOpens = normalized.indexOf("<!--");
        const htmlCloses = normalized.indexOf("-->", htmlOpens === -1 ? 0 : htmlOpens + 4);
        if (inHtmlComment) inHtmlComment = htmlCloses === -1;
        else if (htmlOpens !== -1 && htmlCloses === -1) inHtmlComment = true;

        const obsidianMarker = normalized.indexOf("%%");
        if (inObsidianComment) inObsidianComment = obsidianMarker === -1;
        else if (obsidianMarker !== -1 && normalized.indexOf("%%", obsidianMarker + 2) === -1) {
          inObsidianComment = true;
        }
      }
    }

    lines.push({ from, content, excluded });
    firstLine = false;
    if (newline === -1) break;
    from = newline + 1;
  }
  return lines;
}

function inlineCodeRanges(lines: MarkdownLine[]): SourceRange[] {
  const runs: Array<SourceRange & { length: number; segment: number }> = [];
  let segment = 0;
  for (const line of lines) {
    if (line.excluded || line.content.trim() === "") {
      segment++;
      continue;
    }
    let index = 0;
    while (index < line.content.length) {
      if (line.content[index] !== "`" || isEscaped(line.content, index)) {
        index++;
        continue;
      }
      const opening = index;
      while (line.content[index] === "`") index++;
      runs.push({ from: line.from + opening, to: line.from + index, length: index - opening, segment });
    }
  }

  const nextWithLength = new Array<number | undefined>(runs.length);
  const nextByDelimiter = new Map<string, number>();
  for (let index = runs.length - 1; index >= 0; index--) {
    const run = runs[index];
    if (run === undefined) continue;
    const delimiter = `${run.segment}:${run.length}`;
    nextWithLength[index] = nextByDelimiter.get(delimiter);
    nextByDelimiter.set(delimiter, index);
  }

  const ranges: SourceRange[] = [];
  for (let index = 0; index < runs.length;) {
    const opening = runs[index];
    const closingIndex = nextWithLength[index];
    if (opening === undefined || closingIndex === undefined) {
      index++;
      continue;
    }
    const closing = runs[closingIndex];
    if (closing === undefined) {
      index++;
      continue;
    }
    ranges.push({ from: opening.from, to: closing.to });
    index = closingIndex + 1;
  }
  return ranges;
}

function parseDefinitionsFromLines(lines: MarkdownLine[]): Map<string, FootnoteDefinition> {
  const definitions = new Map<string, FootnoteDefinition>();
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    if (line === undefined || line.excluded) continue;
    const match = line.content.match(/^(\[\^([^\]\r\n]+)\]:[ \t]*)(.*)$/);
    if (match === null) continue;
    const prefix = match[1];
    const id = match[2];
    const firstBodyLine = match[3];
    if (prefix === undefined || id === undefined || firstBodyLine === undefined) continue;

    const bodyLines = [firstBodyLine];
    let to = line.from + line.content.length;
    let pendingBlankLines = 0;
    for (let continuationIndex = index + 1; continuationIndex < lines.length; continuationIndex++) {
      const continuation = lines[continuationIndex];
      if (continuation === undefined || continuation.excluded) break;
      if (continuation.content.trim() === "") {
        pendingBlankLines++;
        continue;
      }
      if (!/^[ \t]/.test(continuation.content)) break;
      while (pendingBlankLines > 0) {
        bodyLines.push("");
        pendingBlankLines--;
      }
      bodyLines.push(continuation.content.replace(/^(?:\t| {1,4})/, ""));
      to = continuation.from + continuation.content.length;
      index = continuationIndex;
    }

    definitions.set(id, {
      id,
      text: bodyLines.join("\n").trim(),
      from: line.from + prefix.length,
      to,
    });
  }
  return definitions;
}

function parseDefinitions(source: string): Map<string, FootnoteDefinition> {
  return parseDefinitionsFromLines(markdownLines(source));
}

function referencesFromLines(lines: MarkdownLine[], definitions: Map<string, FootnoteDefinition>): FootnoteReference[] {
  const references: FootnoteReference[] = [];
  const codeRanges = inlineCodeRanges(lines);
  for (const line of lines) {
    if (line.excluded) continue;
    const pattern = /\[\^([^\]\r\n]+)\](?!:)/g;
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(line.content)) !== null) {
      const id = match[1];
      const from = line.from + match.index;
      if (id === undefined || !definitions.has(id) || positionInRanges(from, codeRanges)) continue;
      references.push({ id, from, to: from + match[0].length });
    }
  }
  return references;
}

function parsedFootnotes(source: string, excludedAt?: (position: number) => boolean): ParsedFootnotes {
  const lines = markdownLines(source);
  // Definition markers are already filtered at line level. Their body may
  // legitimately begin with inline code or an escaped character, so applying
  // syntax exclusions to the body offset would discard a valid definition.
  const definitions = parseDefinitionsFromLines(lines);
  const parsedReferences = referencesFromLines(lines, definitions);
  const references =
    excludedAt === undefined ? parsedReferences : parsedReferences.filter((reference) => !excludedAt(reference.from));
  const order = Array.from(new Set(references.map((reference) => reference.id)));
  return {
    definitions,
    references,
    order,
    idsByLength: Array.from(definitions.keys()).sort((a, b) => b.length - a.length),
    numberById: new Map(order.map((id, index) => [id, index + 1])),
  };
}

function syntaxExclusions(state: EditorState): SourceRange[] {
  const ranges: SourceRange[] = [];
  syntaxTree(state).iterate({
    enter(node) {
      const name = node.name.toLowerCase();
      if (
        name.includes("code") ||
        name.includes("comment") ||
        name.includes("frontmatter") ||
        name.includes("escape")
      ) {
        ranges.push({ from: node.from, to: node.to });
        return false;
      }
      return undefined;
    },
  });
  return ranges.sort((a, b) => a.from - b.from);
}

function positionInRanges(position: number, ranges: SourceRange[]): boolean {
  let low = 0;
  let high = ranges.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1;
    const range = ranges[middle];
    if (range === undefined) return false;
    if (position < range.from) high = middle - 1;
    else if (position >= range.to) low = middle + 1;
    else return true;
  }
  return false;
}

function isEscaped(source: string, position: number): boolean {
  let slashes = 0;
  for (let index = position - 1; index >= 0 && source[index] === "\\"; index--) slashes++;
  return slashes % 2 === 1;
}

function serializeDefinition(text: string): string {
  return text.replace(/\r/g, "").trim().split("\n").join("\n    ");
}

function isLivePreview(state: EditorState): boolean {
  return state.field(editorLivePreviewField, false) !== false;
}

function clearElement(element: HTMLElement): void {
  while (element.firstChild !== null) element.firstChild.remove();
}

function createHtmlElement<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K): HTMLElementTagNameMap[K] {
  // Unlike Obsidian's global helpers, the document is explicit, so elements
  // are created in the correct realm when the editor lives in a popout.
  return doc.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElementTagNameMap[K];
}

function contentBlock(anchor: HTMLElement): HTMLElement | null {
  const line = anchor.closest<HTMLElement>(".cm-line");
  if (line !== null) return line;

  const preview = anchor.closest<HTMLElement>(".markdown-preview-sizer");
  if (preview === null) return anchor.parentElement;
  let block = anchor;
  while (block.parentElement !== null && block.parentElement !== preview) {
    if (block.parentElement.classList.contains("markdown-preview-section")) break;
    block = block.parentElement;
  }
  return block;
}

function collapsedRowHeight(note: HTMLElement): number {
  const win = note.ownerDocument.defaultView;
  const fontSize = Number.parseFloat(win?.getComputedStyle(note).fontSize ?? "");
  return Math.max(24, (Number.isFinite(fontSize) ? fontSize : 13) * COLLAPSED_HEIGHT_EM);
}

function isOpen(note: HTMLElement): boolean {
  return (
    note.classList.contains(PEEKED_CLASS) ||
    note.classList.contains(PINNED_CLASS) ||
    note.classList.contains("is-editing")
  );
}

function stackedBottom(group: LayoutCandidate[], rowHeight: number): number {
  let bottom = group[0]?.top ?? 0;
  for (const candidate of group) {
    const top = Math.max(candidate.top, bottom);
    bottom = top + (isOpen(candidate.note) ? candidate.bottom - candidate.top : rowHeight) + COLLAPSED_GAP;
  }
  return bottom - COLLAPSED_GAP;
}

function syncPinControl(note: HTMLElement, pinned: boolean): void {
  const button = note.querySelector<HTMLButtonElement>(`.${NUMBER_CLASS}`);
  if (button === null) return;
  const number = note.dataset["number"] ?? "";
  const expandable = note.classList.contains(COLLAPSED_CLASS);
  button.disabled = !expandable;
  button.tabIndex = expandable ? 0 : -1;
  if (!expandable) {
    button.removeAttribute("aria-expanded");
    button.setAttribute("aria-label", `Footnote ${number}`);
    button.removeAttribute("title");
    return;
  }
  button.setAttribute("aria-expanded", String(pinned));
  button.setAttribute("aria-label", `${pinned ? "Collapse" : "Keep open"} footnote ${number}`);
  button.title = pinned ? "Collapse footnote" : "Keep footnote open";
}

function layoutRoot(
  root: HTMLElement,
  side: Side,
  distance: number,
  enabled: boolean,
  pinned: (note: HTMLElement) => boolean,
): void {
  const mountedNotes = Array.from(root.querySelectorAll<HTMLElement>(`.${NOTE_CLASS}`)).filter(
    (note) => note.parentElement?.closest(`.${NOTE_CLASS}`) === null,
  );
  for (const note of mountedNotes) {
    note.classList.remove(VISIBLE_CLASS, COLLAPSED_CLASS);
    const isPinned = pinned(note);
    note.classList.toggle(PINNED_CLASS, isPinned);
  }
  // Reading mode runs postprocessors per rendered section, so a repeated
  // reference can be mounted more than once. Keep the first source occurrence
  // as the sidenote and leave later backlinks inline without duplicating text.
  const seenFootnotes = new Set<string>();
  const notes = mountedNotes.filter((note) => {
    const number = note.dataset["number"] ?? "";
    const sourcePath = note.dataset["sourcePath"];
    const footnoteId = note.dataset["footnoteId"];
    const identity =
      sourcePath !== undefined && footnoteId !== undefined ? `${sourcePath}\u0000${footnoteId}` : `number:${number}`;
    if (seenFootnotes.has(identity)) return false;
    seenFootnotes.add(identity);
    return true;
  });
  if (!enabled || notes.length === 0) return;

  const viewport =
    root.querySelector<HTMLElement>(":scope > .cm-scroller") ??
    root.querySelector<HTMLElement>(".cm-scroller") ??
    root.querySelector<HTMLElement>(".markdown-preview-view") ??
    root;
  const viewportRect = viewport.getBoundingClientRect();
  const plans: LayoutPlan[] = [];

  // Read anchor geometry first, then mutate every note, then measure every
  // result. This keeps one crowded paragraph from forcing a layout per note.
  for (const note of notes) {
    const anchor = note.parentElement;
    if (anchor === null || !anchor.isConnected) continue;
    const block = contentBlock(anchor);
    if (block === null) continue;

    const anchorRect = anchor.getBoundingClientRect();
    const blockRect = block.getBoundingClientRect();
    const available = side === "left" ? blockRect.left - viewportRect.left : viewportRect.right - blockRect.right;
    const width = Math.min(MAX_WIDTH, Math.floor(available - distance - EDGE_GAP));
    if (width < MIN_WIDTH) continue;

    const targetLeft = side === "left" ? blockRect.left - distance - width : blockRect.right + distance;
    const baseY = blockRect.top - anchorRect.top;
    plans.push({ note, top: blockRect.top, baseY, width, x: targetLeft - anchorRect.left });
  }

  for (const plan of plans) {
    const { note } = plan;
    note.dataset["side"] = side;
    note.style.setProperty("--micropatches-footnote-width", `${plan.width}px`);
    note.style.setProperty("--micropatches-footnote-x", `${plan.x}px`);
    note.style.setProperty("--micropatches-footnote-y", `${plan.baseY}px`);
    note.classList.add(VISIBLE_CLASS);
  }

  const candidates: LayoutCandidate[] = [];
  const outsidePane: HTMLElement[] = [];
  for (const plan of plans) {
    const { note } = plan;
    const noteRect = note.getBoundingClientRect();
    // Themes can add unexpected padding or transforms. Treat a note that
    // escapes the actual pane as not fitting rather than letting it overlap UI.
    if (noteRect.left < viewportRect.left + EDGE_GAP || noteRect.right > viewportRect.right - EDGE_GAP) {
      outsidePane.push(note);
      continue;
    }
    candidates.push({ note, top: plan.top, bottom: plan.top + noteRect.height, baseY: plan.baseY });
  }
  for (const note of outsidePane) note.classList.remove(VISIBLE_CLASS);

  // CodeMirror may mount widgets in viewport order rather than source order.
  // The owning block supplies stable geometry; footnote numbers break ties in
  // the same position using the order of first occurrence in the source.
  candidates.sort((a, b) => {
    const topDelta = a.top - b.top;
    if (Math.abs(topDelta) >= 0.5) return topDelta;
    return Number.parseInt(a.note.dataset["number"] ?? "", 10) - Number.parseInt(b.note.dataset["number"] ?? "", 10);
  });
  const rowHeight = candidates[0] === undefined ? 0 : collapsedRowHeight(candidates[0].note);
  const groups: LayoutCandidate[][] = [];
  let index = 0;
  while (index < candidates.length) {
    const first = candidates[index];
    if (first === undefined) break;
    const group = [first];
    index++;

    while (index < candidates.length) {
      const next = candidates[index];
      if (next === undefined) break;
      const occupiedBottom = group.length === 1 ? first.bottom : stackedBottom(group, rowHeight);
      if (next.top >= occupiedBottom + VERTICAL_GAP) break;
      group.push(next);
      index++;
    }

    if (group.length === 1) continue;

    groups.push(group);
    for (const candidate of group) candidate.note.classList.add(COLLAPSED_CLASS);
  }

  // The expanded grid can be a little taller than the note's natural inline
  // rendering (for example because its fixed number column creates one more
  // wrapped line). Measure after every group has received its final display
  // mode, otherwise the following compact row can be placed underneath it.
  const openHeights = new Map<HTMLElement, number>();
  for (const group of groups) {
    for (const candidate of group) {
      if (isOpen(candidate.note)) openHeights.set(candidate.note, candidate.note.getBoundingClientRect().height);
    }
  }

  for (const group of groups) {
    const first = group[0];
    if (first === undefined) continue;
    let occupiedBottom = first.top;
    for (const candidate of group) {
      const targetTop = Math.max(candidate.top, occupiedBottom);
      const y = candidate.baseY + targetTop - candidate.top;
      candidate.note.style.setProperty("--micropatches-footnote-y", `${Math.round(y)}px`);
      const height = isOpen(candidate.note)
        ? (openHeights.get(candidate.note) ?? candidate.bottom - candidate.top)
        : rowHeight;
      occupiedBottom = targetTop + height + COLLAPSED_GAP;
    }
  }

  for (const note of mountedNotes) syncPinControl(note, pinned(note));
}

function resolveRenderedId(sup: HTMLElement, order: string[], idsByLength: string[]): string | null {
  const anchor = sup.querySelector<HTMLAnchorElement>("a");
  const rawCandidates = [
    anchor?.dataset["footref"] ?? "",
    sup.dataset["footnoteId"] ?? "",
    sup.id.replace(/^fnref-/, ""),
    (anchor?.getAttribute("href") ?? "").replace(/^#fn-/, ""),
  ];
  // Rendered IDs may carry a per-render hash suffix. Longest-first avoids
  // resolving `note-long-hash` to a shorter `note` definition.
  for (const raw of rawCandidates) {
    for (const id of idsByLength) {
      if (raw === id || raw.startsWith(`${id}-`)) return id;
    }
  }

  const displayed = Number.parseInt(sup.textContent?.match(/\d+/)?.[0] ?? "", 10);
  return Number.isFinite(displayed) ? (order[displayed - 1] ?? null) : null;
}

function renderedFootnoteNumber(sup: HTMLElement): number | null {
  const displayed = Number.parseInt(sup.querySelector("a")?.textContent?.match(/\d+/)?.[0] ?? "", 10);
  return Number.isFinite(displayed) ? displayed : null;
}

function makeNote(
  ownerDocument: Document,
  number: string,
): { note: HTMLElement; numberButton: HTMLButtonElement; content: HTMLElement } {
  const note = createHtmlElement(ownerDocument, "small");
  note.className = NOTE_CLASS;
  note.dataset["number"] = number;
  const numberButton = createHtmlElement(ownerDocument, "button");
  numberButton.type = "button";
  numberButton.className = NUMBER_CLASS;
  numberButton.textContent = number;
  numberButton.disabled = true;
  numberButton.tabIndex = -1;
  numberButton.setAttribute("aria-label", `Footnote ${number}`);
  const content = createHtmlElement(ownerDocument, "span");
  content.className = "micropatches-footnote-content markdown-rendered";
  content.id = `micropatches-footnote-content-${++nextContentId}`;
  numberButton.setAttribute("aria-controls", content.id);
  note.append(numberButton, content);
  return { note, numberButton, content };
}

type SetupNote = (note: HTMLElement, numberButton: HTMLButtonElement, sourcePath: string, id: string) => void;

function editorSourcePath(state: EditorState): string {
  return state.field(editorInfoField, false)?.file?.path ?? "";
}

interface NoteRenderer {
  render: (text: string) => Promise<void>;
  cancel: () => void;
}

function createNoteRenderer(
  plugin: Plugin,
  host: Component,
  content: HTMLElement,
  sourcePath: string,
  scheduleLayout: () => void,
): NoteRenderer {
  const children = new Set<MarkdownRenderChild>();
  let generation = 0;

  const cancel = (): void => {
    generation++;
    for (const child of children) host.removeChild(child);
    children.clear();
  };

  const render = (text: string): Promise<void> => {
    cancel();
    clearElement(content);
    const currentGeneration = generation;
    const staging = createHtmlElement(content.ownerDocument, "span");
    staging.className = `${RENDERED_CLASS} ${RENDERING_CLASS}`;
    content.appendChild(staging);
    const child = host.addChild(new MarkdownRenderChild(staging));
    children.add(child);
    return MarkdownRenderer.render(plugin.app, text, staging, sourcePath, child)
      .then(
        () => {
          if (generation !== currentGeneration) return;
          staging.classList.remove(RENDERING_CLASS);
        },
        () => {
          if (generation !== currentGeneration) return;
          if (children.delete(child)) host.removeChild(child);
          clearElement(staging);
          staging.textContent = text;
          staging.classList.remove(RENDERING_CLASS);
        },
      )
      .then(() => {
        if (generation !== currentGeneration) {
          if (children.delete(child)) host.removeChild(child);
          return;
        }
        scheduleLayout();
      });
  };

  return { render, cancel };
}

interface InlineEditorOptions {
  note: HTMLElement;
  content: HTMLElement;
  id: string;
  text: string;
  scheduleLayout: () => void;
  cancelRender: () => void;
  render: (text: string) => void;
  commit: (replacement: string) => void | Promise<unknown>;
  preventMouseDownDefault?: boolean;
  respectSelection?: boolean;
}

function attachInlineEditor(options: InlineEditorOptions): void {
  const { note, content } = options;
  let currentText = options.text;
  let editing = false;
  let commitGeneration = 0;

  const beginEdit = (event: Event): void => {
    if (editing) {
      event.stopPropagation();
      return;
    }
    if ((event.target as Element | null)?.closest("a") !== null) return;
    const selection = note.ownerDocument.getSelection();
    if (
      options.respectSelection === true &&
      selection !== null &&
      !selection.isCollapsed &&
      selection.rangeCount > 0 &&
      selection.getRangeAt(0).intersectsNode(content)
    ) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    editing = true;
    note.classList.add("is-editing");
    options.cancelRender();
    clearElement(content);

    const textarea = createHtmlElement(note.ownerDocument, "textarea");
    textarea.value = currentText;
    textarea.setAttribute("aria-label", `Edit footnote ${options.id}`);
    content.appendChild(textarea);
    options.scheduleLayout();

    let finished = false;
    const finish = (shouldCommit: boolean): void => {
      if (finished) return;
      finished = true;
      editing = false;
      note.classList.remove("is-editing");
      const previousText = currentText;
      const nextText = textarea.value.trim();
      const replacement = serializeDefinition(nextText);
      if (!shouldCommit || replacement === serializeDefinition(previousText)) {
        options.render(previousText);
        return;
      }

      currentText = nextText;
      options.render(currentText);
      const currentCommit = ++commitGeneration;
      try {
        void Promise.resolve(options.commit(replacement)).catch(() => {
          if (currentCommit !== commitGeneration) return;
          currentText = previousText;
          if (note.isConnected) options.render(previousText);
          new Notice("Could not update the footnote.");
        });
      } catch {
        if (currentCommit !== commitGeneration) return;
        currentText = previousText;
        if (note.isConnected) options.render(previousText);
        new Notice("Could not update the footnote.");
      }
    };

    textarea.addEventListener("blur", () => finish(true), { once: true });
    textarea.addEventListener("keydown", (keyEvent) => {
      keyEvent.stopPropagation();
      if (keyEvent.key === "Escape") {
        keyEvent.preventDefault();
        finish(false);
      } else if (keyEvent.key === "Enter" && (keyEvent.metaKey || keyEvent.ctrlKey)) {
        keyEvent.preventDefault();
        finish(true);
      }
    });
    textarea.addEventListener("input", options.scheduleLayout);
    textarea.focus();
    textarea.select();
  };

  if (options.preventMouseDownDefault === true) {
    content.addEventListener("mousedown", (event) => {
      if ((event.target as Element | null)?.closest("a") !== null) return;
      event.stopPropagation();
      if ((event.target as Element | null)?.closest("textarea") === null) event.preventDefault();
    });
  }
  content.addEventListener("click", beginEdit);
}

class FootnoteWidget extends WidgetType {
  private renderer: NoteRenderer | null = null;

  constructor(
    private readonly plugin: Plugin,
    private readonly id: string,
    private readonly text: string,
    private readonly number: string,
    private readonly sourcePath: string,
    private readonly scheduleLayout: (win: Window) => void,
    private readonly setupNote: SetupNote,
  ) {
    super();
  }

  override toDOM(view: EditorView): HTMLElement {
    const doc = view.dom.ownerDocument;
    const anchor = createHtmlElement(doc, "span");
    anchor.className = ANCHOR_CLASS;
    const { note, numberButton, content } = makeNote(doc, this.number);
    anchor.appendChild(note);
    this.setupNote(note, numberButton, this.sourcePath, this.id);

    const renderer = createNoteRenderer(this.plugin, this.plugin, content, this.sourcePath, () =>
      this.scheduleLayout(view.dom.win),
    );
    this.renderer = renderer;
    void renderer.render(this.text);
    attachInlineEditor({
      note,
      content,
      id: this.id,
      text: this.text,
      scheduleLayout: () => this.scheduleLayout(view.dom.win),
      cancelRender: renderer.cancel,
      render: (text) => void renderer.render(text),
      preventMouseDownDefault: true,
      commit: (replacement) => {
        const definition = parseDefinitions(view.state.doc.toString()).get(this.id);
        if (definition === undefined) throw new Error(`Footnote definition not found: ${this.id}`);
        view.dispatch({
          changes: { from: definition.from, to: definition.to, insert: replacement },
          userEvent: "input",
        });
      },
    });
    return anchor;
  }

  override destroy(): void {
    this.renderer?.cancel();
    this.renderer = null;
  }

  override eq(other: FootnoteWidget): boolean {
    return (
      this.id === other.id &&
      this.text === other.text &&
      this.number === other.number &&
      this.sourcePath === other.sourcePath
    );
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/**
 * Shows ordinary Markdown footnotes in unused document margin space without
 * reserving a column or shifting the page. Sidenotes remain editable in both
 * Live Preview and reading mode. Dense groups become compact, expandable rows;
 * Obsidian's normal definitions remain available at the end of the document.
 */
export const footnoteSidenotes: Patch = {
  id: "footnote-sidenotes",
  name: "Footnotes in the margin",
  description:
    "Shows editable footnotes in unused margin space without shifting the page. Dense groups expand on hover or click; normal footnotes remain at the end.",

  register(plugin: Plugin, ctx: PatchContext): PatchHandle {
    const windows = new Map<Window, WindowState>();
    const frames = new Map<Window, number>();
    const pinnedByPane = new WeakMap<HTMLElement, Map<string, Set<string>>>();
    const parsedByPath = new Map<string, { source: string; parsed: ParsedFootnotes }>();
    const sourceByPath = new Map<string, { mtime: number; source: Promise<string> }>();
    let version = 0;
    const side = (): Side => {
      const value = ctx.getConfig<unknown>(SIDE_KEY, DEFAULT_SIDE);
      return isSide(value) ? value : DEFAULT_SIDE;
    };
    const distance = (): number => configuredDistance(ctx.getConfig<unknown>(DISTANCE_KEY, DEFAULT_DISTANCE));

    const cachedFootnotes = (sourcePath: string, source: string): ParsedFootnotes => {
      const cached = parsedByPath.get(sourcePath);
      if (cached?.source === source) return cached.parsed;
      const parsed = parsedFootnotes(source);
      parsedByPath.set(sourcePath, { source, parsed });
      if (parsedByPath.size > 16) {
        for (const path of parsedByPath.keys()) {
          if (path === sourcePath) continue;
          parsedByPath.delete(path);
          break;
        }
      }
      return parsed;
    };

    const readFootnoteSource = (file: TFile): Promise<string> => {
      const cached = sourceByPath.get(file.path);
      if (cached?.mtime === file.stat.mtime) return cached.source;
      const source = plugin.app.vault.cachedRead(file);
      sourceByPath.set(file.path, { mtime: file.stat.mtime, source });
      void source.catch(() => {
        if (sourceByPath.get(file.path)?.source === source) sourceByPath.delete(file.path);
      });
      if (sourceByPath.size > 16) {
        for (const path of sourceByPath.keys()) {
          if (path === file.path) continue;
          sourceByPath.delete(path);
          break;
        }
      }
      return source;
    };

    const pinState = (note: HTMLElement): Set<string> => {
      const pane =
        note.closest<HTMLElement>(".workspace-leaf-content") ??
        note.closest<HTMLElement>(".markdown-source-view, .markdown-reading-view") ??
        note.ownerDocument.body;
      const sourcePath = note.dataset["sourcePath"] ?? "";
      let bySource = pinnedByPane.get(pane);
      if (bySource === undefined) {
        bySource = new Map();
        pinnedByPane.set(pane, bySource);
      }
      let ids = bySource.get(sourcePath);
      if (ids !== undefined) return ids;
      ids = new Set();
      bySource.set(sourcePath, ids);
      if (bySource.size > 16) {
        for (const path of bySource.keys()) {
          if (path === sourcePath) continue;
          bySource.delete(path);
          break;
        }
      }
      return ids;
    };

    const isPinnedNote = (note: HTMLElement): boolean => {
      const id = note.dataset["footnoteId"];
      return id !== undefined && pinState(note).has(id);
    };

    const layoutWindow = (win: Window): void => {
      frames.delete(win);
      for (const root of Array.from(
        win.document.querySelectorAll<HTMLElement>(".markdown-source-view, .markdown-reading-view"),
      )) {
        layoutRoot(root, side(), distance(), ctx.isEnabled(), isPinnedNote);
      }
    };

    const scheduleLayout = (win: Window): void => {
      if (frames.has(win)) return;
      frames.set(
        win,
        win.requestAnimationFrame(() => layoutWindow(win)),
      );
    };

    const setupNote: SetupNote = (note, numberButton, sourcePath, id) => {
      note.dataset["sourcePath"] = sourcePath;
      note.dataset["footnoteId"] = id;

      let pointerInside = false;
      let suppressPointerPeek = false;
      let peeked = false;
      const updatePeek = (): void => {
        const next = pointerInside && !suppressPointerPeek;
        if (next === peeked) return;
        peeked = next;
        note.classList.toggle(PEEKED_CLASS, next);
        scheduleLayout(note.ownerDocument.defaultView ?? window);
      };

      note.addEventListener("pointerenter", () => {
        pointerInside = true;
        updatePeek();
      });
      note.addEventListener("pointerleave", () => {
        pointerInside = false;
        suppressPointerPeek = false;
        updatePeek();
      });
      numberButton.addEventListener("mousedown", (event) => event.stopPropagation());
      numberButton.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        const pinnedIds = pinState(note);
        const pinned = !pinnedIds.has(id);
        if (pinned) pinnedIds.add(id);
        else {
          pinnedIds.delete(id);
          suppressPointerPeek = pointerInside;
        }
        note.classList.toggle(PINNED_CLASS, pinned);
        updatePeek();
        syncPinControl(note, pinned);
        scheduleLayout(note.ownerDocument.defaultView ?? window);
      });
    };

    const cleanupReadingDom = (win: Window): void => {
      for (const note of Array.from(
        win.document.querySelectorAll<HTMLElement>(`.markdown-reading-view .${NOTE_CLASS}`),
      )) {
        note.remove();
      }
      for (const anchor of Array.from(
        win.document.querySelectorAll<HTMLElement>(`.markdown-reading-view .${ANCHOR_CLASS}`),
      )) {
        anchor.classList.remove(ANCHOR_CLASS);
      }
    };

    const setupWindow = (win: Window): void => {
      if (windows.has(win)) return;
      const style = createHtmlElement(win.document, "style");
      style.id = STYLE_ID;
      style.textContent = CSS;
      win.document.head.appendChild(style);
      const onResize = (): void => scheduleLayout(win);
      const pendingMounts = new Set<HTMLElement>();
      const mountObserver = new (win.document.defaultView ?? window).MutationObserver(() => {
        let mounted = false;
        for (const element of pendingMounts) {
          if (!element.isConnected) continue;
          pendingMounts.delete(element);
          mounted = true;
        }
        if (pendingMounts.size === 0) mountObserver.disconnect();
        if (mounted && ctx.isEnabled()) scheduleLayout(win);
      });
      win.addEventListener("resize", onResize);
      windows.set(win, { style, onResize, mountObserver, pendingMounts });
    };

    const teardownWindow = (win: Window): void => {
      const state = windows.get(win);
      if (state === undefined) return;
      windows.delete(win);
      const frame = frames.get(win);
      if (frame !== undefined) win.cancelAnimationFrame(frame);
      frames.delete(win);
      cleanupReadingDom(win);
      // Editor notes are CodeMirror-owned widgets. Removal is only safe while
      // the patch itself is being torn down; toggling keeps their DOM intact
      // so a later equivalent widget cannot reuse an emptied element.
      for (const note of Array.from(
        win.document.querySelectorAll<HTMLElement>(`.markdown-source-view .${NOTE_CLASS}`),
      )) {
        note.remove();
      }
      state.mountObserver.disconnect();
      state.pendingMounts.clear();
      win.removeEventListener("resize", state.onResize);
      state.style.remove();
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
    plugin.registerEvent(
      plugin.app.workspace.on("layout-change", () => {
        for (const win of windows.keys()) scheduleLayout(win);
      }),
    );

    const buildDecorations = (view: EditorView): DecorationSet => {
      if (!ctx.isEnabled() || !isLivePreview(view.state)) return Decoration.none;
      const source = view.state.doc.toString();
      const excludedRanges = syntaxExclusions(view.state);
      const { definitions, references, order } = parsedFootnotes(
        source,
        (position) => positionInRanges(position, excludedRanges) || isEscaped(source, position),
      );
      if (definitions.size === 0) return Decoration.none;
      const numbers = new Map(order.map((id, index) => [id, String(index + 1)]));
      const sourcePath = editorSourcePath(view.state);
      const ranges: ReturnType<Decoration["range"]>[] = [];
      const rendered = new Set<string>();
      for (const reference of references) {
        const { id } = reference;
        if (rendered.has(id)) continue;
        rendered.add(id);
        const definition = definitions.get(id);
        const number = numbers.get(id);
        if (definition === undefined || number === undefined) continue;
        const widget = new FootnoteWidget(plugin, id, definition.text, number, sourcePath, scheduleLayout, setupNote);
        ranges.push(Decoration.widget({ widget, side: 1 }).range(reference.to));
      }
      return Decoration.set(ranges, true);
    };

    const editorExtension = ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        private seenVersion = version;
        private livePreview: boolean;

        constructor(private readonly view: EditorView) {
          this.livePreview = isLivePreview(view.state);
          this.decorations = buildDecorations(view);
          scheduleLayout(view.dom.win);
        }

        update(update: ViewUpdate): void {
          const livePreview = isLivePreview(update.state);
          const modeChanged = livePreview !== this.livePreview;
          const versionChanged = this.seenVersion !== version;
          if (update.docChanged || modeChanged || versionChanged) {
            this.livePreview = livePreview;
            this.seenVersion = version;
            this.decorations = buildDecorations(update.view);
          }
          if (update.docChanged || update.viewportChanged || update.geometryChanged || modeChanged || versionChanged) {
            scheduleLayout(update.view.dom.win);
          }
        }

        destroy(): void {
          scheduleLayout(this.view.dom.win);
        }
      },
      { decorations: (value) => value.decorations },
    );
    plugin.registerEditorExtension(editorExtension);

    plugin.registerMarkdownPostProcessor(async (el: HTMLElement, mdCtx: MarkdownPostProcessorContext) => {
      if (!ctx.isEnabled()) return;
      const refs = Array.from(
        el.querySelectorAll<HTMLElement>(
          `sup.footnote-ref:not(.${ANCHOR_CLASS}), sup[id^="fnref-"]:not(.${ANCHOR_CLASS}), sup[data-footnote-id]:not(.${ANCHOR_CLASS})`,
        ),
      ).filter(
        (ref) => ref.closest("section.footnotes, .footnotes") === null && ref.closest(`.${NOTE_CLASS}`) === null,
      );
      if (refs.length === 0) return;

      const abstractFile = plugin.app.vault.getAbstractFileByPath(mdCtx.sourcePath);
      if (!(abstractFile instanceof TFile)) return;
      const source = await readFootnoteSource(abstractFile);
      if (!ctx.isEnabled()) return;
      const { definitions, order, idsByLength, numberById } = cachedFootnotes(mdCtx.sourcePath, source);
      const rendered = new Set<string>();
      const renders: Promise<void>[] = [];
      const ownerWindow = el.ownerDocument.defaultView ?? window;

      for (const sup of refs) {
        const id = resolveRenderedId(sup, order, idsByLength);
        if (id === null || rendered.has(id)) continue;
        rendered.add(id);
        const definition = definitions.get(id);
        // Obsidian's rendered label is authoritative: unlike a source regex,
        // it already excludes references inside code and frontmatter.
        const number = renderedFootnoteNumber(sup) ?? numberById.get(id);
        if (definition === undefined || number === undefined) continue;

        sup.classList.add(ANCHOR_CLASS);
        const { note, numberButton, content } = makeNote(sup.ownerDocument, String(number));
        sup.appendChild(note);
        setupNote(note, numberButton, mdCtx.sourcePath, id);
        const renderHost = new MarkdownRenderChild(content);
        mdCtx.addChild(renderHost);
        const renderer = createNoteRenderer(plugin, renderHost, content, mdCtx.sourcePath, () => {
          if (el.isConnected) scheduleLayout(ownerWindow);
        });
        renderHost.register(renderer.cancel);
        renders.push(renderer.render(definition.text));
        attachInlineEditor({
          note,
          content,
          id,
          text: definition.text,
          scheduleLayout: () => scheduleLayout(ownerWindow),
          cancelRender: renderer.cancel,
          render: (text) => void renderer.render(text),
          respectSelection: true,
          commit: (replacement) =>
            plugin.app.vault.process(abstractFile, (currentSource) => {
              const current = parseDefinitions(currentSource).get(id);
              if (current === undefined) throw new Error(`Footnote definition not found: ${id}`);
              return currentSource.slice(0, current.from) + replacement + currentSource.slice(current.to);
            }),
        });
      }
      await Promise.all(renders);
      if (!ctx.isEnabled()) {
        for (const note of Array.from(el.querySelectorAll<HTMLElement>(`.${NOTE_CLASS}`))) note.remove();
        for (const anchor of Array.from(el.querySelectorAll<HTMLElement>(`.${ANCHOR_CLASS}`))) {
          anchor.classList.remove(ANCHOR_CLASS);
        }
        return;
      }
      if (el.isConnected) {
        scheduleLayout(ownerWindow);
        return;
      }

      // Reading Mode renders distant sections off-DOM and mounts them only
      // after postprocessors finish. One observer per window watches all such
      // sections, avoiding one document-wide callback for every section.
      setupWindow(ownerWindow);
      const windowState = windows.get(ownerWindow);
      if (windowState === undefined) return;
      windowState.pendingMounts.add(el);
      const mountWatcher = new MarkdownRenderChild(el);
      mountWatcher.register(() => {
        windowState.pendingMounts.delete(el);
        if (windowState.pendingMounts.size === 0) windowState.mountObserver.disconnect();
      });
      mdCtx.addChild(mountWatcher);
      windowState.mountObserver.observe(el.ownerDocument.documentElement, { childList: true, subtree: true });
      if (el.isConnected) {
        windowState.pendingMounts.delete(el);
        if (windowState.pendingMounts.size === 0) windowState.mountObserver.disconnect();
        scheduleLayout(ownerWindow);
      }
    });

    const refresh = (): void => {
      version++;
      plugin.app.workspace.updateOptions();
      for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
        const view = leaf.view;
        if (view instanceof MarkdownView) view.previewMode.rerender(true);
      }
      for (const win of windows.keys()) {
        if (!ctx.isEnabled()) cleanupReadingDom(win);
        scheduleLayout(win);
      }
    };

    return {
      cleanup: (): void => {
        for (const win of Array.from(windows.keys())) teardownWindow(win);
      },
      onToggle: (): void => refresh(),
      onConfigChange: (key: string): void => {
        if (key === SIDE_KEY || key === DISTANCE_KEY) {
          version++;
          for (const win of windows.keys()) scheduleLayout(win);
        }
      },
    };
  },

  settingDefinitions(_ctx: PatchContext, key: (configKey: string) => string): SettingGroupItem[] {
    return [
      {
        name: "Side",
        desc: "Margin used when it has enough free space.",
        control: {
          type: "dropdown",
          key: key(SIDE_KEY),
          defaultValue: DEFAULT_SIDE,
          options: { left: "Left", right: "Right" },
        },
      },
      {
        name: "Distance from document",
        desc: "Space in pixels between the document text and sidenotes.",
        control: {
          type: "number",
          key: key(DISTANCE_KEY),
          defaultValue: DEFAULT_DISTANCE,
          min: 0,
          max: MAX_DISTANCE,
          step: 1,
        },
      },
    ];
  },
};
