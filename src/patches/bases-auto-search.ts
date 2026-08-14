import type { Plugin } from "obsidian";
import type { Patch, PatchContext, PatchHandle } from "../patch";

// Undocumented Bases-internal API — not in obsidian.d.ts.
interface BasesLeafView {
  controller?: { searchMenu?: { open(): void } };
}

/**
 * Replaces the third-party "Bases Auto Search" plugin (a ~30-line, single-
 * purpose utility) with the same logic. Opens the search bar automatically
 * the first time a Bases view is shown, so you don't have to click it every
 * time you open a base.
 */
export const basesAutoSearch: Patch = {
  id: "bases-auto-search",
  name: "Bases auto search",
  description: "Automatically opens the search bar the first time a Bases view is shown.",

  register(plugin: Plugin, ctx: PatchContext): PatchHandle {
    const processed = new WeakSet<object>();

    const openSearch = (): void => {
      if (!ctx.isEnabled()) return;
      for (const leaf of plugin.app.workspace.getLeavesOfType("bases")) {
        if (processed.has(leaf)) continue;
        const searchMenu = (leaf.view as unknown as BasesLeafView).controller?.searchMenu;
        if (!searchMenu) continue;
        processed.add(leaf);
        searchMenu.open();
      }
    };

    plugin.registerEvent(plugin.app.workspace.on("layout-change", () => openSearch()));
    plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", () => openSearch()));

    return { cleanup: (): void => {} };
  },
};
