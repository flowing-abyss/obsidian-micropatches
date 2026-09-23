import type {
  BasesEntry as Entry,
  BasesPropertyId,
  BasesViewConfig as ViewConfig,
  PluginManifest,
  Value,
} from "obsidian";
import {
  App,
  BasesEntry,
  BasesViewConfig,
  Component,
  FileValue,
  LinkValue,
  ListValue,
  MarkdownRenderer,
  Menu,
  NullValue,
  NumberValue,
  Plugin,
  StringValue,
  type TFile,
} from "obsidian-test-mocks/obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PatchContext, PatchHandle } from "../patch";
import {
  basesColumnSearch,
  cellItems,
  describe as describeValue,
  itemKey,
  parseWikilink,
  tokenize,
} from "./bases-column-search";

const STATUS = "note.status";
const PEOPLE = "note.people";
const TAGS = "note.tags";
const COLUMNS = [STATUS, PEOPLE, TAGS] as const;
const ALL = ["Write", "Review", "Ship", "Plan", "Test"];

type Rows = Record<string, Partial<Record<(typeof COLUMNS)[number], Value>>>;

const manifest: PluginManifest = {
  id: "micropatches",
  name: "Micropatches",
  author: "test",
  version: "0.0.0",
  minAppVersion: "1.13.0",
  description: "test",
};

class TestPlugin extends Plugin {}

// jsdom has no scrollIntoView; the popover scrolls its selected row into view.
Element.prototype.scrollIntoView = function (): void {};

let app: App;
const handles: PatchHandle[] = [];
const menus: FakeMenu[] = [];

function file(path: string): TFile {
  const found = app.vault.getFileByPath(path);
  if (!found) throw new Error(`No file at ${path}`);
  return found;
}

const str = (text: string): Value => StringValue.create__(text).asOriginalType__();
const link = (target: string, display?: string): Value =>
  LinkValue.create2__(app, target, "", display).asOriginalType__();
const fileValue = (path: string): Value => FileValue.create__(app, file(path)).asOriginalType__();
const list = (...values: Value[]): Value => ListValue.create__(values).asOriginalType__();

function item(value: Value): NonNullable<ReturnType<typeof describeValue>> {
  const found = describeValue(value);
  if (!found) throw new Error("Blank value");
  return found;
}

function tasks(): Rows {
  return {
    Write: { [STATUS]: str("Done"), [PEOPLE]: list(link("Ann")), [TAGS]: list(str("alpha"), str("project")) },
    Review: { [STATUS]: str("Todo"), [PEOPLE]: list(link("People/Ann", "Annie")), [TAGS]: list(str("beta")) },
    Ship: { [STATUS]: str("Done"), [PEOPLE]: fileValue("People/Bob.md"), [TAGS]: list(str("alpha")) },
    Plan: { [STATUS]: str("Blocked"), [PEOPLE]: link("Anne") },
    Test: { [PEOPLE]: list(fileValue("People/Ann.md"), link("Bob")), [TAGS]: list(str("project"), str("project")) },
  };
}

// Stands in for Bases' toolbar popover, whose class the patch borrows from the
// controller's property menu.
class FakeMenu {
  readonly menuEl = createDiv();
  readonly scrollEl = this.menuEl.createDiv();
  readonly keys = new Map<string, (evt: KeyboardEvent) => unknown>();
  readonly scope = {
    register: (_modifiers: unknown, key: string, handler: (evt: KeyboardEvent) => unknown): void => {
      this.keys.set(key, handler);
    },
  };
  isOpen = false;
  private readonly closers: Array<() => void> = [];

  constructor(
    _app?: unknown,
    readonly anchorEl?: HTMLElement,
    readonly title?: string,
  ) {
    if (anchorEl) menus.push(this);
  }

  setOpen(open: boolean): void {
    if (open === this.isOpen) return;
    this.isOpen = open;
    if (open) document.body.append(this.menuEl);
    else {
      this.menuEl.remove();
      for (const close of this.closers) close();
    }
  }

  setAutoDestroy(): void {}

  onClose(callback: () => void): void {
    this.closers.push(callback);
  }
}

