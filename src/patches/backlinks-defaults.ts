import { Notice, setTooltip, type Plugin, type SearchComponent, type SettingGroupItem } from "obsidian";
import type { Patch, PatchContext, PatchHandle } from "../patch";

const INDICATOR_CLASS = "micropatches-backlinks-default-filter";
const INDICATOR_DOT_CLASS = "micropatches-backlinks-default-filter-dot";
const OVERRIDDEN_CLASS = "is-overridden";

const SORT_OPTIONS = {
  alphabetical: "File name (A to Z)",
  alphabeticalReverse: "File name (Z to A)",
  byModifiedTime: "Modified time (new to old)",
  byModifiedTimeReverse: "Modified time (old to new)",
  byCreatedTime: "Created time (new to old)",
  byCreatedTimeReverse: "Created time (old to new)",
} as const;

type SortOrder = keyof typeof SORT_OPTIONS;

interface Config {
  collapseResults: boolean;
  showMoreContext: boolean;
  sortOrder: SortOrder;
  expandUnlinked: boolean;
  defaultFilter: string;
}

const DEFAULT_CONFIG: Config = {
  collapseResults: false,
  showMoreContext: false,
  sortOrder: "alphabetical",
  expandUnlinked: false,
  defaultFilter: "",
};

interface SearchComponentInternal extends SearchComponent {
  changeCallback: ((value: string) => unknown) | undefined;
}

interface BacklinksController {
  file?: { path?: string } | null;
  collapseAll: boolean;
  extraContext: boolean;
  sortOrder: string;
  unlinkedCollapsed: boolean;
  searchQuery?: { query?: string } | null;
  showSearchButtonEl: HTMLElement;
  searchComponent: SearchComponentInternal;
  setCollapseAll(value: boolean): void;
  setExtraContext(value: boolean): void;
  setSortOrder(value: string): void;
  setUnlinkedCollapsed(value: boolean, animate: boolean): void | Promise<void>;
  updateSearch: () => void;
}

interface LeafViewWithBacklinks {
  backlink?: unknown;
  backlinks?: unknown;
  containerEl?: HTMLElement;
}

interface ManagedController {
  controller: BacklinksController;
  search: SearchComponentInternal;
  originalUpdateSearch: () => void;
  hadOwnUpdateSearch: boolean;
  patchedUpdateSearch: () => void;
  originalChangeCallback: SearchComponentInternal["changeCallback"];
  hadOwnChangeCallback: boolean;
  patchedChangeCallback: (value: string) => void;
  originalSearchTooltip: string;
  indicatorEl: HTMLElement;
  searchTimer: number | null;
  lastFilePath: string | null | undefined;
  hiddenDefaultActive: boolean;
  invalidFilterNotified: string | null;
}

function isBacklinksController(value: unknown): value is BacklinksController {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BacklinksController>;
  return (
    typeof candidate.setCollapseAll === "function" &&
    typeof candidate.setExtraContext === "function" &&
    typeof candidate.setSortOrder === "function" &&
    typeof candidate.setUnlinkedCollapsed === "function" &&
    typeof candidate.updateSearch === "function" &&
    candidate.showSearchButtonEl !== undefined &&
    candidate.showSearchButtonEl !== null &&
    typeof candidate.showSearchButtonEl.toggleClass === "function" &&
    typeof candidate.showSearchButtonEl.createSpan === "function" &&
    typeof candidate.showSearchButtonEl.getAttribute === "function" &&
    typeof candidate.showSearchButtonEl.removeClass === "function" &&
    typeof candidate.searchComponent?.getValue === "function" &&
    typeof candidate.searchComponent.setValue === "function" &&
    candidate.searchComponent.inputEl !== undefined &&
    candidate.searchComponent.inputEl !== null &&
    typeof candidate.searchComponent.inputEl.win?.setTimeout === "function" &&
    typeof candidate.searchComponent.inputEl.win.clearTimeout === "function"
  );
}

function normalizedSortOrder(value: string): SortOrder {
  return Object.prototype.hasOwnProperty.call(SORT_OPTIONS, value) ? (value as SortOrder) : DEFAULT_CONFIG.sortOrder;
}

function controllerFilePath(controller: BacklinksController): string | null {
  return controller.file?.path ?? null;
}

/**
 * Sets the initial navigation state of Obsidian's Backlinks controller. The
 * controller's own methods update linked and unlinked result DOMs together;
 * the top-level Unlinked mentions section has a separate collapsed state.
 *
 * The Backlinks controller is an undocumented Obsidian API. Keep all access
 * structurally guarded and local to this file so an upstream change fails
 * closed instead of breaking unrelated views.
 */
