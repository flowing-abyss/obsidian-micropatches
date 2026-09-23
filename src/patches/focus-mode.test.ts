import type { PluginManifest } from "obsidian";
import { App, Plugin, type WorkspaceLeaf } from "obsidian-test-mocks/obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { focusMode } from "./focus-mode";

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
  const toggleRibbon = vi.fn((_checking: boolean) => true);
  const ribbon = { id: "app:toggle-ribbon", name: "Toggle ribbon", checkCallback: toggleRibbon };
  Object.assign(app, { commands: { commands: { "app:toggle-ribbon": ribbon } } });

  // Obsidian's DOM for the main area, which the mock doesn't render.
  const root = document.body.createDiv({ cls: "workspace-split mod-root" });
  const addLeaf = (): WorkspaceLeaf => {
    const leaf = app.workspace.getLeaf("split");
    root.createDiv({ cls: "workspace-tabs" }).append(leaf.containerEl);
    leaf.containerEl.addClass("workspace-leaf");
    return leaf;
  };
  const note = addLeaf();

  const plugin = new TestPlugin(app, manifest);
  const state = { enabled: true };
  const handle = focusMode.register(plugin.asOriginalType2__(), {
    isEnabled: () => state.enabled,
    getConfig: <T>(_key: string, defaultValue: T): T => defaultValue,
    setConfig: () => Promise.resolve(),
  });
  const command = plugin.commands__.get("focus-mode");
  const toggle = (checking = false): unknown => command?.checkCallback?.(checking);
  const setEnabled = (value: boolean): void => {
    state.enabled = value;
    handle.onToggle?.(value);
  };
  return { workspace: app.workspace, handle, ribbon, toggleRibbon, addLeaf, note, toggle, setEnabled };
}

const active = (): boolean => document.body.hasClass("micropatches-focus-mode");
const focused = (leaf: WorkspaceLeaf): boolean =>
  leaf.containerEl.hasClass("micropatches-focus-leaf") &&
  leaf.containerEl.parentElement?.hasClass("micropatches-focus-tabs") === true;
const traces = (): number => document.querySelectorAll("[class*='micropatches-focus']").length;

describe("Focus mode", () => {
  afterEach(() => {
    document.body.className = "";
    document.body.empty();
  });

  it("enters and exits with its command", () => {
    const { handle, note, toggle } = setup();

    toggle();
    expect(active()).toBe(true);
    expect(focused(note)).toBe(true);
    toggle();
    expect(active()).toBe(false);
    expect(traces()).toBe(0);
    handle.cleanup();
  });

  it("focuses the most recent note", () => {
    const { handle, note, addLeaf, toggle } = setup();
    const other = addLeaf();

    toggle();
    expect(focused(other)).toBe(true);
    expect(focused(note)).toBe(false);
    handle.cleanup();
  });

  it("is unavailable while the patch is disabled", () => {
    const { handle, toggle, setEnabled } = setup();

    setEnabled(false);
    expect(toggle(true)).toBe(false);
    toggle();
    expect(active()).toBe(false);
    handle.cleanup();
  });

  it("locks the sidebars while active", () => {
    const { handle, workspace, toggle } = setup();

    toggle();
    workspace.leftSplit.collapse();
    workspace.rightSplit.toggle();
    expect(workspace.leftSplit.collapsed).toBe(false);
    expect(workspace.rightSplit.collapsed).toBe(false);

    toggle();
    workspace.leftSplit.collapse();
    workspace.rightSplit.toggle();
    expect(workspace.leftSplit.collapsed).toBe(true);
    expect(workspace.rightSplit.collapsed).toBe(true);
    handle.cleanup();
  });

  it("blocks commands that would change settings while active", () => {
    const { handle, ribbon, toggleRibbon, toggle } = setup();

    toggle();
    expect(ribbon.checkCallback(false)).toBe(false);
    expect(toggleRibbon).not.toHaveBeenCalled();
    toggle();
    expect(ribbon.checkCallback).toBe(toggleRibbon);
    handle.cleanup();
  });

  it("restores methods others own or wrapped meanwhile", () => {
    const { handle, workspace, toggle } = setup();
    const own = vi.fn();
    const wrapper = vi.fn();
    Object.assign(workspace.leftSplit, { expand: own });

    toggle();
    Object.assign(workspace.rightSplit, { toggle: wrapper });
    toggle();
    workspace.leftSplit.expand();
    workspace.rightSplit.toggle();
    expect(own).toHaveBeenCalledOnce();
    expect(wrapper).toHaveBeenCalledOnce();
    handle.cleanup();
  });

  it("follows the active note in the main area", () => {
    const { handle, workspace, note, addLeaf, toggle } = setup();
    const other = addLeaf();

    toggle();
    workspace.trigger("active-leaf-change", note);
    expect(focused(note)).toBe(true);
    expect(focused(other)).toBe(false);
    handle.cleanup();
  });

  it("takes focus back from a sidebar", () => {
    const { handle, workspace, note, toggle } = setup();
    const sidebar = workspace.getRightLeaf(false);
    if (!sidebar) throw new Error("no sidebar leaf");

    toggle();
    const setActiveLeaf = vi.spyOn(workspace, "setActiveLeaf");
    workspace.trigger("active-leaf-change", sidebar);
    expect(setActiveLeaf).toHaveBeenCalledWith(note, { focus: true });
    expect(focused(note)).toBe(true);
    handle.cleanup();
  });

  it("marks the note again after the layout drops the markers", () => {
    const { handle, workspace, note, toggle } = setup();

    toggle();
    note.containerEl.removeClass("micropatches-focus-leaf");
    note.containerEl.addClass("mod-active");
    workspace.trigger("layout-change");
    expect(focused(note)).toBe(true);
    handle.cleanup();
  });

  it("covers popouts from opening until they close", () => {
    const { handle, workspace, toggle } = setup();
    const win = document.body.createEl("iframe").contentWindow;
    if (!win) throw new Error("jsdom gave the iframe no window");

    toggle();
    workspace.trigger("window-open", {}, win);
    expect(win.document.body.classList.contains("micropatches-focus-mode")).toBe(true);
    workspace.trigger("window-close", {}, win);
    expect(win.document.body.classList.contains("micropatches-focus-mode")).toBe(false);
    handle.cleanup();
  });

  it.each(["cleanup", "disabling the patch"])("exits and restores everything on %s", (exit) => {
    const { handle, workspace, ribbon, toggleRibbon, toggle, setEnabled } = setup();

    toggle();
    if (exit === "cleanup") handle.cleanup();
    else setEnabled(false);
    expect(active()).toBe(false);
    expect(traces()).toBe(0);
    expect(ribbon.checkCallback).toBe(toggleRibbon);
    workspace.leftSplit.toggle();
    expect(workspace.leftSplit.collapsed).toBe(true);
    handle.cleanup();
  });
});