// A Bases QueryController as far as the patch looks at it.
class FakeController extends Component {
  query: { file: unknown } | null = { file: "Tasks.base" };
  viewName = "Table";
  readonly viewContainerEl = createDiv("bases-view");
  readonly results = new Map<string, Entry>();
  view: unknown = { getCellFromDom: (el: HTMLElement) => ({ prop: el.getAttribute("data-prop") }) };
  propertyMenu: unknown = { toolbarItem: { menu: new FakeMenu() } };
  readonly config = BasesViewConfig.create__("", "table", "Table");
  // Bases renders by running the results through applySearchQuery.
  readonly notifyView = vi.fn(() => {
    this.visible();
  });

  getViewConfig(): ViewConfig {
    return this.config.asOriginalType__();
  }

  applySearchQuery(entries: Entry[], _order: BasesPropertyId[]): Entry[] {
    return entries;
  }

  visible(): string[] {
    return this.applySearchQuery(Array.from(this.results.values()), this.config.getOrder()).map(
      (entry) => entry.file.basename,
    );
  }
}

function setup(rows: Rows) {
  const plugin = new TestPlugin(app, manifest);
  let enabled = true;
  const ctx: PatchContext = {
    isEnabled: () => enabled,
    getConfig: <T>(_key: string, fallback: T): T => fallback,
    setConfig: () => Promise.resolve(),
  };
  const controller = new FakeController();
  for (const [name, values] of Object.entries(rows)) {
    const entry = BasesEntry.create__(null, file(`tasks/${name}.md`));
    for (const prop of COLUMNS) entry.setValue__(prop, values[prop] ?? null);
    controller.results.set(name, entry.asOriginalType__());
  }
  controller.config.setOrder([...COLUMNS]);
  const head = controller.viewContainerEl.createDiv("bases-thead");
  for (const prop of COLUMNS) {
    head.createDiv({ cls: "bases-td", attr: { "data-prop": prop } }).createDiv("bases-table-header-label");
  }
  document.body.append(controller.viewContainerEl);
  controller.load();
  // Loaded controllers list themselves as listener contexts; the patch finds them there.
  const listener = (): void => {};
  app.vault.on("config-changed", listener, controller);
  const handle = basesColumnSearch.register(plugin.asOriginalType2__(), ctx);
  handles.push(handle);
  return {
    controller,
    handle,
    setEnabled: (value: boolean): void => {
      enabled = value;
    },
    unlist: (): void => {
      app.vault.off("config-changed", listener);
    },
  };
}

function header(controller: FakeController, prop: string): HTMLElement {
  const cell = controller.viewContainerEl.querySelector<HTMLElement>(`[data-prop="${prop}"]`);
  if (!cell) throw new Error(`No header for ${prop}`);
  return cell;
}

function click(el: Element, init: MouseEventInit = {}): MouseEvent {
  const evt = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(evt);
  return evt;
}

function lastMenu(): FakeMenu {
  const menu = menus[menus.length - 1];
  if (!menu) throw new Error("No popover opened");
  return menu;
}

function input(): HTMLInputElement {
  const el = lastMenu().menuEl.querySelector("input");
  if (!el) throw new Error("No search field");
  return el;
}

function type(text: string): void {
  input().value = text;
  input().dispatchEvent(new Event("input"));
}

function press(key: string): void {
  lastMenu().keys.get(key)?.(new KeyboardEvent("keydown", { key }));
}

// A popover row as "name count".
function label(row: Element): string {
  return ["name", "value"]
    .map((part) => row.querySelector(`.bases-toolbar-menu-item-${part}`)?.textContent ?? "")
    .join(" ");
}

function options(): string[] {
  return Array.from(lastMenu().menuEl.querySelectorAll(".suggestion-item"), label);
}

function row(name: string): Element {
  const found = Array.from(lastMenu().menuEl.querySelectorAll(".suggestion-item")).find(
    (el) => el.querySelector(".bases-toolbar-menu-item-name")?.textContent === name,
  );
  if (!found) throw new Error(`No row for ${name}`);
  return found;
}

// The own applySearchQuery, if the patch (or anyone) installed one.
function ownSearch(controller: FakeController): unknown {
  return Object.getOwnPropertyDescriptor(controller, "applySearchQuery")?.value;
}

