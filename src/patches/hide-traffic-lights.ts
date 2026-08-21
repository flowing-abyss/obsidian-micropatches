import { Notice, Platform, debounce, type Plugin } from "obsidian";
import type { Patch, PatchContext, PatchHandle } from "../patch";

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

interface WindowState {
  onFocus: () => void;
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

  register(plugin: Plugin, ctx: PatchContext): PatchHandle {
    // Mobile emulation on macOS still reports isMacOS=true, but its renderer
    // intentionally blocks Node/Electron modules exactly like the real mobile
    // app. The patch has no work to do there: mobile has no native traffic
    // lights or reserved desktop title-bar space. Guard the capability before
    // touching require(), otherwise every mobile layout change produces an
    // Obsidian security notice and a console error.
    if (!Platform.isMacOS || !Platform.isDesktopApp || Platform.isMobile) {
      return { cleanup: (): void => {} };
    }

    const windows = new Map<Window, WindowState>();
    let warnedRemoteUnavailable = false;

    const getBrowserWindow = (win: Window): BrowserWindowLike | undefined => {
      if (win === window) {
        const electron = require("electron") as ElectronModuleLike;
        return electron.remote?.getCurrentWindow();
      }
      const w = win as WindowWithRequire;
      const electron = typeof w.require === "function" ? (w.require("electron") as ElectronModuleLike) : undefined;
      return electron?.remote?.getCurrentWindow();
    };

    // The class removes the reserved tab-bar space; it must only be applied
    // when we actually managed to move the buttons, otherwise the buttons
    // stay put while the space collapses and they end up overlapping the
    // first tab.
    const hideFor = (win: Window): boolean => {
      try {
        const bw = getBrowserWindow(win);
        if (!bw) {
          if (!warnedRemoteUnavailable) {
            warnedRemoteUnavailable = true;
            new Notice(
              "Micropatches: couldn't reach electron's window controls (hide-traffic-lights disabled itself for this session).",
            );
          }
          return false;
        }
        bw.setWindowButtonPosition({ x: -100, y: -100 });
        return true;
      } catch (error) {
        console.error("Micropatches (hide-traffic-lights): failed to hide", error);
        return false;
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

      if (ctx.isEnabled() && hideFor(win)) {
        win.document.body.classList.add(BODY_CLASS);
      } else {
        win.document.body.classList.remove(BODY_CLASS);
        if (!ctx.isEnabled()) restoreFor(win);
      }
    };

    const applyAll = (): void => {
      for (const win of windows.keys()) applyState(win);
    };
    const applyAllDebounced = debounce(applyAll, 50, true);

    const setupWindow = (win: Window): void => {
      if (windows.has(win)) return;

      const onFocus = (): void => applyState(win);
      windows.set(win, { onFocus });
      win.addEventListener("focus", onFocus);

      applyState(win);
    };

    // Remove from the map first: if the window's document is already torn
    // down (win.document/body can legitimately be null on a late
    // "window-close"), the DOM cleanup below is best-effort only and must
    // not stop us from forgetting this window or throw out of the
    // workspace event handler (which would abort other listeners).
    const teardownWindow = (win: Window): void => {
      const state = windows.get(win);
      if (!state) return;
      windows.delete(win);

      try {
        win.removeEventListener("focus", state.onFocus);
        win.document?.body?.classList.remove(BODY_CLASS);
      } catch (error) {
        console.error("Micropatches (hide-traffic-lights): teardown cleanup failed", error);
      }
      restoreFor(win);
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
        for (const win of Array.from(windows.keys())) teardownWindow(win);
      },
      onToggle: (): void => applyAll(),
    };
  },
};
