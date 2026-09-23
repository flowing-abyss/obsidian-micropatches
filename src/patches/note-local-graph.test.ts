import type { MarkdownView as MarkdownViewOriginal, PluginManifest, View } from "obsidian";
import { App, MarkdownView, Plugin, WorkspaceLeaf } from "obsidian-test-mocks/obsidian";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { isRecord, noteLocalGraph, pickSynced, placeHost, sameSynced } from "./note-local-graph";

const manifest: PluginManifest = {
  id: "micropatches",
  name: "Micropatches",
  author: "test",
  version: "0.0.0",
  minAppVersion: "1.13.0",
  description: "test",
};

class TestPlugin extends Plugin {}

type Options = Record<string, unknown>;

interface FakeGraph {
  containerEl: HTMLElement;
  engine: { options: Options; getOptions: () => Options; setOptions: Mock<(options: Options) => void> };
  leaf: WorkspaceLeaf;
  getViewType: () => string;
  onOptionsChange: () => void;
  onResize: () => void;
  open: () => Promise<void>;
  close: Mock<() => Promise<void>>;
  setState: Mock<(state: { file?: string; options?: Options }, result: unknown) => Promise<void>>;
}

function fakeGraph(leaf: WorkspaceLeaf): FakeGraph {
  const engine: FakeGraph["engine"] = {
    options: {},
    getOptions: () => engine.options,
    setOptions: vi.fn((options: Options) => {
      engine.options = { ...engine.options, ...options };
    }),
  };
  return {
    containerEl: createDiv(),
    engine,
    leaf,
    getViewType: () => "localgraph",
    onOptionsChange: () => undefined,
    onResize: () => undefined,
    open: () => Promise.resolve(),
    close: vi.fn(() => Promise.resolve()),
    setState: vi.fn((state: { options?: Options }) => {
      if (state.options) engine.options = { ...engine.options, ...state.options };
      return Promise.resolve();
    }),
  };
}

async function setup(config: Options, globalOptions: Options = {}, prepare?: (view: MarkdownView) => void) {
  const app = App.createConfigured__({ files: { "Note.md": "", "Other.md": "" } });
  app.workspace.setLayoutReady__();
  const saveGlobal = vi.fn();
  const graphPlugin = { options: globalOptions, saveOptions: saveGlobal };
  Object.assign(app, {
    internalPlugins: { getEnabledPluginById: (id: string) => (id === "graph" ? graphPlugin : null) },
  });
  const graphs: FakeGraph[] = [];
  app.viewRegistry.registerView("localgraph", (leaf) => {
    const graph = fakeGraph(leaf as unknown as WorkspaceLeaf);
    graphs.push(graph);
    return graph as unknown as View;
  });

  const view = MarkdownView.create2__(WorkspaceLeaf.create2__(app));
  view.file = app.vault.getFileByPath("Note.md");
  view.containerEl.isShown = () => true;
  const title = view.contentEl.createDiv("markdown-source-view").createDiv("cm-sizer").createDiv("inline-title");
  vi.spyOn(app.workspace, "getLeavesOfType").mockImplementation((type) =>
    type === "markdown" ? [{ view } as unknown as WorkspaceLeaf] : [],
  );
  prepare?.(view);

  const values = new Map(Object.entries(config));
  const setConfig = vi.fn((key: string, value: unknown) => {
    values.set(key, value);
    return Promise.resolve();
  });
  const handle = noteLocalGraph.register(new TestPlugin(app, manifest).asOriginalType2__(), {
    isEnabled: () => true,
    getConfig: <T>(key: string, fallback: T): T => (values.has(key) ? (values.get(key) as T) : fallback),
    setConfig,
  });
  await frame();
  return { app, view, title, graphs, graphPlugin, saveGlobal, setConfig, handle };
}

function only(graphs: FakeGraph[]): FakeGraph {
  const [graph, ...rest] = graphs;
  if (!graph || rest.length > 0) throw new Error(`Expected one local graph, got ${graphs.length}`);
  return graph;
}

// Scans run on the next animation frame; opening a graph takes a few promise hops.
async function frame(): Promise<void> {
  await vi.advanceTimersByTimeAsync(16);
}

function markdownView(mode: "source" | "preview", contentEl: HTMLElement, previewEl: HTMLElement) {
  return { getMode: () => mode, contentEl, previewMode: { containerEl: previewEl } } as unknown as MarkdownViewOriginal;
}