beforeEach(() => {
  vi.useFakeTimers();
  app = App.createConfigured__({
    files: Object.fromEntries(
      [
        "People/Ann.md",
        "People/Anne.md",
        "People/Bob.md",
        "Docs/Spec.pdf",
        ...ALL.map((name) => `tasks/${name}.md`),
      ].map((path) => [path, ""]),
    ),
  });
  menus.length = 0;
  vi.spyOn(MarkdownRenderer, "render").mockImplementation((_app, markdown, el) => {
    el.setText(markdown);
    return Promise.resolve();
  });
});

afterEach(() => {
  for (const handle of handles.splice(0)) handle.cleanup();
  document.body.empty();
  vi.useRealTimers();
});

describe("bases-column-search values", () => {
  it("splits a query into lowercase words", () => {
    expect(tokenize("  Foo\tBAR  baz ")).toEqual(["foo", "bar", "baz"]);
    expect(tokenize(" ")).toEqual([]);
  });

  it("parses a wikilink's target and display text", () => {
    expect(parseWikilink("[[a|b]]")).toEqual({ link: "a", display: "b" });
    expect(parseWikilink("[[a#Intro|b]]")).toEqual({ link: "a#Intro", display: "b" });
    expect(parseWikilink("[[a]]")).toEqual({ link: "a", display: null });
    expect(parseWikilink("[[a|]]")).toEqual({ link: "a", display: null });
    expect(parseWikilink("a|b")).toEqual({ link: "a", display: "b" });
  });

  it("labels links by their display text, files by their name, the rest by their text", () => {
    expect(describeValue(link("People/Ann", "Annie"))).toMatchObject({
      label: "Annie",
      link: "People/Ann",
      display: "Annie",
      file: null,
    });
    expect(describeValue(link("Ann"))).toMatchObject({ label: "Ann", link: "Ann", display: null });
    expect(describeValue(fileValue("People/Ann.md"))).toMatchObject({ label: "Ann", link: null });
    expect(describeValue(fileValue("Docs/Spec.pdf"))).toMatchObject({ label: "Spec.pdf" });
    expect(describeValue(NumberValue.create__(3).asOriginalType__())).toMatchObject({ label: "3", link: null });
    expect(describeValue(str("  "))).toBeNull();
  });

  it("flattens a cell's lists, skipping nulls and blanks", () => {
    const entry = BasesEntry.create__(null, file("tasks/Write.md"));
    entry.setValue__(TAGS, list(str("a"), NullValue.value.asOriginalType__(), list(str("b"), str(" ")), link("Ann")));

    expect(cellItems(entry.asOriginalType__(), TAGS).map(({ label }) => label)).toEqual(["a", "b", "Ann"]);
    expect(cellItems(entry.asOriginalType__(), STATUS)).toEqual([]);
    vi.spyOn(entry, "getValue").mockImplementation(() => {
      throw new Error("Formula failed");
    });
    expect(cellItems(entry.asOriginalType__(), TAGS)).toEqual([]);
  });

  it("gives every spelling of the same note one key", () => {
    const keys = [link("Ann"), link("People/Ann", "Annie"), link("Ann#Intro"), fileValue("People/Ann.md")].map(
      (value) => itemKey(app.asOriginalType__(), item(value), "tasks/Write.md"),
    );

    expect(new Set(keys)).toEqual(new Set(["file:People/Ann.md"]));
    expect(itemKey(app.asOriginalType__(), item(link("Anne")), "")).toBe("file:People/Anne.md");
  });

  it("keys unresolved links by path and text by its trimmed lowercase", () => {
    const key = (value: Value): string => itemKey(app.asOriginalType__(), item(value), "");

    expect(key(link("Nowhere#Top"))).toBe("link:nowhere");
    expect(key(link("nowhere", "Somewhere"))).toBe("link:nowhere");
    expect(key(str(" Done "))).toBe("text:done");
    expect(key(str("Ann"))).toBe("text:ann");
  });
});

