import {
  Component,
  Keymap,
  MarkdownPreviewRenderer,
  sanitizeHTMLToDom,
  renderMatches,
  type FrontmatterLinkCache,
  setIcon,
  type CachedMetadata,
  type Plugin,
  type TFile,
} from "obsidian";
import type { Patch, PatchContext, PatchHandle } from "../patch";

const CLASS = "micropatches-search-context";
const HEIGHT = `--${CLASS}-height`;
const PLACEHOLDER = `${CLASS}-placeholder`;
const MAX_TEXT = 4000;
const MAX_LINES = 18;
const MAX_ANCESTORS = 12;
const MAX_INDEX_ITEMS = 20000;
const MAX_INDEXES = 16;
const MAX_CRUMB_TEXT = 512;
const MAX_CONTEXT_TEXT = 2000;
const MAX_SECTION_TEXT = 64000;

interface Crumb {
  text: string;
  line: number;
  kind: "heading" | "list";
  marker: string;
}

interface ContextIndex {
  cache: CachedMetadata;
  headingParents: number[];
  listParents: number[];
  listEnds: number[];
  listNumbers: Array<number | null> | null;
  footnoteOwners: number[];
  definitions?: string | null;
  clippedCode: Map<number, boolean>;
}

interface Excerpt {
  markdown: string;
  crumbs: Crumb[];
  terms: string[][];
  listStart: number | null;
  kind: "markdown" | "inline" | "code" | "footnote";
  footnote: string | null;
  definitions: string;
}

type Match = ContentMatch | PropertyMatchRow<Result>;

interface ContentMatch {
  el: HTMLElement;
  content: string;
  cache: CachedMetadata;
  start: number;
  end: number;
  matches: Array<[number, number]>;
  parentDom: Result;
  showMoreBeforeEl: HTMLElement;
  showMoreAfterEl: HTMLElement;
  render(...args: unknown[]): unknown;
}

interface Result {
  file: TFile;
  parentDom: Holder;
  vChildren: { _children: unknown[] };
  renderContentMatches(...args: unknown[]): unknown;
}

interface Holder {
  el: HTMLElement;
  resultDomLookup: Map<unknown, unknown>;
  infinityScroll: { invalidate(item: unknown): void };
  addResult(...args: unknown[]): unknown;
}

interface RenderedMatch {
  match: Match;
  root: Root;
  visible: boolean;
  host: HTMLElement | null;
  originals: ChildNode[];
}

interface Root {
  holder: Holder;
  observer: MutationObserver;
  intersection: IntersectionObserver;
  records: Map<HTMLElement, RenderedMatch>;
  mounted: boolean;
  discovered: boolean;
  owner: Component | null;
  child: Component | null;
}

interface ObserverWindow extends Window {
  createDiv: typeof createDiv;
  createSpan: typeof createSpan;
  createFragment: typeof createFragment;
  IntersectionObserver: typeof IntersectionObserver;
  MutationObserver: typeof MutationObserver;
  DOMParser: typeof DOMParser;
  createEl: typeof createEl;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function element(value: unknown): value is HTMLElement {
  return object(value) && value["nodeType"] === 1 && typeof value["querySelectorAll"] === "function";
}

function isHolder(value: unknown): value is Holder {
  return (
    object(value) &&
    element(value["el"]) &&
    value["el"].classList.contains("search-result-container") &&
    object(value["resultDomLookup"]) &&
    typeof value["resultDomLookup"]["values"] === "function" &&
    typeof value["addResult"] === "function" &&
    object(value["infinityScroll"]) &&
    typeof value["infinityScroll"]["invalidate"] === "function"
  );
}

function isResult(value: unknown): value is Result {
  return (
    object(value) &&
    object(value["file"]) &&
    value["file"]["extension"] === "md" &&
    typeof value["file"]["path"] === "string" &&
    isHolder(value["parentDom"]) &&
    object(value["vChildren"]) &&
    Array.isArray(value["vChildren"]["_children"]) &&
    typeof value["renderContentMatches"] === "function"
  );
}

function isContentMatch(value: unknown): value is ContentMatch {
  return (
    object(value) &&
    element(value["el"]) &&
    typeof value["content"] === "string" &&
    object(value["cache"]) &&
    typeof value["start"] === "number" &&
    typeof value["end"] === "number" &&
    Array.isArray(value["matches"]) &&
    value["matches"].length > 0 &&
    value["matches"].length <= 100 &&
    value["matches"].every(
      (pair: unknown) =>
        Array.isArray(pair) && pair.length === 2 && pair.every((offset: unknown) => Number.isSafeInteger(offset)),
    ) &&
    isResult(value["parentDom"]) &&
    element(value["showMoreBeforeEl"]) &&
    element(value["showMoreAfterEl"]) &&
    typeof value["render"] === "function"
  );
}

function isMatch(value: unknown): value is Match {
  return isContentMatch(value) || isPropertyMatchRow(value, isResult);
}

interface NativePropertyMatch {
  key: string;
  subkey?: Array<string | number>;
  pos?: [number, number];
}

/** Pass the existing isResult guard so the parent has the patch's Result type. */
interface PropertyMatchRow<Parent = unknown> {
  el: HTMLElement;
  parentDom: Parent;
  cache: CachedMetadata;
  matches: NativePropertyMatch[];
  render(...args: unknown[]): unknown;
}

function propertyRange(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((offset: unknown) => Number.isSafeInteger(offset)) &&
    value[0] >= 0 &&
    value[1] > value[0]
  );
}

export function isPropertyMatchRow<Parent>(
  value: unknown,
  isParent: (candidate: unknown) => candidate is Parent,
): value is PropertyMatchRow<Parent> {
  if (
    !object(value) ||
    !object(value["el"]) ||
    value["el"]["nodeType"] !== 1 ||
    typeof value["el"]["querySelectorAll"] !== "function" ||
    !object(value["cache"]) ||
    !object(value["cache"]["frontmatter"]) ||
    !isParent(value["parentDom"]) ||
    typeof value["render"] !== "function" ||
    !Array.isArray(value["matches"]) ||
    value["matches"].length === 0 ||
    value["matches"].length > 100
  )
    return false;
  let key: string | undefined;
  return value["matches"].every((match: unknown) => {
    if (!object(match) || typeof match["key"] !== "string") return false;
    key ??= match["key"];
    if (match["key"] !== key || key.length > MAX_TEXT) return false;
    const path = match["subkey"];
    if (
      path !== undefined &&
      (!Array.isArray(path) ||
        path.length > MAX_ANCESTORS ||
        !path.every(
          (part: unknown) =>
            (typeof part === "string" && part.length <= MAX_TEXT) ||
            (typeof part === "number" && Number.isSafeInteger(part) && part >= 0),
        ))
    )
      return false;
    return match["pos"] === undefined ? path === undefined || path.length === 0 : propertyRange(match["pos"]);
  });
}

function mergePropertyRanges(ranges: Array<[number, number]>): Array<[number, number]> {
  const merged: Array<[number, number]> = [];
  for (const [from, to] of [...ranges].sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] - b[0]))) {
    const previous = merged[merged.length - 1];
    if (previous !== undefined && from <= previous[1]) previous[1] = Math.max(previous[1], to);
    else merged.push([from, to]);
  }
  return merged;
}

