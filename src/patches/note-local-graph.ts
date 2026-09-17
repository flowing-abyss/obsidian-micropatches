import {
  type App,
  debounce,
  MarkdownView,
  type Plugin,
  type SettingGroupItem,
  type TFile,
  type View,
  WorkspaceLeaf,
} from "obsidian";
import type { Patch, PatchContext, PatchHandle } from "../patch";

type Position = "top" | "bottom";
type GraphOptions = Record<string, unknown>;

interface Config {
  position: Position;
  syncGlobal: boolean;
}

const DEFAULT_CONFIG: Config = { position: "top", syncGlobal: false };

const POSITION_OPTIONS: Record<Position, string> = {
  top: "Below the title",
  bottom: "Above backlinks",
};

const HOST_CLASS = "micropatches-local-graph";

// Everything the global graph and a local graph share. Zoom, panel state and
// the local-only depth/link toggles stay per graph.
const SYNCED_KEYS = [
  "search",
  "showTags",
  "showAttachments",
  "hideUnresolved",
  "showOrphans",
  "colorGroups",
  "showArrow",
  "textFadeMultiplier",
  "nodeSizeMultiplier",
  "lineSizeMultiplier",
  "centerStrength",
  "repelStrength",
  "linkStrength",
  "linkDistance",
] as const;

interface GraphEngine {
  getOptions(): GraphOptions;
  setOptions(options: GraphOptions): void;
}

interface LocalGraphView extends View {
  file: TFile | null;
  engine: GraphEngine;
  onOptionsChange(): void;
  close(): Promise<void>;
}

interface GraphPluginInstance {
  options: GraphOptions;
  saveOptions: (this: GraphPluginInstance) => void;
}

interface AppWithInternals extends App {
  internalPlugins?: { getEnabledPluginById(id: string): unknown };
  viewRegistry?: { getViewCreatorByType(type: string): ((leaf: WorkspaceLeaf) => View) | undefined };
}

