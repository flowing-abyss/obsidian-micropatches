import type { PluginManifest } from "obsidian";
import { App, Notice, Plugin, type WorkspaceLeaf } from "obsidian-test-mocks/obsidian";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { PatchHandle } from "../patch";
import { backlinksDefaults, isBacklinksController, normalizedSortOrder } from "./backlinks-defaults";

// Obsidian's setTooltip stores the text in aria-label; the mock's does nothing.
vi.mock("obsidian", async () => ({
  ...(await import("obsidian-test-mocks/obsidian")),
  setTooltip: (el: HTMLElement, text: string): void => {
    el.setAttribute("aria-label", text);
  },
}));

const manifest: PluginManifest = {
  id: "micropatches",
  name: "Micropatches",
  author: "test",
  version: "0.0.0",
  minAppVersion: "1.13.0",
  description: "test",
};

class TestPlugin extends Plugin {}

const INDICATOR = "micropatches-backlinks-default-filter";
const DOT = ".micropatches-backlinks-default-filter-dot";
const INVALID = "bad(";

interface FakeSearch {
  inputEl: HTMLInputElement;
  getValue: () => string;
  setValue: (value: string) => FakeSearch;
  changeCallback?: (value: string) => unknown;
}

interface FakeController {
  file: { path: string } | null;
  searchQuery: { query: string } | null;
  showSearchButtonEl: HTMLElement;
  searchComponent: FakeSearch;
  setCollapseAll: Mock<(value: boolean) => void>;
  setExtraContext: Mock<(value: boolean) => void>;
  setSortOrder: Mock<(value: string) => void>;
  setUnlinkedCollapsed: Mock<(value: boolean, animate: boolean) => void>;
  updateSearch: () => void;
}

interface LeafView {
  containerEl?: HTMLElement;
  backlink?: unknown;
  backlinks?: unknown;
}

// Mirrors Obsidian's Backlinks controller: updateSearch parses whatever the field holds.
function fakeController(path = "a.md", tooltip: string | null = "Show search filter") {
  const showSearchButtonEl = createDiv();
  if (tooltip !== null) showSearchButtonEl.setAttribute("aria-label", tooltip);
  const inputEl = createEl("input");
  const search: FakeSearch = {
    inputEl,
    getValue: () => inputEl.value,
    setValue: (value) => {
      inputEl.value = value;
      return search;
    },
  };
  const native = vi.fn(() => {
    const query = search.getValue();
    controller.searchQuery = query === INVALID ? null : { query };
  });
  const controller: FakeController = {
    file: { path },
    searchQuery: null,
    showSearchButtonEl,
    searchComponent: search,
    setCollapseAll: vi.fn(),
    setExtraContext: vi.fn(),
    setSortOrder: vi.fn(),
    setUnlinkedCollapsed: vi.fn(),
    updateSearch: native,
  };
  return { controller, native, search, button: showSearchButtonEl };
}

function typeQuery(search: FakeSearch, value: string): void {
  search.setValue(value);
  search.changeCallback?.(value);
}

function setup(config: Record<string, unknown>, views: LeafView[]) {
  const app = App.createConfigured__();
  app.workspace.setLayoutReady__();
  const iterate = vi.spyOn(app.workspace, "iterateAllLeaves").mockImplementation((callback) => {
    for (const view of views) callback({ view } as unknown as WorkspaceLeaf);
  });
  const values = new Map(Object.entries(config));
  let enabled = true;
  const handle: PatchHandle = backlinksDefaults.register(new TestPlugin(app, manifest).asOriginalType2__(), {
    isEnabled: () => enabled,
    getConfig: <T>(key: string, fallback: T): T => (values.has(key) ? (values.get(key) as T) : fallback),
    setConfig: () => Promise.resolve(),
  });
  vi.advanceTimersByTime(0);
  return {
    handle,
    iterate,
    rescan: (): void => {
      app.workspace.trigger("layout-change");
      vi.advanceTimersByTime(0);
    },
    setEnabled: (value: boolean): void => {
      enabled = value;
      handle.onToggle?.(value);
    },
    configure: (key: string, value: unknown): void => {
      values.set(key, value);
      handle.onConfigChange?.(key, value);
    },
  };
}

