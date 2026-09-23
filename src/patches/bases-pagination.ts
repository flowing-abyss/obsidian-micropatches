import {
  type BasesEntry,
  BasesQueryResult,
  type BasesViewConfig,
  Component,
  type Plugin,
  setIcon,
  setTooltip,
} from "obsidian";
import type { Patch, PatchContext, PatchHandle } from "../patch";

type ApplyLimit = (this: QueryResultInternals, entries: BasesEntry[]) => void;

// Undocumented Bases internals, not in obsidian.d.ts. Everything is checked
// before use: if Bases changes shape, bases show their first page as before.
interface QueryResultInternals {
  config?: ViewConfigInternals;
  // Sorts are done; cuts the sorted entries down to the view's limit.
  applyLimit?: ApplyLimit;
}

interface ViewConfigInternals extends BasesViewConfig {
  getLimit?(): number;
}

interface QueryController {
  viewContainerEl: HTMLElement;
  resultsMenu: { toolbarItem: { button: { containerEl: HTMLElement } } };
  getViewConfig(): ViewConfigInternals | null | undefined;
  notifyView(): void;
  addChild(child: Component): unknown;
  removeChild(child: Component): unknown;
}

interface PageState {
  page: number;
  pageCount: number;
  limit: number;
  total: number;
  sort: string;
}

interface Pager {
  el: HTMLElement;
  anchorEl: HTMLElement;
  prevEl: HTMLElement;
  labelEl: HTMLElement;
  nextEl: HTMLElement;
  state: PageState | null;
  // A child of the controller, so the pager goes when the base does.
  hook: Component;
}

const PAGER_CLASS = "micropatches-bases-pagination";
// On the result count while a pager follows it.
const PAGED_CLASS = "micropatches-bases-paginated";

function isQueryController(value: unknown): value is QueryController {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<QueryController>;
  const resultsMenu = candidate.resultsMenu as { toolbarItem?: { button?: { containerEl?: HTMLElement } } } | undefined;
  return (
    typeof candidate.getViewConfig === "function" &&
    typeof candidate.notifyView === "function" &&
    typeof candidate.addChild === "function" &&
    typeof candidate.removeChild === "function" &&
    candidate.viewContainerEl?.instanceOf(HTMLElement) === true &&
    resultsMenu?.toolbarItem?.button?.containerEl?.instanceOf(HTMLElement) === true
  );
}

function limitOf(config: ViewConfigInternals | null | undefined): number {
  const limit = typeof config?.getLimit === "function" ? config.getLimit() : 0;
  return Number.isInteger(limit) && limit > 0 ? limit : 0;
}

function viewConfigOf(controller: QueryController): ViewConfigInternals | null {
  // Throws while the controller has no query (a base being loaded).
  try {
    return controller.getViewConfig() ?? null;
  } catch {
    return null;
  }
}

/**
 * Pagination for bases with a result limit: instead of only the first
 * `limit` results, previous/next buttons next to the result count step
 * through all of them, `limit` at a time.
 *
 * Bases cuts the sorted results down to the limit in
 * BasesQueryResult.applyLimit; the wrapper drops the pages before the current
 * one first, so the cut keeps exactly the current page and sort, grouping
 * and summaries work as usual. Pages live in memory per view config: the
 * .base file is never written, and a page resets to the first one whenever
 * the number of results changes (a search, a filter) or the limit does.
 */
