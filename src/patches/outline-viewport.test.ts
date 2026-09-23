import type { MarkdownView as MarkdownViewOriginal, PluginManifest } from "obsidian";
import { App, MarkdownView, Plugin, WorkspaceLeaf } from "obsidian-test-mocks/obsidian";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { isOutline, outlineViewport, readingLine } from "./outline-viewport";

const manifest: PluginManifest = {
  id: "micropatches",
  name: "Micropatches",
  author: "test",
  version: "0.0.0",
  minAppVersion: "1.13.0",
  description: "test",
};

class TestPlugin extends Plugin {}

interface Renderer {
  previewEl: HTMLElement;
  topSpace: number;
  sections: unknown[];
}

interface FakeOutline {
  followCursor: boolean;
  findActiveHeading: (owner: unknown) => unknown;
  getOwner: () => unknown;
  setHighlightedItem: Mock<(item: unknown) => void>;
  onToggleFollowCursor: Mock<() => void>;
}

function viewport(scrollTop: number, clientHeight = 400): HTMLElement {
  const el = createDiv();
  Object.defineProperty(el, "clientHeight", { value: clientHeight });
  Object.defineProperty(el, "scrollTop", { value: scrollTop, writable: true });
  return el;
}

function section(line: number, lines: number, height: number, extra: Record<string, unknown> = {}) {
  return { start: { line }, lines, height, computed: true, shown: true, ...extra };
}

// Three sections: lines 0-2 (100px), 3-7 (150px) and 8-9 (100px).
const SECTIONS = [section(0, 3, 100), section(3, 5, 150), section(8, 2, 100)];

function reading(renderer: Partial<Renderer> | undefined): MarkdownViewOriginal {
  return { previewMode: { renderer } } as unknown as MarkdownViewOriginal;
}

// Native lookup echoes what it was asked about, so tests can see the owner or line.
function fakeOutline(owner: unknown, native: Mock<(owner: unknown) => unknown>): FakeOutline {
  const outline: FakeOutline = {
    followCursor: false,
    findActiveHeading: native,
    getOwner: () => owner,
    setHighlightedItem: vi.fn(),
    onToggleFollowCursor: vi.fn(() => {
      outline.followCursor = !outline.followCursor;
    }),
  };
  return outline;
}

function setup(renderer: Partial<Renderer> = { previewEl: viewport(0), topSpace: 0, sections: SECTIONS }) {
  const app = App.createConfigured__({ files: { "Note.md": "# A" } });
  app.workspace.setLayoutReady__();
  const view = MarkdownView.create2__(WorkspaceLeaf.create2__(app));
  view.file = app.vault.getFileByPath("Note.md");
  vi.spyOn(view, "getMode").mockReturnValue("preview");
  Object.assign(view.previewMode, { renderer });
  const native = vi.fn((owner: unknown) => owner);
  const outline = fakeOutline(view, native);
  const outlines: FakeOutline[] = [outline];
  vi.spyOn(app.workspace, "getLeavesOfType").mockImplementation((type) =>
    type === "outline" ? outlines.map((leafView) => ({ view: leafView }) as unknown as WorkspaceLeaf) : [],
  );
  let enabled = true;
  const handle = outlineViewport.register(new TestPlugin(app, manifest).asOriginalType2__(), {
    isEnabled: () => enabled,
    getConfig: <T>(_key: string, fallback: T): T => fallback,
    setConfig: () => Promise.resolve(),
  });
  frame();
  return {
    app,
    view,
    native,
    outline,
    outlines,
    handle,
    rescan: (): void => {
      app.workspace.trigger("layout-change");
      frame();
    },
    setEnabled: (value: boolean): void => {
      enabled = value;
      handle.onToggle?.(value);
    },
  };
}

// Scans and highlights each wait for an animation frame; a scan's highlight comes one frame later.
function frame(): void {
  vi.advanceTimersByTime(32);
}

