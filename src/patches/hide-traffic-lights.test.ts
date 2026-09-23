import type { PluginManifest } from "obsidian";
import { App, Notice, Platform, Plugin } from "obsidian-test-mocks/obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hideTrafficLights } from "./hide-traffic-lights";

const CLASS = "micropatches-hide-traffic-lights";
const manifest: PluginManifest = {
  id: "micropatches",
  name: "Micropatches",
  author: "test",
  version: "0.0.0",
  minAppVersion: "1.13.0",
  description: "test",
};

class TestPlugin extends Plugin {}

interface BrowserWindowLike {
  setWindowButtonVisibility?: (visible: boolean) => void;
  setWindowButtonPosition?: (position: { x: number; y: number } | null) => void;
}

function setup() {
  const app = App.createConfigured__();
  const state = { enabled: true };
  const handle = hideTrafficLights.register(new TestPlugin(app, manifest).asOriginalType2__(), {
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

// What `require("electron")` hands back for a window with this BrowserWindow.
const electron = (browserWindow?: BrowserWindowLike) =>
  browserWindow ? { remote: { getCurrentWindow: () => browserWindow } } : {};

function popout(): Window {
  const win = document.body.createEl("iframe").contentWindow;
  if (!win) throw new Error("jsdom gave the iframe no window");
  return win;
}

const hasClass = (win: Window): boolean => win.document.body.classList.contains(CLASS);

describe("Hide traffic lights", () => {
  const { isDesktopApp, isMobile, isMacOS, isWin } = Platform;

  beforeEach(() => {
    Object.assign(Platform, { isDesktopApp: true, isMobile: false, isMacOS: false, isWin: true });
  });

  afterEach(() => {
    Object.assign(Platform, { isDesktopApp, isMobile, isMacOS, isWin });
    document.body.className = "";
    document.body.empty();
  });

  it("only toggles the body class on Windows and Linux, without Electron", () => {
    const { app, handle, setEnabled } = setup();
    const load = vi.fn();
    const win = Object.assign(popout(), { require: load });

    app.workspace.trigger("window-open", {}, win);
    expect(hasClass(window)).toBe(true);
    expect(hasClass(win)).toBe(true);
    setEnabled(false);
    expect(hasClass(window)).toBe(false);
    expect(hasClass(win)).toBe(false);
    setEnabled(true);
    app.workspace.trigger("window-close", {}, win);
    expect(hasClass(win)).toBe(false);
    handle.cleanup();
    expect(hasClass(window)).toBe(false);
    expect(load).not.toHaveBeenCalled();
  });

  it("does nothing on mobile", () => {
    Platform.isMobile = true;
    setup();

    expect(hasClass(window)).toBe(false);
  });

  // The main window's require("electron") can't be stubbed under vitest, so
  // these go through popouts, which hand the patch their own `require`.
  describe("on macOS", () => {
    beforeEach(() => {
      Object.assign(Platform, { isMacOS: true, isWin: false });
      vi.spyOn(console, "error").mockImplementation(() => undefined);
    });

    const macPopout = (browserWindow?: BrowserWindowLike): Window =>
      Object.assign(popout(), { require: () => electron(browserWindow) });

    it("hides a window's native buttons until disabled or closed", () => {
      const { app, handle, setEnabled } = setup();
      const browserWindow = { setWindowButtonVisibility: vi.fn() };
      const win = macPopout(browserWindow);

      app.workspace.trigger("window-open", {}, win);
      expect(browserWindow.setWindowButtonVisibility).toHaveBeenLastCalledWith(false);
      expect(hasClass(win)).toBe(true);
      setEnabled(false);
      expect(browserWindow.setWindowButtonVisibility).toHaveBeenLastCalledWith(true);
      expect(hasClass(win)).toBe(false);
      setEnabled(true);
      expect(browserWindow.setWindowButtonVisibility).toHaveBeenLastCalledWith(false);

      app.workspace.trigger("window-close", {}, win);
      expect(browserWindow.setWindowButtonVisibility).toHaveBeenLastCalledWith(true);
      expect(hasClass(win)).toBe(false);
      handle.cleanup();
    });

    it("moves the buttons off-screen on older Electron", () => {
      const { app, handle, setEnabled } = setup();
      const browserWindow = { setWindowButtonPosition: vi.fn() };
      const win = macPopout(browserWindow);

      app.workspace.trigger("window-open", {}, win);
      expect(browserWindow.setWindowButtonPosition).toHaveBeenLastCalledWith({ x: -100, y: -100 });
      expect(hasClass(win)).toBe(true);
      setEnabled(false);
      expect(browserWindow.setWindowButtonPosition).toHaveBeenLastCalledWith(null);
      handle.cleanup();
    });

    // Collapsing the reserved space while the buttons stay would put them over the first tab.
    it("keeps the space when the buttons can't be hidden", () => {
      const { app, handle } = setup();
      const noApi = macPopout({});
      const failing = Object.assign(popout(), {
        require: () => {
          throw new Error("blocked");
        },
      });

      app.workspace.trigger("window-open", {}, noApi);
      app.workspace.trigger("window-open", {}, failing);
      expect(hasClass(noApi)).toBe(false);
      expect(hasClass(failing)).toBe(false);
      handle.cleanup();
    });

    it("warns once when Electron's remote is unavailable", () => {
      const notice = vi.spyOn(Notice.prototype, "constructor__");
      const { app, handle } = setup();
      const win = macPopout();

      app.workspace.trigger("window-open", {}, win);
      app.workspace.trigger("window-open", {}, macPopout());
      expect(hasClass(win)).toBe(false);
      expect(notice).toHaveBeenCalledTimes(1);
      handle.cleanup();
    });
  });
});