/** Preserve visible label hits; a hidden destination/syntax hit marks its alias. */
function propertyAliasRanges(value: string, label: string, ranges: Array<[number, number]>): Array<[number, number]> {
  const visible: Array<[number, number]> = [];
  for (const [from, to] of ranges) {
    const term = value.slice(from, to);
    let at = label.indexOf(term);
    if (at < 0) return [[0, label.length]];
    while (at >= 0) {
      visible.push([at, at + term.length]);
      if (visible.length >= 100) return [[0, label.length]];
      at = label.indexOf(term, at + term.length);
    }
  }
  return mergePropertyRanges(visible);
}

/**
 * Render into a detached preview container, then mount through the patch's
 * existing record lifecycle. No Markdown parser/processors are run for YAML.
 * On false, the supplied container is unchanged and no match was discarded.
 * Anchors use the existing internal-link click/auxclick/hover handlers; plain
 * text keeps the native row's propertyMatches navigation and context menu.
 */
export function renderProperties(el: HTMLElement, row: PropertyMatchRow): boolean {
  const first = row.matches[0];
  const frontmatter: unknown = row.cache.frontmatter;
  if (
    first === undefined ||
    row.matches.length > 100 ||
    first.key.length > MAX_TEXT ||
    !object(frontmatter) ||
    !Object.prototype.hasOwnProperty.call(frontmatter, first.key)
  )
    return false;

  const pending = new Map<string, Array<[number, number]>>();
  let keyMatch = false;
  for (const match of row.matches) {
    if (match.key !== first.key || (match.subkey?.length ?? 0) > MAX_ANCESTORS) return false;
    if (match.pos === undefined) {
      if ((match.subkey?.length ?? 0) !== 0 || first.key.length === 0) return false;
      keyMatch = true;
      continue;
    }
    if (!propertyRange(match.pos)) return false;
    const path = JSON.stringify((match.subkey ?? []).map(String));
    const ranges = pending.get(path) ?? [];
    ranges.push(match.pos);
    pending.set(path, ranges);
  }

  const refs = row.cache.frontmatterLinks ?? [];
  if (refs.length > MAX_INDEX_ITEMS) return false;
  const links = new Map<string, FrontmatterLinkCache[]>();
  for (const ref of refs) {
    if (
      ref.key.length > MAX_TEXT ||
      ref.original.length > MAX_TEXT ||
      (ref.key !== first.key && !ref.key.startsWith(`${first.key}.`))
    )
      continue;
    const existing = links.get(ref.key) ?? [];
    existing.push(ref);
    links.set(ref.key, existing);
  }

  const win = el.win as ObserverWindow;
  const fragment = win.createFragment();
  let sourceLength = first.key.length + 2;
  let displayLength = 0;
  let values = 0;
  const text = (value: string): boolean => {
    displayLength += value.length;
    if (displayLength > MAX_TEXT) return false;
    fragment.append(value);
    return true;
  };
  const key = win.createSpan();
  renderMatches(key, first.key, keyMatch ? [[0, first.key.length]] : null);
  fragment.append(key);
  displayLength += first.key.length;
  if (!text(": ")) return false;

  const visit = (value: unknown, path: string[], depth: number): boolean => {
    if (++values > 400 || depth > MAX_ANCESTORS) return false;
    const pathKey = JSON.stringify(path);
    const ranges = pending.get(pathKey) ?? [];
    // A native value search can target String(object). Keep that literal value
    // when it has direct matches; unresolved descendant matches fail below.
    const structured = ranges.length === 0 && object(value);
    if (structured && Array.isArray(value)) {
      if (value.length > 400 || (depth > 0 && !text("["))) return false;
      for (let index = 0; index < value.length; index++) {
        if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
        if (index > 0 && !text(", ")) return false;
        if (!visit(value[index], [...path, String(index)], depth + 1)) return false;
      }
      return depth === 0 || text("]");
    }
    if (structured && Object.prototype.toString.call(value) === "[object Object]") {
      if (!text("{")) return false;
      let entries = 0;
      for (const child in value) {
        if (!Object.prototype.hasOwnProperty.call(value, child)) continue;
        if (++entries > 400) return false;
        sourceLength += child.length;
        if (sourceLength > MAX_TEXT || (entries > 1 && !text(", ")) || !text(`${child}: `)) return false;
        if (!visit(value[child], [...path, child], depth + 1)) return false;
      }
      return text("}");
    }
    if (typeof value === "function" || typeof value === "symbol") return false;
    const original = String(value);
    sourceLength += original.length;
    if (sourceLength > MAX_TEXT || ranges.some((range) => range[1] > original.length)) return false;
    const reference =
      typeof value === "string"
        ? links.get([first.key, ...path].join("."))?.find((candidate) => candidate.original === value)
        : undefined;
    const display = reference === undefined ? original : (reference.displayText ?? reference.link);
    const label = display === "" && reference !== undefined ? reference.link : display;
    displayLength += label.length;
    if (displayLength > MAX_TEXT || (ranges.length > 0 && label.length === 0)) return false;
    const leaf = win.createEl(reference === undefined ? "span" : "a");
    if (reference !== undefined) {
      leaf.className = "internal-link";
      leaf.setAttribute("href", reference.link);
      leaf.setAttribute("data-href", reference.link);
      leaf.setAttribute("aria-label", reference.link);
      leaf.setAttribute("data-tooltip-position", "top");
    }
    const merged = mergePropertyRanges(ranges);
    const highlighted = reference === undefined ? merged : propertyAliasRanges(original, label, merged);
    renderMatches(leaf, label, highlighted);
    fragment.append(leaf);
    pending.delete(pathKey);
    return true;
  };

  if (!visit(frontmatter[first.key], [], 0) || pending.size > 0) return false;
  for (const mark of Array.from(fragment.querySelectorAll(".suggestion-highlight")))
    mark.className = "search-result-file-matched-text";
  el.replaceChildren(fragment);
  return true;
}