function hasOwn(target: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(target, key);
}

describe("isBacklinksController", () => {
  it("accepts a controller with every piece it uses", () => {
    // No changeCallback: Obsidian only sets it once a listener is attached.
    expect(isBacklinksController(fakeController().controller)).toBe(true);
  });

  it("rejects non-objects", () => {
    for (const value of [null, undefined, "backlinks", 1]) expect(isBacklinksController(value)).toBe(false);
  });

  it("rejects a controller missing any piece", () => {
    const breakers: Array<(controller: FakeController) => void> = [
      (c) => Reflect.deleteProperty(c, "setCollapseAll"),
      (c) => Reflect.deleteProperty(c, "setExtraContext"),
      (c) => Reflect.deleteProperty(c, "setSortOrder"),
      (c) => Reflect.deleteProperty(c, "setUnlinkedCollapsed"),
      (c) => Reflect.deleteProperty(c, "updateSearch"),
      (c) => Reflect.deleteProperty(c, "showSearchButtonEl"),
      (c) => Object.assign(c, { showSearchButtonEl: {} }),
      (c) => Reflect.deleteProperty(c, "searchComponent"),
      (c) => Reflect.deleteProperty(c.searchComponent, "getValue"),
      (c) => Reflect.deleteProperty(c.searchComponent, "setValue"),
      (c) => Reflect.deleteProperty(c.searchComponent, "inputEl"),
      (c) => Object.assign(c.searchComponent, { inputEl: {} }),
      (c) => Object.assign(c.searchComponent, { inputEl: { win: {} } }),
      (c) => Object.assign(c.searchComponent, { inputEl: { win: { setTimeout: vi.fn() } } }),
    ];
    for (const [index, breakController] of breakers.entries()) {
      const { controller } = fakeController();
      breakController(controller);
      expect(isBacklinksController(controller), `breaker ${index}`).toBe(false);
    }
  });
});

describe("normalizedSortOrder", () => {
  it("keeps known orders", () => {
    for (const order of ["alphabetical", "alphabeticalReverse", "byModifiedTime", "byCreatedTimeReverse"]) {
      expect(normalizedSortOrder(order)).toBe(order);
    }
  });

  it("falls back to alphabetical for unknown and inherited names", () => {
    for (const order of ["", "byName", "toString", "constructor", "__proto__"]) {
      expect(normalizedSortOrder(order)).toBe("alphabetical");
    }
  });
});

