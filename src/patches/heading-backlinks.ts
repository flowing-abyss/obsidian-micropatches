import { syntaxTree } from "@codemirror/language";
import { RangeSetBuilder, StateEffect, StateField, type Text } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  ViewPlugin,
  type ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import {
  editorInfoField,
  MarkdownRenderChild,
  MarkdownView,
  Notice,
  parseLinktext,
  resolveSubpath,
  setIcon,
  stripHeading,
  stripHeadingForLink,
  TFile,
  type App,
  type CachedMetadata,
  type MarkdownPostProcessorContext,
  type Plugin,
  type ReferenceCache,
  type SettingGroupItem,
} from "obsidian";
import type { Patch, PatchContext, PatchHandle } from "../patch";

interface HeadingBacklinkSource {
  sourceFilePath: string;
  sourceFileName: string;
  lineNumber: number;
  columnNumber: number;
  endOffset: number;
  startOffset: number;
  previewText: string;
  originalText: string;
  originalOrdinal: number;
  positionIsApproximate: boolean;
  propertyKey: string | null;
}

interface PositionedReference extends ReferenceCache {
  originalOrdinal: number;
  positionIsApproximate: boolean;
  propertyKey: string | null;
}

type HeadingBacklinkIndex = Map<string, Map<number, HeadingBacklinkSource[]>>;

interface IndexedContribution {
  targetPath: string;
  targetLine: number;
  source: HeadingBacklinkSource;
}

interface PendingHeadingRename {
  targetPath: string;
  oldHeading: string;
  newHeading: string | null;
  newLevel: number | null;
  headingOrdinal: number;
  lineNumber: number;
  lineStart: number;
  sourcePaths: string[];
  expectedLinks: number;
  previousHeadings: string[];
}

interface QueuedHeadingRename {
  rename: PendingHeadingRename;
  previousHeadings: Set<string>;
  sourcePaths: Set<string>;
  generation: number;
  startedWrites: boolean;
}

interface RenameController {
  cancelPendingRename(): void;
  commitPendingRename(): void;
}

interface TextReplacement {
  from: number;
  to: number;
  text: string;
}

const INDICATOR_CLASS = "micropatches-heading-backlink-indicator";
const LINKED_HEADING_CLASS = "micropatches-heading-has-backlinks";
const COUNT_CLASS = "micropatches-heading-backlink-count";
const POPOVER_CLASS = "micropatches-heading-backlinks-popover";
const POPOVER_TITLE_CLASS = "micropatches-heading-backlinks-title";
const POPOVER_LIST_CLASS = "micropatches-heading-backlinks-list";
const POPOVER_ITEM_CLASS = "micropatches-heading-backlinks-item";
const POPOVER_FILE_CLASS = "micropatches-heading-backlinks-file";
const POPOVER_FILENAME_CLASS = "micropatches-heading-backlinks-filename";
const POPOVER_PATH_CLASS = "micropatches-heading-backlinks-path";
const POPOVER_LINE_CLASS = "micropatches-heading-backlinks-line";
const POPOVER_PREVIEW_CLASS = "micropatches-heading-backlinks-preview";
const POPOVER_EMPTY_PREVIEW_CLASS = "is-empty";
const POPOVER_MORE_CLASS = "micropatches-heading-backlinks-more";
const HOVER_DELAY_MS = 260;
const HOVER_CLOSE_DELAY_MS = 220;
const INVALIDATE_DELAY_MS = 400;
const INDEX_SLICE_MS = 6;
const INCREMENTAL_SOURCE_LIMIT = 32;
const PREVIEW_PAGE_SIZE = 40;
const PREVIEW_READ_CONCURRENCY = 4;
const PREVIEW_CONTEXT_CHARS = 90;
const PREVIEW_MAX_CHARS = 180;
const RENAME_CACHE_WAIT_MS = 6000;
const RENAME_CACHE_POLL_MS = 75;
const REFERENCE_SEARCH_RADIUS = 8192;
const AUTO_RENAME_CONFIG = "autoRenameLinks";
const LINK_NOTICE_DURATION_MS = 1600;
const MAX_VISIBLE_LINK_NOTICES = 3;

function isHeadingSubpath(subpath: string): boolean {
  return subpath.startsWith("#") && !subpath.startsWith("#^");
}

function sourceReferences(cache: CachedMetadata): PositionedReference[] {
  const references: PositionedReference[] = [...(cache.links ?? []), ...(cache.embeds ?? [])].map((reference) => ({
    ...reference,
    originalOrdinal: 0,
    positionIsApproximate: false,
    propertyKey: null,
  }));
  if (cache.frontmatterPosition !== undefined) {
    const originalCounts = new Map<string, number>();
    for (const reference of cache.frontmatterLinks ?? []) {
      const originalOrdinal = originalCounts.get(reference.original) ?? 0;
      originalCounts.set(reference.original, originalOrdinal + 1);
      references.push({
        ...reference,
        position: cache.frontmatterPosition,
        originalOrdinal,
        positionIsApproximate: true,
        propertyKey: reference.key,
      });
    }
  }
  return references;
}

