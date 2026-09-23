import type { BasesEntry, PluginManifest } from "obsidian";
import { App, BasesQueryResult, type Component, Plugin } from "obsidian-test-mocks/obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PatchContext, PatchHandle } from "../patch";
import { basesPagination } from "./bases-pagination";

class TestPlugin extends Plugin {}

const manifest: PluginManifest = {
  id: "micropatches",
  name: "Micropatches",
  author: "test",
  version: "0.0.0",
  minAppVersion: "1.13.0",
  description: "test",
};

interface FakeConfig {
  getLimit(): number;
  getSort(): unknown[];
}

type ApplyLimit = (this: { config: FakeConfig }, entries: BasesEntry[]) => void;

const prototype = BasesQueryResult.prototype as unknown as { applyLimit?: ApplyLimit };

// What Bases does: keep the first `limit` sorted entries.
const nativeApplyLimit: ApplyLimit = function (entries) {
  const limit = this.config.getLimit();
  if (limit > 0) entries.splice(limit);
};

function entries(count: number): BasesEntry[] {
  return Array.from({ length: count }, (_, index) => ({ index }) as unknown as BasesEntry);
}

function indexes(list: BasesEntry[]): number[] {
  return list.map((entry) => (entry as unknown as { index: number }).index);
}

// A base in a tab: a toolbar with the result count, and a view that runs
// applyLimit over `total` sorted entries on every render.
function fakeBase(app: App, config: FakeConfig, total: () => number) {
  const toolbarEl = document.body.createDiv("bases-toolbar");
  const anchorEl = toolbarEl.createDiv("bases-toolbar-item bases-toolbar-result-count");
  toolbarEl.createDiv("bases-toolbar-item");
  const viewContainerEl = document.body.createDiv();
  const scrollTo = vi.fn();
  viewContainerEl.scrollTo = scrollTo;
  const children = new Set<Component>();
  const base = {
    shown: [] as number[],
    viewContainerEl,
    scrollTo,
    resultsMenu: { toolbarItem: { button: { containerEl: anchorEl } } },
    getViewConfig: () => config,
    notifyView: vi.fn(() => {
      const list = entries(total());
      prototype.applyLimit?.call({ config }, list);
      base.shown = indexes(list);
    }),
    addChild: (child: Component) => {
      children.add(child);
      child.load();
      return child;
    },
    removeChild: (child: Component) => {
      children.delete(child);
      child.unload();
      return child;
    },
    children,
    pager: () => toolbarEl.querySelector<HTMLElement>(".micropatches-bases-pagination"),
    label: () => toolbarEl.querySelector(".micropatches-bases-pagination-label")?.textContent,
    button: (index: number) => toolbarEl.querySelectorAll<HTMLElement>(".text-icon-button")[index],
    anchorEl,
  };
  // Live controllers listen to this with themselves as context: how the patch finds them.
  app.vault.on("config-changed", () => undefined, base);
  return base;
}