/** Only indexes a document when a visible result needs its context. */
export function createContextIndex(metadata: CachedMetadata): ContextIndex | null {
  const cache = { ...metadata };
  const headings = cache.headings ?? [];
  const items = cache.listItems ?? [];
  const footnotes = cache.footnotes ?? [];
  if (
    headings.length +
      items.length +
      (cache.sections?.length ?? 0) +
      footnotes.length +
      (cache.footnoteRefs?.length ?? 0) +
      (cache.referenceLinks?.length ?? 0) +
      (cache.links?.length ?? 0) +
      (cache.embeds?.length ?? 0) >
    MAX_INDEX_ITEMS
  )
    return null;
  // Footnote links may be appended by the native parser out of source order.
  // Copy only the arrays used for range lookup; never reorder native metadata.
  for (const key of ["links", "embeds", "footnotes", "footnoteRefs", "referenceLinks"] as const) {
    const entries = cache[key];
    if (entries !== undefined)
      Object.assign(cache, { [key]: [...entries].sort((a, b) => a.position.start.offset - b.position.start.offset) });
  }
  let footnoteEnd = -1;
  let footnoteOwner = -1;
  const footnoteOwners: number[] = [];
  (cache.footnotes ?? []).forEach((note, i) => {
    // Inline notes can be nested inside definitions; the nearest start alone
    // cannot tell whether a fragment still belongs to the enclosing footnote.
    if (note.position.end.offset > footnoteEnd && !note.id.startsWith("[inline")) {
      footnoteEnd = note.position.end.offset;
      footnoteOwner = i;
    }
    footnoteOwners.push(footnoteOwner);
  });
  const headingParents: number[] = [];
  const stack: number[] = [];
  headings.forEach((heading, index) => {
    while (stack.length > 0 && (headings[stack[stack.length - 1] ?? -1]?.level ?? 0) >= heading.level) stack.pop();
    headingParents.push(stack[stack.length - 1] ?? -1);
    stack.push(index);
  });
  const byLine = new Map<number, number>();
  const listParents: number[] = [];
  const listEnds: number[] = [];
  items.forEach((item, index) => {
    const candidate = item.parent < item.position.start.line ? (byLine.get(item.parent) ?? -1) : -1;
    // Native metadata normalizes a root on line zero to parent=-1. Columns
    // cannot determine hierarchy: tabs and spaces may have equal raw columns.
    listParents.push(candidate);
    listEnds.push(item.position.end.offset);
    byLine.set(item.position.start.line, index);
  });
  for (let index = items.length - 1; index >= 0; index--) {
    const parent = listParents[index] ?? -1;
    if (parent >= 0) listEnds[parent] = Math.max(listEnds[parent] ?? 0, listEnds[index] ?? 0);
  }
  return {
    cache,
    headingParents,
    listParents,
    listEnds,
    listNumbers: null,
    footnoteOwners,
    clippedCode: new Map(),
  };
}

function preceding(items: Array<{ position: { start: { offset: number } } }>, offset: number): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if ((items[mid]?.position.start.offset ?? Infinity) <= offset) lo = mid + 1;
    else hi = mid;
  }
  return lo - 1;
}

function indentation(line: string): { length: number; columns: number } {
  let length = 0;
  let columns = 0;
  while (line[length] === " " || line[length] === "\t") {
    columns += line[length] === "\t" ? 4 - (columns % 4) : 1;
    length++;
  }
  return { length, columns };
}

/** Native list parents delimit sibling groups; Markdown numbers subsequent
 * items sequentially even when every source marker is written as `1.`. */
function listNumbers(content: string, index: ContextIndex): Array<number | null> {
  if (index.listNumbers !== null) return index.listNumbers;
  const siblings = new Map<number, { delimiter: string; number: number | null; end: number }>();
  let gapBudget = MAX_SECTION_TEXT;
  index.listNumbers = (index.cache.listItems ?? []).map((item, i) => {
    const start = item.position.start.offset;
    const marker = /^[ \t]*(\d{1,9})([.)])(?=[ \t\r\n]|$)/u.exec(content.slice(start, start + 32));
    if (marker === null) {
      siblings.delete(item.parent);
      return null;
    }
    const delimiter = marker[2] ?? ".";
    const previous = siblings.get(item.parent);
    let number: number | null = Number(marker[1]);
    if (previous?.delimiter === delimiter) {
      const gap = start - previous.end;
      // A paragraph between nested sibling runs starts a new list. Bound the
      // inspection and keep uncertain fragments native rather than guess.
      if (gap < 0 || gap > MAX_TEXT || gap > gapBudget) number = null;
      else {
        gapBudget -= gap;
        const between = content.slice(previous.end, start);
        // A quote marker may wrap this list or separate two sibling lists.
        // Metadata alone cannot distinguish those nested container boundaries.
        if (between.includes(">")) number = null;
        else if (/^[ \t\r\n]*$/u.test(between)) number = previous.number === null ? null : previous.number + 1;
      }
    }
    siblings.set(item.parent, { delimiter, number, end: index.listEnds[i] ?? item.position.end.offset });
    return number;
  });
  return index.listNumbers;
}

function contextCrumb(text: string, line: number, kind: Crumb["kind"], marker: string): Crumb | null {
  return text.length > MAX_CRUMB_TEXT ? null : { text, line, kind, marker };
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/gu, (char) => `&#${char.charCodeAt(0)};`);
}

/** Supply the native parser's document-wide definitions in source order.
 * No hand-written reference-link grammar, and no rendering an entire note. */
function definitions(content: string, index: ContextIndex): string | null {
  if (index.definitions !== undefined) return index.definitions;
  const parts: string[] = [];
  let length = 0;
  for (const ref of index.cache.referenceLinks ?? []) {
    const size = ref.position.end.offset - ref.position.start.offset;
    length += size + 2;
    if (size < 0 || length > MAX_TEXT) {
      index.definitions = null;
      return null;
    }
    parts.push(content.slice(ref.position.start.offset, ref.position.end.offset));
  }
  const ids = new Set<string>();
  for (const note of [...(index.cache.footnotes ?? []), ...(index.cache.footnoteRefs ?? [])]) {
    if (note.id.startsWith("[inline") || ids.has(note.id)) continue;
    ids.add(note.id);
    const definition = `[^${note.id}]: \u200b`;
    length += definition.length + 2;
    if (length > MAX_TEXT) {
      index.definitions = null;
      return null;
    }
    parts.push(definition);
  }
  index.definitions = parts.length === 0 ? "" : `${parts.join("\n\n")}\n\n`;
  return index.definitions;
}