describe("Backlinks defaults", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("applies display defaults once per file", () => {
    const { controller } = fakeController("a.md");
    const config = { collapseResults: true, showMoreContext: true, sortOrder: "byModifiedTime", expandUnlinked: true };
    const { rescan, handle } = setup(config, [{ backlink: controller }]);

    expect(controller.setCollapseAll).toHaveBeenCalledExactlyOnceWith(true);
    expect(controller.setExtraContext).toHaveBeenCalledExactlyOnceWith(true);
    expect(controller.setSortOrder).toHaveBeenCalledExactlyOnceWith("byModifiedTime");
    expect(controller.setUnlinkedCollapsed).toHaveBeenCalledExactlyOnceWith(false, false);

    rescan();
    expect(controller.setSortOrder).toHaveBeenCalledOnce();

    controller.file = { path: "b.md" };
    rescan();
    expect(controller.setSortOrder).toHaveBeenCalledTimes(2);
    handle.cleanup();
  });

  it("falls back to defaults for malformed settings", () => {
    const { controller, button } = fakeController();
    const config = { collapseResults: "yes", showMoreContext: 1, sortOrder: "byName", expandUnlinked: null };
    const { handle } = setup({ ...config, defaultFilter: 42 }, [{ backlinks: controller }]);

    expect(controller.setCollapseAll).toHaveBeenCalledWith(false);
    expect(controller.setExtraContext).toHaveBeenCalledWith(false);
    expect(controller.setSortOrder).toHaveBeenCalledWith("alphabetical");
    expect(controller.setUnlinkedCollapsed).toHaveBeenCalledWith(true, false);
    expect(controller.searchQuery).toEqual({ query: "" });
    expect(button.hasClass(INDICATOR)).toBe(false);
    handle.cleanup();
  });

  it("applies the trimmed default filter while the field is empty, without showing it", () => {
    const { controller, search } = fakeController();
    const { handle } = setup({ defaultFilter: "  -path:Diary  " }, [{ backlink: controller }]);

    expect(controller.searchQuery).toEqual({ query: "-path:Diary" });
    expect(search.getValue()).toBe("");

    // Obsidian re-runs its own search, e.g. when results refresh.
    controller.searchQuery = null;
    controller.updateSearch();
    expect(controller.searchQuery).toEqual({ query: "-path:Diary" });
    handle.cleanup();
  });

  it("lets a typed query win after a pause, and restores the default when cleared", () => {
    const { controller, search } = fakeController();
    const { handle } = setup({ defaultFilter: "-path:Diary" }, [{ backlink: controller }]);

    typeQuery(search, "tag:#idea");
    vi.advanceTimersByTime(299);
    expect(controller.searchQuery).toEqual({ query: "-path:Diary" });
    vi.advanceTimersByTime(1);
    expect(controller.searchQuery).toEqual({ query: "tag:#idea" });

    typeQuery(search, "");
    vi.advanceTimersByTime(300);
    expect(controller.searchQuery).toEqual({ query: "-path:Diary" });
    expect(search.getValue()).toBe("");
    handle.cleanup();
  });

  it("warns once about an invalid default filter and leaves no hidden filter", () => {
    const notice = vi.spyOn(Notice.prototype, "constructor__");
    const { controller, search } = fakeController();
    const { handle } = setup({ defaultFilter: INVALID }, [{ backlink: controller }]);

    expect(controller.searchQuery).toEqual({ query: "" });
    expect(search.getValue()).toBe("");
    controller.updateSearch();
    expect(notice).toHaveBeenCalledOnce();
    expect(notice.mock.calls[0]?.[0]).toBe("Micropatches: the default backlinks filter is invalid.");
    handle.cleanup();
  });

  it("marks the search button while a default filter is set", () => {
    const { controller, search, button } = fakeController();
    const { handle } = setup({ defaultFilter: "-path:Diary" }, [{ backlink: controller }]);
    const dot = button.querySelector<HTMLElement>(DOT);

    expect(button.hasClass(INDICATOR)).toBe(true);
    expect(button.hasClass("is-overridden")).toBe(false);
    expect(dot?.style.display).toBe("");
    expect(button.getAttribute("aria-label")).toBe("Show search filter. Default filter set in Micropatches");

    typeQuery(search, "tag:#idea");
    expect(button.hasClass("is-overridden")).toBe(true);
    expect(button.getAttribute("aria-label")).toBe("Show search filter. Default filter overridden");
    handle.cleanup();
  });

  it("leaves the search button plain without a default filter", () => {
    const { controller, button } = fakeController();
    const { handle } = setup({}, [{ backlink: controller }]);

    expect(button.hasClass(INDICATOR)).toBe(false);
    expect(button.querySelector<HTMLElement>(DOT)?.style.display).toBe("none");
    expect(button.getAttribute("aria-label")).toBe("Show search filter");
    handle.cleanup();
  });

  it("keeps one period between the original tooltip and the status", () => {
    for (const tooltip of ["Show search filter", "Show search filter.", "Show search filter . ", null]) {
      const { controller, button } = fakeController("a.md", tooltip);
      const { handle } = setup({ defaultFilter: "-path:Diary" }, [{ backlink: controller }]);

      expect(button.getAttribute("aria-label")).toBe("Show search filter. Default filter set in Micropatches");
      handle.cleanup();
      expect(button.getAttribute("aria-label")).toBe(tooltip ?? "Show search filter");
    }
  });

  it("applies changed settings to open Backlinks", () => {
    const { controller, button } = fakeController();
    const { handle, configure } = setup({}, [{ backlink: controller }]);

    configure("sortOrder", "byCreatedTime");
    expect(controller.setSortOrder).toHaveBeenLastCalledWith("byCreatedTime");

    configure("defaultFilter", "-path:Diary");
    expect(button.hasClass(INDICATOR)).toBe(true);
    expect(controller.searchQuery).toEqual({ query: "" });
    vi.advanceTimersByTime(300);
    expect(controller.searchQuery).toEqual({ query: "-path:Diary" });
    handle.cleanup();
  });

  it("restores own handlers, clears the hidden filter and removes the dot when disabled", () => {
    const { controller, native, search, button } = fakeController();
    const change = vi.fn();
    search.changeCallback = change;
    const { setEnabled } = setup({ defaultFilter: "-path:Diary" }, [{ backlink: controller }]);
    expect(controller.updateSearch).not.toBe(native);

    setEnabled(false);
    expect(controller.updateSearch).toBe(native);
    expect(search.changeCallback).toBe(change);
    expect(controller.searchQuery).toEqual({ query: "" });
    expect(button.querySelector(DOT)).toBeNull();
    expect(button.hasClass(INDICATOR)).toBe(false);
    expect(button.getAttribute("aria-label")).toBe("Show search filter");
  });

  it("runs a query still waiting for its pause when disabled", () => {
    const { controller, search } = fakeController();
    const { setEnabled } = setup({}, [{ backlink: controller }]);

    typeQuery(search, "tag:#idea");
    setEnabled(false);
    expect(controller.searchQuery).toEqual({ query: "tag:#idea" });
  });

  it("removes its own properties from controllers whose handlers are inherited", () => {
    const { controller, native, search } = fakeController();
    Reflect.deleteProperty(controller, "updateSearch");
    Object.setPrototypeOf(controller, { updateSearch: native });
    const { handle } = setup({}, [{ backlink: controller }]);
    expect(hasOwn(controller, "updateSearch")).toBe(true);
    expect(hasOwn(search, "changeCallback")).toBe(true);

    handle.cleanup();
    expect(hasOwn(controller, "updateSearch")).toBe(false);
    expect(controller.updateSearch).toBe(native);
    expect(hasOwn(search, "changeCallback")).toBe(false);
  });

  it("lets go of Backlinks that leave the workspace", () => {
    const { controller, native } = fakeController();
    const views: LeafView[] = [{ backlink: controller }];
    const { handle, rescan } = setup({}, views);

    views.length = 0;
    rescan();
    expect(controller.updateSearch).toBe(native);
    handle.cleanup();
  });

  it("finds Backlinks in document added without a workspace event", async () => {
    const containerEl = createDiv();
    const root = containerEl.createDiv("embedded-backlinks");
    const view: LeafView = { containerEl };
    const { handle, rescan, iterate } = setup({}, [view]);
    const { controller } = fakeController();

    view.backlinks = controller;
    root.createDiv();
    await Promise.resolve(); // MutationObserver callbacks run as a microtask.
    vi.advanceTimersByTime(0);
    expect(controller.setSortOrder).toHaveBeenCalledOnce();

    // Once the root leaves the note, its changes no longer trigger scans.
    root.detach();
    rescan();
    const scans = iterate.mock.calls.length;
    root.createDiv();
    await Promise.resolve();
    vi.advanceTimersByTime(0);
    expect(iterate).toHaveBeenCalledTimes(scans);
    handle.cleanup();
  });
});