describe("bases-column-search popover", () => {
  it("opens on a header click instead of sorting, and closes on a second one", () => {
    const { controller } = setup(tasks());

    expect(click(header(controller, STATUS)).defaultPrevented).toBe(true);
    expect(lastMenu()).toMatchObject({ isOpen: true, title: "status", anchorEl: header(controller, STATUS) });
    expect(lastMenu().menuEl.classList.contains("micropatches-bases-column-search")).toBe(true);
    expect(input().placeholder).toBe("Search status…");

    expect(click(header(controller, STATUS)).defaultPrevented).toBe(true);
    expect(lastMenu().isOpen).toBe(false);
  });

  it("leaves header clicks to sorting when off, modified, or Bases looks different", () => {
    const { controller, setEnabled, unlist } = setup(tasks());
    const cell = header(controller, STATUS);

    setEnabled(false);
    expect(click(cell).defaultPrevented).toBe(false);
    setEnabled(true);
    expect(click(cell, { shiftKey: true }).defaultPrevented).toBe(false);
    expect(click(cell, { button: 1 }).defaultPrevented).toBe(false);
    const { propertyMenu, view } = controller;
    controller.propertyMenu = { toolbarItem: {} };
    expect(click(cell).defaultPrevented).toBe(false);
    controller.propertyMenu = propertyMenu;
    controller.view = {};
    expect(click(cell).defaultPrevented).toBe(false);
    controller.view = view;
    unlist();
    expect(click(cell).defaultPrevented).toBe(false);
    expect(menus).toHaveLength(0);
  });

  it("adds a Search column item to the header's context menu", () => {
    const { controller } = setup(tasks());
    const nativeMenu = Menu.create2__();
    const forEvent = vi.spyOn(Menu, "forEvent").mockReturnValue(nativeMenu);
    const cell = header(controller, TAGS);
    const contextMenu = (): boolean =>
      cell.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, cancelable: true }));

    contextMenu();
    expect(forEvent).not.toHaveBeenCalled();

    // The header's own handler builds the native menu and prevents the default.
    cell.addEventListener("contextmenu", (evt) => {
      evt.preventDefault();
    });
    contextMenu();
    const [entry] = nativeMenu.menuItems__;
    expect(entry?.title__).toBe("Search column");
    entry?.onClick__?.(new MouseEvent("click"));
    vi.runAllTimers();
    expect(lastMenu()).toMatchObject({ isOpen: true, title: "tags" });
  });

  it("lists a column's values once per row, most frequent first", () => {
    const { controller } = setup(tasks());

    click(header(controller, STATUS));
    expect(options()).toEqual(["Done 2", "Blocked 1", "Todo 1"]);
    click(header(controller, TAGS));
    expect(options()).toEqual(["alpha 2", "project 2", "beta 1"]);
    // Every spelling of a note, link or file, is one value.
    click(header(controller, PEOPLE));
    expect(options()).toEqual(["[[Ann]] 3", "[[Bob]] 2", "[[Anne]] 1"]);
  });

  it("orders equally frequent values naturally", () => {
    const { controller } = setup({
      Write: { [STATUS]: str("Step 10") },
      Review: { [STATUS]: str("Step 9") },
      Ship: { [STATUS]: str("step 2") },
    });

    click(header(controller, STATUS));
    expect(options()).toEqual(["step 2 1", "Step 9 1", "Step 10 1"]);
  });

  it("narrows the list as you type, values starting with it first", () => {
    const { controller } = setup(tasks());

    click(header(controller, TAGS));
    type("p");
    expect(options()).toEqual(["project 2", "alpha 2"]);
    type("zzz");
    expect(options()).toEqual([]);
    expect(lastMenu().menuEl.querySelector(".suggestion-empty")?.textContent).toBe("No matching values.");
  });

  it("narrows rows as you type, every word matching the cell's text", () => {
    const { controller } = setup(tasks());

    click(header(controller, PEOPLE));
    type("an");
    expect(controller.visible()).toEqual(["Write", "Review", "Plan", "Test"]);
    // A link matches by the text it shows.
    type("ANN ie");
    expect(controller.visible()).toEqual(["Review"]);
    type("");
    // Words may match different items of a list.
    click(header(controller, TAGS));
    type("alp proj");
    expect(controller.visible()).toEqual(["Write"]);
  });

  it("combines the filters of several columns", () => {
    const { controller } = setup(tasks());

    click(header(controller, TAGS));
    type("alpha");
    expect(controller.visible()).toEqual(["Write", "Ship"]);
    click(header(controller, PEOPLE));
    type("bob");
    expect(controller.visible()).toEqual(["Ship"]);
  });

  it("keeps only rows containing exactly a picked value, and drops it when picked again", () => {
    const { controller } = setup(tasks());

    click(header(controller, PEOPLE));
    click(row("[[Ann]]"));
    expect(controller.visible()).toEqual(["Write", "Review", "Test"]);
    expect(lastMenu().isOpen).toBe(false);

    click(header(controller, PEOPLE));
    expect(input().value).toBe("Ann");
    expect(row("[[Ann]]").classList.contains("mod-active")).toBe(true);
    click(row("[[Ann]]"));
    expect(controller.visible()).toEqual(ALL);
    expect(lastMenu().isOpen).toBe(true);
    expect(input().value).toBe("");
  });

  it("moves the selection with the arrow keys and picks it with Enter", () => {
    const { controller } = setup(tasks());
    const selected = (): string => label(lastMenu().menuEl.querySelector(".is-selected") ?? createDiv());

    click(header(controller, STATUS));
    expect(selected()).toBe("Done 2");
    press("ArrowDown");
    expect(selected()).toBe("Blocked 1");
    press("ArrowUp");
    press("ArrowUp");
    expect(selected()).toBe("Todo 1");
    press("Enter");
    expect(controller.visible()).toEqual(["Review"]);
  });

  it("lists the values the other columns' filters leave, but not its own filter's", () => {
    const { controller } = setup({
      Write: { [STATUS]: str("Done"), [TAGS]: str("alpha") },
      Review: { [STATUS]: str("Done later"), [TAGS]: str("beta") },
      Ship: { [STATUS]: str("Done"), [TAGS]: str("gamma") },
    });

    click(header(controller, STATUS));
    click(row("Done"));
    click(header(controller, TAGS));
    expect(options()).toEqual(["alpha 1", "gamma 1"]);
    // Reopened on the picked value, whose text narrows the list.
    click(header(controller, STATUS));
    expect(options()).toEqual(["Done 2", "Done later 1"]);
  });

  it("closes without filtering once its base is gone", () => {
    const { controller } = setup(tasks());

    click(header(controller, STATUS));
    header(controller, STATUS).remove();
    type("todo");
    expect(lastMenu().isOpen).toBe(false);
    expect(controller.visible()).toEqual(ALL);

    click(header(controller, TAGS));
    controller.query = { file: "Other.base" };
    type("alpha");
    expect(lastMenu().isOpen).toBe(false);
    expect(controller.visible()).toEqual(ALL);
  });
});