describe("isRecord", () => {
  it("accepts objects and rejects everything else", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord([])).toBe(true);
    for (const value of [null, undefined, "graph", 1, () => undefined]) expect(isRecord(value)).toBe(false);
  });
});

describe("pickSynced", () => {
  it("keeps only the options shared with the global graph", () => {
    const options = { search: "tag:#a", showTags: false, repelStrength: 10, scale: 2, close: true, localJumps: 2 };
    expect(pickSynced({ ...options, colorGroups: undefined })).toEqual({
      search: "tag:#a",
      showTags: false,
      repelStrength: 10,
    });
  });
});

describe("sameSynced", () => {
  it("compares synced options by value and ignores the rest", () => {
    const groups = [{ query: "tag:#a", color: { a: 1, rgb: 255 } }];
    const current = { showTags: true, colorGroups: groups, scale: 1 };
    expect(sameSynced(current, { showTags: true, colorGroups: structuredClone(groups), scale: 3 })).toBe(true);
    expect(sameSynced(current, {})).toBe(true);
    expect(sameSynced(current, { showTags: false })).toBe(false);
    expect(sameSynced(current, { colorGroups: [] })).toBe(false);
    expect(sameSynced(current, { showArrow: false })).toBe(false);
  });
});

describe("placeHost", () => {
  it("places the graph below the inline title in editing mode", () => {
    const contentEl = createDiv();
    const sizer = contentEl.createDiv("markdown-source-view").createDiv("cm-sizer");
    const title = sizer.createDiv("inline-title");
    sizer.createDiv("cm-contentContainer");
    const host = createDiv();

    expect(placeHost(markdownView("source", contentEl, createDiv()), host, "top")).toBe(true);
    expect(title.nextElementSibling).toBe(host);
  });

  it("places the graph above backlinks, or at the end without them", () => {
    const contentEl = createDiv();
    const sizer = contentEl.createDiv("markdown-source-view").createDiv("cm-sizer");
    sizer.createDiv("cm-contentContainer");
    const host = createDiv();
    const view = markdownView("source", contentEl, createDiv());

    expect(placeHost(view, host, "bottom")).toBe(true);
    expect(sizer.lastElementChild).toBe(host);

    const backlinks = sizer.createDiv("embedded-backlinks");
    expect(placeHost(view, host, "bottom")).toBe(true);
    expect(backlinks.previousElementSibling).toBe(host);
  });

  it("uses the reading view's header and footer in reading mode", () => {
    const previewEl = createDiv();
    const sizer = previewEl.createDiv("markdown-preview-sizer");
    const title = sizer.createDiv("mod-header").createDiv("inline-title");
    const backlinks = sizer.createDiv("mod-footer").createDiv("embedded-backlinks");
    const host = createDiv();
    const view = markdownView("preview", createDiv(), previewEl);

    expect(placeHost(view, host, "top")).toBe(true);
    expect(title.nextElementSibling).toBe(host);
    expect(placeHost(view, host, "bottom")).toBe(true);
    expect(backlinks.previousElementSibling).toBe(host);
  });

  it("reports notes without an anchor yet", () => {
    const host = createDiv();
    // Reading mode before its first render.
    expect(placeHost(markdownView("preview", createDiv(), createDiv()), host, "top")).toBe(false);

    const previewEl = createDiv();
    previewEl.createDiv("markdown-preview-sizer");
    expect(placeHost(markdownView("preview", createDiv(), previewEl), host, "bottom")).toBe(false);

    // Inline title hidden; a title inside an embedded note doesn't count.
    const contentEl = createDiv();
    const sizer = contentEl.createDiv("markdown-source-view").createDiv("cm-sizer");
    sizer.createDiv("internal-embed").createDiv("inline-title");
    expect(placeHost(markdownView("source", contentEl, createDiv()), host, "top")).toBe(false);
    expect(host.parentElement).toBeNull();
  });
});

