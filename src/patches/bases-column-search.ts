import {
  type App,
  type BasesEntry,
  type BasesPropertyId,
  type BasesViewConfig,
  Component,
  FileValue,
  getLinkpath,
  HTMLValue,
  ImageValue,
  LinkValue,
  ListValue,
  MarkdownRenderer,
  Menu,
  NullValue,
  Platform,
  type Plugin,
  type Scope,
  SearchComponent,
  setIcon,
  setTooltip,
  TFile,
  type Value,
} from "obsidian";
import type { Patch, PatchContext, PatchHandle } from "../patch";

type SearchFn = (this: QueryController, entries: BasesEntry[], order: BasesPropertyId[]) => BasesEntry[];

// Undocumented Bases internals, not in obsidian.d.ts. Everything is checked
// before use: if Bases changes shape, header clicks fall back to native sorting.
interface QueryController {
  // The parsed .base; its file is unset for a base written in a code block.
  query?: { file?: unknown } | null;
  viewName?: string | null;
  viewContainerEl: HTMLElement;
  results: Map<TFile, BasesEntry>;
  view: unknown;
  propertyMenu?: { toolbarItem?: { menu?: unknown } };
  getViewConfig(): BasesViewConfig | null | undefined;
  // notifyView() runs every result through this (native search) before the
  // view's sort, limit and grouping, so filtering here is invisible to them.
  applySearchQuery: SearchFn;
  notifyView(): void;
  addChild(child: Component): unknown;
  removeChild(child: Component): unknown;
}

interface TableView {
  getCellFromDom(el: HTMLElement): { prop?: unknown } | null | undefined;
}

// The popover Bases uses for its own toolbar menus (sort, filter,
// properties): anchored under an element, closed by Escape or an outside
// click, a bottom sheet on phones.
interface ToolbarMenu {
  menuEl: HTMLElement;
  scrollEl: HTMLElement;
  scope: Scope;
  setOpen(open: boolean): void;
  setAutoDestroy(anchorEl: HTMLElement): void;
  onClose(callback: () => void): unknown;
}

type ToolbarMenuConstructor = new (app: App, anchorEl: HTMLElement, title: string) => ToolbarMenu;

interface ColumnFilter {
  // What the search field shows.
  query: string;
  // Set once a value is picked from the list: rows must contain exactly it.
  key: string | null;
}

interface ControllerState {
  controller: QueryController;
  // applySearchQuery as found before any wrapping: native search only.
  search: SearchFn;
  // The .base file the filters were set on.
  file: unknown;
  filters: Map<string, Map<BasesPropertyId, ColumnFilter>>; // by view name
  restore: (() => void) | null;
  frame: number;
  indicatorsQueued: boolean;
  // A child of the controller, so the filters go when the base does.
  hook: Component;
}

interface HeaderTarget {
  controller: QueryController;
  cellEl: HTMLElement;
  prop: BasesPropertyId;
}

// One value inside a cell; list properties contribute one item per element.
interface CellItem {
  value: Value;
  label: string;
  link: string | null;
  display: string | null;
  file: TFile | null;
}

interface ValueOption extends CellItem {
  key: string;
  // Every label the value was seen under, lowercased, one per line.
  lower: string;
  count: number;
  sourcePath: string;
}

const POPOVER_CLASS = "micropatches-bases-column-search";
const INDICATOR_CLASS = "micropatches-bases-column-filter";
// Rows rendered at a time: about two screenfuls of the list. Scrolling
// down renders the next ones, typing narrows them down.
const LIST_CHUNK = 30;

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function isQueryController(value: unknown): value is QueryController {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<QueryController>;
  return (
    typeof candidate.applySearchQuery === "function" &&
    typeof candidate.notifyView === "function" &&
    typeof candidate.getViewConfig === "function" &&
    typeof candidate.addChild === "function" &&
    typeof candidate.removeChild === "function" &&
    candidate.results instanceof Map &&
    candidate.viewContainerEl?.instanceOf(HTMLElement) === true
  );
}