describe("bases-column-search filtering", () => {
  it("wraps applySearchQuery only while a filter is set", () => {
    const { controller } = setup(tasks());

    click(header(controller, STATUS));
    expect(ownSearch(controller)).toBeUndefined();
    type("do");
    expect(ownSearch(controller)).toBeTypeOf("function");
    expect(controller.visible()).toEqual(["Write", "Review", "Ship"]);
    type(" ");
    expect(ownSearch(controller)).toBeUndefined();
    expect(controller.visible()).toEqual(ALL);
  });

  it("puts back an applySearchQuery of the base's own, and leaves a later wrapper alone", () => {
    const { controller } = setup(tasks());
    const own = (entries: Entry[]): Entry[] => entries;
    controller.applySearchQuery = own;

    click(header(controller, STATUS));
    type("do");
    expect(ownSearch(controller)).not.toBe(own);
    type("");
    expect(ownSearch(controller)).toBe(own);

    type("do");
    const later = (entries: Entry[]): Entry[] => entries;
    controller.applySearchQuery = later;
    type("");
    expect(ownSearch(controller)).toBe(later);
  });

  it("re-renders the base once per frame however fast you type", () => {
    const { controller } = setup(tasks());

    click(header(controller, STATUS));
    type("d");
    type("do");
    type("don");
    expect(controller.notifyView).not.toHaveBeenCalled();
    vi.advanceTimersToNextFrame();
    expect(controller.notifyView).toHaveBeenCalledTimes(1);
  });

  it("marks the filtered column's header while the filter lasts", async () => {
    const { controller } = setup(tasks());
    const mark = (prop: string): Element | null =>
      header(controller, prop).querySelector(".bases-table-header-label .micropatches-bases-column-filter");

    click(header(controller, STATUS));
    type("todo");
    vi.advanceTimersToNextFrame();
    await Promise.resolve();
    expect(mark(STATUS)).not.toBeNull();
    expect(mark(PEOPLE)).toBeNull();

    type("");
    vi.advanceTimersToNextFrame();
    expect(mark(STATUS)).toBeNull();
  });

  it("applies a filter only while its column is shown in a table", () => {
    const { controller } = setup(tasks());

    click(header(controller, STATUS));
    type("todo");
    expect(controller.visible()).toEqual(["Review"]);
    controller.config.setOrder([PEOPLE, TAGS]);
    expect(controller.visible()).toEqual(ALL);
    controller.config.setOrder([...COLUMNS]);
    expect(controller.visible()).toEqual(["Review"]);
    const { view } = controller;
    controller.view = {};
    expect(controller.visible()).toEqual(ALL);
    controller.view = view;
    expect(controller.visible()).toEqual(["Review"]);
  });

  it("keeps filters per view", () => {
    const { controller } = setup(tasks());

    click(header(controller, STATUS));
    type("todo");
    controller.viewName = "Board";
    expect(controller.visible()).toEqual(ALL);
    controller.viewName = "Table";
    expect(controller.visible()).toEqual(["Review"]);
  });

  it("drops the filters when the tab opens another base", () => {
    const { controller } = setup(tasks());

    click(header(controller, STATUS));
    type("todo");
    controller.query = { file: "Other.base" };
    expect(controller.visible()).toEqual(ALL);
    expect(ownSearch(controller)).toBeUndefined();
    controller.query = { file: "Tasks.base" };
    expect(controller.visible()).toEqual(ALL);
  });

  it("shows every row, reporting once, if filtering fails", () => {
    const { controller } = setup(tasks());
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    click(header(controller, STATUS));
    type("todo");
    controller.getViewConfig = (): ViewConfig => {
      throw new Error("Config gone");
    };
    expect(controller.visible()).toEqual(ALL);
    expect(controller.visible()).toEqual(ALL);
    expect(error).toHaveBeenCalledTimes(1);
  });
});