export const backlinksDefaults: Patch = {
  id: "backlinks-defaults",
  name: "Backlinks defaults",
  description: "Sets consistent default display and filter behavior for linked and unlinked mentions.",

  register(plugin: Plugin, ctx: PatchContext): PatchHandle {
    const managed = new Map<BacklinksController, ManagedController>();
    const observers = new Map<HTMLElement, MutationObserver>();
    let pendingScan: number | null = null;
    let defaultFilterTimer: number | null = null;
    let disposed = false;
    let internalErrorReported = false;

    const getConfig = (): Config => {
      const collapseResults = ctx.getConfig<unknown>("collapseResults", DEFAULT_CONFIG.collapseResults);
      const showMoreContext = ctx.getConfig<unknown>("showMoreContext", DEFAULT_CONFIG.showMoreContext);
      const configuredSortOrder = ctx.getConfig<unknown>("sortOrder", DEFAULT_CONFIG.sortOrder);
      const expandUnlinked = ctx.getConfig<unknown>("expandUnlinked", DEFAULT_CONFIG.expandUnlinked);
      const defaultFilter = ctx.getConfig<unknown>("defaultFilter", DEFAULT_CONFIG.defaultFilter);
      return {
        collapseResults: typeof collapseResults === "boolean" ? collapseResults : DEFAULT_CONFIG.collapseResults,
        showMoreContext: typeof showMoreContext === "boolean" ? showMoreContext : DEFAULT_CONFIG.showMoreContext,
        sortOrder:
          typeof configuredSortOrder === "string" ? normalizedSortOrder(configuredSortOrder) : DEFAULT_CONFIG.sortOrder,
        expandUnlinked: typeof expandUnlinked === "boolean" ? expandUnlinked : DEFAULT_CONFIG.expandUnlinked,
        defaultFilter: typeof defaultFilter === "string" ? defaultFilter.trim() : DEFAULT_CONFIG.defaultFilter,
      };
    };

    const reportInternalError = (operation: string, error: unknown): void => {
      if (disposed || internalErrorReported) return;
      internalErrorReported = true;
      console.error(`Micropatches (backlinks-defaults): ${operation} failed`, error);
    };

    const tooltipWithStatus = (base: string, status: string): string => {
      const action = base.replace(/[.\s]+$/u, "");
      return `${action}. ${status}`;
    };

    const updateIndicator = (record: ManagedController): void => {
      const hasDefault = getConfig().defaultFilter.length > 0;
      const overridden = record.search.getValue().length > 0;
      record.controller.showSearchButtonEl.toggleClass(INDICATOR_CLASS, hasDefault);
      record.controller.showSearchButtonEl.toggleClass(OVERRIDDEN_CLASS, hasDefault && overridden);
      record.indicatorEl.toggle(hasDefault);

      if (hasDefault) {
        setTooltip(
          record.controller.showSearchButtonEl,
          tooltipWithStatus(
            record.originalSearchTooltip,
            overridden ? "Default filter overridden" : "Default filter set in Micropatches",
          ),
        );
      } else {
        setTooltip(record.controller.showSearchButtonEl, record.originalSearchTooltip);
      }
    };

    const clearSearchTimer = (record: ManagedController): void => {
      if (record.searchTimer === null) return;
      record.search.inputEl.win.clearTimeout(record.searchTimer);
      record.searchTimer = null;
    };

    const runNativeSearch = (record: ManagedController): void => {
      record.originalUpdateSearch.call(record.controller);
    };

    const runEffectiveSearch = (record: ManagedController): void => {
      clearSearchTimer(record);
      const visibleQuery = record.search.getValue();
      const defaultFilter = ctx.isEnabled() ? getConfig().defaultFilter : "";
      const effectiveQuery = visibleQuery || defaultFilter;

      if (visibleQuery || !defaultFilter) {
        runNativeSearch(record);
        record.hiddenDefaultActive = false;
        record.invalidFilterNotified = null;
        updateIndicator(record);
        return;
      }

      // Obsidian's parser reads directly from SearchComponent. Let the native
      // controller parse and apply the default synchronously, then blank only
      // the visible input without dispatching another input event.
      record.search.setValue(effectiveQuery);
      runNativeSearch(record);
      const applied = record.controller.searchQuery?.query === effectiveQuery;

      if (!applied) {
        // Never leave a stale hidden filter behind when a configured query is
        // invalid. The native parser may also show its own syntax error.
        record.search.setValue("");
        runNativeSearch(record);
        if (record.invalidFilterNotified !== effectiveQuery) {
          record.invalidFilterNotified = effectiveQuery;
          new Notice("Micropatches: the default backlinks filter is invalid.");
        }
      } else {
        record.invalidFilterNotified = null;
      }

      record.search.setValue("");
      record.hiddenDefaultActive = applied;
      updateIndicator(record);
    };

    const setUnlinkedExpanded = (controller: BacklinksController, expanded: boolean): void => {
      try {
        const result = controller.setUnlinkedCollapsed(!expanded, false);
        void Promise.resolve(result).catch((error: unknown) =>
          reportInternalError("setting the Unlinked mentions section", error),
        );
      } catch (error) {
        reportInternalError("setting the Unlinked mentions section", error);
      }
    };

    const applyDisplayDefaults = (controller: BacklinksController): void => {
      const config = getConfig();
      controller.setCollapseAll(config.collapseResults);
      controller.setExtraContext(config.showMoreContext);
      controller.setSortOrder(config.sortOrder);
      setUnlinkedExpanded(controller, config.expandUnlinked);
    };

    const detach = (record: ManagedController): void => {
      clearSearchTimer(record);
      // Flush a pending visible query, or clear the hidden default, before
      // restoring Obsidian's own handlers.
      if (record.hiddenDefaultActive || record.search.getValue() !== (record.controller.searchQuery?.query ?? "")) {
        runNativeSearch(record);
      }

      if (record.controller.updateSearch === record.patchedUpdateSearch) {
        if (record.hadOwnUpdateSearch) {
          record.controller.updateSearch = record.originalUpdateSearch;
        } else {
          delete (record.controller as unknown as Record<string, unknown>)["updateSearch"];
        }
      }
      if (record.search.changeCallback === record.patchedChangeCallback) {
        if (record.hadOwnChangeCallback) {
          record.search.changeCallback = record.originalChangeCallback;
        } else {
          delete (record.search as unknown as Record<string, unknown>)["changeCallback"];
        }
      }
      record.controller.showSearchButtonEl.removeClass(INDICATOR_CLASS, OVERRIDDEN_CLASS);
      setTooltip(record.controller.showSearchButtonEl, record.originalSearchTooltip);
      record.indicatorEl.remove();
      managed.delete(record.controller);
    };

    const attach = (controller: BacklinksController): ManagedController => {
      const search = controller.searchComponent;
      const indicatorEl = controller.showSearchButtonEl.createSpan({ cls: INDICATOR_DOT_CLASS });
      indicatorEl.setAttribute("aria-hidden", "true");

      const originalUpdateSearch = controller.updateSearch;
      const originalChangeCallback = search.changeCallback;
      let record: ManagedController;
      const patchedUpdateSearch = (): void => {
        if (disposed || !ctx.isEnabled() || managed.get(controller) !== record) {
          originalUpdateSearch.call(controller);
          return;
        }
        runEffectiveSearch(record);
      };
      const patchedChangeCallback = (value: string): void => {
        if (disposed || !ctx.isEnabled() || managed.get(controller) !== record) {
          originalChangeCallback?.call(search, value);
          return;
        }
        clearSearchTimer(record);
        updateIndicator(record);
        record.searchTimer = search.inputEl.win.setTimeout(() => {
          record.searchTimer = null;
          runEffectiveSearch(record);
        }, 300);
      };

      record = {
        controller,
        search,
        originalUpdateSearch,
        hadOwnUpdateSearch: Object.prototype.hasOwnProperty.call(controller, "updateSearch"),
        patchedUpdateSearch,
        originalChangeCallback,
        hadOwnChangeCallback: Object.prototype.hasOwnProperty.call(search, "changeCallback"),
        patchedChangeCallback,
        originalSearchTooltip: controller.showSearchButtonEl.getAttribute("aria-label") ?? "Show search filter",
        indicatorEl,
        searchTimer: null,
        lastFilePath: undefined,
        hiddenDefaultActive: false,
        invalidFilterNotified: null,
      };

      controller.updateSearch = patchedUpdateSearch;
      search.changeCallback = patchedChangeCallback;
      managed.set(controller, record);
      updateIndicator(record);
      return record;
    };

    const visitController = (value: unknown, seen: Set<BacklinksController>): void => {
      if (!isBacklinksController(value)) return;
      seen.add(value);
      try {
        const record = managed.get(value) ?? attach(value);
        const filePath = controllerFilePath(value);
        if (record.lastFilePath === filePath) return;
        record.lastFilePath = filePath;
        applyDisplayDefaults(value);
        runEffectiveSearch(record);
      } catch (error) {
        reportInternalError("attaching to a Backlinks view", error);
      }
    };

    const observeEmbeddedRoot = (root: HTMLElement): void => {
      if (observers.has(root)) return;
      // Obsidian keeps this root when Backlinks in document is hidden, then
      // adds/removes its direct panes without emitting a workspace event.
      const observer = new MutationObserver(queueScan);
      observer.observe(root, { childList: true });
      observers.set(root, observer);
    };

    const scan = (): void => {
      if (disposed || !ctx.isEnabled()) return;

      const seenControllers = new Set<BacklinksController>();
      const seenRoots = new Set<HTMLElement>();

      plugin.app.workspace.iterateAllLeaves((leaf) => {
        const view = leaf.view as unknown as LeafViewWithBacklinks;
        if (view.containerEl !== undefined) {
          for (const root of Array.from(view.containerEl.querySelectorAll<HTMLElement>(".embedded-backlinks"))) {
            seenRoots.add(root);
            observeEmbeddedRoot(root);
          }
        }
        visitController(view.backlink, seenControllers);
        visitController(view.backlinks, seenControllers);
      });

      for (const record of Array.from(managed.values())) {
        if (!seenControllers.has(record.controller)) detach(record);
      }
      for (const [root, observer] of observers) {
        if (seenRoots.has(root)) continue;
        observer.disconnect();
        observers.delete(root);
      }
    };

    function queueScan(): void {
      if (disposed || !ctx.isEnabled() || pendingScan !== null) return;
      pendingScan = window.setTimeout(() => {
        pendingScan = null;
        scan();
      });
    }

    const clearDefaultFilterTimer = (): void => {
      if (defaultFilterTimer === null) return;
      window.clearTimeout(defaultFilterTimer);
      defaultFilterTimer = null;
    };

    const disconnectObservers = (): void => {
      for (const observer of observers.values()) observer.disconnect();
      observers.clear();
    };

    plugin.registerEvent(plugin.app.workspace.on("layout-change", queueScan));
    plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", queueScan));
    plugin.registerEvent(plugin.app.workspace.on("file-open", queueScan));
    plugin.app.workspace.onLayoutReady(queueScan);

    return {
      cleanup: (): void => {
        disposed = true;
        if (pendingScan !== null) window.clearTimeout(pendingScan);
        pendingScan = null;
        clearDefaultFilterTimer();
        disconnectObservers();
        for (const record of Array.from(managed.values())) detach(record);
      },
      onToggle: (enabled: boolean): void => {
        if (enabled) {
          queueScan();
        } else {
          if (pendingScan !== null) window.clearTimeout(pendingScan);
          pendingScan = null;
          clearDefaultFilterTimer();
          disconnectObservers();
          for (const record of Array.from(managed.values())) detach(record);
        }
      },
      onConfigChange: (key: string): void => {
        if (!ctx.isEnabled()) return;
        const config = getConfig();
        if (key === "defaultFilter") {
          for (const record of managed.values()) updateIndicator(record);
          clearDefaultFilterTimer();
          defaultFilterTimer = window.setTimeout(() => {
            defaultFilterTimer = null;
            for (const record of managed.values()) runEffectiveSearch(record);
          }, 300);
          return;
        }

        for (const record of managed.values()) {
          switch (key) {
            case "collapseResults":
              record.controller.setCollapseAll(config.collapseResults);
              break;
            case "showMoreContext":
              record.controller.setExtraContext(config.showMoreContext);
              break;
            case "sortOrder":
              record.controller.setSortOrder(config.sortOrder);
              break;
            case "expandUnlinked":
              setUnlinkedExpanded(record.controller, config.expandUnlinked);
              break;
          }
          updateIndicator(record);
        }
      },
    };
  },

  settingDefinitions(_ctx: PatchContext, key: (configKey: string) => string): SettingGroupItem[] {
    return [
      {
        name: "Collapse results",
        desc: "Collapses individual result files in both linked and unlinked mentions when a Backlinks view opens.",
        control: {
          type: "toggle",
          key: key("collapseResults"),
          defaultValue: DEFAULT_CONFIG.collapseResults,
        },
      },
      {
        name: "Show more context",
        desc: "Shows additional context in both linked and unlinked results by default.",
        control: {
          type: "toggle",
          key: key("showMoreContext"),
          defaultValue: DEFAULT_CONFIG.showMoreContext,
        },
      },
      {
        name: "Sort order",
        desc: "Default order for linked and unlinked results.",
        control: {
          type: "dropdown",
          key: key("sortOrder"),
          defaultValue: DEFAULT_CONFIG.sortOrder,
          options: SORT_OPTIONS,
        },
      },
      {
        name: "Expand Unlinked mentions section",
        desc: "Opens the whole Unlinked mentions section by default. This is independent of result files inside it.",
        control: {
          type: "toggle",
          key: key("expandUnlinked"),
          defaultValue: DEFAULT_CONFIG.expandUnlinked,
        },
      },
      {
        name: "Default search filter",
        desc: "Used for linked and unlinked mentions while the search field is empty. The default remains hidden in the field.",
        control: {
          type: "text",
          key: key("defaultFilter"),
          defaultValue: DEFAULT_CONFIG.defaultFilter,
          placeholder: "For example, -path:Diary",
        },
      },
    ];
  },
};
