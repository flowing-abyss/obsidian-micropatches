import {
  type App,
  type EventRef,
  MarkdownView,
  moment,
  Notice,
  type Plugin,
  type TAbstractFile,
  TFile,
  type WorkspaceLeaf,
} from "obsidian";
import type { Patch, PatchContext, PatchHandle } from "../patch";

type Granularity = "day" | "week" | "month" | "quarter" | "year";
type Direction = "backwards" | "forwards";
type PeriodDate = ReturnType<typeof moment>;

interface PeriodicNoteMetadata {
  calendarSet: string;
  filePath: string;
  date: PeriodDate;
  granularity: Granularity;
}

interface PeriodicNotesApi {
  findInCache(filePath: string): PeriodicNoteMetadata | null;
  findAdjacent(calendarSet: string, filePath: string, direction: Direction): PeriodicNoteMetadata | null | undefined;
  getPeriodicNote(granularity: Granularity, date: PeriodDate): TFile | null;
  createPeriodicNote(granularity: Granularity, date: PeriodDate): Promise<TFile>;
  calendarSetManager?: {
    getActiveSet(): string;
    getFormat(granularity: Granularity): string;
  };
}

interface AppWithCommunityPlugins extends App {
  plugins?: {
    getPlugin(id: string): unknown;
  };
}

interface CustomWorkspaceEvents {
  on(name: "periodic-notes:resolve", callback: (granularity: Granularity, file: TFile) => void): EventRef;
  on(name: "periodic-notes:settings-updated", callback: () => void): EventRef;
}

const HOST_CLASS = "micropatches-periodic-breadcrumbs";
const BUTTON_CLASS = "micropatches-periodic-breadcrumb";
const PREVIOUS_CLASS = "is-previous";
const NEXT_CLASS = "is-next";
const CREATE_CLASS = "is-create";
const STATE_ATTRIBUTE = "data-micropatches-periodic-breadcrumbs-state";

const DEFAULT_FORMATS: Record<Granularity, string> = {
  day: "YYYY-MM-DD",
  week: "YYYY-[W]ww",
  month: "YYYY-MM",
  quarter: "YYYY-[Q]Q",
  year: "YYYY",
};

const PERIOD_NAMES: Record<Granularity, string> = {
  day: "daily",
  week: "weekly",
  month: "monthly",
  quarter: "quarterly",
  year: "yearly",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function getPeriodicNotesApi(app: App): PeriodicNotesApi | null {
  const registry = (app as AppWithCommunityPlugins).plugins;
  const candidate = registry?.getPlugin("periodic-notes");
  if (!isRecord(candidate)) return null;
  if (
    typeof candidate["findInCache"] !== "function" ||
    typeof candidate["findAdjacent"] !== "function" ||
    typeof candidate["getPeriodicNote"] !== "function" ||
    typeof candidate["createPeriodicNote"] !== "function"
  ) {
    return null;
  }
  return candidate as unknown as PeriodicNotesApi;
}

function shiftedDate(metadata: PeriodicNoteMetadata, amount: -1 | 1): PeriodDate {
  return metadata.date.clone().add(amount, metadata.granularity).startOf(metadata.granularity);
}

function basename(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name.endsWith(".md") ? name.slice(0, -3) : name;
}

function labelForDate(api: PeriodicNotesApi, metadata: PeriodicNoteMetadata, date: PeriodDate): string {
  const format = api.calendarSetManager?.getFormat(metadata.granularity) ?? DEFAULT_FORMATS[metadata.granularity];
  return basename(date.format(format));
}

function periodName(metadata: PeriodicNoteMetadata): string {
  return PERIOD_NAMES[metadata.granularity];
}

function findExistingAdjacent(
  app: App,
  api: PeriodicNotesApi,
  current: PeriodicNoteMetadata,
  direction: Direction,
): PeriodicNoteMetadata | null {
  const seen = new Set([current.filePath]);
  let cursor = current;
  while (true) {
    const adjacent = api.findAdjacent(cursor.calendarSet, cursor.filePath, direction) ?? null;
    if (adjacent === null || seen.has(adjacent.filePath)) return null;
    seen.add(adjacent.filePath);
    if (app.vault.getFileByPath(adjacent.filePath) !== null) return adjacent;
    // Periodic Notes 1.0.0 does not evict deleted files from its cache. Keep
    // following its ordering while ignoring entries the vault no longer has.
    cursor = adjacent;
  }
}

function removeControls(view: MarkdownView): void {
  const container = view.containerEl.querySelector<HTMLElement>(".view-header-title-container");
  if (container === null) return;
  for (const button of Array.from(container.querySelectorAll<HTMLElement>(`.${BUTTON_CLASS}`))) button.remove();
  container.classList.remove(HOST_CLASS);
  container.removeAttribute(STATE_ATTRIBUTE);
}

function makeButton(
  container: HTMLElement,
  label: string,
  className: string,
  ariaLabel: string,
  disabled: boolean,
  onClick: () => void,
): HTMLButtonElement {
  const button = container.createEl("button", {
    cls: `${BUTTON_CLASS} ${className}`,
    text: label,
    attr: { type: "button", "aria-label": ariaLabel },
  });
  button.disabled = disabled;
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onClick();
  });
  return button;
}