interface Embed {
  hostEl: HTMLElement;
  win: Window;
  file: TFile;
  graph: LocalGraphView;
  resizeObserver: ResizeObserver | null;
  ready: boolean;
  released: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLocalGraph(view: unknown): view is LocalGraphView {
  if (!isRecord(view) || typeof view["getViewType"] !== "function") return false;
  const engine = view["engine"];
  return (
    (view as unknown as View).getViewType() === "localgraph" &&
    isRecord(engine) &&
    typeof engine["getOptions"] === "function" &&
    typeof engine["setOptions"] === "function" &&
    typeof view["onOptionsChange"] === "function" &&
    typeof view["close"] === "function"
  );
}

function getGraphPlugin(app: App): GraphPluginInstance | null {
  const instance = (app as AppWithInternals).internalPlugins?.getEnabledPluginById("graph");
  if (!isRecord(instance) || !isRecord(instance["options"]) || typeof instance["saveOptions"] !== "function") {
    return null;
  }
  return instance as unknown as GraphPluginInstance;
}

function pickSynced(options: GraphOptions): GraphOptions {
  const picked: GraphOptions = {};
  for (const key of SYNCED_KEYS) if (options[key] !== undefined) picked[key] = options[key];
  return picked;
}

function sameSynced(current: GraphOptions, wanted: GraphOptions): boolean {
  return SYNCED_KEYS.every(
    (key) => wanted[key] === undefined || JSON.stringify(current[key]) === JSON.stringify(wanted[key]),
  );
}

// Obsidian moves one inline title and one Backlinks section between the
// editing and reading containers, so anchors are looked up in the current mode.
// Returns false when the note has no anchor yet, e.g. reading mode before its
// first render.
function placeHost(view: MarkdownView, hostEl: HTMLElement, position: Position): boolean {
  const preview = view.getMode() === "preview";
  const modeEl = preview ? view.previewMode.containerEl : view.contentEl.querySelector(".markdown-source-view");
  const sizer = modeEl?.querySelector<HTMLElement>(preview ? ".markdown-preview-sizer" : ".cm-sizer");
  if (!sizer) return false;

  if (position === "top") {
    const title = sizer.querySelector<HTMLElement>(
      preview ? ":scope > .mod-header > .inline-title" : ":scope > .inline-title",
    );
    if (!title) return false;
    if (title.nextElementSibling !== hostEl) title.after(hostEl);
    return true;
  }

  const parent = preview ? sizer.querySelector<HTMLElement>(":scope > .mod-footer") : sizer;
  if (!parent) return false;
  const backlinks = parent.querySelector<HTMLElement>(":scope > .embedded-backlinks");
  if (backlinks) {
    if (backlinks.previousElementSibling !== hostEl) backlinks.before(hostEl);
  } else if (parent.lastElementChild !== hostEl) {
    parent.append(hostEl);
  }
  return true;
}

/**
 * Hosts Obsidian's own Local graph view inside the note. Each visible
 * Markdown view gets a pinned, workspace-less leaf, so the graph keeps its
 * controls, hover previews and navigation without adding a tab or sidebar
 * item. Hidden tabs release their graph and its worker.
 *
 * Syncing reads the Graph core plugin's in-memory options instead of
 * graph.json. Local graphs are only updated when the global options object
 * changes or a new local graph appears, so startup does no graph work unless a
 * restored local graph is actually out of date.
 */
export const noteLocalGraph: Patch = {
  id: "note-local-graph",
  name: "Local graph in notes",
  description:
    "Shows the core Local graph inside notes, below the title or above backlinks. Scroll passes through the graph; hold Ctrl or Cmd to zoom. Requires the Graph view core plugin.",

  register(plugin: Plugin, ctx: PatchContext): PatchHandle {
    const embeds = new Map<MarkdownView, Embed>();
    let synced = new WeakMap<LocalGraphView, GraphOptions>();
    let wrapped: {
      instance: GraphPluginInstance;
      original: GraphPluginInstance["saveOptions"];
      replacement: GraphPluginInstance["saveOptions"];
      hadOwn: boolean;
    } | null = null;
    let pendingScan: number | null = null;
    let disposed = false;
    let unsupported = false;
    let reportedError = false;

    const getConfig = (): Config => {
      const position = ctx.getConfig<unknown>("position", DEFAULT_CONFIG.position);
      const syncGlobal = ctx.getConfig<unknown>("syncGlobal", DEFAULT_CONFIG.syncGlobal);
      return {
        position: position === "bottom" ? "bottom" : "top",
        syncGlobal: typeof syncGlobal === "boolean" ? syncGlobal : DEFAULT_CONFIG.syncGlobal,
      };
    };

    const storedOptions = (): GraphOptions => {
      const options = ctx.getConfig<unknown>("graphOptions", {});
      return isRecord(options) ? options : {};
    };

    const saveOptions = debounce(
      (options: GraphOptions): void => {
        if (disposed || JSON.stringify(options) === JSON.stringify(storedOptions())) return;
        void ctx.setConfig("graphOptions", options);
      },
      1000,
      true,
    );

    const reportError = (error: unknown): void => {
      if (reportedError) return;
      reportedError = true;
      console.error("Micropatches (note-local-graph): local graph failed", error);
    };

    const syncGraph = (graph: LocalGraphView, instance: GraphPluginInstance): void => {
      if (synced.get(graph) === instance.options) return;
      synced.set(graph, instance.options);
      const wanted = pickSynced(instance.options);
      if (!sameSynced(graph.engine.getOptions(), wanted)) graph.engine.setOptions(wanted);
    };

    const syncAll = (instance: GraphPluginInstance): void => {
      for (const leaf of plugin.app.workspace.getLeavesOfType("localgraph")) {
        if (!leaf.isDeferred && isLocalGraph(leaf.view)) syncGraph(leaf.view, instance);
      }
      for (const embed of embeds.values()) if (embed.ready) syncGraph(embed.graph, instance);
    };

    const unwrapSaveOptions = (): void => {
      if (wrapped === null) return;
      const { instance, original, replacement, hadOwn } = wrapped;
      if (instance.saveOptions === replacement) {
        if (hadOwn) instance.saveOptions = original;
        else delete (instance as unknown as Record<string, unknown>)["saveOptions"];
      }
      wrapped = null;
    };

    // The global Graph view replaces `options` and saves it on every change.
    // Hooking the save follows edits live without polling graph.json.
    const wrapSaveOptions = (instance: GraphPluginInstance): void => {
      if (wrapped?.instance === instance) return;
      unwrapSaveOptions();
      const original = instance.saveOptions;
      const hadOwn = Object.prototype.hasOwnProperty.call(instance, "saveOptions");
      const replacement: GraphPluginInstance["saveOptions"] = function () {
        original.call(this);
        queueScan();
      };
      instance.saveOptions = replacement;
      wrapped = { instance, original, replacement, hadOwn };
    };

    // View.close() is runtime-only API; isLocalGraph guards its presence.
    const closeGraph = (graph: LocalGraphView): void => {
      graph.close().catch(reportError);
    };

    const release = (view: MarkdownView, embed: Embed): void => {
      embed.released = true;
      embeds.delete(view);
      embed.resizeObserver?.disconnect();
      embed.hostEl.remove();
      if (embed.ready) closeGraph(embed.graph);
    };

    const releaseAll = (): void => {
      for (const [view, embed] of Array.from(embeds)) release(view, embed);
    };

    const create = async (
      view: MarkdownView,
      hostEl: HTMLElement,
      file: TFile,
      instance: GraphPluginInstance,
    ): Promise<void> => {
      const createView = (plugin.app as AppWithInternals).viewRegistry?.getViewCreatorByType("localgraph");
      let graph: unknown = null;
      try {
        // A leaf outside the workspace tree hosts the view. Opening it directly
        // skips setViewState's layout-change broadcast, which made every
        // layout-change listener in the vault run for each embedded graph.
        const leaf = new (WorkspaceLeaf as unknown as new (app: App) => WorkspaceLeaf)(plugin.app);
        // Pinned local graphs stay on their file instead of following the active note.
        (leaf as unknown as { pinned: boolean }).pinned = true;
        graph = createView?.(leaf) ?? null;
        if (!isLocalGraph(graph)) throw new Error("Unexpected Local graph view");
        await leaf.open(graph);
      } catch (error) {
        unsupported = true;
        hostEl.remove();
        if (isLocalGraph(graph)) closeGraph(graph);
        throw error;
      }

      // Page scrolling wins over graph zoom unless a zoom modifier is held.
      hostEl.addEventListener(
        "wheel",
        (event) => {
          if (!event.ctrlKey && !event.metaKey) event.stopPropagation();
        },
        { capture: true },
      );
      const embed: Embed = {
        hostEl,
        win: hostEl.win,
        file,
        graph,
        resizeObserver: null,
        ready: false,
        released: false,
      };
      embeds.set(view, embed);
      hostEl.appendChild(graph.containerEl);

      const { syncGlobal } = getConfig();
      const options: GraphOptions = { ...storedOptions(), close: true };
      if (syncGlobal) Object.assign(options, pickSynced(instance.options));
      try {
        await graph.setState({ file: file.path, options }, { history: false });
      } catch (error) {
        unsupported = true;
        if (!embed.released) release(view, embed);
        closeGraph(graph);
        throw error;
      }
      if (embed.released) {
        closeGraph(graph);
        return;
      }

      embed.ready = true;
      if (syncGlobal) synced.set(graph, instance.options);
      const localGraph = graph;
      localGraph.onOptionsChange = (): void => {
        const { scale: _scale, close: _close, ...rest } = localGraph.engine.getOptions();
        // Synced values belong to the global graph; keep them out of local defaults.
        if (getConfig().syncGlobal) for (const key of SYNCED_KEYS) delete rest[key];
        saveOptions(rest);
      };
      let width = 0;
      let height = 0;
      embed.resizeObserver = new (hostEl.win as typeof window).ResizeObserver(([entry]) => {
        if (!entry || (entry.contentRect.width === width && entry.contentRect.height === height)) return;
        ({ width, height } = entry.contentRect);
        localGraph.onResize();
      });
      embed.resizeObserver.observe(hostEl);
      // The note may have changed while the graph was opening.
      if (view.file !== file) queueScan();
    };

    const scan = (): void => {
      if (disposed || !ctx.isEnabled() || unsupported) return;
      const instance = getGraphPlugin(plugin.app);
      if (instance === null) {
        releaseAll();
        unwrapSaveOptions();
        return;
      }

      const { position, syncGlobal } = getConfig();
      const seen = new Set<MarkdownView>();
      for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
        const view = leaf.view;
        // Hover editors are too small for a graph and it blocks their scrolling.
        if (
          !(view instanceof MarkdownView) ||
          view.file === null ||
          !view.containerEl.isShown() ||
          view.containerEl.closest(".hover-popover") !== null
        ) {
          continue;
        }
        seen.add(view);
        const embed = embeds.get(view);
        // A tab moved to another window gets a graph built for that window.
        if (embed !== undefined && embed.win !== view.containerEl.win) release(view, embed);
        else if (embed !== undefined) {
          placeHost(view, embed.hostEl, position);
          if (embed.ready && embed.file !== view.file) {
            embed.file = view.file;
            embed.graph.setState({ file: view.file.path }, { history: false }).catch(reportError);
          }
          continue;
        }

        const hostEl = view.containerEl.createDiv({ cls: HOST_CLASS });
        if (placeHost(view, hostEl, position)) create(view, hostEl, view.file, instance).catch(reportError);
        else hostEl.remove();
      }
      for (const [view, embed] of Array.from(embeds)) {
        if (!seen.has(view)) release(view, embed);
      }

      if (syncGlobal) {
        wrapSaveOptions(instance);
        syncAll(instance);
      } else {
        unwrapSaveOptions();
      }
    };

    function queueScan(): void {
      if (disposed || !ctx.isEnabled() || !plugin.app.workspace.layoutReady || pendingScan !== null) return;
      pendingScan = window.requestAnimationFrame(() => {
        pendingScan = null;
        try {
          scan();
        } catch (error) {
          reportError(error);
        }
      });
    }

    const stop = (): void => {
      if (pendingScan !== null) window.cancelAnimationFrame(pendingScan);
      pendingScan = null;
      releaseAll();
      unwrapSaveOptions();
      synced = new WeakMap();
    };

    plugin.registerEvent(plugin.app.workspace.on("layout-change", queueScan));
    plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", queueScan));
    plugin.registerEvent(plugin.app.workspace.on("file-open", queueScan));
    plugin.app.workspace.onLayoutReady(queueScan);

    return {
      cleanup: (): void => {
        saveOptions.run();
        disposed = true;
        stop();
      },
      onToggle: (enabled: boolean): void => {
        if (enabled) queueScan();
        else stop();
      },
      onConfigChange: (key: string): void => {
        // Re-enabling sync must re-apply options even to graphs synced before.
        if (key === "syncGlobal") synced = new WeakMap();
        queueScan();
      },
    };
  },

  settingDefinitions(_ctx: PatchContext, key: (configKey: string) => string): SettingGroupItem[] {
    return [
      {
        name: "Position",
        desc: "Where the local graph appears in each note.",
        control: {
          type: "dropdown",
          key: key("position"),
          defaultValue: DEFAULT_CONFIG.position,
          options: POSITION_OPTIONS,
        },
      },
      {
        name: "Sync with global graph",
        desc: "Applies the global graph's filters, groups, display and forces to every local graph, including local graph tabs. Depth and link toggles stay local.",
        control: {
          type: "toggle",
          key: key("syncGlobal"),
          defaultValue: DEFAULT_CONFIG.syncGlobal,
        },
      },
    ];
  },
};
