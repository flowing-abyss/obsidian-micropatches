import type { Command, Plugin, WorkspaceLeaf } from "obsidian";
import type { Patch, PatchContext, PatchHandle } from "../patch";

interface CommandsLike {
  commands?: Record<string, Command | undefined>;
}

const BODY_CLASS = "micropatches-focus-mode";
const TABS_CLASS = "micropatches-focus-tabs";
const LEAF_CLASS = "micropatches-focus-leaf";

// Core commands that write a UI setting instead of toggling in-memory state.
// CSS keeps the UI hidden either way, but letting them run would silently
// change the user's configuration while they can't see the result.
const BLOCKED_COMMANDS = ["app:toggle-ribbon"];
const LOCKED_SPLIT_METHODS = ["expand", "collapse", "toggle"];

// Own-property state of one shadowed method, so unlock can put back exactly
// what was there (usually nothing: the method lives on the prototype).
interface Shadow {
  target: Record<string, unknown>;
  key: string;
  stub: unknown;
  hadOwn: boolean;
  previous: unknown;
}

/**
 * A strict, session-only focus mode. Everything is hidden by CSS scoped to a
 * body class (styles.css) using an allowlist — "only the focused note's text
 * and inline title stay" — rather than a list of things to switch off, so it
 * never touches settings, never enables anything the user had disabled, and
 * also covers whatever other plugins inject around the note.
 *
 * On top of the CSS, the sidebars' expand/collapse/toggle are shadowed on the
 * instances (not the shared prototype, so other plugins' prototype patches
 * are untouched) while the mode is on: otherwise a toggle command would flip
 * the hidden sidebar's state and it would look different on exit.
 */
