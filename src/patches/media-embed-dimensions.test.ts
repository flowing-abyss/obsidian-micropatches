import { describe, expect, it } from "vitest";
import { MEDIA_EMBED_CLASS, setMediaEmbedDimensionsEnabled } from "./media-embed-dimensions";

describe("setMediaEmbedDimensionsEnabled", () => {
  it("adds and removes the scoped feature class", () => {
    const root = document.body.createDiv();

    setMediaEmbedDimensionsEnabled(root, true);
    expect(root.classList.contains(MEDIA_EMBED_CLASS)).toBe(true);

    setMediaEmbedDimensionsEnabled(root, false);
    expect(root.classList.contains(MEDIA_EMBED_CLASS)).toBe(false);
  });
});