/** A small preview, preserving every native match and native context expansion. */
export function searchExcerpt(
  content: string,
  start: number,
  end: number,
  matches: Array<[number, number]>,
  index: ContextIndex,
): Excerpt | null {
  if (start < 0 || end > content.length || end <= start || end - start > MAX_TEXT || matches.length > 100) return null;
  if (matches.some(([from, to]) => from < start || to > end || to <= from)) return null;
  const position = matches[0]?.[0];
  if (position === undefined) return null;
  const { cache } = index;
  const headings = cache.headings ?? [];
  const items = cache.listItems ?? [];
  const sections = cache.sections ?? [];
  const crumbs: Crumb[] = [];
  let headingIndex = preceding(headings, position);
  while (headingIndex >= 0 && crumbs.length < MAX_ANCESTORS) {
    const heading = headings[headingIndex];
    if (heading === undefined) break;
    if (heading.position.end.offset < start) {
      const crumb = contextCrumb(heading.heading, heading.position.start.line, "heading", `H${heading.level}`);
      if (crumb === null) break;
      crumbs.unshift(crumb);
    }
    headingIndex = index.headingParents[headingIndex] ?? -1;
  }
  const itemIndex = preceding(items, position);
  const item = items[itemIndex];
  const inList = item !== undefined && position <= item.position.end.offset;
  let ancestor = inList ? (index.listParents[itemIndex] ?? -1) : -1;
  const listCrumbs: Crumb[] = [];
  while (ancestor >= 0 && listCrumbs.length + crumbs.length < MAX_ANCESTORS) {
    const parent = items[ancestor];
    if (parent === undefined) break;
    const text =
      content
        .slice(
          parent.position.start.offset,
          Math.min(parent.position.end.offset, parent.position.start.offset + MAX_CRUMB_TEXT + 32),
        )
        .split("\n", 1)[0] ?? "";
    if (parent.position.end.offset < start) {
      const ordered = /^[ \t]*\d{1,9}[.)](?=[ \t\r\n]|$)/u.test(text);
      const number = ordered ? listNumbers(content, index)[ancestor] : null;
      if (ordered && number == null) break;
      const crumb = contextCrumb(
        text.replace(/^\s*(?:[-+*]|\d+[.)])\s+(?:\[[^\]]\]\s+)?/u, ""),
        parent.position.start.line,
        "list",
        ordered ? `${number}.` : "•",
      );
      if (crumb === null) break;
      listCrumbs.unshift(crumb);
    }
    ancestor = index.listParents[ancestor] ?? -1;
  }
  crumbs.push(...listCrumbs);
  // Context is optional; keep the nearest complete labels within one shared
  // budget instead of multiplying renderer work by the nesting depth.
  let contextSize = crumbs.reduce((size, crumb) => size + crumb.text.length, 0);
  while (contextSize > MAX_CONTEXT_TEXT && crumbs.length > 0) contextSize -= crumbs.shift()?.text.length ?? 0;
  let from = start;
  let to = end;
  let clipped = false;
  const sectionIndex = preceding(sections, position);
  const section = sections[sectionIndex];
  if (inList) {
    from = Math.min(from, item.position.start.offset - item.position.start.col);
    to = Math.max(to, index.listEnds[itemIndex] ?? end);
  } else if (section !== undefined && position <= section.position.end.offset) {
    from = Math.min(from, section.position.start.offset);
    to = Math.max(to, section.position.end.offset);
    if (section.type === "heading") to = Math.max(to, sections[sectionIndex + 1]?.position.end.offset ?? end);
  }
  if (to - from > MAX_TEXT || content.slice(from, to).split("\n").length > MAX_LINES) {
    clipped = true;
    from = start;
    to = end;
  }
  let kind: Excerpt["kind"] = "markdown";
  let footnote: string | null = null;
  const noteIndex = preceding(cache.footnotes ?? [], position);
  const owner = cache.footnotes?.[index.footnoteOwners[noteIndex] ?? -1];
  if (owner !== undefined && owner.position.end.offset > position) {
    crumbs.length = 0;
    footnote = owner.id;
    const first = Math.min(
      section?.position.start.offset ?? start,
      owner.position.start.offset - owner.position.start.col,
    );
    const last = Math.max(owner.position.end.offset, end);
    if (last - first <= MAX_TEXT && content.slice(first, last).split("\n").length <= MAX_LINES) {
      from = first;
      to = last;
      kind = "footnote";
    } else {
      kind = "inline";
      clipped = true;
    }
  }
  const frontmatter = cache.frontmatterPosition;
  for (let i = Math.max(0, preceding(sections, from)); i < sections.length; i++) {
    const enclosing = sections[i];
    if (enclosing === undefined || enclosing.position.start.offset >= to) break;
    if (enclosing.position.end.offset <= from) continue;
    if (enclosing.type === "code") kind = "code";
    else if (["yaml", "definition"].includes(enclosing.type)) kind = "inline";
  }
  if (frontmatter !== undefined && frontmatter.start.offset < to && frontmatter.end.offset > from) kind = "inline";
  if (kind === "inline" || kind === "code") {
    from = start;
    to = end;
    crumbs.length = 0;
  }
  // A budget-clipped container may start inside a fence or a multiline code
  // span. Outer metadata has no nested code ranges: never invent links there.
  if (clipped && kind !== "code") {
    for (const span of [section?.position, owner?.position]) {
      if (span === undefined || span.end.offset <= position) continue;
      let code = index.clippedCode.get(span.start.offset);
      if (code === undefined) {
        code =
          span.end.offset - span.start.offset > MAX_SECTION_TEXT ||
          /`|~{3}/u.test(content.slice(span.start.offset, span.end.offset));
        index.clippedCode.set(span.start.offset, code);
      }
      if (code) return null;
    }
  }
  let markdown = content.slice(from, to);
  if (markdown.split("\n").length > MAX_LINES) return null;
  // Preserve the displayed number when a native fragment starts partway
  // through an ordered list, without changing Markdown content indentation.
  let listStart: number | null = null;
  const firstMarker = /^([ \t]*(?:>[ \t]*)*)(\d{1,9})([.)])(?=[ \t\r\n]|$)/u.exec(markdown);
  if (kind === "markdown" && firstMarker !== null) {
    const prefix = firstMarker[1] ?? "";
    const firstItem = preceding(items, from + prefix.length);
    if ((items[firstItem]?.position.start.offset ?? -1) >= from) {
      const number = listNumbers(content, index)[firstItem];
      if (number == null) return null;
      listStart = number;
    }
  }
  if (
    kind === "markdown" &&
    inList &&
    item.position.start.col > 0 &&
    from === item.position.start.offset - item.position.start.col
  ) {
    const indent = indentation(markdown).columns;
    markdown = markdown
      .split("\n")
      .map((line) => {
        const prefix = indentation(line);
        return prefix.columns >= indent ? " ".repeat(prefix.columns - indent) + line.slice(prefix.length) : line;
      })
      .join("\n");
  }
  if (markdown.length > MAX_TEXT) return null;
  const terms: string[][] = [];
  for (const [matchStart, matchEnd] of matches) {
    const term = content.slice(matchStart, matchEnd);
    if (term.length === 0 || term.length > 160) return null;
    const alternatives = [term];
    for (const references of [cache.links ?? [], cache.embeds ?? []]) {
      const link = references[preceding(references, matchStart)];
      if (link !== undefined && matchStart >= link.position.start.offset && matchEnd <= link.position.end.offset) {
        const label = link.displayText === undefined || link.displayText === "" ? link.link : link.displayText;
        if (label.length > 160) return null;
        if (label.length > 0) alternatives.push(label);
      }
    }
    terms.push(alternatives);
  }
  let supporting = definitions(content, index);
  if (supporting === null) return null;
  if (kind === "footnote") {
    supporting = supporting.replace(`[^${footnote}]: \u200b\n\n`, "");
    markdown = `[^${footnote}]\n\n${markdown}`;
  }
  return { markdown, crumbs, terms, listStart, kind, footnote, definitions: supporting };
}

function markLabel(label: HTMLElement, marker: string, nodes = Array.from(label.childNodes)): HTMLElement {
  label.classList.add(`${CLASS}-label`);
  label.createSpan({
    cls: `${CLASS}-marker${marker === "•" ? " is-bullet" : ""}`,
    text: marker === "•" ? "" : marker,
    attr: { "aria-hidden": "true" },
  });
  const content = label.createSpan({ cls: `${CLASS}-label-content` });
  content.append(...nodes);
  return content;
}

/** Static previews use Obsidian's parser without running plugin processors.
 * The undocumented parse adapter is guarded like the native search adapters. */
export function renderPreview(el: HTMLElement, markdown: string): boolean {
  const parser = MarkdownPreviewRenderer.prototype as unknown as Record<string, unknown>;
  if (typeof parser["parseSync"] !== "function" || markdown.length > MAX_SECTION_TEXT) return false;
  let parsed: unknown;
  try {
    Reflect.apply(
      parser["parseSync"],
      {
        text: markdown,
        parseFinish: (_text: unknown, result: unknown) => {
          parsed = result;
        },
      },
      [],
    );
  } catch {
    return false;
  }
  if (!object(parsed) || !Array.isArray(parsed["sections"]) || parsed["sections"].length > 512) return false;
  const sections: unknown[] = parsed["sections"];
  let html = "";
  for (const section of sections) {
    if (!object(section) || typeof section["html"] !== "string") return false;
    html += section["html"];
    if (html.length > MAX_SECTION_TEXT * 2) return false;
  }
  // sanitizeHTMLToDom imports into the live document and can load even detached
  // images. Strip resource-bearing markup inside an inert template FIRST.
  const inert = new (el.win as ObserverWindow).DOMParser().parseFromString(
    `<!doctype html><template>${html.replace(/<\/template/giu, "&lt;/template")}</template>`,
    "text/html",
  );
  const template = inert.querySelector("template");
  if (template === null) return false;
  for (const media of Array.from(
    template.content.querySelectorAll(".internal-embed, img, audio, video, iframe, object, embed"),
  )) {
    const href = media.getAttribute("src") ?? media.getAttribute("data");
    const label = media.getAttribute("alt") ?? href ?? media.textContent;
    const replacement = (el.win as ObserverWindow).createEl(href === null ? "span" : "a");
    replacement.textContent = label;
    if (href !== null) {
      replacement.setAttribute("href", href);
      replacement.className = media.classList.contains("internal-embed") ? "internal-link" : "external-link";
    }
    media.replaceWith(replacement);
  }
  const tags = new Set(
    "a p br hr div section span strong em b i s del mark sub sup blockquote ul ol li h1 h2 h3 h4 h5 h6 pre code table thead tbody tfoot tr th td input".split(
      " ",
    ),
  );
  const attributes = new Set(
    "class href data-href title aria-label data-tooltip-position target rel dir start value colspan rowspan type checked data-task data-callout data-callout-metadata data-footnote-id data-footref".split(
      " ",
    ),
  );
  for (const node of Array.from(template.content.querySelectorAll("*"))) {
    if (["script", "style", "link", "meta", "base", "svg", "math"].includes(node.localName)) {
      node.remove();
      continue;
    }
    if (!tags.has(node.localName)) {
      node.replaceWith(...Array.from(node.childNodes));
      continue;
    }
    for (const attribute of Array.from(node.attributes))
      if (!attributes.has(attribute.name)) node.removeAttribute(attribute.name);
    if (node.localName === "input" && node.getAttribute("type") !== "checkbox") node.remove();
  }
  el.append(sanitizeHTMLToDom(template.innerHTML));
  for (const input of Array.from(el.querySelectorAll<HTMLInputElement>("input"))) input.disabled = true;
  for (const node of Array.from(el.querySelectorAll("p, li, h1, h2, h3, h4, h5, h6"))) node.setAttribute("dir", "auto");
  for (const link of Array.from(el.querySelectorAll("a:not(.tag):not(.footnote-link)"))) {
    let href = link.getAttribute("data-href") ?? link.getAttribute("href");
    if (href === null) continue;
    if (
      link.classList.contains("internal-link") ||
      href.startsWith("./") ||
      href.startsWith("../") ||
      (!href.includes(":") && !href.startsWith("//"))
    ) {
      if (!link.classList.contains("internal-link")) {
        try {
          href = decodeURI(href)
            .replace(/\u00a0/gu, " ")
            .trim()
            .normalize("NFC");
        } catch {
          continue;
        }
      }
      link.classList.remove("external-link");
      link.classList.add("internal-link");
      link.setAttribute("data-href", href);
    }
    link.setAttribute("target", "_blank");
    link.setAttribute("rel", "noopener nofollow");
    if (link.textContent === "") link.textContent = href;
  }
  return true;
}

function footnotes(body: HTMLElement, excerpt: Excerpt): void {
  if (excerpt.kind === "footnote") {
    const reference = Array.from(body.querySelectorAll("a[data-footref]")).find(
      (el) => el.getAttribute("data-footref") === excerpt.footnote,
    );
    const target = reference?.getAttribute("href")?.slice(1) ?? "";
    const note = Array.from(body.querySelectorAll(".footnotes > ol > li")).find(
      (el) => el.getAttribute("data-footnote-id") === target,
    );
    if (note !== undefined) {
      for (const backref of Array.from(
        note.querySelectorAll(":scope > .footnote-backref, :scope > p > .footnote-backref"),
      ))
        backref.remove();
      const nodes = Array.from(note.childNodes);
      note.remove();
      const remaining = Array.from(body.querySelectorAll(".footnotes"));
      body.replaceChildren(...nodes, ...remaining);
      body.createEl("a", {
        cls: `${CLASS}-footnote internal-link`,
        text: `[^${excerpt.footnote}]`,
        attr: { "data-href": `#[^${excerpt.footnote}]`, href: `#[^${excerpt.footnote}]` },
      });
      const label = body.lastElementChild;
      if (label !== null) body.prepend(label);
    }
  }
  for (const link of Array.from(body.querySelectorAll("a[data-footref]"))) {
    const id = link.getAttribute("data-footref");
    if (id === null || id.startsWith("[inline")) continue;
    link.className = "internal-link";
    link.setAttribute("data-href", `#[^${id}]`);
    link.setAttribute("href", `#[^${id}]`);
    link.textContent = `[^${id}]`;
  }
  for (const note of Array.from(body.querySelectorAll(".footnotes > ol > li"))) {
    if (note.textContent.replace(/\s|\u200b|↩︎/gu, "") === "") note.remove();
  }
  for (const section of Array.from(body.querySelectorAll(".footnotes")))
    if (section.querySelector("li") === null) section.remove();
}