export const focusMode: Patch = {
  id: "focus-mode",
  name: "Focus mode command",
  description:
    "Adds an 'Enter or exit focus mode' command: hides every panel, tab, header and everything around the note's text, locks them away until you exit, and dims all lines except the active one. Never changes settings; always off after a restart.",

  register(plugin: Plugin, ctx: PatchContext): PatchHandle {
    const { workspace } = plugin.app;
    const windows = new Set<Window>();
    const shadows: Shadow[] = [];
    let active = false;
    let targetLeaf: WorkspaceLeaf | null = null;

    const isSidebarLeaf = (leaf: WorkspaceLeaf): boolean => {
      const root = leaf.getRoot();
      return root === workspace.leftSplit || root === workspace.rightSplit;
    };

    const clearTarget = (doc: Document): void => {
      for (const el of Array.from(doc.querySelectorAll(`.${TABS_CLASS}, .${LEAF_CLASS}`))) {
        el.classList.remove(TABS_CLASS, LEAF_CLASS);
      }
    };

    const setTarget = (leafEl: HTMLElement): void => {
      const tabsEl = leafEl.closest(".workspace-tabs");
      // Floating leaves inside popovers (e.g. Hover Editor) are never the note.
      if (!tabsEl || leafEl.closest(".popover")) return;
      clearTarget(leafEl.ownerDocument);
      tabsEl.classList.add(TABS_CLASS);
      leafEl.classList.add(LEAF_CLASS);
    };

    // The focused note follows the active leaf, but only within the main
    // area: if a command moves focus into a (hidden) sidebar, the previous
    // target stays and takes the focus back so typing never goes nowhere.
    const retarget = (leaf: WorkspaceLeaf | null): void => {
      if (!active || !leaf) return;
      if (isSidebarLeaf(leaf)) {
        if (targetLeaf?.view.containerEl.isConnected === true) workspace.setActiveLeaf(targetLeaf, { focus: true });
        return;
      }
      const leafEl = leaf.view.containerEl.closest<HTMLElement>(".workspace-leaf");
      if (!leafEl) return;
      targetLeaf = leaf;
      setTarget(leafEl);
    };

    const applyWindow = (win: Window): void => {
      const doc = win.document;
      doc.body.classList.toggle(BODY_CLASS, active);
      if (!active) {
        clearTarget(doc);
        return;
      }
      if (doc.querySelector(`.${TABS_CLASS} .${LEAF_CLASS}`)) return;
      const leafEl =
        doc.querySelector<HTMLElement>(".workspace-split.mod-root .workspace-leaf.mod-active") ??
        doc.querySelector<HTMLElement>(
          ".workspace-split.mod-root .workspace-tabs.mod-active .workspace-leaf:not([style*='display: none'])",
        ) ??
        doc.querySelector<HTMLElement>(".workspace-split.mod-root .workspace-leaf:not([style*='display: none'])");
      if (leafEl) setTarget(leafEl);
    };

    const shadow = (target: object, key: string, stub: unknown): void => {
      const record = target as Record<string, unknown>;
      shadows.push({
        target: record,
        key,
        stub,
        hadOwn: Object.prototype.hasOwnProperty.call(record, key),
        previous: record[key],
      });
      record[key] = stub;
    };

    const lock = (): void => {
      for (const split of [workspace.leftSplit, workspace.rightSplit]) {
        for (const key of LOCKED_SPLIT_METHODS) shadow(split, key, (): void => {});
      }
      const commands = (plugin.app as unknown as { commands?: CommandsLike }).commands?.commands;
      for (const id of BLOCKED_COMMANDS) {
        const command = commands?.[id];
        if (command) shadow(command, "checkCallback", (): boolean => false);
      }
    };

    // If someone else wrapped a shadowed method meanwhile, leave their wrapper
    // alone rather than clobbering it.
    const unlock = (): void => {
      for (const { target, key, stub, hadOwn, previous } of shadows.splice(0).reverse()) {
        if (target[key] !== stub) continue;
        if (hadOwn) target[key] = previous;
        else delete target[key];
      }
    };

    const setActive = (next: boolean): void => {
      if (active === next) return;
      active = next;
      if (active) {
        lock();
        // No root argument: the main area of whichever window has focus.
        const leaf = workspace.getMostRecentLeaf();
        if (leaf) {
          retarget(leaf);
          workspace.setActiveLeaf(leaf, { focus: true });
        }
      } else {
        unlock();
        targetLeaf = null;
      }
      for (const win of windows) applyWindow(win);
    };

    const setupWindow = (win: Window): void => {
      if (windows.has(win)) return;
      windows.add(win);
      applyWindow(win);
    };

    const teardownWindow = (win: Window): void => {
      if (!windows.has(win)) return;
      windows.delete(win);
      try {
        // A window closing late can already have lost its document or body.
        const doc = win.document as Document | null;
        if (doc) {
          (doc.body as HTMLElement | null)?.classList.remove(BODY_CLASS);
          clearTarget(doc);
        }
      } catch (error) {
        console.error("Micropatches (focus-mode): teardown cleanup failed", error);
      }
    };

    setupWindow(window);
    // Popouts that were open before this loaded (the plugin enabled later)
    // fire no "window-open". Once unloaded, not even the main window is set up.
    workspace.onLayoutReady(() => {
      if (!windows.has(window)) return;
      workspace.iterateAllLeaves((leaf) => {
        setupWindow(leaf.view.containerEl.win);
      });
    });

    plugin.addCommand({
      id: "focus-mode",
      name: "Enter or exit focus mode",
      checkCallback: (checking: boolean): boolean => {
        if (!ctx.isEnabled()) return false;
        if (!checking) setActive(!active);
        return true;
      },
    });

    plugin.registerEvent(
      workspace.on("active-leaf-change", (leaf) => {
        retarget(leaf);
      }),
    );
    // Closing the target or rebuilding the layout drops the marker classes.
    plugin.registerEvent(
      workspace.on("layout-change", () => {
        if (active) for (const win of windows) applyWindow(win);
      }),
    );
    plugin.registerEvent(
      workspace.on("window-open", (_workspaceWindow, win) => {
        setupWindow(win);
      }),
    );
    plugin.registerEvent(
      workspace.on("window-close", (_workspaceWindow, win) => {
        teardownWindow(win);
      }),
    );

    return {
      cleanup: (): void => {
        setActive(false);
        for (const win of Array.from(windows)) teardownWindow(win);
      },
      onToggle: (enabled: boolean): void => {
        if (!enabled) setActive(false);
      },
    };
  },
};
