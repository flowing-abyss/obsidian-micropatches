import type { Plugin } from "obsidian";
import type { Patch, PatchContext, PatchHandle } from "../patch";

export const MEDIA_EMBED_CLASS = "micropatches-media-embed-dimensions";

export function setMediaEmbedDimensionsEnabled(root: HTMLElement, enabled: boolean): void {
  root.classList.toggle(MEDIA_EMBED_CLASS, enabled);
}

export const mediaEmbedDimensions: Patch = {
  id: "media-embed-dimensions",
  name: "Media embed dimensions",
  description:
    "Makes Obsidian's existing embed dimensions apply consistently to media embeds in Reading View and Live Preview.",

  register(_plugin: Plugin, ctx: PatchContext): PatchHandle {
    const root = document.body;
    const apply = (): void => {
      setMediaEmbedDimensionsEnabled(root, ctx.isEnabled());
    };
    apply();
    return {
      cleanup: (): void => {
        setMediaEmbedDimensionsEnabled(root, false);
      },
      onToggle: (enabled): void => {
        setMediaEmbedDimensionsEnabled(root, enabled);
      },
    };
  },
};