export const periodicBreadcrumbs: Patch = {
  id: "periodic-breadcrumbs",
  name: "Periodic note breadcrumbs",
  description:
    "Adds the previous and next existing period to a periodic note's breadcrumb. At the newest note, the muted next period creates it. Requires Periodic Notes 1.0.0 or newer.",

  register(plugin: Plugin, ctx: PatchContext): PatchHandle {
    interface NavigationState {
      expectedPath: string;
      generation: number;
      tail: Promise<void>;
    }

    const navigation = new WeakMap<WorkspaceLeaf, NavigationState>();
    const pendingLeaves = new Set<WorkspaceLeaf>();
    let refreshFrame: number | null = null;
    let refreshAllPending = false;
    let navigationGeneration = 0;
    let disposed = false;

    const isCurrentNavigation = (leaf: WorkspaceLeaf, state: NavigationState): boolean =>
      !disposed && ctx.isEnabled() && state.generation === navigationGeneration && navigation.get(leaf) === state;

    const navigate = async (leaf: WorkspaceLeaf, state: NavigationState, direction: Direction): Promise<void> => {
      if (!isCurrentNavigation(leaf, state)) return;
      const api = getPeriodicNotesApi(plugin.app);
      const view = leaf.view;
      if (
        api === null ||
        !(view instanceof MarkdownView) ||
        view.file === null ||
        view.file.path !== state.expectedPath
      ) {
        navigation.delete(leaf);
        return;
      }

      const current = api.findInCache(view.file.path);
      if (current === null) {
        navigation.delete(leaf);
        return;
      }

      const adjacent = findExistingAdjacent(plugin.app, api, current, direction);
      let target: TFile | null = adjacent === null ? null : plugin.app.vault.getFileByPath(adjacent.filePath);

      if (target === null && direction === "forwards") {
        if (api.calendarSetManager?.getActiveSet() !== current.calendarSet) return;
        const nextDate = shiftedDate(current, 1);
        target = api.getPeriodicNote(current.granularity, nextDate);
        if (target === null) target = await api.createPeriodicNote(current.granularity, nextDate);
      }

      const liveView = leaf.view;
      if (
        !isCurrentNavigation(leaf, state) ||
        !(liveView instanceof MarkdownView) ||
        liveView.file?.path !== state.expectedPath ||
        target === null
      ) {
        return;
      }
      const targetMetadata = api.findInCache(target.path);
      if (targetMetadata?.calendarSet !== current.calendarSet || targetMetadata.granularity !== current.granularity) {
        return;
      }
      await leaf.openFile(target, { active: true });
      if (!isCurrentNavigation(leaf, state)) return;
      state.expectedPath = target.path;
    };

    const enqueueNavigation = (leaf: WorkspaceLeaf, sourcePath: string, direction: Direction): void => {
      if (disposed || !ctx.isEnabled()) return;
      let state = navigation.get(leaf);
      const livePath = leaf.view instanceof MarkdownView ? leaf.view.file?.path : undefined;
      if (
        state === undefined ||
        state.generation !== navigationGeneration ||
        (sourcePath !== state.expectedPath && livePath === sourcePath)
      ) {
        state = { expectedPath: sourcePath, generation: navigationGeneration, tail: Promise.resolve() };
        navigation.set(leaf, state);
      }

      const currentState = state;
      const next = currentState.tail
        .then(() => navigate(leaf, currentState, direction))
        .catch((error: unknown) => {
          if (!isCurrentNavigation(leaf, currentState)) return;
          console.error("Micropatches (periodic-breadcrumbs): navigation failed", error);
          new Notice("Couldn't open the periodic note.");
        });
      currentState.tail = next;
      void next.then(() => {
        if (navigation.get(leaf) === currentState && currentState.tail === next) navigation.delete(leaf);
      });
    };

    const renderLeaf = (leaf: WorkspaceLeaf): void => {
      const view = leaf.view;
      if (!(view instanceof MarkdownView)) return;
      if (!ctx.isEnabled() || view.file === null) {
        removeControls(view);
        return;
      }

      const api = getPeriodicNotesApi(plugin.app);
      const current = api === null ? null : api.findInCache(view.file.path);
      if (api === null || current === null) {
        removeControls(view);
        return;
      }

      const container = view.containerEl.querySelector<HTMLElement>(".view-header-title-container");
      if (container === null) return;

      const previous = findExistingAdjacent(plugin.app, api, current, "backwards");
      const next = findExistingAdjacent(plugin.app, api, current, "forwards");
      const previousLabel =
        previous === null
          ? labelForDate(api, current, shiftedDate(current, -1))
          : labelForDate(api, current, previous.date);
      const nextLabel =
        next === null ? labelForDate(api, current, shiftedDate(current, 1)) : labelForDate(api, current, next.date);
      const kind = periodName(current);
      const canCreate = api.calendarSetManager?.getActiveSet() === current.calendarSet;
      const renderState = [
        current.filePath,
        previousLabel,
        previous === null,
        nextLabel,
        next === null,
        canCreate,
      ].join("\n");
      if (
        container.getAttribute(STATE_ATTRIBUTE) === renderState &&
        container.querySelectorAll(`.${BUTTON_CLASS}`).length === 2
      ) {
        return;
      }

      removeControls(view);
      container.classList.add(HOST_CLASS);
      container.setAttribute(STATE_ATTRIBUTE, renderState);

      const previousButton = makeButton(
        container,
        previousLabel,
        PREVIOUS_CLASS,
        previous === null ? `No previous ${kind} note` : `Open ${previousLabel}`,
        previous === null,
        () => enqueueNavigation(leaf, current.filePath, "backwards"),
      );
      container.prepend(previousButton);

      makeButton(
        container,
        nextLabel,
        `${NEXT_CLASS}${next === null && canCreate ? ` ${CREATE_CLASS}` : ""}`,
        next === null ? (canCreate ? `Create ${nextLabel}` : `No next ${kind} note`) : `Open ${nextLabel}`,
        next === null && !canCreate,
        () => enqueueNavigation(leaf, current.filePath, "forwards"),
      );
    };

    const refreshAll = (): void => {
      if (disposed) return;
      plugin.app.workspace.iterateAllLeaves(renderLeaf);
    };

    const scheduleRefresh = (leaf?: WorkspaceLeaf | null): void => {
      if (leaf === undefined || leaf === null) refreshAllPending = true;
      else pendingLeaves.add(leaf);
      if (disposed || refreshFrame !== null) return;
      const ownerWindow = plugin.app.workspace.containerEl.ownerDocument.defaultView ?? window;
      refreshFrame = ownerWindow.requestAnimationFrame(() => {
        // file-open fires before MarkdownView.file and the managed breadcrumb
        // finish switching. Waiting one additional paint keeps labels tied to
        // the file that is actually visible, without delaying navigation.
        refreshFrame = ownerWindow.requestAnimationFrame(() => {
          refreshFrame = null;
          if (refreshAllPending) refreshAll();
          else for (const pendingLeaf of pendingLeaves) renderLeaf(pendingLeaf);
          refreshAllPending = false;
          pendingLeaves.clear();
        });
      });
    };

    const scheduleActiveLeaf = (): void => {
      const activeView = plugin.app.workspace.getActiveViewOfType(MarkdownView);
      if (activeView !== null) scheduleRefresh(activeView.leaf);
    };
    const scheduleIfPeriodic = (file: TAbstractFile, oldPath?: string): void => {
      const api = getPeriodicNotesApi(plugin.app);
      if (api === null) return;
      if (
        !(file instanceof TFile) ||
        api.findInCache(file.path) !== null ||
        (oldPath !== undefined && api.findInCache(oldPath) !== null)
      ) {
        scheduleRefresh();
      }
    };
    const scheduleResolvedPeriod = (_granularity: Granularity, file: TFile): void => {
      const api = getPeriodicNotesApi(plugin.app);
      const resolved = api?.findInCache(file.path) ?? null;
      if (api === null || resolved === null) return;
      plugin.app.workspace.iterateAllLeaves((leaf) => {
        const view = leaf.view;
        if (!(view instanceof MarkdownView) || view.file === null) return;
        const current = api.findInCache(view.file.path);
        if (current?.calendarSet === resolved.calendarSet && current.granularity === resolved.granularity) {
          scheduleRefresh(leaf);
        }
      });
    };

    plugin.registerEvent(plugin.app.workspace.on("file-open", scheduleActiveLeaf));
    plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", scheduleRefresh));
    plugin.registerEvent(plugin.app.workspace.on("layout-change", () => scheduleRefresh()));
    plugin.registerEvent(plugin.app.vault.on("delete", scheduleIfPeriodic));
    plugin.registerEvent(plugin.app.vault.on("rename", scheduleIfPeriodic));

    const customEvents = plugin.app.workspace as unknown as CustomWorkspaceEvents;
    plugin.registerEvent(customEvents.on("periodic-notes:resolve", scheduleResolvedPeriod));
    plugin.registerEvent(customEvents.on("periodic-notes:settings-updated", () => scheduleRefresh()));

    plugin.app.workspace.onLayoutReady(() => scheduleRefresh());
    scheduleRefresh();

    return {
      cleanup: (): void => {
        disposed = true;
        refreshAllPending = false;
        pendingLeaves.clear();
        if (refreshFrame !== null) {
          const ownerWindow = plugin.app.workspace.containerEl.ownerDocument.defaultView ?? window;
          ownerWindow.cancelAnimationFrame(refreshFrame);
          refreshFrame = null;
        }
        plugin.app.workspace.iterateAllLeaves((leaf) => {
          if (leaf.view instanceof MarkdownView) removeControls(leaf.view);
        });
      },
      onToggle: (): void => {
        navigationGeneration += 1;
        refreshAll();
      },
    };
  },
};