/** Literal native matches, including aliases; no regexp supplied by a query is executed. */
export function highlightExcerpt(el: HTMLElement, nativeTerms: string[][]): boolean {
  if (nativeTerms.length === 0) return false;
  const terms = nativeTerms.map((alternatives) => [...alternatives]);
  // The native parser hides URL destinations, as it should. A search for that
  // destination highlights the visible link label instead of exposing syntax.
  for (const alternatives of terms) {
    if (alternatives.some((term) => el.textContent.includes(term))) continue;
    for (const link of Array.from(el.querySelectorAll("a"))) {
      const href = link.getAttribute("data-href") ?? link.getAttribute("href") ?? "";
      let decoded = href;
      try {
        decoded = decodeURIComponent(href);
      } catch {
        /* Keep a literal malformed URL. */
      }
      if (!alternatives.some((term) => href.includes(term) || decoded.includes(term))) continue;
      if (link.textContent === "") link.textContent = decoded;
      alternatives.push(link.textContent);
    }
  }
  const pattern = Array.from(new Set(terms.flat()))
    .filter((term) => term.length > 0)
    .sort((a, b) => b.length - a.length)
    .map((term) => term.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"))
    .join("|");
  if (pattern === "") return false;
  const regex = new RegExp(pattern, "gu");
  const walker = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes: Array<{ node: Text; from: number; to: number }> = [];
  let text = "";
  for (let node = walker.nextNode(); node !== null && nodes.length < 1200; node = walker.nextNode()) {
    const from = text.length;
    text += node.textContent;
    nodes.push({ node: node as Text, from, to: text.length });
    if (text.length > MAX_TEXT * 2) return false;
  }
  const complete = terms.every((alternatives) => alternatives.some((term) => text.includes(term)));
  const ranges = Array.from(text.matchAll(regex), (match) => [match.index, match.index + match[0].length] as const);
  let rangeIndex = 0;
  for (const { node, from, to } of nodes) {
    while ((ranges[rangeIndex]?.[1] ?? Infinity) <= from) rangeIndex++;
    const intersections: Array<readonly [number, number]> = [];
    for (let i = rangeIndex; i < ranges.length; i++) {
      const range = ranges[i];
      if (range === undefined || range[0] >= to) break;
      intersections.push(range);
    }
    if (intersections.length === 0) continue;
    const win = el.win as ObserverWindow;
    const fragment = win.createFragment();
    let cursor = 0;
    for (const [a, b] of intersections) {
      const left = Math.max(a, from) - from;
      const right = Math.min(b, to) - from;
      fragment.append(node.data.slice(cursor, left));
      const mark = win.createSpan();
      mark.className = "search-result-file-matched-text";
      mark.textContent = node.data.slice(left, right);
      fragment.append(mark);
      cursor = right;
    }
    fragment.append(node.data.slice(cursor));
    node.replaceWith(fragment);
  }
  return complete && ranges.length > 0;
}

/** Narrow adapters to native search result classes; all hooks are reversible. */
export const searchContext: Patch = {
  id: "search-context",
  name: "Search context",
  description: "Shows Markdown previews with heading and list context in search, backlinks and embedded queries.",

  register(plugin: Plugin, ctx: PatchContext): PatchHandle {
    const roots = new Map<HTMLElement, Root>();
    const matches = new WeakMap<HTMLElement, Match>();
    const indexes = new Map<CachedMetadata, ContextIndex>();
    const patched = new WeakMap<object, Set<string>>();
    const restores: Array<() => void> = [];
    const queue = new Set<RenderedMatch>();
    let disposed = false;
    let timer: number | null = null;
    let scanTimer: number | null = null;

    const enabled = (): boolean => !disposed && ctx.isEnabled();
    const invalidate = (record: RenderedMatch): void => {
      record.root.holder.infinityScroll.invalidate(record.match);
    };
    const clearHeight = (el: HTMLElement): boolean => {
      const reserved = el.classList.contains(PLACEHOLDER);
      el.classList.remove(PLACEHOLDER);
      el.style.removeProperty(HEIGHT);
      return reserved;
    };
    const saveHeight = (record: RenderedMatch): void => {
      if (record.host === null || !record.match.el.isConnected) return;
      const el = record.match.el;
      const height = (el.win as ObserverWindow).getComputedStyle(el).height;
      if (parseFloat(height) > 0 && el.style.getPropertyValue(HEIGHT) !== height) el.style.setProperty(HEIGHT, height);
    };
    const reset = (record: RenderedMatch, restore: boolean, reserve = false): void => {
      queue.delete(record);
      if (restore && record.host?.parentElement === record.match.el) {
        // Native virtualization detaches rows but retains their nodes and height
        // cache. Release render children without changing that cached geometry.
        if (reserve && record.match.el.style.getPropertyValue(HEIGHT) !== "")
          record.match.el.classList.add(PLACEHOLDER);
        record.match.el.replaceChildren(...record.originals);
        if (!reserve) {
          clearHeight(record.match.el);
          invalidate(record);
        }
      }
      record.host = null;
      record.originals = [];
    };
    const remove = (root: Root, el: HTMLElement): void => {
      const record = root.records.get(el);
      if (record === undefined) return;
      root.records.delete(el);
      root.intersection.unobserve(el);
      reset(record, true, true);
    };
    const hide = (root: Root): void => {
      for (const record of root.records.values()) {
        record.visible = false;
        reset(record, true, true);
      }
    };
    const release = (root: Root): void => {
      roots.delete(root.holder.el);
      root.observer.disconnect();
      root.intersection.disconnect();
      for (const record of root.records.values()) reset(record, true);
      root.records.clear();
      // Parked rows are owned by the native result tree, not a second cache.
      for (const result of root.holder.resultDomLookup.values()) {
        if (!isResult(result)) continue;
        for (const match of result.vChildren._children) {
          if (isMatch(match) && clearHeight(match.el)) root.holder.infinityScroll.invalidate(match);
        }
      }
      if (root.child !== null) root.owner?.removeChild(root.child);
      root.owner = null;
      root.child = null;
    };
    const getIndex = (cache: CachedMetadata): ContextIndex | null => {
      const existing = indexes.get(cache);
      if (existing !== undefined) return existing;
      const index = createContextIndex(cache);
      if (index === null) return null;
      if (indexes.size >= MAX_INDEXES) {
        const oldest = indexes.keys().next().value;
        if (oldest !== undefined) indexes.delete(oldest);
      }
      indexes.set(cache, index);
      return index;
    };

    const mount = (record: RenderedMatch, host: HTMLElement): void => {
      const { match } = record;
      record.originals = Array.from(match.el.childNodes);
      record.host = host;
      // Preserve native context and link-creation controls and their listeners.
      for (const node of record.originals) {
        if (isContentMatch(match) && (node === match.showMoreBeforeEl || node === match.showMoreAfterEl)) continue;
        if (element(node) && node.tagName !== "SPAN") continue;
        node.remove();
      }
      match.el.prepend(host);
      clearHeight(match.el);
      saveHeight(record);
      invalidate(record);
    };

    const render = (record: RenderedMatch): void => {
      const { match } = record;
      const index = isContentMatch(match) ? getIndex(match.cache) : null;
      const excerpt =
        index !== null && isContentMatch(match)
          ? searchExcerpt(match.content, match.start, match.end, match.matches, index)
          : null;
      if (isContentMatch(match) && excerpt === null) {
        if (clearHeight(match.el)) invalidate(record);
        return;
      }
      const host = (match.el.win as ObserverWindow).createDiv();
      host.className = CLASS;
      const body = host.createDiv({ cls: `${CLASS}-body markdown-rendered` });
      try {
        if (excerpt !== null) {
          if (excerpt.kind === "code") body.createEl("pre").createEl("code", { text: excerpt.markdown });
          else {
            const markdown =
              excerpt.kind === "inline"
                ? `<span>${escapeHtml(excerpt.markdown).replace(/\n/gu, "<br>")}</span>`
                : excerpt.markdown;
            if (!renderPreview(body, excerpt.definitions + markdown)) return;
            footnotes(body, excerpt);
          }
          if (excerpt.listStart !== null) {
            const list = body.querySelector("ol");
            if (list === null) return;
            list.start = excerpt.listStart;
          }
          if (!highlightExcerpt(body, excerpt.terms)) {
            // A query can explicitly target hidden Markdown syntax. Keep its
            // literal matched tokens visible without reverting rendered links.
            const source = body.createEl("code", {
              cls: `${CLASS}-source`,
              text: excerpt.terms.map((term) => term[0]).join(" … "),
            });
            highlightExcerpt(
              source,
              excerpt.terms.map((term) => term.slice(0, 1)),
            );
          }
          for (const heading of Array.from(body.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"))) {
            markLabel(heading, heading.tagName);
            heading.classList.add("is-heading");
          }
          if (excerpt.crumbs.length > 0) {
            const labels = host.createDiv({ cls: `${CLASS}-tree markdown-rendered` });
            // One native render for all ancestors, independent of nesting depth.
            // The inline wrapper preserves literal leading block/task markers
            // in headings, while native Markdown still renders links and emphasis.
            const markdown = excerpt.crumbs.map((crumb) => `- <span>${crumb.text}</span>`).join("\n");
            const rendered = renderPreview(labels, excerpt.definitions + markdown);
            if (rendered) footnotes(labels, { ...excerpt, kind: "markdown" });
            const list = labels.firstElementChild;
            const items = list === null ? [] : Array.from(list.children);
            if (
              rendered &&
              labels.children.length === 1 &&
              list?.tagName === "UL" &&
              items.length === excerpt.crumbs.length &&
              items.every((item) => item.tagName === "LI")
            ) {
              // Preserve the native Markdown nodes while arranging their hierarchy.
              list.classList.add(`${CLASS}-list`);
              let parent = list;
              for (const [i, crumb] of excerpt.crumbs.entries()) {
                const ancestor = items[i] as HTMLElement;
                ancestor.classList.add(`${CLASS}-ancestor`, `is-${crumb.kind}`);
                parent.append(ancestor);
                const nodes = Array.from(ancestor.childNodes);
                const label = ancestor.createDiv();
                const content = markLabel(label, crumb.marker, nodes);
                if (crumb.kind === "heading") {
                  label.classList.add("is-heading");
                  label.setAttribute("role", "heading");
                  label.setAttribute("aria-level", crumb.marker.slice(1));
                }
                // Actual wiki links keep their destinations. Plain labels are quiet
                // source-location links, with no nested buttons or disclosure icons.
                if (content.querySelector("a") === null) {
                  const children = Array.from(content.childNodes);
                  const location = content.createEl("a", {
                    cls: `${CLASS}-location`,
                    href: match.parentDom.file.path,
                    attr: { "data-context-line": String(crumb.line) },
                  });
                  location.append(...children);
                }
                parent = ancestor.createEl("ul", { cls: `${CLASS}-list ${CLASS}-children` });
              }
              parent.createEl("li", { cls: `${CLASS}-match` }).append(body);
            } else labels.remove();
          }
        } else if (!isPropertyMatchRow(match, isResult) || !renderProperties(body, match)) return;
        for (const input of Array.from(host.querySelectorAll<HTMLInputElement>("input"))) input.disabled = true;
        // Native row navigation handles plain text; rendered links retain their own target.
        const onLinkClick = (event: MouseEvent): void => {
          if (event.button !== 0 && event.button !== 1) return;
          const target = event.target;
          if (!element(target)) return;
          const link = target.closest<HTMLAnchorElement>("a");
          if (link === null) return;
          event.stopPropagation();
          if (link.classList.contains("tag")) {
            event.preventDefault();
            plugin.app.workspace
              .ensureSideLeaf("search", "left", {
                active: true,
                reveal: true,
                state: { query: `tag:${link.textContent}` },
              })
              .catch((error: unknown) => {
                console.error("Micropatches (search-context): tag search failed", error);
              });
            return;
          }
          if (link.classList.contains("footnote-link")) {
            event.preventDefault();
            const target = link.getAttribute("href")?.slice(1) ?? "";
            for (const node of Array.from(host.querySelectorAll("[data-footnote-id]")))
              if (node.getAttribute("data-footnote-id") === target) node.scrollIntoView({ block: "nearest" });
            return;
          }
          if (link.classList.contains(`${CLASS}-location`)) {
            event.preventDefault();
            const line = Number(link.getAttribute("data-context-line"));
            plugin.app.workspace
              .getLeaf(Keymap.isModEvent(event))
              .openFile(match.parentDom.file, { eState: { line } })
              .catch((error: unknown) => {
                console.error("Micropatches (search-context): navigation failed", error);
              });
            return;
          }
          if (!link.classList.contains("internal-link")) return;
          const href = link.getAttribute("data-href") ?? link.getAttribute("href");
          if (href === null) return;
          event.preventDefault();
          event.stopPropagation();
          plugin.app.workspace
            .openLinkText(href, match.parentDom.file.path, Keymap.isModEvent(event))
            .catch((error: unknown) => {
              console.error("Micropatches (search-context): opening link failed", error);
            });
        };
        host.addEventListener("click", onLinkClick);
        host.addEventListener("auxclick", onLinkClick);
        host.addEventListener("mouseover", (event) => {
          if (!element(event.target)) return;
          const link = event.target.closest<HTMLAnchorElement>("a");
          if (link === null) return;
          event.stopPropagation();
          const href = link.getAttribute("data-href") ?? link.getAttribute("href");
          if (link.classList.contains("internal-link") && href !== null)
            plugin.app.workspace.trigger("hover-link", {
              event,
              source: "search",
              hoverParent: record.root.holder,
              targetEl: link,
              linktext: href,
              sourcePath: match.parentDom.file.path,
            });
        });
        mount(record, host);
        for (const callout of Array.from(host.querySelectorAll<HTMLElement>(".callout"))) {
          const icon = callout.querySelector<HTMLElement>(".callout-icon");
          const name = (host.win as ObserverWindow)
            .getComputedStyle(callout)
            .getPropertyValue("--callout-icon")
            .trim()
            .replace(/^["']|["']$/gu, "");
          if (icon !== null && /^[\w-]+$/u.test(name)) setIcon(icon, name);
        }
      } finally {
        if (record.host !== host && clearHeight(match.el)) invalidate(record);
      }
    };

    const schedule = (): void => {
      if (!enabled() || timer !== null || queue.size === 0) return;
      timer = window.setTimeout(() => {
        timer = null;
        const record = queue.values().next().value;
        if (record === undefined) return;
        queue.delete(record);
        try {
          if (record.visible && record.match.el.isConnected && record.host === null) render(record);
        } catch (error) {
          if (clearHeight(record.match.el)) invalidate(record);
          console.error("Micropatches (search-context): preview failed", error);
        } finally {
          schedule();
        }
      }, 0);
    };
    const enqueue = (record: RenderedMatch): void => {
      if (!enabled() || !record.visible || record.host !== null) return;
      queue.add(record);
      schedule();
    };

    const watch = (root: Root, el: HTMLElement): void => {
      if (!enabled() || !el.isConnected || root.records.has(el)) return;
      const match = matches.get(el);
      if (match === undefined) return;
      const record: RenderedMatch = {
        match,
        root,
        visible: false,
        host: null,
        originals: [],
      };
      root.records.set(el, record);
      root.intersection.observe(el);
    };
    const visitElements = (node: Node, action: (el: HTMLElement) => void): void => {
      if (!element(node)) return;
      if (node.classList.contains("search-result-file-match")) action(node);
      for (const el of Array.from(node.querySelectorAll<HTMLElement>(".search-result-file-match"))) action(el);
    };
    const rootFor = (holder: Holder): Root => {
      const existing = roots.get(holder.el);
      if (existing !== undefined) return existing;
      const win = holder.el.win as ObserverWindow;
      const intersection = new win.IntersectionObserver(
        (entries) => {
          if (holder.el.offsetParent === null) {
            hide(root);
            return;
          }
          for (const entry of entries) {
            const record = root.records.get(entry.target as HTMLElement);
            if (record === undefined) continue;
            record.visible = entry.isIntersecting;
            if (record.visible) enqueue(record);
            else if (record.host === null) reset(record, true);
          }
        },
        { rootMargin: "300px 0px" },
      );
      const observer = new win.MutationObserver((mutations) => {
        if (!enabled()) return;
        root.mounted ||= holder.el.isConnected;
        for (const mutation of mutations) {
          for (const node of Array.from(mutation.removedNodes))
            visitElements(node, (el) => {
              if (!holder.el.contains(el)) remove(root, el);
            });
          for (const node of Array.from(mutation.addedNodes))
            visitElements(node, (el) => {
              watch(root, el);
            });
        }
      });
      const root: Root = {
        holder,
        observer,
        intersection,
        records: new Map(),
        mounted: holder.el.isConnected,
        discovered: false,
        owner: null,
        child: null,
      };
      roots.set(holder.el, root);
      wrap(holder.infinityScroll, "measure", (_self, _result, args) => {
        const match: unknown = args[1];
        if (!isMatch(match)) return;
        const record = roots.get(match.parentDom.parentDom.el)?.records.get(match.el);
        if (record !== undefined) saveHeight(record);
      });
      observer.observe(holder.el, { childList: true, subtree: true });
      return root;
    };

    const wrap = (
      value: object,
      key: string,
      after: (self: unknown, result: unknown, args: unknown[]) => void,
      before?: (self: unknown) => void,
    ): void => {
      const proto = Object.getPrototypeOf(value) as Record<string, unknown>;
      let keys = patched.get(proto);
      if (keys?.has(key) === true) return;
      const original = proto[key];
      if (typeof original !== "function") return;
      keys ??= new Set<string>();
      keys.add(key);
      patched.set(proto, keys);
      let active = true;
      const wrapped = function (this: unknown, ...args: unknown[]): unknown {
        if (active && enabled()) before?.(this);
        const result: unknown = Reflect.apply(original, this, args);
        if (active && enabled()) after(this, result, args);
        return result;
      };
      proto[key] = wrapped;
      restores.push(() => {
        active = false;
        if (proto[key] === wrapped) proto[key] = original;
        keys.delete(key);
      });
    };
    const rememberMatch = (value: unknown): void => {
      if (!isMatch(value)) return;
      const knownRoot = roots.get(value.parentDom.parentDom.el);
      if (knownRoot === undefined) {
        queueScan();
        return;
      }
      matches.set(value.el, value);
      wrap(
        value,
        "render",
        (self) => {
          if (!isMatch(self)) return;
          matches.set(self.el, self);
          const root = roots.get(self.parentDom.parentDom.el);
          if (root === undefined) {
            queueScan();
            return;
          }
          watch(root, self.el);
          const record = root.records.get(self.el);
          if (record !== undefined) enqueue(record);
        },
        (self) => {
          if (!isMatch(self)) return;
          clearHeight(self.el);
          const record = roots.get(self.parentDom.parentDom.el)?.records.get(self.el);
          if (record !== undefined) reset(record, false);
        },
      );
      watch(knownRoot, value.el);
    };
    const rememberResult = (value: unknown): void => {
      if (!isResult(value)) return;
      if (!roots.has(value.parentDom.el)) {
        queueScan();
        return;
      }
      wrap(value, "renderContentMatches", (self) => {
        if (isResult(self)) for (const match of self.vChildren._children) rememberMatch(match);
      });
      for (const match of value.vChildren._children) rememberMatch(match);
    };
    const discover = (value: unknown, owner?: Component): void => {
      if (!isHolder(value)) return;
      const root = rootFor(value);
      if (owner !== undefined && root.child === null) {
        const child = new Component();
        root.owner = owner;
        root.child = child;
        child.register(() => {
          if (roots.get(value.el) === root) release(root);
        });
        owner.addChild(child);
      }
      if (root.discovered) return;
      root.discovered = true;
      wrap(value, "addResult", (_self, result) => {
        rememberResult(result);
      });
      for (const result of value.resultDomLookup.values()) rememberResult(result);
    };
    const discoverQueries = (mode: unknown): void => {
      if (!object(mode)) return;
      const pending: unknown[] = [mode];
      const seen = new Set<unknown>();
      // Native Reading/Live Preview own query render children. No hooks on the
      // global Component class, and no unbounded traversal of plugin objects.
      while (pending.length > 0 && seen.size < 1000) {
        const child = pending.pop();
        if (!object(child) || seen.has(child)) continue;
        seen.add(child);
        const dom = child["dom"];
        if (
          isHolder(dom) &&
          dom.el === child["containerEl"] &&
          dom.el.closest(".internal-query") !== null &&
          typeof child["addChild"] === "function" &&
          typeof child["removeChild"] === "function"
        ) {
          discover(dom, child as unknown as Component);
          continue;
        }
        const children = child["_children"];
        if (Array.isArray(children))
          pending.push(...(children as unknown[]).slice(0, Math.max(0, 1000 - seen.size - pending.length)));
      }
    };
    const scan = (): void => {
      if (!enabled()) return;
      for (const root of roots.values()) {
        if (root.holder.el.isConnected) {
          root.mounted = true;
          if (root.holder.el.offsetParent === null) hide(root);
        } else if (root.mounted) release(root);
      }
      plugin.app.workspace.iterateAllLeaves((leaf) => {
        const view = leaf.view as unknown as Record<string, unknown>;
        const owner =
          typeof view["addChild"] === "function" && typeof view["removeChild"] === "function" ? leaf.view : undefined;
        discover(view["dom"], owner);
        discoverQueries(view["previewMode"]);
        discoverQueries(view["editMode"]);
        for (const key of ["backlink", "backlinks"]) {
          const controller = view[key];
          if (!object(controller)) continue;
          discover(controller["backlinkDom"], owner);
          discover(controller["unlinkedDom"], owner);
        }
      });
    };
    const queueScan = (): void => {
      if (!enabled() || scanTimer !== null) return;
      scanTimer = window.setTimeout(() => {
        scanTimer = null;
        scan();
      }, 0);
    };
    const clear = (): void => {
      if (timer !== null) window.clearTimeout(timer);
      if (scanTimer !== null) window.clearTimeout(scanTimer);
      timer = null;
      scanTimer = null;
      queue.clear();
      for (const root of Array.from(roots.values())) release(root);
      for (const restore of restores.splice(0).reverse()) restore();
      indexes.clear();
    };

    plugin.registerEvent(plugin.app.workspace.on("layout-change", queueScan));
    plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", queueScan));
    plugin.registerEvent(plugin.app.workspace.on("file-open", queueScan));
    plugin.registerEvent(plugin.app.workspace.on("window-open", queueScan));
    plugin.registerEvent(plugin.app.workspace.on("window-close", queueScan));
    plugin.app.workspace.onLayoutReady(queueScan);
    plugin.registerMarkdownPostProcessor((el) => {
      if (!enabled() || el.querySelector(".internal-query") === null) return;
      queueScan();
    });

    return {
      cleanup: (): void => {
        disposed = true;
        clear();
      },
      onToggle: (active: boolean): void => {
        if (active) queueScan();
        else clear();
      },
    };
  },
};