describe("Bases pagination", () => {
  let app: App;
  let handle: PatchHandle;
  let enabled: boolean;

  const render = async (base: ReturnType<typeof fakeBase>): Promise<void> => {
    base.notifyView();
    await Promise.resolve();
  };

  const click = async (el: HTMLElement | undefined): Promise<void> => {
    el?.click();
    await Promise.resolve();
  };

  beforeEach(() => {
    prototype.applyLimit = nativeApplyLimit;
    app = App.createConfigured__();
    enabled = true;
    const ctx: PatchContext = {
      isEnabled: () => enabled,
      getConfig: <T>(_key: string, defaultValue: T): T => defaultValue,
      setConfig: async (): Promise<void> => {},
    };
    const plugin = new TestPlugin(app, manifest);
    handle = basesPagination.register(plugin.asOriginalType2__(), ctx);
    app.workspace.setLayoutReady__();
  });

  afterEach(() => {
    handle.cleanup();
    delete prototype.applyLimit;
    document.body.empty();
  });

  it("shows the first page, then steps through the rest", async () => {
    const base = fakeBase(app, { getLimit: () => 10, getSort: () => [] }, () => 25);

    await render(base);
    expect(base.shown).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(base.label()).toBe("1 / 3");
    expect(base.button(0)?.hasClass("is-disabled")).toBe(true);

    await click(base.button(1));
    expect(base.shown).toEqual([10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);
    expect(base.label()).toBe("2 / 3");
    expect(base.scrollTo).toHaveBeenCalledWith({ top: 0 });

    await click(base.button(1));
    expect(base.shown).toEqual([20, 21, 22, 23, 24]);
    expect(base.label()).toBe("3 / 3");
    expect(base.button(1)?.getAttribute("aria-disabled")).toBe("true");

    await click(base.button(1));
    expect(base.label()).toBe("3 / 3");
    await click(base.button(0));
    expect(base.shown[0]).toBe(10);
  });

  it("sits right after the result count", async () => {
    const base = fakeBase(app, { getLimit: () => 10, getSort: () => [] }, () => 25);

    await render(base);

    expect(base.anchorEl.nextElementSibling).toBe(base.pager());
    expect(base.anchorEl.hasClass("micropatches-bases-paginated")).toBe(true);
  });

  it("starts over when the results, the sort or the limit change", async () => {
    let total = 25;
    let sort: unknown[] = [];
    let limit = 10;
    const base = fakeBase(app, { getLimit: () => limit, getSort: () => sort }, () => total);
    const toSecondPage = async (): Promise<void> => {
      await render(base);
      await click(base.button(1));
      expect(base.label()).toBe("2 / 3");
    };

    await toSecondPage();
    total = 24;
    await render(base);
    expect(base.label()).toBe("1 / 3");

    await toSecondPage();
    sort = [{ property: "file.name", direction: "DESC" }];
    await render(base);
    expect(base.label()).toBe("1 / 3");

    await toSecondPage();
    limit = 5;
    await render(base);
    expect(base.label()).toBe("1 / 5");
  });

  it("stays out of bases that fit on one page or have no limit", async () => {
    const fits = fakeBase(app, { getLimit: () => 10, getSort: () => [] }, () => 10);
    const unlimited = fakeBase(app, { getLimit: () => 0, getSort: () => [] }, () => 25);

    await render(fits);
    await render(unlimited);

    expect(fits.shown).toHaveLength(10);
    expect(unlimited.shown).toHaveLength(25);
    expect(document.querySelector(".micropatches-bases-pagination")).toBeNull();
  });

  it("goes when the limit is removed", async () => {
    let limit = 10;
    const base = fakeBase(app, { getLimit: () => limit, getSort: () => [] }, () => 25);
    await render(base);

    limit = 0;
    await render(base);

    expect(base.pager()).toBeNull();
    expect(base.anchorEl.hasClass("micropatches-bases-paginated")).toBe(false);
  });

  it("puts everything back when turned off", async () => {
    const base = fakeBase(app, { getLimit: () => 10, getSort: () => [] }, () => 25);
    await render(base);
    await click(base.button(1));

    enabled = false;
    handle.onToggle?.(false);

    expect(prototype.applyLimit).toBe(nativeApplyLimit);
    expect(base.pager()).toBeNull();
    expect(base.anchorEl.hasClass("micropatches-bases-paginated")).toBe(false);
    expect(base.children.size).toBe(0);
    // Re-rendered: back to the first page.
    expect(base.shown[0]).toBe(0);
  });

  it("drops the pager with its base", async () => {
    const base = fakeBase(app, { getLimit: () => 10, getSort: () => [] }, () => 25);
    await render(base);

    for (const child of Array.from(base.children)) base.removeChild(child);

    expect(base.pager()).toBeNull();
  });

  it("leaves a wrapper installed by someone else in place", async () => {
    const base = fakeBase(app, { getLimit: () => 10, getSort: () => [] }, () => 25);
    await render(base);
    const theirs: ApplyLimit = function (list) {
      list.splice(1);
    };
    prototype.applyLimit = theirs;

    handle.onToggle?.(false);

    expect(prototype.applyLimit).toBe(theirs);
  });
});