describe("isOutline", () => {
  it("accepts an Outline view with every piece it uses", () => {
    expect(isOutline(fakeOutline(null, vi.fn()))).toBe(true);
  });

  it("rejects views missing any piece", () => {
    expect(isOutline(null)).toBe(false);
    for (const key of ["findActiveHeading", "getOwner", "setHighlightedItem", "onToggleFollowCursor", "followCursor"]) {
      const outline = fakeOutline(null, vi.fn());
      Reflect.deleteProperty(outline, key);
      expect(isOutline(outline), key).toBe(false);
    }
    expect(isOutline({ ...fakeOutline(null, vi.fn()), followCursor: "true" })).toBe(false);
  });
});

describe("readingLine", () => {
  it("returns the first line of the section at the middle of the viewport", () => {
    // The middle is 200px down, inside the second section (100-250px).
    expect(readingLine(reading({ previewEl: viewport(0), topSpace: 0, sections: SECTIONS }))).toBe(3);
    // A section ending exactly at the middle still counts.
    expect(readingLine(reading({ previewEl: viewport(50), topSpace: 0, sections: SECTIONS }))).toBe(3);
    expect(readingLine(reading({ previewEl: viewport(150), topSpace: 0, sections: SECTIONS }))).toBe(8);
    expect(readingLine(reading({ previewEl: viewport(5000), topSpace: 0, sections: SECTIONS }))).toBe(8);
  });

  it("counts the space above the first section", () => {
    expect(readingLine(reading({ previewEl: viewport(0), topSpace: 120, sections: SECTIONS }))).toBe(0);
  });

  it("skips folded sections", () => {
    const sections = [section(0, 3, 100), section(3, 5, 150, { shown: false }), section(8, 2, 100)];
    expect(readingLine(reading({ previewEl: viewport(0), topSpace: 0, sections }))).toBe(8);
  });

  it("keeps the previous line across sections without lines", () => {
    const sections = [section(0, 3, 100), section(3, 0, 150), section(8, 2, 100)];
    expect(readingLine(reading({ previewEl: viewport(0), topSpace: 0, sections }))).toBe(0);
  });

  it("returns null without a usable renderer", () => {
    const previewEl = viewport(0);
    expect(readingLine(reading(undefined))).toBeNull();
    expect(readingLine(reading({ topSpace: 0, sections: SECTIONS }))).toBeNull();
    expect(readingLine(reading({ previewEl, sections: SECTIONS }))).toBeNull();
    expect(readingLine(reading({ previewEl, topSpace: 0 }))).toBeNull();
    expect(readingLine(reading({ previewEl: viewport(0, 0), topSpace: 0, sections: SECTIONS }))).toBeNull();
  });

  it("returns null when a section before the middle is malformed", () => {
    const malformed = [
      { lines: 3, height: 100, computed: true, shown: true },
      section(0, 3, 100, { start: { line: "0" } }),
      section(0, 3, 100, { lines: "3" }),
      section(0, 3, Number.NaN),
      section(0, 3, Number.POSITIVE_INFINITY),
      section(0, 3, 100, { height: "100" }),
      section(0, 3, 100, { shown: 1 }),
      section(0, 3, 100, { computed: false }),
    ];
    for (const [index, first] of malformed.entries()) {
      const sections = [first, ...SECTIONS];
      expect(readingLine(reading({ previewEl: viewport(0), topSpace: 0, sections })), `case ${index}`).toBeNull();
    }
  });
});

