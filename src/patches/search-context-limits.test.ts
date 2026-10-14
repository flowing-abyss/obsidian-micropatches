import type { CachedMetadata, Pos } from "obsidian";
import { describe, expect, it } from "vitest";
import { createContextIndex, searchExcerpt } from "./search-context";

function position(text: string, start = 0, end = text.length): Pos {
  const point = (offset: number) => ({
    offset,
    line: text.slice(0, offset).split("\n").length - 1,
    col: offset - text.lastIndexOf("\n", offset - 1) - 1,
  });
  return { start: point(start), end: point(end) };
}

function excerpt(text: string, cache: CachedMetadata) {
  const match = text.indexOf("Target");
  const start = text.lastIndexOf("\n", match) + 1;
  const newline = text.indexOf("\n", match);
  const end = newline < 0 ? text.length : newline;
  const index = createContextIndex(cache);
  if (match < 0 || index === null) throw new Error("Invalid test fixture");
  return searchExcerpt(text, start, end, [[match, match + "Target".length]], index);
}

type Container = "paragraph" | "list" | "blockquote" | "footnoteDefinition";
type Budget = "lines" | "characters" | "complete";

function codeFixture(kind: Container, budget: Budget, fence = "```") {
  const lines =
    budget === "lines"
      ? Array.from({ length: 20 }, () => "plain")
      : [budget === "characters" ? "plain ".repeat(800) : "plain"];
  let text: string;
  if (kind === "paragraph") text = ["`first", ...lines, "Target [[Other|Alias]]", "last`"].join("\n");
  else {
    const prefix = { list: "  ", blockquote: "> ", footnoteDefinition: "    " }[kind];
    const container = [fence, ...lines, "Target [[Other|Alias]]", fence].map((line) => prefix + line).join("\n");
    text = { list: "- Parent\n\n", blockquote: "", footnoteDefinition: "[^a]: Prefix\n" }[kind] + container;
  }
  // Native 1.14.4 worker metadata: code inside these containers has no separate
  // code section or link cache. List items and footnotes cover their full body.
  const cache: CachedMetadata = { sections: [{ type: kind, position: position(text) }] };
  if (kind === "list") cache.listItems = [{ parent: -1, position: position(text) }];
  if (kind === "footnoteDefinition") cache.footnotes = [{ id: "a", position: position(text) }];
  return { text, cache };
}

describe("search context clipping limits", () => {
  const containers: Container[] = ["paragraph", "list", "blockquote", "footnoteDefinition"];

  describe.each(containers)("%s", (container) => {
    it.each(["lines", "characters"] as const)(
      "keeps native code semantics when the %s budget clips its delimiters",
      (budget) => {
        const { text, cache } = codeFixture(container, budget);
        expect(excerpt(text, cache)).toBeNull();
      },
    );

    it("allows the complete bounded container through the native parser", () => {
      const { text, cache } = codeFixture(container, "complete");
      const result = excerpt(text, cache);
      expect(result?.markdown).toContain(text);
      expect(result?.kind).toBe(container === "footnoteDefinition" ? "footnote" : "markdown");
      expect(result?.terms).toEqual([["Target"]]);
    });
  });

  it.each(["list", "blockquote", "footnoteDefinition"] as const)(
    "also protects a clipped tilde fence in %s",
    (kind) => {
      const { text, cache } = codeFixture(kind, "lines", "~~~");
      expect(excerpt(text, cache)).toBeNull();
    },
  );

  it("keeps an explicit native code section static after clipping", () => {
    const text = ["```", ...Array.from({ length: 20 }, () => "plain"), "Target [[Other|Alias]]", "```"].join("\n");
    const result = excerpt(text, { sections: [{ type: "code", position: position(text) }] });
    expect(result).toMatchObject({ kind: "code", markdown: "Target [[Other|Alias]]", crumbs: [] });
  });

  it("checks a long footnote owner even when section metadata is unavailable", () => {
    const { text, cache } = codeFixture("footnoteDefinition", "lines");
    expect(excerpt(text, { footnotes: cache.footnotes ?? [] })).toBeNull();
  });

  it("does not inherit code context from a footnote that ended before the result", () => {
    const note = "[^a]: `code`";
    const paragraph = `${"plain\n".repeat(20)}Target [[Other|Alias]]`;
    const text = `${note}\n\n${paragraph}`;
    const result = excerpt(text, {
      footnotes: [{ id: "a", position: position(text, 0, note.length) }],
      sections: [
        { type: "footnoteDefinition", position: position(text, 0, note.length) },
        { type: "paragraph", position: position(text, note.length + 2) },
      ],
    });
    expect(result).toMatchObject({ kind: "markdown", markdown: "Target [[Other|Alias]]", footnote: null });
  });

  it("retains ordinary self-contained inline code and adjacent links", () => {
    const text = "Before `literal [[Code]]` and Target [[Other|Alias]] after.";
    const result = excerpt(text, { sections: [{ type: "paragraph", position: position(text) }] });
    expect(result).toMatchObject({ kind: "markdown", markdown: text });
  });
});