function sourceBasename(app: App, path: string): string {
  const file = app.vault.getFileByPath(path);
  if (file !== null) return file.basename;
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

function sourceParentPath(path: string): string {
  const separator = path.lastIndexOf("/");
  return separator === -1 ? "" : path.slice(0, separator);
}

function compareSources(left: HeadingBacklinkSource, right: HeadingBacklinkSource): number {
  return (
    left.sourceFileName.localeCompare(right.sourceFileName) ||
    left.sourceFilePath.localeCompare(right.sourceFilePath) ||
    left.lineNumber - right.lineNumber ||
    left.columnNumber - right.columnNumber
  );
}

function headingSignature(cache: CachedMetadata | null): string {
  return (cache?.headings ?? [])
    .map(({ heading, level, position }) => `${String(level)}\u0000${String(position.start.line)}\u0000${heading}`)
    .join("\u0001");
}

function buildReferencePreview(source: string, startOffset: number, endOffset: number): string {
  const lineStart = source.lastIndexOf("\n", Math.max(0, startOffset - 1)) + 1;
  const nextLineBreak = source.indexOf("\n", endOffset);
  const lineEnd = nextLineBreak === -1 ? source.length : nextLineBreak;
  const from = Math.max(lineStart, startOffset - PREVIEW_CONTEXT_CHARS);
  const to = Math.min(lineEnd, endOffset + PREVIEW_CONTEXT_CHARS);
  let preview = source.slice(from, to).replace(/\s+/gu, " ").trim();
  if (from > lineStart) preview = `…${preview}`;
  if (to < lineEnd) preview = `${preview}…`;
  if (preview.length <= PREVIEW_MAX_CHARS) return preview;
  return `${preview.slice(0, PREVIEW_MAX_CHARS - 1).trimEnd()}…`;
}

function refineApproximatePosition(text: string, source: HeadingBacklinkSource): void {
  if (!source.positionIsApproximate || source.originalText === "") return;
  let matchOffset = Math.max(0, source.startOffset);
  for (let ordinal = 0; ordinal <= source.originalOrdinal; ordinal++) {
    matchOffset = text.indexOf(source.originalText, matchOffset);
    if (matchOffset === -1 || matchOffset >= source.endOffset) return;
    if (ordinal < source.originalOrdinal) matchOffset += source.originalText.length;
  }

  const lineStart = text.lastIndexOf("\n", Math.max(0, matchOffset - 1)) + 1;
  let lineNumber = 0;
  for (let index = 0; index < lineStart; index++) {
    if (text.charCodeAt(index) === 10) lineNumber++;
  }
  source.lineNumber = lineNumber;
  source.columnNumber = matchOffset - lineStart;
  source.startOffset = matchOffset;
  source.endOffset = matchOffset + source.originalText.length;
  source.positionIsApproximate = false;
}

function normalizedHeading(heading: string): string {
  return stripHeading(heading).toLocaleLowerCase();
}

function markdownHeading(line: string): { heading: string; level: number } | null {
  const match = /^ {0,3}(#{1,6})[\t ]+(.*)$/u.exec(line);
  if (match === null) return null;
  const hashes = match[1];
  const rawHeading = match[2];
  if (hashes === undefined || rawHeading === undefined) return null;
  const heading = stripHeading(rawHeading.replace(/[\t ]+#+[\t ]*$/u, "").trim());
  return heading === "" ? null : { heading, level: hashes.length };
}

function documentHeading(doc: Text, lineNumber: number): { heading: string; level: number } | null {
  const line = doc.line(lineNumber);
  const atx = markdownHeading(line.text);
  if (atx !== null) return atx;
  if (lineNumber >= doc.lines) return null;
  const underline = /^ {0,3}(=+|-+)[\t ]*$/u.exec(doc.line(lineNumber + 1).text)?.[1];
  if (underline === undefined) return null;
  const heading = stripHeading(line.text.trim());
  return heading === "" ? null : { heading, level: underline.startsWith("=") ? 1 : 2 };
}

function referenceOccurrences(
  text: string,
  original: string,
  from: number,
  to: number,
  cache: Map<string, number[]>,
): number[] {
  const key = `${String(from)}\u0000${String(to)}\u0000${original}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const occurrences: number[] = [];
  let offset = text.indexOf(original, from);
  while (offset !== -1 && offset < to) {
    occurrences.push(offset);
    offset = text.indexOf(original, offset + Math.max(1, original.length));
  }
  cache.set(key, occurrences);
  return occurrences;
}

function locateReference(
  text: string,
  reference: PositionedReference,
  occurrenceCache: Map<string, number[]>,
): { from: number; to: number } | null {
  if (reference.original === "") return null;
  const expectedFrom = reference.position.start.offset;
  const expectedTo = reference.position.end.offset;
  if (text.slice(expectedFrom, expectedTo) === reference.original) {
    return { from: expectedFrom, to: expectedTo };
  }

  if (reference.positionIsApproximate) {
    const from = referenceOccurrences(
      text,
      reference.original,
      Math.max(0, expectedFrom),
      Math.min(text.length, expectedTo),
      occurrenceCache,
    )[reference.originalOrdinal];
    if (from === undefined) return null;
    return { from, to: from + reference.original.length };
  }

  const searchFrom = Math.max(0, expectedFrom - REFERENCE_SEARCH_RADIUS);
  const searchTo = Math.min(text.length, expectedTo + REFERENCE_SEARCH_RADIUS);
  const closest = referenceOccurrences(text, reference.original, searchFrom, searchTo, occurrenceCache).reduce<
    number | null
  >((best, offset) => {
    if (best === null) return offset;
    return Math.abs(offset - expectedFrom) < Math.abs(best - expectedFrom) ? offset : best;
  }, null);
  return closest === null ? null : { from: closest, to: closest + reference.original.length };
}

function rewriteReferenceHeading(original: string, heading: string): string | null {
  const linkHeading = stripHeadingForLink(heading);
  const wikiStart = original.indexOf("[[");
  if (wikiStart !== -1) {
    const wikiEnd = original.lastIndexOf("]]");
    if (wikiEnd === -1) return null;
    const alias = original.indexOf("|", wikiStart + 2);
    const targetEnd = alias === -1 || alias > wikiEnd ? wikiEnd : alias;
    const hash = original.indexOf("#", wikiStart + 2);
    if (hash === -1 || hash >= targetEnd) return null;
    return `${original.slice(0, hash + 1)}${linkHeading}${original.slice(targetEnd)}`;
  }

  const destinationMarker = original.indexOf("](");
  if (destinationMarker === -1) return null;
  let destinationStart = destinationMarker + 2;
  let destinationEnd: number;
  if (original[destinationStart] === "<") {
    destinationStart++;
    destinationEnd = original.indexOf(">", destinationStart);
    if (destinationEnd === -1) return null;
  } else {
    destinationEnd = original.length;
    let nestedParentheses = 0;
    let escaped = false;
    for (let index = destinationStart; index < original.length; index++) {
      const character = original[index];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
      } else if (character === "(") {
        nestedParentheses++;
      } else if (character === ")") {
        if (nestedParentheses === 0) {
          destinationEnd = index;
          break;
        }
        nestedParentheses--;
      } else if (/\s/u.test(character ?? "") && nestedParentheses === 0) {
        destinationEnd = index;
        break;
      }
    }
  }

  const destination = original.slice(destinationStart, destinationEnd);
  const hash = destination.indexOf("#");
  if (hash === -1) return null;
  const previousFragment = destination.slice(hash + 1);
  const nextFragment = /%[\dA-Fa-f]{2}/u.test(previousFragment) ? encodeURIComponent(linkHeading) : linkHeading;
  const rewrittenDestination = `${destination.slice(0, hash + 1)}${nextFragment}`;
  return `${original.slice(0, destinationStart)}${rewrittenDestination}${original.slice(destinationEnd)}`;
}

class BacklinkResolver {
  private readonly index: HeadingBacklinkIndex = new Map();
  private readonly contributionsBySource = new Map<string, IndexedContribution[]>();
  private readonly headingSignatures = new Map<string, string>();
  private readonly inboundSourcesByTarget = new Map<string, Set<string>>();
  private readonly headingTargetsBySource = new Map<string, Set<string>>();
  private readonly previewReads = new Map<string, Promise<string | null>>();
  private buildTimer: number | null = null;
  private buildGeneration = 0;
  private ready = false;

  constructor(private readonly app: App) {}

  startBuild(onComplete: () => void): void {
    this.reset();
    const generation = ++this.buildGeneration;
    const sourcePaths = Object.keys(this.app.metadataCache.resolvedLinks);
    let cursor = 0;

    const runSlice = (): void => {
      this.buildTimer = null;
      if (generation !== this.buildGeneration) return;
      const deadline = performance.now() + INDEX_SLICE_MS;
      while (cursor < sourcePaths.length && performance.now() < deadline) {
        const sourcePath = sourcePaths[cursor];
        cursor++;
        if (sourcePath === undefined) continue;
        const sourceCache = this.app.metadataCache.getCache(sourcePath);
        if (sourceCache === null) continue;
        this.headingSignatures.set(sourcePath, headingSignature(sourceCache));
        this.addSource(sourcePath, sourceCache);
      }

      if (cursor < sourcePaths.length) {
        this.buildTimer = window.setTimeout(runSlice, 0);
        return;
      }

      for (const byLine of this.index.values()) {
        for (const sources of byLine.values()) sources.sort(compareSources);
      }
      this.ready = true;
      onComplete();
    };

    this.buildTimer = window.setTimeout(runSlice, 0);
  }

  reset(): void {
    this.cancelBuild();
    this.index.clear();
    this.contributionsBySource.clear();
    this.headingSignatures.clear();
    this.inboundSourcesByTarget.clear();
    this.headingTargetsBySource.clear();
    this.ready = false;
  }

  cancelBuild(): void {
    this.buildGeneration++;
    if (this.buildTimer !== null) {
      window.clearTimeout(this.buildTimer);
      this.buildTimer = null;
    }
  }

  get(targetPath: string, headingLine: number): HeadingBacklinkSource[] {
    return this.index.get(targetPath)?.get(headingLine) ?? [];
  }

  updateFiles(paths: Iterable<string>): Set<string> | null {
    if (!this.ready) return null;
    const changedPaths = Array.from(paths);
    if (changedPaths.length > INCREMENTAL_SOURCE_LIMIT) return null;
    const affectedTargets = new Set<string>();
    const sourcesToRefresh = new Set<string>();
    const changedTargets = new Set<string>();

    for (const path of changedPaths) {
      affectedTargets.add(path);
      sourcesToRefresh.add(path);
      const cache = this.app.metadataCache.getCache(path);
      const previousSignature = this.headingSignatures.get(path);
      const nextSignature = headingSignature(cache);
      if (previousSignature !== nextSignature) changedTargets.add(path);
      if (cache === null) this.headingSignatures.delete(path);
      else this.headingSignatures.set(path, nextSignature);
    }

    for (const targetPath of changedTargets) {
      affectedTargets.add(targetPath);
      for (const sourcePath of this.inboundSourcesByTarget.get(targetPath) ?? []) {
        sourcesToRefresh.add(sourcePath);
        if (sourcesToRefresh.size > INCREMENTAL_SOURCE_LIMIT) return null;
      }
    }

    const touchedBuckets = new Set<HeadingBacklinkSource[]>();
    for (const sourcePath of sourcesToRefresh) this.removeSource(sourcePath, affectedTargets);
    for (const sourcePath of sourcesToRefresh) {
      this.clearHeadingTargets(sourcePath);
      const cache = this.app.metadataCache.getCache(sourcePath);
      if (cache !== null) this.addSource(sourcePath, cache, affectedTargets, touchedBuckets);
    }
    for (const sources of touchedBuckets) sources.sort(compareSources);
    for (const targetPath of changedTargets) {
      if (this.app.vault.getFileByPath(targetPath) === null) this.index.delete(targetPath);
    }
    return affectedTargets;
  }

  async loadPreviews(sources: HeadingBacklinkSource[], shouldContinue: () => boolean): Promise<void> {
    const byFile = new Map<string, HeadingBacklinkSource[]>();
    for (const source of sources) {
      if (source.previewText !== "") continue;
      const group = byFile.get(source.sourceFilePath);
      if (group === undefined) byFile.set(source.sourceFilePath, [source]);
      else group.push(source);
    }

    const groups = Array.from(byFile);
    let cursor = 0;
    const worker = async (): Promise<void> => {
      while (cursor < groups.length && shouldContinue()) {
        const group = groups[cursor];
        cursor++;
        if (group === undefined) continue;
        const [path, fileSources] = group;
        const text = await this.readSource(path);
        if (text === null || !shouldContinue()) continue;
        for (const source of fileSources) {
          refineApproximatePosition(text, source);
          source.previewText = buildReferencePreview(text, source.startOffset, source.endOffset);
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PREVIEW_READ_CONCURRENCY, groups.length) }, worker));
  }

  private readSource(path: string): Promise<string | null> {
    const existing = this.previewReads.get(path);
    if (existing !== undefined) return existing;
    const read = (async (): Promise<string | null> => {
      const file = this.app.vault.getFileByPath(path);
      return file === null ? null : this.app.vault.cachedRead(file);
    })();
    this.previewReads.set(path, read);
    void read.then(
      () => this.previewReads.delete(path),
      () => this.previewReads.delete(path),
    );
    return read;
  }

  private clearHeadingTargets(sourcePath: string): void {
    for (const targetPath of this.headingTargetsBySource.get(sourcePath) ?? []) {
      const sources = this.inboundSourcesByTarget.get(targetPath);
      sources?.delete(sourcePath);
      if (sources?.size === 0) this.inboundSourcesByTarget.delete(targetPath);
    }
    this.headingTargetsBySource.delete(sourcePath);
  }

  private addHeadingTarget(sourcePath: string, targetPath: string): void {
    let targets = this.headingTargetsBySource.get(sourcePath);
    if (targets === undefined) {
      targets = new Set();
      this.headingTargetsBySource.set(sourcePath, targets);
    }
    if (targets.has(targetPath)) return;
    targets.add(targetPath);
    let sources = this.inboundSourcesByTarget.get(targetPath);
    if (sources === undefined) {
      sources = new Set();
      this.inboundSourcesByTarget.set(targetPath, sources);
    }
    sources.add(sourcePath);
  }

  private removeSource(sourcePath: string, affectedTargets: Set<string>): void {
    const contributions = this.contributionsBySource.get(sourcePath) ?? [];
    this.contributionsBySource.delete(sourcePath);
    for (const contribution of contributions) {
      affectedTargets.add(contribution.targetPath);
      const byLine = this.index.get(contribution.targetPath);
      const sources = byLine?.get(contribution.targetLine);
      if (sources === undefined || byLine === undefined) continue;
      const sourceIndex = sources.indexOf(contribution.source);
      if (sourceIndex !== -1) sources.splice(sourceIndex, 1);
      if (sources.length === 0) byLine.delete(contribution.targetLine);
      if (byLine.size === 0) this.index.delete(contribution.targetPath);
    }
  }

  private addSource(
    sourcePath: string,
    sourceCache: CachedMetadata,
    affectedTargets?: Set<string>,
    touchedBuckets?: Set<HeadingBacklinkSource[]>,
  ): void {
    const contributions: IndexedContribution[] = [];
    const targetCaches = new Map<string, CachedMetadata | null>();
    const sourceFileName = sourceBasename(this.app, sourcePath);
    for (const reference of sourceReferences(sourceCache)) {
      if (!reference.link.includes("#")) continue;
      const { path: linkPath, subpath } = parseLinktext(reference.link);
      if (!isHeadingSubpath(subpath)) continue;

      const target =
        linkPath === ""
          ? this.app.vault.getFileByPath(sourcePath)
          : this.app.metadataCache.getFirstLinkpathDest(linkPath, sourcePath);
      if (!(target instanceof TFile) || target.extension !== "md") continue;
      this.addHeadingTarget(sourcePath, target.path);

      let targetCache = targetCaches.get(target.path);
      if (targetCache === undefined) {
        targetCache = this.app.metadataCache.getFileCache(target);
        targetCaches.set(target.path, targetCache);
      }
      if (targetCache === null) continue;
      if (!this.headingSignatures.has(target.path)) {
        this.headingSignatures.set(target.path, headingSignature(targetCache));
      }

      const resolved = resolveSubpath(targetCache, subpath);
      if (resolved?.type !== "heading") continue;

      let byLine = this.index.get(target.path);
      if (byLine === undefined) {
        byLine = new Map();
        this.index.set(target.path, byLine);
      }
      const targetLine = resolved.current.position.start.line;
      let sources = byLine.get(targetLine);
      if (sources === undefined) {
        sources = [];
        byLine.set(targetLine, sources);
      }
      const source: HeadingBacklinkSource = {
        sourceFilePath: sourcePath,
        sourceFileName,
        lineNumber: reference.position.start.line,
        columnNumber: reference.position.start.col,
        startOffset: reference.position.start.offset,
        endOffset: reference.position.end.offset,
        previewText: "",
        originalText: reference.original,
        originalOrdinal: reference.originalOrdinal,
        positionIsApproximate: reference.positionIsApproximate,
        propertyKey: reference.propertyKey,
      };
      sources.push(source);
      touchedBuckets?.add(sources);
      contributions.push({ targetPath: target.path, targetLine, source });
      affectedTargets?.add(target.path);
    }
    this.contributionsBySource.set(sourcePath, contributions);
  }
}

async function openSource(app: App, source: HeadingBacklinkSource): Promise<void> {
  const file = app.vault.getFileByPath(source.sourceFilePath);
  if (file === null) return;
  const leaf = app.workspace.getLeaf("tab");
  await leaf.openFile(file, { active: true, eState: { line: source.lineNumber } });
  app.workspace.setActiveLeaf(leaf, { focus: true });
  const win = leaf.view.containerEl.ownerDocument.defaultView ?? window;
  await new Promise<void>((resolve) => {
    win.requestAnimationFrame(() => win.requestAnimationFrame(() => resolve()));
  });
  const view = leaf.view;
  if (view instanceof MarkdownView && view.getMode() === "source") {
    if (source.propertyKey !== null) {
      const property = view.containerEl.querySelector<HTMLElement>(
        `.metadata-property[data-property-key="${win.CSS.escape(source.propertyKey)}"]`,
      );
      if (property !== null) {
        property.focus({ preventScroll: true });
        property.scrollIntoView({ block: "center", inline: "nearest" });
        return;
      }
    }
    const position = { line: source.lineNumber, ch: source.columnNumber };
    view.editor.focus();
    view.editor.setCursor(position);
    view.editor.scrollIntoView({ from: position, to: position }, true);
  } else {
    view.setEphemeralState({ line: source.lineNumber });
  }
}

function createTextElement(doc: Document, tag: "div" | "span", className: string, text: string): HTMLElement {
  const element = createOwnedElement(doc, tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function createOwnedElement<K extends keyof HTMLElementTagNameMap>(doc: Document, tag: K): HTMLElementTagNameMap[K] {
  return doc.createElementNS("http://www.w3.org/1999/xhtml", tag) as HTMLElementTagNameMap[K];
}

let nextPopoverId = 0;

class BacklinkPopover {
  private popoverEl: HTMLElement | null = null;
  private anchorEl: HTMLButtonElement | null = null;
  private sources: HeadingBacklinkSource[] = [];
  private closeTimer: number | null = null;
  private renderGeneration = 0;
  private renderLimit = PREVIEW_PAGE_SIZE;
  private repositionFrame: number | null = null;
  private readonly id = `micropatches-heading-backlinks-${String(++nextPopoverId)}`;

  constructor(
    private readonly app: App,
    private readonly resolver: BacklinkResolver,
  ) {}

  isOpenFor(anchor: HTMLButtonElement): boolean {
    return this.popoverEl !== null && this.anchorEl === anchor;
  }

  open(anchor: HTMLButtonElement, sources: HeadingBacklinkSource[]): void {
    this.cancelClose();
    if (this.isOpenFor(anchor)) return;
    this.close();

    this.anchorEl = anchor;
    this.sources = sources;
    this.renderLimit = Math.min(PREVIEW_PAGE_SIZE, sources.length);
    const doc = anchor.ownerDocument;
    const win = doc.defaultView ?? window;
    const popover = createOwnedElement(doc, "div");
    popover.id = this.id;
    popover.className = `popover hover-popover ${POPOVER_CLASS}`;
    popover.setAttribute("role", "dialog");
    popover.setAttribute("aria-label", "Links to this heading");
    popover.addEventListener("pointerenter", () => this.cancelClose());
    popover.addEventListener("pointerleave", () => this.scheduleClose());
    popover.addEventListener("focusin", () => this.cancelClose());
    popover.addEventListener("focusout", (event) => {
      const relatedTarget = event.relatedTarget;
      if (relatedTarget === null || !("nodeType" in relatedTarget) || !popover.contains(relatedTarget as Node)) {
        this.scheduleClose();
      }
    });
    doc.body.appendChild(popover);
    this.popoverEl = popover;
    anchor.setAttribute("aria-expanded", "true");
    anchor.setAttribute("aria-controls", this.id);
    this.render();
    this.position();

    doc.addEventListener("pointerdown", this.onDocumentPointerDown, true);
    doc.addEventListener("keydown", this.onDocumentKeyDown, true);
    win.addEventListener("resize", this.onResize);
    doc.addEventListener("scroll", this.onScroll, true);
    this.loadVisiblePreviews();
  }

  focusFirst(anchor: HTMLButtonElement, sources: HeadingBacklinkSource[]): void {
    this.open(anchor, sources);
    this.popoverEl?.querySelector<HTMLButtonElement>(`.${POPOVER_ITEM_CLASS}`)?.focus();
  }

  scheduleClose(): void {
    if (this.closeTimer !== null) return;
    const win = this.anchorEl?.ownerDocument.defaultView ?? window;
    this.closeTimer = win.setTimeout(() => {
      this.closeTimer = null;
      this.close();
    }, HOVER_CLOSE_DELAY_MS);
  }

  cancelClose(): void {
    if (this.closeTimer === null) return;
    const win = this.anchorEl?.ownerDocument.defaultView ?? window;
    win.clearTimeout(this.closeTimer);
    this.closeTimer = null;
  }

  close(): void {
    this.cancelClose();
    this.renderGeneration++;
    const popover = this.popoverEl;
    const anchor = this.anchorEl;
    this.popoverEl = null;
    this.anchorEl = null;
    this.sources = [];
    anchor?.setAttribute("aria-expanded", "false");
    anchor?.removeAttribute("aria-controls");
    popover?.remove();

    const doc = popover?.ownerDocument ?? anchor?.ownerDocument;
    const win = doc?.defaultView ?? window;
    doc?.removeEventListener("pointerdown", this.onDocumentPointerDown, true);
    doc?.removeEventListener("keydown", this.onDocumentKeyDown, true);
    doc?.removeEventListener("scroll", this.onScroll, true);
    win.removeEventListener("resize", this.onResize);
    if (this.repositionFrame !== null) {
      win.cancelAnimationFrame(this.repositionFrame);
      this.repositionFrame = null;
    }
  }

  private readonly onDocumentPointerDown = (event: PointerEvent): void => {
    const target = event.target;
    if (target === null || !("nodeType" in target)) return;
    const targetNode = target as Node;
    if (this.popoverEl?.contains(targetNode) === true || this.anchorEl?.contains(targetNode) === true) return;
    this.close();
  };

  private readonly onDocumentKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    const anchor = this.anchorEl;
    this.close();
    anchor?.focus({ preventScroll: true });
  };

  private readonly onResize = (): void => {
    this.scheduleReposition();
  };

  private readonly onScroll = (event: Event): void => {
    const target = event.target;
    if (target !== null && "nodeType" in target && this.popoverEl?.contains(target as Node) === true) {
      return;
    }
    this.scheduleReposition();
  };

  private scheduleReposition(): void {
    if (this.anchorEl?.isConnected !== true) {
      this.close();
      return;
    }
    if (this.repositionFrame !== null) return;
    const win = this.anchorEl.ownerDocument.defaultView ?? window;
    this.repositionFrame = win.requestAnimationFrame(() => {
      this.repositionFrame = null;
      this.position();
    });
  }

  private render(): void {
    const popover = this.popoverEl;
    if (popover === null) return;
    popover.replaceChildren();
    const doc = popover.ownerDocument;

    const title = createOwnedElement(doc, "div");
    title.className = POPOVER_TITLE_CLASS;
    title.append(
      createTextElement(doc, "span", "", "Linked from"),
      createTextElement(doc, "span", COUNT_CLASS, String(this.sources.length)),
    );
    popover.appendChild(title);

    const list = createOwnedElement(doc, "div");
    list.className = POPOVER_LIST_CLASS;
    const pathsByName = new Map<string, Set<string>>();
    for (const source of this.sources) {
      let paths = pathsByName.get(source.sourceFileName);
      if (paths === undefined) {
        paths = new Set();
        pathsByName.set(source.sourceFileName, paths);
      }
      paths.add(source.sourceFilePath);
    }
    for (const [index, source] of this.sources.slice(0, this.renderLimit).entries()) {
      const item = createOwnedElement(doc, "button");
      item.type = "button";
      item.className = POPOVER_ITEM_CLASS;
      item.dataset["sourceIndex"] = String(index);
      item.setAttribute("aria-label", `Open ${source.sourceFilePath}, line ${String(source.lineNumber + 1)}`);
      item.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.close();
        void (async (): Promise<void> => {
          try {
            await this.resolver.loadPreviews([source], () => true);
          } catch (error: unknown) {
            console.error("Micropatches (heading-backlinks): locating source link failed", error);
          }
          await openSource(this.app, source);
        })();
      });

      const file = createOwnedElement(doc, "span");
      file.className = POPOVER_FILE_CLASS;
      const icon = createOwnedElement(doc, "span");
      setIcon(icon, "file-text");
      const parentPath =
        (pathsByName.get(source.sourceFileName)?.size ?? 0) > 1 ? sourceParentPath(source.sourceFilePath) : "";
      file.append(
        icon,
        createTextElement(doc, "span", POPOVER_FILENAME_CLASS, source.sourceFileName),
        createTextElement(doc, "span", POPOVER_PATH_CLASS, parentPath === "" ? "" : ` · ${parentPath}`),
        createTextElement(doc, "span", POPOVER_LINE_CLASS, `:${String(source.lineNumber + 1)}`),
      );
      const preview = createTextElement(
        doc,
        "span",
        `${POPOVER_PREVIEW_CLASS}${source.previewText === "" ? ` ${POPOVER_EMPTY_PREVIEW_CLASS}` : ""}`,
        source.previewText === "" ? "Loading context…" : source.previewText,
      );
      item.append(file, preview);
      list.appendChild(item);
    }
    if (this.renderLimit < this.sources.length) {
      const remaining = this.sources.length - this.renderLimit;
      const more = createOwnedElement(doc, "button");
      more.type = "button";
      more.className = POPOVER_MORE_CLASS;
      more.textContent = `Show ${String(Math.min(PREVIEW_PAGE_SIZE, remaining))} more`;
      more.addEventListener("click", () => {
        const firstNewIndex = this.renderLimit;
        this.renderLimit = Math.min(this.sources.length, this.renderLimit + PREVIEW_PAGE_SIZE);
        this.render();
        this.loadVisiblePreviews();
        this.popoverEl?.querySelector<HTMLButtonElement>(`[data-source-index="${String(firstNewIndex)}"]`)?.focus();
        this.scheduleReposition();
      });
      list.appendChild(more);
    }
    popover.appendChild(list);
  }

  private loadVisiblePreviews(): void {
    const popover = this.popoverEl;
    if (popover === null) return;
    const generation = ++this.renderGeneration;
    const visibleSources = this.sources.slice(0, this.renderLimit);
    const isCurrent = (): boolean => generation === this.renderGeneration && this.popoverEl === popover;
    void this.resolver
      .loadPreviews(visibleSources, isCurrent)
      .then(() => {
        if (!isCurrent()) return;
        for (const item of Array.from(popover.querySelectorAll<HTMLElement>(`.${POPOVER_ITEM_CLASS}`))) {
          const index = Number(item.dataset["sourceIndex"]);
          const source = visibleSources[index];
          const preview = item.querySelector<HTMLElement>(`.${POPOVER_PREVIEW_CLASS}`);
          if (source === undefined || preview === null || source.previewText === "") continue;
          item.setAttribute("aria-label", `Open ${source.sourceFilePath}, line ${String(source.lineNumber + 1)}`);
          const line = item.querySelector<HTMLElement>(`.${POPOVER_LINE_CLASS}`);
          if (line !== null) line.textContent = `:${String(source.lineNumber + 1)}`;
          preview.textContent = source.previewText;
          preview.classList.remove(POPOVER_EMPTY_PREVIEW_CLASS);
        }
        this.scheduleReposition();
      })
      .catch((error: unknown) => {
        console.error("Micropatches (heading-backlinks): loading link previews failed", error);
      });
  }

  private position(): void {
    const popover = this.popoverEl;
    const anchor = this.anchorEl;
    if (popover === null || anchor === null) return;
    const anchorRect = anchor.getBoundingClientRect();
    const popoverRect = popover.getBoundingClientRect();
    const win = anchor.ownerDocument.defaultView ?? window;
    const edge = 8;
    const gap = 5;
    const left = Math.min(Math.max(edge, anchorRect.left), Math.max(edge, win.innerWidth - popoverRect.width - edge));
    const roomBelow = win.innerHeight - anchorRect.bottom;
    const top =
      roomBelow >= popoverRect.height + gap || anchorRect.top < popoverRect.height + gap
        ? anchorRect.bottom + gap
        : anchorRect.top - popoverRect.height - gap;
    const maxTop = Math.max(edge, win.innerHeight - popoverRect.height - edge);
    popover.style.left = `${String(Math.round(left))}px`;
    popover.style.top = `${String(Math.round(Math.min(maxTop, Math.max(edge, top))))}px`;
  }
}

class IndicatorController {
  private hoverTimer: number | null = null;
  private pointerOver = false;

  constructor(
    readonly button: HTMLButtonElement,
    private readonly sources: HeadingBacklinkSource[],
    private readonly popover: BacklinkPopover,
  ) {
    button.addEventListener("pointerenter", this.onPointerEnter);
    button.addEventListener("pointerleave", this.onPointerLeave);
    button.addEventListener("focus", this.onFocus);
    button.addEventListener("blur", this.onBlur);
    button.addEventListener("pointerdown", this.stopEditorEvent);
    button.addEventListener("keydown", this.onKeyDown);
    button.addEventListener("click", this.onClick);
  }

  dispose(): void {
    this.pointerOver = false;
    this.cancelHover();
    if (this.popover.isOpenFor(this.button)) this.popover.close();
    this.button.removeEventListener("pointerenter", this.onPointerEnter);
    this.button.removeEventListener("pointerleave", this.onPointerLeave);
    this.button.removeEventListener("focus", this.onFocus);
    this.button.removeEventListener("blur", this.onBlur);
    this.button.removeEventListener("pointerdown", this.stopEditorEvent);
    this.button.removeEventListener("keydown", this.onKeyDown);
    this.button.removeEventListener("click", this.onClick);
  }

  private readonly onPointerEnter = (): void => {
    this.pointerOver = true;
    this.popover.cancelClose();
    if (this.popover.isOpenFor(this.button) || this.hoverTimer !== null) return;
    const win = this.button.ownerDocument.defaultView ?? window;
    this.hoverTimer = win.setTimeout(() => {
      this.hoverTimer = null;
      if (this.pointerOver) this.popover.open(this.button, this.sources);
    }, HOVER_DELAY_MS);
  };

  private readonly onPointerLeave = (): void => {
    this.pointerOver = false;
    this.cancelHover();
    if (this.popover.isOpenFor(this.button)) this.popover.scheduleClose();
  };

  private readonly onFocus = (): void => {
    this.cancelHover();
  };

  private readonly onBlur = (): void => {
    this.popover.scheduleClose();
  };

  private readonly stopEditorEvent = (event: PointerEvent): void => {
    event.stopPropagation();
  };

  private readonly onClick = (event: MouseEvent): void => {
    event.preventDefault();
    event.stopPropagation();
    this.cancelHover();
    if (event.detail === 0) {
      this.popover.focusFirst(this.button, this.sources);
    } else if (this.popover.isOpenFor(this.button)) {
      this.popover.close();
    } else {
      this.popover.open(this.button, this.sources);
    }
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Enter" && event.key !== " " && event.key !== "ArrowDown") return;
    event.preventDefault();
    event.stopPropagation();
    this.cancelHover();
    this.popover.focusFirst(this.button, this.sources);
  };

  private cancelHover(): void {
    if (this.hoverTimer === null) return;
    const win = this.button.ownerDocument.defaultView ?? window;
    win.clearTimeout(this.hoverTimer);
    this.hoverTimer = null;
  }
}

function createIndicator(
  doc: Document,
  sources: HeadingBacklinkSource[],
  popover: BacklinkPopover,
): IndicatorController {
  const button = createOwnedElement(doc, "button");
  button.type = "button";
  button.className = `${INDICATOR_CLASS} clickable-icon`;
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-expanded", "false");
  button.setAttribute(
    "aria-label",
    `${String(sources.length)} ${sources.length === 1 ? "link" : "links"} to this heading`,
  );
  const icon = createOwnedElement(doc, "span");
  setIcon(icon, "link-2");
  button.appendChild(icon);
  return new IndicatorController(button, sources, popover);
}

class HeadingBacklinkWidget extends WidgetType {
  private controller: IndicatorController | null = null;

  constructor(
    private readonly sources: HeadingBacklinkSource[],
    private readonly getPopover: (win: Window) => BacklinkPopover,
    private readonly revision: number,
  ) {
    super();
  }

  override eq(other: HeadingBacklinkWidget): boolean {
    return other.revision === this.revision && other.sources === this.sources;
  }

  override toDOM(editorView: EditorView): HTMLElement {
    this.controller = createIndicator(editorView.dom.ownerDocument, this.sources, this.getPopover(editorView.dom.win));
    return this.controller.button;
  }

  override ignoreEvent(): boolean {
    return true;
  }

  override destroy(): void {
    this.controller?.dispose();
    this.controller = null;
  }
}

function readingHeadingLine(
  headingEl: HTMLElement,
  context: MarkdownPostProcessorContext,
  cache: CachedMetadata,
  usedLines: Set<number>,
): number | null {
  const section = context.getSectionInfo(headingEl);
  const headings = cache.headings ?? [];
  let direct: (typeof headings)[number] | undefined;
  if (section !== null) {
    let low = 0;
    let high = headings.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      const line = headings[middle]?.position.start.line ?? Number.POSITIVE_INFINITY;
      if (line < section.lineStart) low = middle + 1;
      else high = middle;
    }
    const candidate = headings[low];
    if (candidate?.position.start.line === section.lineStart) direct = candidate;
  }
  if (direct !== undefined && !usedLines.has(direct.position.start.line)) return direct.position.start.line;

  const renderedHeading = headingEl.dataset["heading"] ?? headingEl.textContent ?? "";
  const normalized = stripHeading(renderedHeading);
  const fallback = headings.find(
    (heading) =>
      !usedLines.has(heading.position.start.line) &&
      stripHeading(heading.heading) === normalized &&
      (section === null ||
        (heading.position.start.line >= section.lineStart && heading.position.start.line <= section.lineEnd)),
  );
  return fallback?.position.start.line ?? null;
}

const backlinkVersionEffect = StateEffect.define<number>();
const backlinkVersionField = StateField.define<number>({
  create: () => 0,
  update(value, transaction) {
    for (const effect of transaction.effects) if (effect.is(backlinkVersionEffect)) return effect.value;
    return value;
  },
});

export const headingBacklinks: Patch = {
  id: "heading-backlinks",
  name: "Heading backlinks",
  description:
    "Shows incoming links on headings and opens their exact sources. Automatic heading-link updates are available below.",

  settingDefinitions(_ctx: PatchContext, key: (configKey: string) => string): SettingGroupItem[] {
    return [
      {
        name: "Automatically update heading links",
        desc: "After you leave a renamed heading, update links to it across the vault. Off by default because it edits other notes. A batch that has begun writing finishes even if you turn this off, avoiding a partial result.",
        control: {
          type: "toggle",
          key: key(AUTO_RENAME_CONFIG),
          defaultValue: false,
        },
      },
    ];
  },

  register(plugin: Plugin, ctx: PatchContext): PatchHandle {
    const resolver = new BacklinkResolver(plugin.app);
    const editorViews = new Set<EditorView>();
    const popovers = new Map<Window, BacklinkPopover>();
    const popoverUnloadHandlers = new Map<Window, () => void>();
    const pendingPaths = new Set<string>();
    let version = 0;
    let invalidateTimer: number | null = null;
    let fullRefreshPending = false;
    let disposed = false;
    let renameBatchActive = false;
    let renameWorkerRunning = false;
    let activeRename: QueuedHeadingRename | null = null;
    const queuedRenames = new Map<string, QueuedHeadingRename>();
    const renameGenerations = new Map<string, number>();
    const recentRenames = new Map<string, { headings: Set<string>; sourcePaths: Set<string>; expectedLinks: number }>();
    const renameControllers = new Set<RenameController>();
    const linkNoticeQueue: Array<{ message: string; remaining: number }> = [];
    const visibleLinkNotices = new Set<Notice>();
    const linkNoticeTimers = new Set<number>();
    let linkNoticePumpTimer: number | null = null;

    const autoRenameEnabled = (): boolean => ctx.isEnabled() && ctx.getConfig(AUTO_RENAME_CONFIG, false);

    const scheduleLinkNoticePump = (): void => {
      if (disposed || linkNoticePumpTimer !== null) return;
      linkNoticePumpTimer = window.setTimeout(() => {
        linkNoticePumpTimer = null;
        while (visibleLinkNotices.size < MAX_VISIBLE_LINK_NOTICES) {
          const batch = linkNoticeQueue[0];
          if (batch === undefined) return;
          const notice = new Notice(batch.message, 0);
          visibleLinkNotices.add(notice);
          batch.remaining--;
          if (batch.remaining === 0) linkNoticeQueue.shift();
          const timer = window.setTimeout(() => {
            linkNoticeTimers.delete(timer);
            visibleLinkNotices.delete(notice);
            notice.hide();
            scheduleLinkNoticePump();
          }, LINK_NOTICE_DURATION_MS);
          linkNoticeTimers.add(timer);
        }
      }, 0);
    };

    const enqueueLinkNotices = (message: string, count: number): void => {
      if (count <= 0) return;
      const lastBatch = linkNoticeQueue[linkNoticeQueue.length - 1];
      if (lastBatch?.message === message) lastBatch.remaining += count;
      else linkNoticeQueue.push({ message, remaining: count });
      scheduleLinkNoticePump();
    };

    const clearLinkNotices = (): void => {
      if (linkNoticePumpTimer !== null) {
        window.clearTimeout(linkNoticePumpTimer);
        linkNoticePumpTimer = null;
      }
      for (const timer of linkNoticeTimers) window.clearTimeout(timer);
      linkNoticeTimers.clear();
      for (const notice of visibleLinkNotices) notice.hide();
      visibleLinkNotices.clear();
      linkNoticeQueue.length = 0;
    };

    const popoverFor = (win: Window): BacklinkPopover => {
      let popover = popovers.get(win);
      if (popover === undefined) {
        popover = new BacklinkPopover(plugin.app, resolver);
        popovers.set(win, popover);
        const onUnload = (): void => {
          popover?.close();
          popovers.delete(win);
          popoverUnloadHandlers.delete(win);
        };
        popoverUnloadHandlers.set(win, onUnload);
        win.addEventListener("unload", onUnload, { once: true });
      }
      return popover;
    };

    const notifyEditors = (affectedTargets: Set<string> | null): void => {
      version++;
      for (const view of editorViews) {
        const file = view.state.field(editorInfoField).file;
        if (file === null || (affectedTargets !== null && !affectedTargets.has(file.path))) continue;
        view.dispatch({ effects: backlinkVersionEffect.of(version) });
      }
    };

    const rerenderReadingViews = (affectedTargets: Set<string> | null): void => {
      for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
        const view = leaf.view;
        if (
          view instanceof MarkdownView &&
          view.file !== null &&
          view.getMode() === "preview" &&
          (affectedTargets === null || affectedTargets.has(view.file.path))
        ) {
          view.previewMode.rerender(true);
        }
      }
    };

    const closePopovers = (): void => {
      for (const popover of popovers.values()) popover.close();
    };

    const onIndexReady = (): void => {
      if (disposed || !ctx.isEnabled()) return;
      closePopovers();
      notifyEditors(null);
      rerenderReadingViews(null);
      if (pendingPaths.size > 0 || fullRefreshPending) ensureRefreshTimer();
    };

    const rebuildIndex = (): void => {
      resolver.reset();
      closePopovers();
      notifyEditors(null);
      rerenderReadingViews(null);
      if (ctx.isEnabled()) resolver.startBuild(onIndexReady);
    };

    const refreshAll = (): void => {
      if (disposed) return;
      pendingPaths.clear();
      fullRefreshPending = false;
      rebuildIndex();
    };

    const flushRefresh = (): void => {
      invalidateTimer = null;
      if (disposed) return;
      if (fullRefreshPending) {
        refreshAll();
        return;
      }

      const affectedTargets = resolver.updateFiles(pendingPaths);
      pendingPaths.clear();
      if (affectedTargets === null) {
        rebuildIndex();
        return;
      }
      if (affectedTargets.size === 0) return;
      closePopovers();
      notifyEditors(affectedTargets);
      rerenderReadingViews(affectedTargets);
    };

    const ensureRefreshTimer = (restart = false): void => {
      if (disposed) return;
      if (invalidateTimer !== null) {
        if (!restart) return;
        window.clearTimeout(invalidateTimer);
      }
      invalidateTimer = window.setTimeout(() => {
        flushRefresh();
      }, INVALIDATE_DELAY_MS);
    };

    const scheduleFileRefresh = (file: TFile): void => {
      pendingPaths.add(file.path);
      if (!renameBatchActive) ensureRefreshTimer(true);
    };

    const scheduleFullRefresh = (): void => {
      fullRefreshPending = true;
      if (!renameBatchActive) ensureRefreshTimer(true);
    };

    const headingMatchesRename = (rename: PendingHeadingRename): boolean => {
      if (rename.newHeading === null || rename.newLevel === null) return false;
      const target = plugin.app.vault.getFileByPath(rename.targetPath);
      if (target === null) return false;
      const headings = plugin.app.metadataCache.getFileCache(target)?.headings ?? [];
      const ordinalMatch = headings[rename.headingOrdinal];
      const closest = headings.reduce<(typeof headings)[number] | null>((best, heading) => {
        if (best === null) return heading;
        const bestDistance = Math.abs(best.position.start.line - rename.lineNumber);
        const distance = Math.abs(heading.position.start.line - rename.lineNumber);
        return distance < bestDistance ? heading : best;
      }, null);
      return [ordinalMatch, closest].some(
        (heading) =>
          heading !== undefined &&
          heading !== null &&
          heading.level === rename.newLevel &&
          stripHeading(heading.heading) === stripHeading(rename.newHeading ?? ""),
      );
    };

    const jobIsCurrent = (job: QueuedHeadingRename): boolean =>
      !disposed && renameGenerations.get(job.rename.targetPath) === job.generation;

    const waitForRenamedHeading = async (job: QueuedHeadingRename): Promise<TFile | null> => {
      const deadline = Date.now() + RENAME_CACHE_WAIT_MS;
      while (jobIsCurrent(job) && Date.now() < deadline) {
        const target = plugin.app.vault.getFileByPath(job.rename.targetPath);
        if (target === null) return null;
        if (headingMatchesRename(job.rename)) return target;
        await new Promise<void>((resolve) => window.setTimeout(resolve, RENAME_CACHE_POLL_MS));
      }
      return null;
    };

    const replacementsForSource = (source: TFile, text: string, job: QueuedHeadingRename): TextReplacement[] => {
      const cache = plugin.app.metadataCache.getFileCache(source);
      if (cache === null || job.rename.newHeading === null) return [];
      const previousHeadings = new Set(Array.from(job.previousHeadings, normalizedHeading));
      const replacements = new Map<string, TextReplacement>();
      const occurrenceCache = new Map<string, number[]>();

      for (const reference of sourceReferences(cache)) {
        const { path, subpath } = parseLinktext(reference.link);
        if (!isHeadingSubpath(subpath) || !previousHeadings.has(normalizedHeading(subpath.slice(1)))) continue;
        const target = path === "" ? source : plugin.app.metadataCache.getFirstLinkpathDest(path, source.path);
        if (target?.path !== job.rename.targetPath) continue;

        const possibleOriginals = new Set<string>([reference.original]);
        for (const previousHeading of job.previousHeadings) {
          const possibleOriginal = rewriteReferenceHeading(reference.original, previousHeading);
          if (possibleOriginal !== null) possibleOriginals.add(possibleOriginal);
        }
        for (const possibleOriginal of possibleOriginals) {
          const positionedReference = { ...reference, original: possibleOriginal };
          const range = locateReference(text, positionedReference, occurrenceCache);
          if (range === null) continue;
          const rewritten = rewriteReferenceHeading(possibleOriginal, job.rename.newHeading);
          if (rewritten === null || rewritten === possibleOriginal) break;
          replacements.set(`${String(range.from)}:${String(range.to)}`, { ...range, text: rewritten });
          break;
        }
      }

      return Array.from(replacements.values()).sort((left, right) => left.from - right.from);
    };

    const applyHeadingRename = async (job: QueuedHeadingRename): Promise<void> => {
      const rename = job.rename;
      if (
        rename.newHeading === null ||
        !Array.from(job.previousHeadings).some(
          (previousHeading) => stripHeading(previousHeading) !== stripHeading(rename.newHeading ?? ""),
        ) ||
        job.sourcePaths.size === 0 ||
        !jobIsCurrent(job) ||
        (!job.startedWrites && !autoRenameEnabled())
      ) {
        return;
      }
      const target = await waitForRenamedHeading(job);
      if (target === null || !jobIsCurrent(job) || (!job.startedWrites && !autoRenameEnabled())) return;

      let updatedLinks = 0;
      let failedFiles = 0;
      let missedFiles = 0;
      let canceled = false;
      for (const [index, sourcePath] of Array.from(job.sourcePaths).entries()) {
        if (!jobIsCurrent(job) || !headingMatchesRename(rename)) {
          canceled = true;
          break;
        }
        const source = plugin.app.vault.getFileByPath(sourcePath);
        if (source === null) continue;
        job.startedWrites = true;
        try {
          let replacementsApplied = 0;
          await plugin.app.vault.process(source, (text) => {
            if (!jobIsCurrent(job) || !headingMatchesRename(rename)) return text;
            const replacements = replacementsForSource(source, text, job);
            if (replacements.length === 0) return text;
            const chunks: string[] = [];
            let cursor = 0;
            let applied = 0;
            for (const replacement of replacements) {
              if (replacement.from < cursor) continue;
              chunks.push(text.slice(cursor, replacement.from), replacement.text);
              cursor = replacement.to;
              applied++;
            }
            replacementsApplied = applied;
            chunks.push(text.slice(cursor));
            return chunks.join("");
          });
          if (replacementsApplied > 0) {
            updatedLinks += replacementsApplied;
            const link = `[[${target.basename}#${stripHeadingForLink(rename.newHeading)}]]`;
            enqueueLinkNotices(`Updated: ${link}`, replacementsApplied);
          } else {
            missedFiles++;
          }
        } catch (error) {
          failedFiles++;
          console.error(`[Micropatches] Could not update heading links in ${source.path}`, error);
        }
        if (index % 8 === 7) await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      }

      if (canceled || !jobIsCurrent(job) || !headingMatchesRename(rename)) {
        if (!disposed && updatedLinks > 0) {
          new Notice("Heading changed again; remaining links will update after you leave it.");
        }
        return;
      }

      if (failedFiles > 0) {
        new Notice(`Could not update heading links in ${String(failedFiles)} notes. See the developer console.`);
      }
      const missingLinks = Math.max(0, rename.expectedLinks - updatedLinks);
      if (missingLinks > 0) {
        const linkLabel = missingLinks === 1 ? "link" : "links";
        const noteContext = missedFiles > 0 ? ` in ${String(missedFiles)} notes` : "";
        new Notice(`${String(missingLinks)} heading ${linkLabel} could not be updated${noteContext}.`);
      }
    };

    const rememberRename = (job: QueuedHeadingRename): void => {
      const headings = new Set(job.previousHeadings);
      if (job.rename.newHeading !== null) headings.add(job.rename.newHeading);
      recentRenames.delete(job.rename.targetPath);
      recentRenames.set(job.rename.targetPath, {
        headings,
        sourcePaths: new Set(job.sourcePaths),
        expectedLinks: job.rename.expectedLinks,
      });
      while (recentRenames.size > 32) {
        const oldest = recentRenames.keys().next().value;
        if (oldest === undefined) break;
        recentRenames.delete(oldest);
      }
    };

    const runRenameWorker = async (): Promise<void> => {
      if (renameWorkerRunning) return;
      renameWorkerRunning = true;
      renameBatchActive = true;
      if (invalidateTimer !== null) {
        window.clearTimeout(invalidateTimer);
        invalidateTimer = null;
      }
      try {
        while (!disposed && autoRenameEnabled() && queuedRenames.size > 0) {
          const entry = queuedRenames.entries().next().value;
          if (entry === undefined) break;
          const [targetPath, job] = entry;
          queuedRenames.delete(targetPath);
          activeRename = job;
          try {
            await applyHeadingRename(job);
          } catch (error) {
            console.error("[Micropatches] Could not update heading links", error);
          } finally {
            if (jobIsCurrent(job)) rememberRename(job);
            activeRename = null;
          }
        }
      } finally {
        renameBatchActive = false;
        renameWorkerRunning = false;
        if (!disposed && (pendingPaths.size > 0 || fullRefreshPending)) ensureRefreshTimer(true);
      }
    };

    const invalidateRenameTarget = (targetPath: string): void => {
      renameGenerations.set(targetPath, (renameGenerations.get(targetPath) ?? 0) + 1);
    };

    const cancelHeadingRenames = (finishActive: boolean): void => {
      for (const controller of renameControllers) controller.cancelPendingRename();
      if (activeRename !== null && (!finishActive || !activeRename.startedWrites)) {
        invalidateRenameTarget(activeRename.rename.targetPath);
      }
      for (const targetPath of queuedRenames.keys()) invalidateRenameTarget(targetPath);
      queuedRenames.clear();
      recentRenames.clear();
    };

    const enqueueHeadingRename = (rename: PendingHeadingRename): void => {
      if (!autoRenameEnabled()) return;
      const generation = (renameGenerations.get(rename.targetPath) ?? 0) + 1;
      renameGenerations.set(rename.targetPath, generation);
      const queued = queuedRenames.get(rename.targetPath);
      const related = [activeRename?.rename.targetPath === rename.targetPath ? activeRename : null, queued].filter(
        (job): job is QueuedHeadingRename => job !== null && job !== undefined,
      );
      const previousHeadings = new Set<string>(rename.previousHeadings);
      const sourcePaths = new Set(rename.sourcePaths);
      let expectedLinks = rename.expectedLinks;
      for (const job of related) {
        for (const heading of job.previousHeadings) previousHeadings.add(heading);
        if (job.rename.newHeading !== null) previousHeadings.add(job.rename.newHeading);
        for (const sourcePath of job.sourcePaths) sourcePaths.add(sourcePath);
        expectedLinks = Math.max(expectedLinks, job.rename.expectedLinks);
      }
      const recent = recentRenames.get(rename.targetPath);
      if (
        recent !== undefined &&
        Array.from(recent.headings, normalizedHeading).includes(normalizedHeading(rename.oldHeading))
      ) {
        for (const heading of recent.headings) previousHeadings.add(heading);
        for (const sourcePath of recent.sourcePaths) sourcePaths.add(sourcePath);
        expectedLinks = Math.max(expectedLinks, recent.expectedLinks);
      }
      rename.expectedLinks = expectedLinks;
      queuedRenames.set(rename.targetPath, { rename, previousHeadings, sourcePaths, generation, startedWrites: false });
      void runRenameWorker();
    };

    const renameSources = (
      targetPath: string,
      headingLine: number,
      oldHeading: string,
    ): { sourcePaths: string[]; expectedLinks: number; previousHeadings: string[] } => {
      const directSources = resolver.get(targetPath, headingLine);
      const sourcePaths = new Set(directSources.map(({ sourceFilePath }) => sourceFilePath));
      const previousHeadings = new Set([oldHeading]);
      const normalizedOldHeading = normalizedHeading(oldHeading);
      const addKnownSources = (job: QueuedHeadingRename): void => {
        const knownHeadings = new Set(Array.from(job.previousHeadings, normalizedHeading));
        if (job.rename.newHeading !== null) knownHeadings.add(normalizedHeading(job.rename.newHeading));
        if (!knownHeadings.has(normalizedOldHeading)) return;
        for (const sourcePath of job.sourcePaths) sourcePaths.add(sourcePath);
        for (const heading of job.previousHeadings) previousHeadings.add(heading);
        if (job.rename.newHeading !== null) previousHeadings.add(job.rename.newHeading);
      };
      if (activeRename?.rename.targetPath === targetPath) addKnownSources(activeRename);
      const queued = queuedRenames.get(targetPath);
      if (queued !== undefined) addKnownSources(queued);
      const recent = recentRenames.get(targetPath);
      if (recent !== undefined && Array.from(recent.headings, normalizedHeading).includes(normalizedOldHeading)) {
        for (const sourcePath of recent.sourcePaths) sourcePaths.add(sourcePath);
        for (const heading of recent.headings) previousHeadings.add(heading);
      }
      return {
        sourcePaths: Array.from(sourcePaths),
        expectedLinks: directSources.length,
        previousHeadings: Array.from(previousHeadings),
      };
    };

    const buildEditorDecorations = (view: EditorView): DecorationSet => {
      const builder = new RangeSetBuilder<Decoration>();
      if (!ctx.isEnabled()) return builder.finish();
      const info = view.state.field(editorInfoField);
      const file = info.file;
      if (file === null) return builder.finish();
      const cache = plugin.app.metadataCache.getFileCache(file);
      if (cache?.headings === undefined) return builder.finish();

      const ranges = view.visibleRanges;
      const headings = cache.headings;
      for (const range of ranges) {
        const firstLine = view.state.doc.lineAt(range.from).number - 1;
        const lastLine = view.state.doc.lineAt(range.to).number - 1;
        let low = 0;
        let high = headings.length;
        while (low < high) {
          const middle = Math.floor((low + high) / 2);
          const middleLine = headings[middle]?.position.start.line ?? Number.POSITIVE_INFINITY;
          if (middleLine < firstLine) low = middle + 1;
          else high = middle;
        }

        for (let index = low; index < headings.length; index++) {
          const lineNumber = headings[index]?.position.start.line;
          if (lineNumber === undefined || lineNumber > lastLine) break;
          if (lineNumber >= view.state.doc.lines) continue;
          const line = view.state.doc.line(lineNumber + 1);
          const sources = resolver.get(file.path, lineNumber);
          if (sources.length === 0) continue;
          builder.add(
            line.to,
            line.to,
            Decoration.widget({
              side: 1,
              widget: new HeadingBacklinkWidget(sources, popoverFor, version),
            }),
          );
        }
      }
      return builder.finish();
    };

    const buildEditorDecorationsFromDocument = (
      view: EditorView,
      mappedHeadingLines: readonly number[],
    ): DecorationSet => {
      const builder = new RangeSetBuilder<Decoration>();
      if (!ctx.isEnabled()) return builder.finish();
      const file = view.state.field(editorInfoField).file;
      if (file === null) return builder.finish();
      const headings = plugin.app.metadataCache.getFileCache(file)?.headings;
      if (headings === undefined) return builder.finish();

      const visibleLines = view.visibleRanges.map((range) => ({
        first: view.state.doc.lineAt(range.from).number,
        last: view.state.doc.lineAt(range.to).number,
      }));
      const decoratedLines = new Set<number>();
      for (let index = 0; index < headings.length; index++) {
        const cachedHeading = headings[index];
        const lineNumber = mappedHeadingLines[index];
        if (
          cachedHeading === undefined ||
          lineNumber === undefined ||
          lineNumber < 1 ||
          lineNumber > view.state.doc.lines ||
          !visibleLines.some(({ first, last }) => lineNumber >= first && lineNumber <= last) ||
          decoratedLines.has(lineNumber)
        ) {
          continue;
        }
        const line = view.state.doc.line(lineNumber);
        const currentHeading = documentHeading(view.state.doc, lineNumber);
        if (
          currentHeading === null ||
          currentHeading.level !== cachedHeading.level ||
          normalizedHeading(currentHeading.heading) !== normalizedHeading(cachedHeading.heading)
        ) {
          continue;
        }
        let syntaxNode = syntaxTree(view.state).resolveInner(line.from, 1);
        let isMarkdownHeading = false;
        for (;;) {
          const level = String(currentHeading.level);
          if (
            syntaxNode.name === `ATXHeading${level}` ||
            syntaxNode.name === `SetextHeading${level}` ||
            syntaxNode.name.split("_").includes(`HyperMD-header-${level}`)
          ) {
            isMarkdownHeading = true;
            break;
          }
          const parent = syntaxNode.parent;
          if (parent === null) break;
          syntaxNode = parent;
        }
        if (!isMarkdownHeading) continue;
        const sources = resolver.get(file.path, cachedHeading.position.start.line);
        if (sources.length === 0) continue;
        builder.add(
          line.to,
          line.to,
          Decoration.widget({
            side: 1,
            widget: new HeadingBacklinkWidget(sources, popoverFor, version),
          }),
        );
        decoratedLines.add(lineNumber);
      }
      return builder.finish();
    };

    const changesLineStructure = (update: ViewUpdate): boolean => {
      let changed = false;
      update.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
        if (
          inserted.lines > 1 ||
          update.startState.doc.lineAt(fromA).number !== update.startState.doc.lineAt(toA).number
        ) {
          changed = true;
        }
      });
      return changed;
    };

    const editorExtension = ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        private seenVersion: number;
        private seenFilePath: string | null;
        private structureDirty = false;
        private mappedHeadingLines: number[] | null = null;
        private readonly view: EditorView;
        private pendingRename: PendingHeadingRename | null = null;
        private readonly onFocusOut = (): void => {
          window.setTimeout(() => {
            if (!this.view.hasFocus) this.commitPendingRename();
          }, 0);
        };

        constructor(view: EditorView) {
          this.view = view;
          editorViews.add(view);
          renameControllers.add(this);
          this.seenVersion = view.state.field(backlinkVersionField);
          this.seenFilePath = view.state.field(editorInfoField).file?.path ?? null;
          this.decorations = buildEditorDecorations(view);
          view.dom.addEventListener("focusout", this.onFocusOut);
        }

        commitPendingRename(): void {
          if (this.pendingRename === null) return;
          const rename = this.pendingRename;
          this.pendingRename = null;
          enqueueHeadingRename(rename);
        }

        cancelPendingRename(): void {
          if (this.pendingRename !== null) invalidateRenameTarget(this.pendingRename.targetPath);
          this.pendingRename = null;
        }

        private capturePendingRename(update: ViewUpdate): void {
          if (!autoRenameEnabled()) return;
          const isUserEdit = update.transactions.some(
            (transaction) =>
              transaction.isUserEvent("input") ||
              transaction.isUserEvent("delete") ||
              transaction.isUserEvent("undo") ||
              transaction.isUserEvent("redo"),
          );
          if (!isUserEdit) return;
          const file = update.startState.field(editorInfoField).file;
          if (file === null) return;
          const changedLines = new Set<number>();
          let tooLarge = false;
          update.changes.iterChangedRanges((fromA, toA) => {
            if (tooLarge) return;
            const firstLine = update.startState.doc.lineAt(fromA).number;
            const lastLine = update.startState.doc.lineAt(toA).number;
            if (changedLines.size + lastLine - firstLine + 1 > 8) {
              tooLarge = true;
              changedLines.clear();
              return;
            }
            for (let lineNumber = firstLine; lineNumber <= lastLine; lineNumber++) changedLines.add(lineNumber);
          });
          if (tooLarge || changedLines.size === 0) return;

          const selectionLine = update.startState.doc.lineAt(update.startState.selection.main.head).number;
          const orderedLines = Array.from(changedLines).sort(
            (left, right) => Number(right === selectionLine) - Number(left === selectionLine),
          );
          const candidates = new Map<
            number,
            {
              line: ReturnType<Text["line"]>;
              previousHeading: { heading: string; level: number };
              sources: { sourcePaths: string[]; expectedLinks: number; previousHeadings: string[] };
            }
          >();
          for (const lineNumber of orderedLines) {
            let headingLineNumber = lineNumber;
            let previousHeading = documentHeading(update.startState.doc, headingLineNumber);
            if (previousHeading === null && headingLineNumber > 1) {
              const previousLineHeading = documentHeading(update.startState.doc, headingLineNumber - 1);
              if (previousLineHeading !== null) {
                headingLineNumber--;
                previousHeading = previousLineHeading;
              }
            }
            if (previousHeading === null) continue;
            const sources = renameSources(file.path, headingLineNumber - 1, previousHeading.heading);
            if (sources.sourcePaths.length === 0) continue;
            candidates.set(headingLineNumber, {
              line: update.startState.doc.line(headingLineNumber),
              previousHeading,
              sources,
            });
          }
          const candidate = candidates.values().next().value;
          if (candidate === undefined || candidates.size !== 1) return;
          const { line, previousHeading, sources } = candidate;
          const mappedLine = update.state.doc.lineAt(update.changes.mapPos(line.from, 1));
          const nextHeading = documentHeading(update.state.doc, mappedLine.number);
          const cachedHeadings = plugin.app.metadataCache.getFileCache(file)?.headings ?? [];
          invalidateRenameTarget(file.path);
          this.pendingRename = {
            targetPath: file.path,
            oldHeading: previousHeading.heading,
            newHeading: nextHeading?.heading ?? null,
            newLevel: nextHeading?.level ?? null,
            headingOrdinal: Math.max(
              0,
              cachedHeadings.findIndex(({ position }) => position.start.line === line.number - 1),
            ),
            lineNumber: mappedLine.number - 1,
            lineStart: mappedLine.from,
            sourcePaths: sources.sourcePaths,
            expectedLinks: sources.expectedLinks,
            previousHeadings: sources.previousHeadings,
          };
        }

        private updatePendingRename(update: ViewUpdate): void {
          const pending = this.pendingRename;
          if (pending === null) return;
          const mappedStart = update.changes.mapPos(pending.lineStart, 1);
          const line = update.state.doc.lineAt(mappedStart);
          const heading = documentHeading(update.state.doc, line.number);
          pending.lineStart = line.from;
          pending.lineNumber = line.number - 1;
          pending.newHeading = heading?.heading ?? null;
          pending.newLevel = heading?.level ?? null;
        }

        private mapHeadingLines(update: ViewUpdate): void {
          const file = update.startState.field(editorInfoField).file;
          const headings = file === null ? undefined : plugin.app.metadataCache.getFileCache(file)?.headings;
          if (headings === undefined) {
            this.mappedHeadingLines = [];
            return;
          }
          const previousLines = this.mappedHeadingLines ?? headings.map(({ position }) => position.start.line + 1);
          this.mappedHeadingLines = previousLines.map((lineNumber) => {
            const boundedLine = Math.max(1, Math.min(lineNumber, update.startState.doc.lines));
            const oldPosition = update.startState.doc.line(boundedLine).from;
            return update.state.doc.lineAt(update.changes.mapPos(oldPosition, 1)).number;
          });
        }

        update(update: ViewUpdate): void {
          const nextVersion = update.state.field(backlinkVersionField);
          const nextFilePath = update.state.field(editorInfoField).file?.path ?? null;
          if (nextFilePath !== this.seenFilePath) this.commitPendingRename();
          if (update.docChanged && nextFilePath === this.seenFilePath) {
            if (this.pendingRename === null) this.capturePendingRename(update);
            else this.updatePendingRename(update);
          }
          if (nextFilePath !== this.seenFilePath || nextVersion !== this.seenVersion) {
            this.seenFilePath = nextFilePath;
            this.seenVersion = nextVersion;
            this.structureDirty = false;
            this.mappedHeadingLines = null;
            this.decorations = buildEditorDecorations(update.view);
          } else if (update.docChanged) {
            if (changesLineStructure(update)) {
              this.structureDirty = true;
              this.mapHeadingLines(update);
              this.decorations = buildEditorDecorationsFromDocument(update.view, this.mappedHeadingLines ?? []);
            } else {
              this.decorations = this.decorations.map(update.changes);
            }
          } else if (update.viewportChanged) {
            this.decorations = this.structureDirty
              ? buildEditorDecorationsFromDocument(update.view, this.mappedHeadingLines ?? [])
              : buildEditorDecorations(update.view);
          }

          if (this.pendingRename !== null) {
            const selectionLine = update.state.doc.lineAt(update.state.selection.main.head);
            if (selectionLine.from !== this.pendingRename.lineStart) this.commitPendingRename();
          }
        }

        destroy(): void {
          this.commitPendingRename();
          this.view.dom.removeEventListener("focusout", this.onFocusOut);
          editorViews.delete(this.view);
          renameControllers.delete(this);
        }
      },
      { decorations: (value) => value.decorations },
    );
    plugin.registerEditorExtension([backlinkVersionField, editorExtension]);

    plugin.registerMarkdownPostProcessor((el: HTMLElement, mdContext: MarkdownPostProcessorContext) => {
      if (!ctx.isEnabled()) return;
      const file = plugin.app.vault.getFileByPath(mdContext.sourcePath);
      if (file === null) return;
      const cache = plugin.app.metadataCache.getFileCache(file);
      if (cache === null) return;
      const usedLines = new Set<number>();
      const controllers: IndicatorController[] = [];
      const ownerWindow = el.ownerDocument.defaultView ?? window;

      for (const headingEl of Array.from(el.querySelectorAll<HTMLElement>("h1, h2, h3, h4, h5, h6"))) {
        if (headingEl.querySelector(`:scope > .${INDICATOR_CLASS}`) !== null) continue;
        const line = readingHeadingLine(headingEl, mdContext, cache, usedLines);
        if (line === null) continue;
        usedLines.add(line);
        const sources = resolver.get(file.path, line);
        if (sources.length === 0) continue;
        const controller = createIndicator(el.ownerDocument, sources, popoverFor(ownerWindow));
        headingEl.classList.add(LINKED_HEADING_CLASS);
        headingEl.appendChild(controller.button);
        controllers.push(controller);
      }

      if (controllers.length > 0) {
        const child = new MarkdownRenderChild(el);
        child.register(() => {
          for (const controller of controllers) controller.dispose();
          for (const headingEl of Array.from(el.querySelectorAll<HTMLElement>(`.${LINKED_HEADING_CLASS}`))) {
            headingEl.classList.remove(LINKED_HEADING_CLASS);
          }
        });
        mdContext.addChild(child);
      }
    });

    plugin.registerEvent(plugin.app.metadataCache.on("changed", scheduleFileRefresh));
    plugin.registerEvent(plugin.app.metadataCache.on("deleted", scheduleFileRefresh));
    plugin.registerEvent(plugin.app.metadataCache.on("resolve", scheduleFileRefresh));
    plugin.registerEvent(plugin.app.vault.on("rename", scheduleFullRefresh));
    plugin.registerEvent(
      plugin.app.workspace.on("active-leaf-change", () => {
        for (const controller of renameControllers) controller.commitPendingRename();
      }),
    );
    if (ctx.isEnabled()) resolver.startBuild(onIndexReady);

    return {
      cleanup: (): void => {
        cancelHeadingRenames(false);
        clearLinkNotices();
        disposed = true;
        resolver.reset();
        if (invalidateTimer !== null) {
          window.clearTimeout(invalidateTimer);
          invalidateTimer = null;
        }
        pendingPaths.clear();
        for (const [win, popover] of popovers) {
          popover.close();
          for (const button of Array.from(win.document.querySelectorAll<HTMLElement>(`.${INDICATOR_CLASS}`))) {
            button.remove();
          }
          const onUnload = popoverUnloadHandlers.get(win);
          if (onUnload !== undefined) win.removeEventListener("unload", onUnload);
        }
        editorViews.clear();
        renameControllers.clear();
        popovers.clear();
        popoverUnloadHandlers.clear();
      },
      onToggle: (enabled: boolean): void => {
        if (!enabled) cancelHeadingRenames(true);
        refreshAll();
      },
      onConfigChange: (key: string, value: unknown): void => {
        if (key === AUTO_RENAME_CONFIG && value !== true) cancelHeadingRenames(true);
      },
    };
  },
};