describe("Outline follows viewport", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("turns Follow on once, leaving a manual toggle alone", () => {
    const { outline, rescan, handle } = setup();
    expect(outline.onToggleFollowCursor).toHaveBeenCalledOnce();
    expect(outline.followCursor).toBe(true);

    outline.onToggleFollowCursor();
    rescan();
    expect(outline.followCursor).toBe(false);
    handle.cleanup();
  });

  it("asks native lookup about the line at the middle of the reading view", () => {
    const { view, outline, native, handle } = setup();
    native.mockClear();

    const lookup = outline.findActiveHeading(view) as { getMode(): string; scroll: number };
    expect(lookup.scroll).toBe(3);
    expect(lookup.getMode()).toBe("preview");
    expect(native.mock.contexts[0]).toBe(outline);
    // The real view is left alone.
    expect(view.getMode()).toBe("preview");
    handle.cleanup();
  });

  it("falls back to native lookup when the layout is unknown or the owner isn't a note", () => {
    const { view, outline, native, handle } = setup({ previewEl: viewport(0), topSpace: 0, sections: [{}] });

    expect(outline.findActiveHeading(view)).toBe(view);
    const other = { getMode: () => "preview" };
    expect(outline.findActiveHeading(other)).toBe(other);
    expect(native).toHaveBeenLastCalledWith(other);
    handle.cleanup();
  });

  it("falls back to native lookup, logging once, when reading the layout throws", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const renderer = { previewEl: viewport(0), topSpace: 0 };
    Object.defineProperty(renderer, "sections", {
      get: () => {
        throw new Error("changed internals");
      },
    });
    const { view, outline, handle } = setup(renderer);

    expect(outline.findActiveHeading(view)).toBe(view);
    expect(outline.findActiveHeading(view)).toBe(view);
    expect(error).toHaveBeenCalledOnce();
    handle.cleanup();
  });

  it("re-highlights once per frame while the reading view scrolls", () => {
    const { view, outline, handle } = setup();
    const renderer = (view.previewMode as unknown as { renderer: Renderer }).renderer;
    expect(outline.setHighlightedItem).toHaveBeenLastCalledWith(expect.objectContaining({ scroll: 3 }));
    outline.setHighlightedItem.mockClear();

    renderer.previewEl.scrollTop = 150;
    view.contentEl.dispatchEvent(new Event("scroll"));
    view.contentEl.dispatchEvent(new Event("scroll"));
    frame();
    expect(outline.setHighlightedItem).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ scroll: 8 }));
    handle.cleanup();
  });

  it("re-highlights when the note's metadata changes", () => {
    const { app, view, outline, handle } = setup();
    outline.setHighlightedItem.mockClear();

    app.metadataCache.trigger("changed", view.file);
    frame();
    expect(outline.setHighlightedItem).toHaveBeenCalledOnce();
    handle.cleanup();
  });

  it("restores native lookup and highlights with it when disabled", () => {
    const { view, outline, native, setEnabled } = setup();
    outline.setHighlightedItem.mockClear();

    setEnabled(false);
    expect(outline.findActiveHeading).toBe(native);
    expect(outline.setHighlightedItem).toHaveBeenCalledExactlyOnceWith(view);

    view.contentEl.dispatchEvent(new Event("scroll"));
    frame();
    expect(outline.setHighlightedItem).toHaveBeenCalledOnce();
  });

  it("restores Outline views that close", () => {
    const { outline, outlines, native, rescan, handle } = setup();

    outlines.length = 0;
    rescan();
    expect(outline.findActiveHeading).toBe(native);
    handle.cleanup();
  });

  it("removes its own lookup from Outline views that inherit it", () => {
    const { outline, outlines, native, rescan, handle } = setup();
    const inherited = fakeOutline(outline.getOwner(), native);
    Reflect.deleteProperty(inherited, "findActiveHeading");
    Object.setPrototypeOf(inherited, { findActiveHeading: native });
    outlines.push(inherited);
    rescan();
    expect(Object.prototype.hasOwnProperty.call(inherited, "findActiveHeading")).toBe(true);

    handle.cleanup();
    expect(Object.prototype.hasOwnProperty.call(inherited, "findActiveHeading")).toBe(false);
    expect(inherited.findActiveHeading).toBe(native);
  });
});