export const basesPagination: Patch = {
  id: "bases-pagination",
  name: "Bases pagination",
  description:
    "Adds previous and next page buttons next to the result count of a base with a result limit, to step through all results instead of only the first ones. Nothing is saved to the .base file.",

  register(plugin: Plugin, ctx: PatchContext): PatchHandle {
    const { app } = plugin;
    const prototype = BasesQueryResult.prototype as unknown as QueryResultInternals;
    let pages = new WeakMap<ViewConfigInternals, PageState>();
    const pagers = new Map<QueryController, Pager>();
    let restore: (() => void) | null = null;
    let unloaded = false;
    let syncQueued = false;

    // Every loaded controller listens to the vault's "config-changed" with
    // itself as the context, so the listeners list them all: bases in tabs,
    // embeds, code blocks and canvases alike.
    const controllers = (): QueryController[] => {
      const listeners = (app.vault as unknown as { _?: Record<string, Array<{ ctx?: unknown }> | undefined> })._;
      const found: QueryController[] = [];
      for (const { ctx: listener } of listeners?.["config-changed"] ?? []) {
        if (isQueryController(listener)) found.push(listener);
      }
      return found;
    };

    const goTo = (controller: QueryController, state: PageState, page: number): void => {
      if (page < 0 || page >= state.pageCount || page === state.page) return;
      state.page = page;
      controller.notifyView();
      queueSync();
      controller.viewContainerEl.scrollTo({ top: 0 });
    };

    const createPager = (controller: QueryController): Pager => {
      const anchorEl = controller.resultsMenu.toolbarItem.button.containerEl;
      // Created in the toolbar's own document: the base may be in a popout window.
      const el = (anchorEl.parentElement ?? anchorEl).createDiv(`bases-toolbar-item ${PAGER_CLASS}`);
      anchorEl.after(el);
      anchorEl.addClass(PAGED_CLASS);
      const button = (icon: string, tooltip: string, step: number): HTMLElement => {
        const buttonEl = el.createDiv({ cls: "text-icon-button", attr: { tabindex: 0, role: "button" } });
        setIcon(buttonEl.createSpan("text-button-icon"), icon);
        setTooltip(buttonEl, tooltip);
        const act = (): void => {
          const { state } = pager;
          if (state) goTo(controller, state, state.page + step);
        };
        buttonEl.addEventListener("click", (evt) => {
          evt.preventDefault();
          act();
        });
        buttonEl.addEventListener("keydown", (evt) => {
          if (evt.isComposing || evt.defaultPrevented || (evt.key !== "Enter" && evt.key !== " ")) return;
          evt.preventDefault();
          act();
        });
        return buttonEl;
      };
      const prevEl = button("lucide-chevron-left", "Previous page", -1);
      const labelEl = el.createSpan({ cls: `${PAGER_CLASS}-label`, attr: { "aria-live": "polite" } });
      const nextEl = button("lucide-chevron-right", "Next page", 1);
      // Closing the base's tab unloads the controller and its children.
      // A child rather than controller.register(), which the plugin could
      // never take back: removePager() removes it.
      const hook = new Component();
      hook.register(() => {
        removePager(controller);
      });
      controller.addChild(hook);
      const pager: Pager = { el, anchorEl, prevEl, labelEl, nextEl, state: null, hook };
      return pager;
    };

    const removePager = (controller: QueryController): void => {
      const pager = pagers.get(controller);
      if (!pager) return;
      // First: removing the hook below calls removePager() again.
      pagers.delete(controller);
      pager.el.remove();
      pager.anchorEl.removeClass(PAGED_CLASS);
      controller.removeChild(pager.hook);
    };

    const renderPager = (controller: QueryController, state: PageState): void => {
      let pager = pagers.get(controller);
      if (pager?.el.isConnected !== true) {
        removePager(controller);
        pager = createPager(controller);
        pagers.set(controller, pager);
      }
      pager.state = state;
      const { page, pageCount, limit, total } = state;
      pager.labelEl.setText(`${(page + 1).toLocaleString()} / ${pageCount.toLocaleString()}`);
      const first = page * limit + 1;
      const last = Math.min(total, first + limit - 1);
      setTooltip(pager.labelEl, `${first.toLocaleString()}–${last.toLocaleString()} of ${total.toLocaleString()}`);
      for (const [buttonEl, disabled] of [
        [pager.prevEl, page === 0],
        [pager.nextEl, page === pageCount - 1],
      ] as const) {
        buttonEl.toggleClass("is-disabled", disabled);
        buttonEl.setAttr("aria-disabled", String(disabled));
      }
    };

    // After the render that queued it, when the toolbar is up to date too.
    const sync = (): void => {
      syncQueued = false;
      const live = new Set<QueryController>();
      for (const controller of controllers()) {
        const config = viewConfigOf(controller);
        const state = config ? pages.get(config) : undefined;
        if (!state || state.pageCount === 0) continue;
        live.add(controller);
        renderPager(controller, state);
      }
      for (const controller of Array.from(pagers.keys())) {
        if (!live.has(controller)) removePager(controller);
      }
    };

    const queueSync = (): void => {
      if (syncQueued) return;
      syncQueued = true;
      queueMicrotask(sync);
    };

    // Drops the pages before the current one, so the limit keeps the page.
    const paginate = (config: ViewConfigInternals, entries: BasesEntry[]): void => {
      // Every render: the tab may just have switched to a view or a base
      // that needs no pager, and the old one has to go.
      queueSync();
      const limit = limitOf(config);
      let state = pages.get(config);
      if (limit === 0) {
        if (state) state.pageCount = 0;
        return;
      }
      const total = entries.length;
      const sort = JSON.stringify(config.getSort());
      if (!state) {
        state = { page: 0, pageCount: 0, limit, total, sort };
        pages.set(config, state);
      }
      // A new search, filter, limit or sort starts over from the first page.
      if (state.total !== total || state.limit !== limit || state.sort !== sort) {
        Object.assign(state, { page: 0, limit, total, sort });
      }
      state.pageCount = total > limit ? Math.ceil(total / limit) : 0;
      if (state.page > 0) entries.splice(0, state.page * limit);
    };

    // Re-renders limited bases, first clearing pagers nothing tracks (left
    // by an earlier load of the plugin), which would otherwise never go.
    const refreshLimited = (): void => {
      for (const controller of controllers()) {
        const anchorEl = controller.resultsMenu.toolbarItem.button.containerEl;
        const tracked = pagers.get(controller)?.el;
        for (const el of Array.from(anchorEl.parentElement?.querySelectorAll<HTMLElement>(`.${PAGER_CLASS}`) ?? [])) {
          if (el !== tracked) el.remove();
        }
        if (!tracked) anchorEl.removeClass(PAGED_CLASS);
        if (limitOf(viewConfigOf(controller)) > 0) controller.notifyView();
      }
    };

    const install = (): void => {
      if (restore) return;
      const previous = prototype.applyLimit;
      if (typeof previous !== "function") return;
      const hadOwn = Object.prototype.hasOwnProperty.call(prototype, "applyLimit");
      const wrapper: ApplyLimit = function (entries) {
        try {
          if (this.config && Array.isArray(entries)) paginate(this.config, entries);
        } catch (error) {
          console.error("Micropatches (bases-pagination): paging failed", error);
        }
        previous.call(this, entries);
      };
      prototype.applyLimit = wrapper;
      // If someone else wrapped it meanwhile, leave their wrapper alone.
      restore = (): void => {
        if (prototype.applyLimit !== wrapper) return;
        if (hadOwn) prototype.applyLimit = previous;
        else delete prototype.applyLimit;
      };
      refreshLimited();
    };

    const uninstall = (): void => {
      if (!restore) return;
      restore();
      restore = null;
      for (const controller of Array.from(pagers.keys())) removePager(controller);
      pages = new WeakMap();
      // Back to the first page everywhere.
      refreshLimited();
    };

    // A view that fails to load renders nothing, so no render cleans up
    // the pager it leaves behind; layout changes cover that.
    plugin.registerEvent(
      app.workspace.on("layout-change", () => {
        if (pagers.size > 0) queueSync();
      }),
    );

    // Deferred: bases restored with the workspace render right after load.
    app.workspace.onLayoutReady(() => {
      if (!unloaded && ctx.isEnabled()) install();
    });

    return {
      cleanup: (): void => {
        unloaded = true;
        uninstall();
      },
      onToggle: (enabled: boolean): void => {
        if (enabled) install();
        else uninstall();
      },
    };
  },
};
