import type { PluginManifest } from "obsidian";
import { App, Plugin, type WorkspaceLeaf } from "obsidian-test-mocks/obsidian";
import { describe, expect, it, vi } from "vitest";
import type { PatchContext } from "../patch";
import { basesAutoSearch } from "./bases-auto-search";

const manifest: PluginManifest = {
  id: "micropatches",
  name: "Micropatches",
  author: "test",
  version: "0.0.0",
  minAppVersion: "1.13.0",
  description: "test",
};

class TestPlugin extends Plugin {}

function setup() {
  const app = App.createConfigured__();
  let enabled = true;
  const ctx: PatchContext = {
    isEnabled: () => enabled,
    getConfig: <T>(_key: string, fallback: T): T => fallback,
    setConfig: () => Promise.resolve(),
  };
  // Bases views as far as the patch looks at them; these have no search menu (yet).
  const views: unknown[] = [{}, { controller: {} }];
  const getLeaves = vi
    .spyOn(app.workspace, "getLeavesOfType")
    .mockImplementation((type) =>
      type === "bases" ? views.map((view) => ({ view }) as unknown as WorkspaceLeaf) : [],
    );
  const addBase = () => {
    const searchMenu = { open: vi.fn() };
    views.push({ controller: { searchMenu } });
    return searchMenu;
  };
  basesAutoSearch.register(new TestPlugin(app, manifest).asOriginalType2__(), ctx);
  return {
    app,
    addBase,
    getLeaves,
    setEnabled: (value: boolean): void => {
      enabled = value;
    },
  };
}

describe("bases-auto-search", () => {
  it("opens each base's search once, on the first layout or leaf change", () => {
    const { app, addBase } = setup();
    const first = addBase();

    app.workspace.trigger("layout-change");
    expect(first.open).toHaveBeenCalledTimes(1);

    const second = addBase();
    app.workspace.trigger("active-leaf-change");
    app.workspace.trigger("layout-change");
    expect(first.open).toHaveBeenCalledTimes(1);
    expect(second.open).toHaveBeenCalledTimes(1);
  });

  it("does nothing while disabled, then opens bases once enabled", () => {
    const { app, addBase, getLeaves, setEnabled } = setup();
    const base = addBase();

    setEnabled(false);
    app.workspace.trigger("layout-change");
    app.workspace.trigger("active-leaf-change");
    expect(getLeaves).not.toHaveBeenCalled();
    expect(base.open).not.toHaveBeenCalled();

    setEnabled(true);
    app.workspace.trigger("active-leaf-change");
    expect(base.open).toHaveBeenCalledTimes(1);
  });
});
