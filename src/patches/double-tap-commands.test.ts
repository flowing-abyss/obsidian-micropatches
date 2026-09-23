import type { PluginManifest } from "obsidian";
import { App, Notice, Plugin } from "obsidian-test-mocks/obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DOUBLE_TAP_GAP_MS, TAP_MAX_MS, doubleTapCommands } from "./double-tap-commands";

const manifest: PluginManifest = {
  id: "micropatches",
  name: "Micropatches",
  author: "test",
  version: "0.0.0",
  minAppVersion: "1.13.0",
  description: "test",
};

class TestPlugin extends Plugin {}

const FLAGS: Record<string, keyof KeyboardEventInit> = {
  Shift: "shiftKey",
  Control: "ctrlKey",
  Alt: "altKey",
  Meta: "metaKey",
};

const cleanups: Array<() => void> = [];

function setup(config: Record<string, string> = { shift: "app:open-settings" }) {
  const app = App.createConfigured__();
  const executeCommandById = vi.fn(() => true);
  const commands = { "app:open-settings": { id: "app:open-settings", name: "Open settings" } };
  Object.assign(app, { commands: { commands, executeCommandById } });
  const state = { enabled: true };
  const handle = doubleTapCommands.register(new TestPlugin(app, manifest).asOriginalType2__(), {
    isEnabled: () => state.enabled,
    getConfig: <T>(key: string, defaultValue: T): T => {
      const value = config[key];
      return value === undefined ? defaultValue : (value as T);
    },
    setConfig: () => Promise.resolve(),
  });
  cleanups.push(handle.cleanup);
  const setEnabled = (value: boolean): void => {
    state.enabled = value;
    handle.onToggle?.(value);
  };
  return { app, handle, executeCommandById, setEnabled };
}

function send(type: "keydown" | "keyup", key: string, init: KeyboardEventInit = {}, doc = document): void {
  // A modifier's own flag is set on its keydown and already cleared on its keyup.
  const flag = FLAGS[key];
  const own = type === "keydown" && flag !== undefined ? { [flag]: true } : {};
  doc.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, ...own, ...init }));
}

function tap(key = "Shift", doc = document): void {
  send("keydown", key, {}, doc);
  vi.advanceTimersByTime(50);
  send("keyup", key, {}, doc);
}

function doubleTap(key = "Shift", doc = document): void {
  tap(key, doc);
  vi.advanceTimersByTime(100);
  tap(key, doc);
}

describe("Double-tap commands", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    vi.useRealTimers();
    document.body.empty();
  });

  it("runs the command on a quick double tap", () => {
    const { executeCommandById } = setup();

    tap();
    expect(executeCommandById).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    tap();
    expect(executeCommandById).toHaveBeenCalledExactlyOnceWith("app:open-settings");
  });

  it("runs the command of the tapped modifier only", () => {
    const { executeCommandById } = setup({ ctrl: "app:open-settings" });

    doubleTap("Shift");
    expect(executeCommandById).not.toHaveBeenCalled();
    doubleTap("Control");
    expect(executeCommandById).toHaveBeenCalledOnce();
  });

  it("treats a late second tap as a new first tap", () => {
    const { executeCommandById } = setup();

    tap();
    vi.advanceTimersByTime(DOUBLE_TAP_GAP_MS + 1);
    tap();
    expect(executeCommandById).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    tap();
    expect(executeCommandById).toHaveBeenCalledOnce();
  });

  it("ignores a held key", () => {
    const { executeCommandById } = setup();

    tap();
    send("keydown", "Shift");
    vi.advanceTimersByTime(TAP_MAX_MS + 1);
    send("keyup", "Shift");
    expect(executeCommandById).not.toHaveBeenCalled();
  });

  it("ignores a held key even while it auto-repeats", () => {
    const { executeCommandById } = setup();

    tap();
    send("keydown", "Shift");
    for (let elapsed = 0; elapsed <= TAP_MAX_MS; elapsed += 30) {
      vi.advanceTimersByTime(30);
      send("keydown", "Shift", { repeat: true });
    }
    send("keyup", "Shift");
    expect(executeCommandById).not.toHaveBeenCalled();
  });

  it("ignores a modifier pressed as part of a shortcut", () => {
    const { executeCommandById } = setup();

    tap();
    send("keydown", "Shift", { ctrlKey: true });
    send("keyup", "Shift", { ctrlKey: true });
    tap();
    expect(executeCommandById).not.toHaveBeenCalled();
  });

  it.each([
    ["another key", () => document.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }))],
    ["a mouse press", () => document.dispatchEvent(new MouseEvent("mousedown"))],
    ["the window losing focus", () => window.dispatchEvent(new FocusEvent("blur"))],
  ])("cancels a pending tap on %s", (_name, interrupt) => {
    const { executeCommandById } = setup();

    tap();
    interrupt();
    tap();
    expect(executeCommandById).not.toHaveBeenCalled();
  });

  it("shows a notice instead of running an unknown command", () => {
    const notice = vi.spyOn(Notice.prototype, "constructor__");
    const { executeCommandById } = setup({ shift: "gone:command" });

    doubleTap();
    expect(executeCommandById).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("gone:command"), undefined);
  });

  it("does nothing while disabled", () => {
    const { executeCommandById, setEnabled } = setup();

    setEnabled(false);
    doubleTap();
    expect(executeCommandById).not.toHaveBeenCalled();
  });

  it("forgets a first tap made before disabling", () => {
    const { executeCommandById, setEnabled } = setup();

    tap();
    setEnabled(false);
    setEnabled(true);
    tap();
    expect(executeCommandById).not.toHaveBeenCalled();
  });

  it("stops listening after cleanup", () => {
    const { executeCommandById, handle } = setup();

    handle.cleanup();
    doubleTap();
    expect(executeCommandById).not.toHaveBeenCalled();
  });

  it("listens in a popout from opening until it closes", () => {
    const { app, executeCommandById } = setup();
    const win = document.body.createEl("iframe").contentWindow;
    if (!win) throw new Error("jsdom gave the iframe no window");

    app.workspace.trigger("window-open", {}, win);
    doubleTap("Shift", win.document);
    expect(executeCommandById).toHaveBeenCalledOnce();
    app.workspace.trigger("window-close", {}, win);
    vi.advanceTimersByTime(1000);
    doubleTap("Shift", win.document);
    expect(executeCommandById).toHaveBeenCalledOnce();
  });
});