function hierarchy(headings: string[], parents: string[] = []) {
  let text = "";
  const cache: CachedMetadata = { headings: [], listItems: [] };
  for (const [index, heading] of headings.entries()) {
    const start = text.length;
    text += `${"#".repeat(index + 1)} ${heading}`;
    cache.headings?.push({ heading, level: index + 1, position: position(text, start) });
    text += "\n\n";
  }
  let previous = -1;
  for (const [index, label] of [...parents, "Target"].entries()) {
    if (parents.length === 0) {
      text += label;
      break;
    }
    const start = text.length + index * 2;
    text += `${"  ".repeat(index)}- ${label}`;
    const range = position(text, start);
    cache.listItems?.push({ position: range, parent: previous < 0 ? -Math.max(1, range.start.line) : previous });
    previous = range.start.line;
    text += "\n";
  }
  return { text, cache };
}

describe("search context ancestor text budget", () => {
  it("keeps the four nearest complete 500-character headings at the 2000-character limit", () => {
    const labels = Array.from({ length: 6 }, (_, index) => String(index + 1).repeat(500));
    const { text, cache } = hierarchy(labels);
    const result = excerpt(text, cache);
    expect(result?.crumbs.map((crumb) => crumb.text)).toEqual(labels.slice(2));
    expect(result?.crumbs.map((crumb) => crumb.marker)).toEqual(["H3", "H4", "H5", "H6"]);
    expect(result?.crumbs.reduce((sum, crumb) => sum + crumb.text.length, 0)).toBe(2000);
    expect(result?.markdown).toBe("Target");
  });

  it("shares one budget between headings and the nearest complete list ancestors", () => {
    const headings = ["A".repeat(320), "B".repeat(320)];
    const parents = Array.from({ length: 4 }, (_, index) => String(index + 1).repeat(360));
    const { text, cache } = hierarchy(headings, parents);
    const result = excerpt(text, cache);
    expect(result?.crumbs.map((crumb) => crumb.text)).toEqual([headings[1], ...parents]);
    expect(result?.crumbs.map((crumb) => crumb.kind)).toEqual(["heading", "list", "list", "list", "list"]);
    expect(result?.crumbs.reduce((sum, crumb) => sum + crumb.text.length, 0)).toBe(1760);
    expect(result?.markdown.trim()).toBe("- Target");
  });

  it("preserves every complete ancestor when the shared budget is met exactly", () => {
    const labels = Array.from({ length: 4 }, (_, index) => String(index + 1).repeat(500));
    const { text, cache } = hierarchy(labels);
    expect(excerpt(text, cache)?.crumbs.map((crumb) => crumb.text)).toEqual(labels);
  });
});
