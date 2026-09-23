import type { PluginManifest } from "obsidian";
import { App, Notice, Plugin } from "obsidian-test-mocks/obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HINT_RADIUS, TRIGGER_RADIUS, commandLabel, hotCorners, modifierHeld, nearestCorner } from "./hot-corners";

const manifest: PluginManifest = {
  id: "micropatches",
  name: "Micropatches",
  author: "test",
  version: "0.0.0",
  minAppVersion: "1.13.0",
  description: "test",
};

class TestPlugin extends Plugin {}

// Distances from the top-left corner along the top edge.
const FAR = HINT_RADIUS + 10;
const NEAR = (HINT_RADIUS + TRIGGER_RADIUS) / 2;
const INSIDE = TRIGGER_RADIUS / 2;

const cleanups: Array<() => void> = [];

function setup(config: Record<string, string> = { topLeft: "quickadd:create" }) {
  const app = App.createConfigured__();
  const executeCommandById = vi.fn(() => true);
  const commands = { "quickadd:create": { id: "quickadd:create", name: "QuickAdd: Create note" } };
  Object.assign(app, { commands: { commands, executeCommandById } });
  const state = { enabled: true };
  const handle = hotCorners.register(new TestPlugin(app, manifest).asOriginalType2__(), {
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
  return { handle, executeCommandById, setEnabled };
}

function move(x: number, y = 0, init: MouseEventInit = { shiftKey: true }): void {
  document.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, ...init }));
}

const glow = (): HTMLElement | null => document.querySelector<HTMLElement>(".micropatches-hot-corner");
const glowing = (): boolean => glow()?.classList.contains("is-visible") ?? false;

describe("nearestCorner", () => {
  const win = { innerWidth: 1000, innerHeight: 800 } as unknown as Window;

  it.each([
    [0, 0, "topLeft"],
    [999, 0, "topRight"],
    [0, 799, "bottomLeft"],
    [999, 799, "bottomRight"],
  ])("puts (%i, %i) right in the %s corner", (x, y, corner) => {
    expect(nearestCorner(win, x, y)).toEqual({ corner, distance: 0 });
  });

  it("measures the straight-line distance to the corner", () => {
    expect(nearestCorner(win, 30, 40)).toEqual({ corner: "topLeft", distance: 50 });
    expect(nearestCorner(win, 999 - 30, 799 - 40)).toEqual({ corner: "bottomRight", distance: 50 });
  });
});

describe("commandLabel", () => {
  it("drops the plugin prefix from a command name", () => {
    expect(commandLabel("QuickAdd: Create note")).toBe("Create note");
    expect(commandLabel("Daily notes: Open today's note: now")).toBe("Open today's note: now");
    expect(commandLabel("Toggle bold")).toBe("Toggle bold");
  });
});

describe("modifierHeld", () => {
  it("checks only the chosen modifier", () => {
    const event = new MouseEvent("mousemove", { altKey: true });

    expect(modifierHeld(event, "alt")).toBe(true);
    expect(modifierHeld(event, "shift")).toBe(false);
    expect(modifierHeld(event, "ctrl")).toBe(false);
    expect(modifierHeld(event, "meta")).toBe(false);
  });
});

describe("Hot corners", () => {
  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    document.body.empty();
  });

  it("glows on approach, then fires once per visit", () => {
    const { executeCommandById } = setup();

    move(FAR);
    expect(glowing()).toBe(false);
    move(NEAR);
    expect(glowing()).toBe(true);
    expect(glow()?.dataset["corner"]).toBe("topLeft");
    expect(glow()?.textContent).toBe("Create note");

    move(INSIDE);
    expect(executeCommandById).toHaveBeenCalledExactlyOnceWith("quickadd:create");
    expect(glow()?.classList.contains("is-fired")).toBe(true);
    move(INSIDE - 5);
    move(NEAR);
    move(INSIDE);
    expect(executeCommandById).toHaveBeenCalledOnce();
  });

  it("fires again after leaving the corner", () => {
    const { executeCommandById } = setup();

    move(FAR);
    move(INSIDE);
    move(FAR);
    move(INSIDE);
    expect(executeCommandById).toHaveBeenCalledTimes(2);
  });

  it("ignores corners without a command", () => {
    const { executeCommandById } = setup();

    move(window.innerWidth - 1 - FAR);
    move(window.innerWidth - 1 - NEAR);
    move(window.innerWidth - 1 - INSIDE);
    expect(glowing()).toBe(false);
    expect(executeCommandById).not.toHaveBeenCalled();
  });

  it("does not fire when the modifier is pressed in the corner", () => {
    const { executeCommandById } = setup();

    move(INSIDE, 0, {});
    move(INSIDE);
    expect(executeCommandById).not.toHaveBeenCalled();
  });

  it("does not fire while a mouse button is held", () => {
    const { executeCommandById } = setup();

    move(FAR);
    move(NEAR, 0, { shiftKey: true, buttons: 1 });
    expect(glowing()).toBe(false);
    move(INSIDE, 0, { shiftKey: true, buttons: 1 });
    move(INSIDE);
    expect(executeCommandById).not.toHaveBeenCalled();
  });

  it("hides the glow and disarms when the modifier is released", () => {
    const { executeCommandById } = setup();

    move(FAR);
    move(NEAR);
    document.dispatchEvent(new KeyboardEvent("keyup", { key: "Shift" }));
    expect(glowing()).toBe(false);
    move(INSIDE);
    expect(executeCommandById).not.toHaveBeenCalled();
  });

  it("uses the configured modifier", () => {
    const { executeCommandById } = setup({ topLeft: "quickadd:create", modifier: "alt" });

    move(FAR);
    move(INSIDE);
    expect(executeCommandById).not.toHaveBeenCalled();
    move(FAR, 0, { altKey: true });
    move(INSIDE, 0, { altKey: true });
    expect(executeCommandById).toHaveBeenCalledOnce();
  });

  it("shows a notice instead of running an unknown command", () => {
    const notice = vi.spyOn(Notice.prototype, "constructor__");
    const { executeCommandById } = setup({ topLeft: "gone:command" });

    move(FAR);
    move(INSIDE);
    expect(executeCommandById).not.toHaveBeenCalled();
    expect(notice).toHaveBeenCalledWith(expect.stringContaining("gone:command"), undefined);
    expect(glowing()).toBe(false);
  });

  it("goes dark and inert when disabled", () => {
    const { executeCommandById, setEnabled } = setup();

    move(FAR);
    move(NEAR);
    setEnabled(false);
    expect(glowing()).toBe(false);
    move(INSIDE);
    expect(executeCommandById).not.toHaveBeenCalled();
  });

  it("removes the glow and its listeners on cleanup", () => {
    const { executeCommandById, handle } = setup();

    move(FAR);
    move(NEAR);
    handle.cleanup();
    expect(glow()).toBeNull();
    move(INSIDE);
    expect(glow()).toBeNull();
    expect(executeCommandById).not.toHaveBeenCalled();
  });
});