describe("Local graph in notes", () => {
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

  it("embeds a pinned local graph of the note below its title", async () => {
    const { title, graphs, handle } = await setup({ graphOptions: { localJumps: 2 } });
    const graph = only(graphs);

    expect(graph.leaf.isPinned__()).toBe(true);
    expect(title.nextElementSibling?.hasClass("micropatches-local-graph")).toBe(true);
    expect(graph.containerEl.parentElement).toBe(title.nextElementSibling);
    expect(graph.setState).toHaveBeenCalledWith(
      { file: "Note.md", options: { localJumps: 2, close: true } },
      { history: false },
    );
    handle.cleanup();
  });

  it("follows the note to another file", async () => {
    const { app, view, graphs, handle } = await setup({});
    const graph = only(graphs);

    view.file = app.vault.getFileByPath("Other.md");
    app.workspace.trigger("file-open");
    await frame();
    expect(graph.setState).toHaveBeenLastCalledWith({ file: "Other.md" }, { history: false });
    handle.cleanup();
  });

  it("lets the wheel scroll the note unless Ctrl or Cmd is held", async () => {
    const { graphs, handle } = await setup({});
    const graph = only(graphs);
    const zoom = vi.fn();
    graph.containerEl.addEventListener("wheel", zoom);

    graph.containerEl.dispatchEvent(new WheelEvent("wheel", { bubbles: true }));
    expect(zoom).not.toHaveBeenCalled();
    graph.containerEl.dispatchEvent(new WheelEvent("wheel", { bubbles: true, ctrlKey: true }));
    graph.containerEl.dispatchEvent(new WheelEvent("wheel", { bubbles: true, metaKey: true }));
    expect(zoom).toHaveBeenCalledTimes(2);
    handle.cleanup();
  });

  it("saves local option changes without zoom or panel state", async () => {
    const { graphs, setConfig, handle } = await setup({});
    const graph = only(graphs);
    const options = { scale: 2, close: false, localJumps: 3, showTags: true };
    graph.engine.options = options;

    graph.onOptionsChange();
    vi.advanceTimersByTime(1000);
    expect(setConfig).toHaveBeenCalledExactlyOnceWith("graphOptions", { localJumps: 3, showTags: true });
    // The engine's own options stay untouched.
    expect(options).toEqual({ scale: 2, close: false, localJumps: 3, showTags: true });
    handle.cleanup();
  });

  it("keeps synced options out of saved local options while syncing", async () => {
    const { graphs, setConfig, handle } = await setup({ syncGlobal: true });
    const graph = only(graphs);
    graph.engine.options = { scale: 2, close: false, localJumps: 3, showTags: true, search: "x" };

    graph.onOptionsChange();
    vi.advanceTimersByTime(1000);
    expect(setConfig).toHaveBeenCalledExactlyOnceWith("graphOptions", { localJumps: 3 });
    handle.cleanup();
  });

  it("follows the global graph's options while syncing", async () => {
    const { graphs, graphPlugin, saveGlobal, handle } = await setup(
      { syncGlobal: true, graphOptions: { showTags: true, localJumps: 2 } },
      { showTags: false, scale: 9 },
    );
    const graph = only(graphs);
    expect(graph.setState).toHaveBeenCalledWith(
      { file: "Note.md", options: { showTags: false, localJumps: 2, close: true } },
      { history: false },
    );

    // The Graph plugin replaces its options object and saves it on every change.
    graphPlugin.options = { showTags: false, scale: 3 };
    graphPlugin.saveOptions();
    await frame();
    expect(graph.engine.setOptions).not.toHaveBeenCalled();

    graphPlugin.options = { showTags: true, scale: 3 };
    graphPlugin.saveOptions();
    await frame();
    expect(saveGlobal).toHaveBeenCalledTimes(2);
    expect(graph.engine.setOptions).toHaveBeenCalledExactlyOnceWith({ showTags: true });

    handle.cleanup();
    expect(graphPlugin.saveOptions).toBe(saveGlobal);
  });

  it("skips hover previews", async () => {
    const { graphs, handle } = await setup({}, {}, (view) => {
      createDiv("hover-popover").append(view.containerEl);
    });
    expect(graphs).toHaveLength(0);
    handle.cleanup();
  });

  it("releases the graph when the note is hidden and on cleanup", async () => {
    const { app, view, title, graphs, handle } = await setup({});
    const graph = only(graphs);

    view.containerEl.isShown = () => false;
    app.workspace.trigger("layout-change");
    await frame();
    expect(title.nextElementSibling).toBeNull();
    expect(graph.close).toHaveBeenCalledOnce();

    view.containerEl.isShown = () => true;
    app.workspace.trigger("layout-change");
    await frame();
    expect(graphs).toHaveLength(2);

    handle.cleanup();
    expect(title.nextElementSibling).toBeNull();
    expect(graphs[1]?.close).toHaveBeenCalledOnce();
  });
});
