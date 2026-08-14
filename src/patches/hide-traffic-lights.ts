import { Platform, debounce, type Plugin } from "obsidian";
import type { Patch, PatchHandle } from "../patch";

interface BrowserWindowLike {
  setWindowButtonPosition(position: { x: number; y: number } | null): void;
}

interface ElectronModuleLike {
  remote?: {
    getCurrentWindow(): BrowserWindowLike;
  };
}

interface WindowWithRequire extends Window {
  require?: (id: string) => unknown;
}

declare function require(id: string): unknown;

const BODY_CLASS = "micropatches-hide-traffic-lights";

/**
 * Obsidian on macOS reserves layout space in the tab bar for the native
 * traffic-light window controls even when they're not wanted. This moves the
 * traffic lights off-screen via Electron's setWindowButtonPosition and
 * removes the reserved space (styles.css, scoped to a body class we toggle
 * per window), for every open window (main window + popouts).
 */
export const hideTrafficLights: Patch = {
  id: "hide-traffic-lights",
  name: "Hide traffic lights (macOS)",
  description:
    "Moves the native macOS traffic-light window controls off-screen and removes the reserved tab-bar space, for every open window.",

  register(plugin: Plugin, isEnabled: () => boolean): PatchHandle {
    if (!Platform.isMacOS) {
      return { cleanup: (): void => {} };
    }

    const windows = new Set<Window>();

    const getBrowserWindow = (win: Window): BrowserWindowLike | undefined => {
      if (win === window) {
        const electron = require("electron") as ElectronModuleLike;
        return electron.remote?.getCurrentWindow();
      }
      const w = win as WindowWithRequire;
      const electron = typeof w.require === "function" ? (w.require("electron") as ElectronModuleLike) : undefined;
      return electron?.remote?.getCurrentWindow();
    };

    const hideFor = (win: Window): void => {
      try {
        getBrowserWindow(win)?.setWindowButtonPosition({ x: -100, y: -100 });
      } catch (error) {
        console.error("Micropatches (hide-traffic-lights): failed to hide", error);
      }
    };

    const restoreFor = (win: Window): void => {
      try {
        getBrowserWindow(win)?.setWindowButtonPosition(null);
      } catch (error) {
        console.error("Micropatches (hide-traffic-lights): failed to restore", error);
      }
    };

    const applyState = (win: Window): void => {
      if (!windows.has(win)) return;

      if (isEnabled()) {
        win.document.body.classList.add(BODY_CLASS);
        hideFor(win);
      } else {
        win.document.body.classList.remove(BODY_CLASS);
        restoreFor(win);
      }
    };

    const applyAll = (): void => {
      for (const win of windows) applyState(win);
    };
    const applyAllDebounced = debounce(applyAll, 50, true);

    const setupWindow = (win: Window): void => {
      if (windows.has(win)) return;
      windows.add(win);
      applyState(win);
      plugin.registerDomEvent(win, "focus", () => applyState(win));
    };

    const teardownWindow = (win: Window): void => {
      if (!windows.has(win)) return;
      win.document.body.classList.remove(BODY_CLASS);
      restoreFor(win);
      windows.delete(win);
    };

    setupWindow(window);

    plugin.registerEvent(plugin.app.workspace.on("layout-change", () => applyAllDebounced()));
    plugin.registerEvent(
      plugin.app.workspace.on("window-open", (_workspaceWindow, win) => {
        setupWindow(win);
      }),
    );
    plugin.registerEvent(
      plugin.app.workspace.on("window-close", (_workspaceWindow, win) => {
        teardownWindow(win);
      }),
    );

    return {
      cleanup: (): void => {
        for (const win of Array.from(windows)) teardownWindow(win);
      },
      onToggle: (): void => applyAll(),
    };
  },
};
