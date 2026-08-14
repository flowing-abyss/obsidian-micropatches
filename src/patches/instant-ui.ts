import type { Plugin } from "obsidian";
import type { Patch, PatchHandle } from "../patch";

const BODY_CLASS = "micropatches-instant-ui";

/**
 * Collapses CSS transition/animation durations to near-zero across the UI
 * instead of setting them to `none`: a ~0ms duration still fires
 * `transitionend` / `animationend` and still applies `animation-fill-mode`,
 * so cleanup logic that depends on those (Notice, sidebar reveal, folder
 * collapse, and several community plugins) keeps working — it just happens
 * instantly instead of over 100-300ms. The actual rules live in styles.css,
 * scoped to this body class, with an allowlist for indicators that must
 * keep genuinely running (spinners, progress bars, CodeMirror's blinking
 * cursor) rather than freezing on a stale frame.
 */
export const instantUi: Patch = {
  id: "instant-ui",
  name: "Instant UI (skip animations)",
  description:
    "Collapses CSS transition/animation durations to near-zero across Obsidian's UI. Completion events and fill-mode still fire normally, so nothing gets stuck invisible — only spinners/progress bars/the blinking cursor keep actually animating.",

  register(plugin: Plugin, isEnabled: () => boolean): PatchHandle {
    const windows = new Set<Window>();

    const applyState = (win: Window): void => {
      if (!windows.has(win)) return;
      win.document.body.classList.toggle(BODY_CLASS, isEnabled());
    };

    const applyAll = (): void => {
      for (const win of windows) applyState(win);
    };

    const setupWindow = (win: Window): void => {
      if (windows.has(win)) return;
      windows.add(win);
      applyState(win);
    };

    const teardownWindow = (win: Window): void => {
      if (!windows.has(win)) return;
      windows.delete(win);
      try {
        win.document?.body?.classList.remove(BODY_CLASS);
      } catch (error) {
        console.error("Micropatches (instant-ui): teardown cleanup failed", error);
      }
    };

    setupWindow(window);

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
