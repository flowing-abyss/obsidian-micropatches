import type { PluginManifest } from "obsidian";
import { App, Plugin } from "obsidian-test-mocks/obsidian";
import { afterEach, describe, expect, it } from "vitest";
import { instantUi } from "./instant-ui";

const CLASS = "micropatches-instant-ui";
const manifest: PluginManifest = {
  id: "micropatches",
  name: "Micropatches",
  author: "test",
  version: "0.0.0",
  minAppVersion: "1.13.0",
  description: "test",
};

class TestPlugin extends Plugin {}

function setup(app = App.createConfigured__(), enabled = true) {
  const state = { enabled };
  const handle = instantUi.register(new TestPlugin(app, manifest).asOriginalType2__(), {
    isEnabled: () => state.enabled,
    getConfig: <T>(_key: string, defaultValue: T): T => defaultValue,
    setConfig: () => Promise.resolve(),
  });
  const setEnabled = (value: boolean): void => {
    state.enabled = value;
    handle.onToggle?.(value);
  };
  return { app, handle, setEnabled };
}

function popout(): Window {
  const win = document.body.createEl("iframe").contentWindow;
  if (!win) throw new Error("jsdom gave the iframe no window");
  return win;
}

const hasClass = (win: Window): boolean => win.document.body.classList.contains(CLASS);

describe("Instant UI", () => {
  afterEach(() => {
    document.body.className = "";
    document.body.empty();
  });

  it("puts the body class on while enabled", () => {
    const { handle, setEnabled } = setup(undefined, false);
    expect(hasClass(window)).toBe(false);

    setEnabled(true);
    expect(hasClass(window)).toBe(true);
    setEnabled(false);
    expect(hasClass(window)).toBe(false);
    handle.cleanup();
  });

  it("removes the class on cleanup", () => {
    const { handle } = setup();
    expect(hasClass(window)).toBe(true);

    handle.cleanup();
    expect(hasClass(window)).toBe(false);
  });

  it("covers a popout from opening until it closes", () => {
    const { app, handle, setEnabled } = setup();
    const win = popout();

    app.workspace.trigger("window-open", {}, win);
    expect(hasClass(win)).toBe(true);
    setEnabled(false);
    expect(hasClass(win)).toBe(false);
    setEnabled(true);
    expect(hasClass(win)).toBe(true);

    app.workspace.trigger("window-close", {}, win);
    expect(hasClass(win)).toBe(false);
    setEnabled(false);
    setEnabled(true);
    expect(hasClass(win)).toBe(false);
    handle.cleanup();
  });

  it("covers popouts that were open before loading, once the layout is ready", () => {
    const app = App.createConfigured__();
    const win = popout();
    win.document.body.append(app.workspace.openPopoutLeaf().view.containerEl);
    const { handle } = setup(app);
    expect(hasClass(win)).toBe(false);

    app.workspace.setLayoutReady__();
    expect(hasClass(win)).toBe(true);
    handle.cleanup();
    expect(hasClass(win)).toBe(false);
  });

  it("sets nothing up when unloaded before the layout is ready", () => {
    const app = App.createConfigured__();
    const win = popout();
    win.document.body.append(app.workspace.openPopoutLeaf().view.containerEl);
    setup(app).handle.cleanup();

    app.workspace.setLayoutReady__();
    expect(hasClass(window)).toBe(false);
    expect(hasClass(win)).toBe(false);
  });
});