describe("bases-column-search lifecycle", () => {
  it("clears every filter and re-renders when turned off", () => {
    const { controller, handle, setEnabled } = setup(tasks());

    click(header(controller, STATUS));
    type("todo");
    expect(controller._children).toHaveLength(1);
    setEnabled(false);
    handle.onToggle?.(false);

    expect(ownSearch(controller)).toBeUndefined();
    expect(controller._children).toHaveLength(0);
    expect(controller.notifyView).toHaveBeenCalledTimes(1);
    expect(lastMenu().isOpen).toBe(false);
    // The frame queued by typing was cancelled.
    vi.runAllTimers();
    expect(controller.notifyView).toHaveBeenCalledTimes(1);

    setEnabled(true);
    handle.onToggle?.(true);
    expect(controller.visible()).toEqual(ALL);
    click(header(controller, STATUS));
    expect(input().value).toBe("");
  });

  it("leaves nothing attached after cleanup", async () => {
    const { controller, handle } = setup(tasks());

    click(header(controller, STATUS));
    type("todo");
    vi.advanceTimersToNextFrame();
    await Promise.resolve();
    handle.cleanup();

    expect(ownSearch(controller)).toBeUndefined();
    expect(controller._children).toHaveLength(0);
    expect(document.querySelector(".micropatches-bases-column-filter")).toBeNull();
    expect(lastMenu().isOpen).toBe(false);
    expect(click(header(controller, STATUS)).defaultPrevented).toBe(false);
  });

  it("forgets a base's filters when the base closes", () => {
    const { controller } = setup(tasks());

    click(header(controller, STATUS));
    type("todo");
    controller.unload();

    expect(ownSearch(controller)).toBeUndefined();
    vi.runAllTimers();
    expect(controller.notifyView).not.toHaveBeenCalled();
  });
});
