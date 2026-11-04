import type { Plugin } from "obsidian";
import type { Patch, PatchContext, PatchHandle } from "../patch";

const BODY_CLASS = "micropatches-instant-ui";
const INSTANT_DURATION = 0.001;
// Keep this list in sync with styles.css. A loading indicator may animate a child
// SVG or path, so its descendants must keep their timing too.
const KEEP_ANIMATING = [
  '[class^="editingToolbarCommandsubItem"] > .subitem',
  ".loader-spinner svg",
  ".loader-cube",
  ".sk-cube",
  ".cm-fat-cursor-mark",
  ".cm-animate-fat-cursor",
  ".progress-bar-line",
  ".progress-bar-subline",
  '[class*="spinner"]',
  '[class*="loading"]',
  ".cm-cursorLayer .cm-cursor",
  ".node-insert-event",
  ".hmd-file-uploading",
  ".mod-pending",
].join(", ");

interface WindowState {
  restoreAnimate: (() => void) | null;
}

function shortenAnimation(animation: Animation, target: Element): void {
  const effect = animation.effect;
  if (
    effect === null ||
    target.closest(KEEP_ANIMATING) !== null ||
    animation.timeline !== target.ownerDocument.timeline
  ) {
    return;
  }
  const timing = effect.getTiming();
  // Infinite animations and custom timelines can be progress indicators or
  // follow scrolling rather than elapsed time. Leave their behavior intact.
  if (timing.iterations === Infinity || timing.duration === Infinity) return;
  effect.updateTiming({ duration: INSTANT_DURATION, delay: 0, endDelay: 0 });
}

/**
 * Collapses CSS and Web Animations API durations to near-zero across the UI.
 * CSS rules live in styles.css. Element.animate still returns its native
 * Animation, with fill, finish events and the finished promise intact, so
 * Obsidian can clean up temporary styles and removed tabs after completion.
 * Loading indicators and CodeMirror's blinking cursor keep animating.
 */
export const instantUi: Patch = {
  id: "instant-ui",
  name: "Instant UI (skip animations)",
  description: "Skips interface animations while keeping loading indicators and the blinking cursor.",

  register(plugin: Plugin, ctx: PatchContext): PatchHandle {
    const windows = new Map<Window, WindowState>();
    let disposed = false;

    const wrapAnimate = (win: Window): (() => void) | null => {
      const prototype: { animate: Element["animate"] } = (win.document.defaultView ?? window).Element.prototype;
      const original = prototype.animate;
      if (typeof original !== "function") return null;
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "animate");
      if (descriptor !== undefined && descriptor.writable !== true) return null;
      let active = true;
      const wrapped: Element["animate"] = function (this: Element, ...args): Animation {
        const animation = original.apply(this, args);
        if (active && ctx.isEnabled()) shortenAnimation(animation, this);
        return animation;
      };
      prototype.animate = wrapped;
      return () => {
        // A later wrapper may still call us. Make that saved reference inert
        // without replacing another plugin's method during teardown.
        active = false;
        if (prototype.animate !== wrapped) return;
        if (descriptor !== undefined) Object.defineProperty(prototype, "animate", descriptor);
        else Reflect.deleteProperty(prototype, "animate");
      };
    };

    const applyState = (win: Window): void => {
      const state = windows.get(win);
      if (state === undefined) return;
      const enabled = ctx.isEnabled();
      win.document.body.classList.toggle(BODY_CLASS, enabled);
      if (enabled) state.restoreAnimate ??= wrapAnimate(win);
      else {
        state.restoreAnimate?.();
        state.restoreAnimate = null;
      }
    };

    const applyAll = (): void => {
      for (const win of windows.keys()) applyState(win);
    };

    const setupWindow = (win: Window): void => {
      if (disposed || windows.has(win)) return;
      windows.set(win, { restoreAnimate: null });
      applyState(win);
    };

    const teardownWindow = (win: Window): void => {
      const state = windows.get(win);
      if (state === undefined) return;
      windows.delete(win);
      state.restoreAnimate?.();
      try {
        // A window closing late can already have lost its document or body.
        const body = (win.document as Document | null)?.body as HTMLElement | null | undefined;
        body?.classList.remove(BODY_CLASS);
      } catch (error) {
        console.error("Micropatches (instant-ui): teardown cleanup failed", error);
      }
    };

    setupWindow(window);
    // Popouts that were open before this loaded (the plugin enabled later)
    // fire no "window-open". Once unloaded, not even the main window is set up.
    plugin.app.workspace.onLayoutReady(() => {
      if (!windows.has(window)) return;
      plugin.app.workspace.iterateAllLeaves((leaf) => {
        setupWindow(leaf.view.containerEl.win);
      });
    });

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
        disposed = true;
        for (const win of Array.from(windows.keys())) teardownWindow(win);
      },
      onToggle: (): void => {
        applyAll();
      },
    };
  },
};