function isTableView(value: unknown): value is TableView {
  return value != null && typeof (value as Partial<TableView>).getCellFromDom === "function";
}

function toolbarMenuClass(controller: QueryController): ToolbarMenuConstructor | null {
  const menu = controller.propertyMenu?.toolbarItem?.menu as Partial<ToolbarMenu> | undefined;
  if (
    !menu ||
    typeof menu.setOpen !== "function" ||
    typeof menu.setAutoDestroy !== "function" ||
    typeof menu.onClose !== "function" ||
    !menu.scrollEl ||
    !menu.scope
  ) {
    return null;
  }
  return menu.constructor as ToolbarMenuConstructor;
}

function viewKey(controller: QueryController): string {
  return controller.viewName ?? "";
}

function baseFile(controller: QueryController): unknown {
  return controller.query?.file ?? null;
}

// Element, not HTMLElement: a click on a header icon lands on an SVG node.
function targetElement(evt: UIEvent): Element | null {
  const node = evt.targetNode;
  return node?.instanceOf(Element) === true ? node : null;
}

export function tokenize(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

// LinkValue keeps its parts private; toString() is its public wikilink form.
export function parseWikilink(text: string): { link: string; display: string | null } {
  const inner = text.startsWith("[[") && text.endsWith("]]") ? text.slice(2, -2) : text;
  const bar = inner.indexOf("|");
  if (bar === -1) return { link: inner, display: null };
  const display = inner.slice(bar + 1);
  return { link: inner.slice(0, bar), display: display !== "" ? display : null };
}

export function describe(value: Value): CellItem | null {
  if (value instanceof LinkValue) {
    const { link, display } = parseWikilink(value.toString());
    return { value, label: display ?? link, link, display, file: null };
  }
  if (value instanceof FileValue) {
    const file = (value as unknown as { file?: unknown }).file;
    if (file instanceof TFile) {
      const label = file.extension === "md" ? file.basename : file.name;
      return { value, label, link: null, display: null, file };
    }
  }
  const label = value.toString();
  return label.trim() !== "" ? { value, label, link: null, display: null, file: null } : null;
}

function collect(value: Value | null, items: CellItem[]): void {
  if (!value || value instanceof NullValue) return;
  if (value instanceof ListValue) {
    for (let index = 0; index < value.length(); index++) collect(value.get(index), items);
    return;
  }
  const item = describe(value);
  if (item) items.push(item);
}

export function cellItems(entry: BasesEntry, prop: BasesPropertyId): CellItem[] {
  let value: Value | null;
  try {
    value = entry.getValue(prop);
  } catch {
    return [];
  }
  const items: CellItem[] = [];
  collect(value, items);
  return items;
}

// Identity of a value across rows: a link and a file value pointing to the
// same note are one value, however each row happens to spell the link.
export function itemKey(app: App, item: CellItem, sourcePath: string): string {
  if (item.file) return `file:${item.file.path}`;
  if (item.link !== null) {
    const linkpath = getLinkpath(item.link);
    const dest = app.metadataCache.getFirstLinkpathDest(linkpath, sourcePath);
    return dest ? `file:${dest.path}` : `link:${linkpath.toLowerCase()}`;
  }
  return `text:${item.label.trim().toLowerCase()}`;
}

/**
 * Column search for Bases tables, a rewrite of the column search from the
 * "Bases Utilities" plugin. Clicking a table header opens Bases' own toolbar
 * popover with a search field and the column's distinct values; the table
 * narrows as you type, and picking a value keeps only rows that contain it.
 * Filters are held in memory per open base and view, so the .base file is
 * never written and closing the base forgets them.
 *
 * Filtering wraps applySearchQuery only on controllers that have a filter,
 * the step where Bases applies its native search, so sort, limit, grouping
 * and summaries all see the narrowed rows and every other base is untouched.
 */
export const basesColumnSearch: Patch = {
  id: "bases-column-search",
  name: "Bases column search",
  description:
    "Clicking a table column header searches that column instead of sorting it: rows narrow as you type, and picking a value keeps only rows that contain it. Nothing is saved to the .base file. Sorting stays in the header's context menu.",

  register(plugin: Plugin, ctx: PatchContext): PatchHandle {
    const { app } = plugin;
    const states = new Map<QueryController, ControllerState>();
    const windows = new Map<Window, () => void>();
    let current: { menu: ToolbarMenu; anchorEl: HTMLElement; controller: QueryController } | null = null;
    let reportedError = false;

    const reportError = (error: unknown): void => {
      if (reportedError) return;
      reportedError = true;
      console.error("Micropatches (bases-column-search): filtering failed, showing all rows", error);
    };

    // Every loaded controller listens to the vault's "config-changed" with
    // itself as the context, so the listeners list them all: bases in tabs,
    // embeds, code blocks and canvases alike.
    const findController = (root: HTMLElement): QueryController | null => {
      const listeners = (app.vault as unknown as { _?: Record<string, Array<{ ctx?: unknown }> | undefined> })._;
      for (const { ctx } of listeners?.["config-changed"] ?? []) {
        if (isQueryController(ctx) && ctx.viewContainerEl === root) return ctx;
      }
      return null;
    };

    const headerTarget = (evt: MouseEvent): HeaderTarget | null => {
      const target = targetElement(evt);
      if (!target || target.closest(".bases-table-header-resizer")) return null;
      const cellEl = target.closest<HTMLElement>(".bases-thead .bases-td");
      const root = cellEl?.closest<HTMLElement>(".bases-view");
      if (!cellEl || !root) return null;
      const controller = findController(root);
      if (!controller || !isTableView(controller.view)) return null;
      const prop = controller.view.getCellFromDom(cellEl)?.prop;
      return typeof prop === "string" ? { controller, cellEl, prop: prop as BasesPropertyId } : null;
    };

    // A tab keeps its controller when it opens another .base file; the
    // filters are dropped then rather than carried over to it.
    const filtersOf = (state: ControllerState): Map<BasesPropertyId, ColumnFilter> | undefined => {
      const file = baseFile(state.controller);
      if (file !== state.file) {
        state.file = file;
        state.filters.clear();
        uninstall(state);
      }
      return state.filters.get(viewKey(state.controller));
    };

    const matcher = (prop: BasesPropertyId, filter: ColumnFilter): ((entry: BasesEntry) => boolean) => {
      const { key } = filter;
      if (key !== null) {
        return (entry) => cellItems(entry, prop).some((item) => itemKey(app, item, entry.file.path) === key);
      }
      const tokens = tokenize(filter.query);
      return (entry) => {
        const text = cellItems(entry, prop)
          .map((item) => item.label.toLowerCase())
          .join("\n");
        return tokens.every((token) => text.includes(token));
      };
    };

    // A filter only applies while its column is shown in a table, where the
    // header marks it and can take it off; hiding the column or switching the
    // view to cards suspends it.
    const applyFilters = (state: ControllerState, entries: BasesEntry[], except?: BasesPropertyId): BasesEntry[] => {
      const filters = filtersOf(state);
      if (!filters || !isTableView(state.controller.view)) return entries;
      const columns = new Set(state.controller.getViewConfig()?.getOrder());
      const tests: Array<(entry: BasesEntry) => boolean> = [];
      for (const [prop, filter] of filters) {
        if (prop !== except && columns.has(prop)) tests.push(matcher(prop, filter));
      }
      if (tests.length === 0) return entries;
      return entries.filter((entry) => tests.every((test) => test(entry)));
    };

    const syncIndicators = (state: ControllerState): void => {
      const { controller } = state;
      const view = controller.view;
      if (!isTableView(view)) return;
      const filters = filtersOf(state);
      const cells = controller.viewContainerEl.querySelectorAll<HTMLElement>(".bases-thead .bases-td");
      for (const cellEl of Array.from(cells)) {
        const prop = view.getCellFromDom(cellEl)?.prop;
        const filter = typeof prop === "string" ? filters?.get(prop as BasesPropertyId) : undefined;
        let icon = cellEl.querySelector<HTMLElement>(`.${INDICATOR_CLASS}`);
        if (!filter) {
          icon?.remove();
          continue;
        }
        if (!icon) {
          const labelEl = cellEl.querySelector<HTMLElement>(".bases-table-header-label");
          if (!labelEl) continue;
          icon = labelEl.createDiv(INDICATOR_CLASS);
          setIcon(icon, "list-filter");
        }
        setTooltip(icon, filter.query);
      }
    };

    // Header cells are reused across renders, but a new column or a view
    // switch builds fresh ones. Runs right after the render that queued it.
    const queueIndicators = (state: ControllerState): void => {
      if (state.indicatorsQueued) return;
      state.indicatorsQueued = true;
      queueMicrotask(() => {
        state.indicatorsQueued = false;
        syncIndicators(state);
      });
    };

    const install = (state: ControllerState): void => {
      if (state.restore) return;
      const { controller } = state;
      const hadOwn = Object.prototype.hasOwnProperty.call(controller, "applySearchQuery");
      const previous = controller.applySearchQuery;
      const wrapper: SearchFn = function (entries, order) {
        const result = previous.call(this, entries, order);
        queueIndicators(state);
        try {
          return applyFilters(state, result);
        } catch (error) {
          reportError(error);
          return result;
        }
      };
      controller.applySearchQuery = wrapper;
      // If someone else wrapped it meanwhile, leave their wrapper alone.
      state.restore = (): void => {
        if (controller.applySearchQuery !== wrapper) return;
        if (hadOwn) controller.applySearchQuery = previous;
        else delete (controller as unknown as Record<string, unknown>)["applySearchQuery"];
      };
    };

    const uninstall = (state: ControllerState): void => {
      state.restore?.();
      state.restore = null;
    };

    const forget = (controller: QueryController): void => {
      const state = states.get(controller);
      if (!state) return;
      // First: removing the hook below calls forget() again.
      states.delete(controller);
      // An open popover would put the wrapper back on a state nothing tracks.
      if (current?.controller === controller) closeSearch();
      if (state.frame !== 0) controller.viewContainerEl.win.cancelAnimationFrame(state.frame);
      uninstall(state);
      controller.removeChild(state.hook);
    };

    const stateFor = (controller: QueryController): ControllerState => {
      let state = states.get(controller);
      if (state) return state;
      const hook = new Component();
      state = {
        controller,
        search: controller.applySearchQuery,
        file: baseFile(controller),
        filters: new Map(),
        restore: null,
        frame: 0,
        indicatorsQueued: false,
        hook,
      };
      states.set(controller, state);
      // Closing the base's tab unloads the controller and its children.
      // A child rather than controller.register(), which the plugin could
      // never take back: forget() removes it.
      hook.register(() => {
        forget(controller);
      });
      controller.addChild(hook);
      return state;
    };

    // One re-render per frame however fast you type; native search waits
    // for a 50 ms debounce instead.
    const refresh = (state: ControllerState): void => {
      if (state.frame !== 0) return;
      state.frame = state.controller.viewContainerEl.win.requestAnimationFrame(() => {
        state.frame = 0;
        state.controller.notifyView();
        // The wrapper syncs them itself; this covers the last filter going.
        if (!state.restore) syncIndicators(state);
      });
    };

    const setFilter = (state: ControllerState, prop: BasesPropertyId, filter: ColumnFilter | null): void => {
      const view = viewKey(state.controller);
      let filters = filtersOf(state);
      if (filter) {
        if (!filters) {
          filters = new Map<BasesPropertyId, ColumnFilter>();
          state.filters.set(view, filters);
        }
        filters.set(prop, filter);
      } else if (filters) {
        filters.delete(prop);
        if (filters.size === 0) state.filters.delete(view);
      }
      if (state.filters.size > 0) install(state);
      else uninstall(state);
      refresh(state);
    };

    // Distinct values of the column among rows that pass the native search
    // and the other columns' filters, most frequent first.
    const collectOptions = (state: ControllerState, prop: BasesPropertyId): ValueOption[] => {
      const { controller } = state;
      const order = controller.getViewConfig()?.getOrder() ?? [];
      const entries = applyFilters(
        state,
        state.search.call(controller, Array.from(controller.results.values()), order),
        prop,
      );
      const options = new Map<string, ValueOption>();
      for (const entry of entries) {
        const seen = new Set<string>();
        for (const item of cellItems(entry, prop)) {
          const key = itemKey(app, item, entry.file.path);
          if (seen.has(key)) continue;
          seen.add(key);
          const lower = item.label.toLowerCase();
          const option = options.get(key);
          if (option) {
            option.count++;
            // Any spelling of a note finds it, as it does among the rows.
            if (!option.lower.includes(lower)) option.lower += `\n${lower}`;
          } else {
            options.set(key, { ...item, key, lower, count: 1, sourcePath: entry.file.path });
          }
        }
      }
      return Array.from(options.values()).sort((a, b) =>
        a.count !== b.count ? b.count - a.count : collator.compare(a.label, b.label),
      );
    };

    const renderValue = (el: HTMLElement, option: ValueOption, component: Component): void => {
      const linktext = option.file ? app.metadataCache.fileToLinktext(option.file, option.sourcePath) : option.link;
      if (linktext !== null) {
        // Rendered as Markdown so link decorators such as Supercharged Links
        // style it exactly like the same link in a note.
        el.addClass("markdown-rendered");
        const alias = option.display !== null ? `|${option.display}` : "";
        void MarkdownRenderer.render(app, `[[${linktext}${alias}]]`, el, option.sourcePath, component)
          .then(() => {
            if (option.key.startsWith("link:")) el.querySelector(".internal-link")?.addClass("is-unresolved");
          })
          .catch(() => {
            el.setText(option.label);
          });
        return;
      }
      if (option.value instanceof ImageValue || option.value instanceof HTMLValue) {
        el.setText(option.label);
        return;
      }
      try {
        option.value.renderTo(el, app.renderContext);
      } catch {
        el.setText(option.label);
      }
    };

    const closeSearch = (): void => {
      current?.menu.setOpen(false);
    };

    const openSearch = ({ controller, cellEl, prop }: HeaderTarget): boolean => {
      const ToolbarMenuClass = toolbarMenuClass(controller);
      if (!ToolbarMenuClass) return false;
      closeSearch();

      const state = stateFor(controller);
      const title = controller.getViewConfig()?.getDisplayName(prop) ?? prop;
      const menu = new ToolbarMenuClass(app, cellEl, title);
      const component = new Component();
      component.load();
      menu.menuEl.addClass(POPOVER_CLASS);

      const containerEl = menu.scrollEl.createDiv("bases-toolbar-menu-container");
      const search = new SearchComponent(containerEl).setPlaceholder(`Search ${title}…`);
      search.inputEl.parentElement?.addClass("mod-raised");
      const groupEl = containerEl.createDiv("bases-toolbar-items").createDiv("suggestion-group");

      let options = collectOptions(state, prop);
      const rows = new Map<string, HTMLElement>();
      const optionOf = new WeakMap<HTMLElement, ValueOption>();
      let matching: ValueOption[] = [];
      let shown: ValueOption[] = [];
      let selected = 0;

      const rowFor = (option: ValueOption): HTMLElement => {
        let row = rows.get(option.key);
        if (row) return row;
        row = groupEl.createDiv("suggestion-item bases-toolbar-menu-item bases-summary-menu-item");
        const infoEl = row.createDiv("bases-toolbar-menu-item-info");
        renderValue(infoEl.createDiv("bases-toolbar-menu-item-name"), option, component);
        infoEl.createDiv({ cls: "bases-toolbar-menu-item-value", text: option.count.toLocaleString() });
        rows.set(option.key, row);
        optionOf.set(row, option);
        return row;
      };

      // Only the keyboard scrolls the list: under the pointer it would move.
      const select = (index: number, scroll = true): void => {
        if (shown.length === 0) return;
        selected = (index + shown.length) % shown.length;
        shown.forEach((option, i) => rows.get(option.key)?.toggleClass("is-selected", i === selected));
        const option = shown[selected];
        if (option && scroll) rows.get(option.key)?.scrollIntoView({ block: "nearest" });
      };

      // more: render the next chunk of the same list instead of starting over.
      const render = (more = false): void => {
        if (!more) matching = options;
        const tokens = more ? [] : tokenize(search.getValue());
        if (tokens.length > 0) {
          const [first = ""] = tokens;
          matching = options.filter((option) => tokens.every((token) => option.lower.includes(token)));
          // Values that start with what you typed come first.
          matching = [
            ...matching.filter((option) => option.lower.startsWith(first)),
            ...matching.filter((option) => !option.lower.startsWith(first)),
          ];
        }
        shown = matching.slice(0, more ? shown.length + LIST_CHUNK : LIST_CHUNK);
        const activeKey = filtersOf(state)?.get(prop)?.key ?? null;
        groupEl.setChildrenInPlace(
          shown.map((option) => {
            const row = rowFor(option);
            row.toggleClass("mod-active", option.key === activeKey);
            return row;
          }),
        );
        if (shown.length === 0) groupEl.createDiv({ cls: "suggestion-empty", text: "No matching values." });
        if (more) return;
        selected = 0;
        select(0);
      };

      const hasMore = (): boolean => shown.length < matching.length;

      const pick = (option: ValueOption): void => {
        // Picking the active value again turns the filter off.
        if (filtersOf(state)?.get(prop)?.key === option.key) {
          search.setValue("");
          setFilter(state, prop, null);
          render();
          return;
        }
        search.setValue(option.label);
        setFilter(state, prop, { query: option.label, key: option.key });
        menu.setOpen(false);
      };

      search.setValue(filtersOf(state)?.get(prop)?.query ?? "");
      const file = baseFile(controller);
      search.onChange((value) => {
        // The base can go away under an open popover (tab closed, another
        // .base opened in it) before the popover notices and closes.
        if (!cellEl.isConnected || baseFile(controller) !== file) {
          menu.setOpen(false);
          return;
        }
        setFilter(state, prop, value.trim() !== "" ? { query: value, key: null } : null);
        render();
      });

      const optionAt = (evt: MouseEvent): ValueOption | undefined => {
        const row = targetElement(evt)?.closest<HTMLElement>(".suggestion-item");
        return row ? optionOf.get(row) : undefined;
      };
      // Keep the caret in the search field while clicking rows.
      groupEl.addEventListener("mousedown", (evt) => {
        evt.preventDefault();
      });
      groupEl.addEventListener("mousemove", (evt) => {
        const option = optionAt(evt);
        if (option && shown[selected] !== option) select(shown.indexOf(option), false);
      });
      groupEl.addEventListener("click", (evt) => {
        const option = optionAt(evt);
        if (option) pick(option);
      });
      // Capture: the list scrolls on desktop, the whole sheet on phones.
      menu.menuEl.addEventListener(
        "scroll",
        (evt) => {
          const scroller = [groupEl, menu.scrollEl].find((el) => el === evt.target);
          if (scroller && hasMore() && scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 200) {
            render(true);
          }
        },
        { capture: true, passive: true },
      );

      menu.scope.register([], "ArrowDown", () => {
        if (selected === shown.length - 1 && hasMore()) render(true);
        select(selected + 1);
        return false;
      });
      menu.scope.register([], "ArrowUp", () => {
        select(selected - 1);
        return false;
      });
      menu.scope.register([], "Enter", (evt) => {
        if (evt.isComposing) return;
        const option = shown[selected];
        if (option) pick(option);
        else menu.setOpen(false);
        return false;
      });

      menu.onClose(() => {
        component.unload();
        // Link decorators can keep the rendered links, and through them the
        // detached popover, alive; let go of the rows and the value list.
        groupEl.empty();
        rows.clear();
        options = matching = shown = [];
        if (current?.menu === menu) current = null;
      });
      menu.setAutoDestroy(cellEl);
      current = { menu, anchorEl: cellEl, controller };
      render();
      menu.setOpen(true);
      search.inputEl.focus();
      search.inputEl.select();
      return true;
    };

    const tryOpenSearch = (target: HeaderTarget): void => {
      try {
        openSearch(target);
      } catch (error) {
        console.error("Micropatches (bases-column-search): opening the search failed", error);
      }
    };

    // Capture phase, before the table's own header handler, which skips
    // sorting once the default is prevented.
    const onClick = (evt: MouseEvent): void => {
      if (!ctx.isEnabled() || evt.button !== 0 || evt.shiftKey || evt.altKey || evt.ctrlKey || evt.metaKey) return;
      const target = headerTarget(evt);
      if (!target) return;
      if (current?.anchorEl === target.cellEl) {
        evt.preventDefault();
        closeSearch();
        return;
      }
      if (!toolbarMenuClass(target.controller)) return;
      // Prevented up front: if opening fails, the click must not fall
      // through to sorting, which writes the .base file.
      evt.preventDefault();
      tryOpenSearch(target);
    };

    // Bubble phase, after the header built its native menu (which prevents
    // the default): add an entry to that same menu. On mobile this is the
    // only way in, since tapping a header opens the menu.
    const onMenu = (evt: MouseEvent): void => {
      if (!ctx.isEnabled() || !evt.defaultPrevented) return;
      const target = headerTarget(evt);
      if (!target || !toolbarMenuClass(target.controller)) return;
      Menu.forEvent(evt).addItem((item) =>
        item
          .setSection("action")
          .setTitle("Search column")
          .setIcon("lucide-search")
          .onClick(() => {
            // Once the menu has closed: closing clears the header highlight
            // the popover sets.
            target.cellEl.win.setTimeout(() => {
              tryOpenSearch(target);
            });
          }),
      );
    };

    const setupWindow = (win: Window): void => {
      if (windows.has(win)) return;
      const doc = win.document;
      const menuEvent = Platform.isMobile ? "click" : "contextmenu";
      if (!Platform.isMobile) doc.addEventListener("click", onClick, true);
      doc.addEventListener(menuEvent, onMenu);
      windows.set(win, () => {
        doc.removeEventListener("click", onClick, true);
        doc.removeEventListener(menuEvent, onMenu);
      });
    };

    const teardownWindow = (win: Window): void => {
      const teardown = windows.get(win);
      if (!teardown) return;
      windows.delete(win);
      // win.document can legitimately be gone on a late "window-close".
      try {
        teardown();
      } catch (error) {
        console.error("Micropatches (bases-column-search): teardown cleanup failed", error);
      }
    };

    const clearAll = (): void => {
      closeSearch();
      for (const state of Array.from(states.values())) {
        forget(state.controller);
        state.filters.clear();
        try {
          state.controller.notifyView();
          syncIndicators(state);
        } catch (error) {
          console.error("Micropatches (bases-column-search): restoring a base failed", error);
        }
      }
    };

    setupWindow(window);
    // Popouts that were open before this loaded (the plugin enabled later)
    // fire no "window-open". Once unloaded, not even the main window is set up.
    app.workspace.onLayoutReady(() => {
      if (!windows.has(window)) return;
      app.workspace.iterateAllLeaves((leaf) => {
        setupWindow(leaf.view.containerEl.win);
      });
    });
    plugin.registerEvent(
      app.workspace.on("window-open", (_workspaceWindow, win) => {
        setupWindow(win);
      }),
    );
    plugin.registerEvent(
      app.workspace.on("window-close", (_workspaceWindow, win) => {
        teardownWindow(win);
      }),
    );

    return {
      cleanup: (): void => {
        clearAll();
        for (const win of Array.from(windows.keys())) teardownWindow(win);
      },
      onToggle: (enabled: boolean): void => {
        if (!enabled) clearAll();
      },
    };
  },
};
