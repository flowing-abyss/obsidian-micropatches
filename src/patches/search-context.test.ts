import {
  App,
  Component,
  MarkdownPreviewRenderer,
  MarkdownRenderer,
  Plugin,
  type WorkspaceLeaf,
} from "obsidian-test-mocks/obsidian";
import * as obsidian from "obsidian";
import type { CachedMetadata, Pos } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PatchHandle } from "../patch";
import { createContextIndex, highlightExcerpt, renderPreview, searchContext, searchExcerpt } from "./search-context";

vi.mock("obsidian", async (importOriginal) => ({
  ...(await importOriginal<typeof obsidian>()),
  sanitizeHTMLToDom: vi.fn(),
}));

const SOURCE =
  "# Notes\n\n## Research\n\n- Parent\n  - **Matched** [[Target|Alias]]\n    - Child\n- Sibling\n\n## Next\n\nOther match\n";
function position(text: string, fragment: string): Pos {
  const start = text.indexOf(fragment);
  if (start < 0) throw new Error("Missing fixture text");
  const end = start + fragment.length;
  const loc = (offset: number) => ({
    offset,
    line: text.slice(0, offset).split("\n").length - 1,
    col: offset - text.lastIndexOf("\n", offset - 1) - 1,
  });
  return { start: loc(start), end: loc(end) };
}

function listFixture(...rows: Array<string | [text: string, parent: number]>) {
  const text = rows.map((row) => (typeof row === "string" ? row : row[0])).join("\n");
  const cache: CachedMetadata = {
    listItems: rows.flatMap((row) =>
      typeof row === "string" ? [] : [{ parent: row[1], position: position(text, row[0].trimStart()) }],
    ),
  };
  return { text, cache };
}

function documentContextFixtures(): Array<{ name: string; text: string; cache: CachedMetadata }> {
  const yaml = "---\ntitle: Target\n---\n\nAfter";
  const invalidYaml = "---\nbroken: [\nTarget: **value**\n---\n\nAfter Target";
  const reference = "Text Target [^a].\n\n[^a]: Definition";
  const nested = "Before [^a].\n\n[^a]: Note\n    - First\n      - Target\n\nAfter\n\n## Next\nNormal";
  const quoted = "> [^a]: Target\n>     continuation\n\nText [^a].";
  const inline = "# Body\nText ^[Footnote Target [[Other|Alias]]] tail";
  const overlapping = "> [^a]: Before ^[inline]\n>     - Parent\n>       - Target";
  const longDefinition = `[^a]: Note\n${"    Continuation\n".repeat(20)}    Target`;
  const fixtures: Array<{ name: string; text: string; cache: CachedMetadata }> = [
    {
      name: "frontmatter properties",
      text: yaml,
      cache: { frontmatterPosition: position(yaml, "---\ntitle: Target\n---") },
    },
    {
      // Invalid YAML has a native yaml section but no frontmatterPosition.
      name: "invalid YAML without frontmatter metadata",
      text: invalidYaml,
      cache: {
        sections: [
          { type: "yaml", position: position(invalidYaml, "---\nbroken: [\nTarget: **value**\n---") },
          { type: "paragraph", position: position(invalidYaml, "After Target") },
        ],
      },
    },
    {
      name: "footnote reference with a definition outside the excerpt",
      text: reference,
      cache: {
        footnoteRefs: [{ id: "a", position: position(reference, "[^a]") }],
        footnotes: [{ id: "a", position: position(reference, "[^a]: Definition") }],
      },
    },
    {
      // Native worker snapshot: the definition encloses both nested list items.
      name: "list inside a footnote definition",
      text: nested,
      cache: {
        footnotes: [{ id: "a", position: position(nested, "[^a]: Note\n    - First\n      - Target") }],
        footnoteRefs: [{ id: "a", position: position(nested, "[^a]") }],
        listItems: [
          { parent: -3, position: position(nested, "- First") },
          { parent: 3, position: position(nested, "- Target") },
        ],
        sections: [
          { type: "paragraph", position: position(nested, "Before [^a].") },
          { type: "footnoteDefinition", position: position(nested, "[^a]: Note\n    - First\n      - Target") },
          { type: "paragraph", position: position(nested, "After") },
        ],
      },
    },
    {
      // Native worker snapshot: the outer section is a blockquote, not a definition.
      name: "footnote definition in a quote",
      text: quoted,
      cache: {
        footnotes: [{ id: "a", position: position(quoted, "[^a]: Target\n>     continuation") }],
        sections: [{ type: "blockquote", position: position(quoted, "> [^a]: Target\n>     continuation") }],
      },
    },
    {
      name: "inline footnote with a known wiki link",
      text: inline,
      cache: {
        footnotes: [{ id: "[inline0", position: position(inline, "Footnote Target [[Other|Alias]]") }],
        links: [
          {
            link: "Other",
            displayText: "Alias",
            original: "[[Other|Alias]]",
            position: position(inline, "[[Other|Alias]]"),
          },
        ],
        headings: [{ heading: "Body", level: 1, position: position(inline, "# Body") }],
        sections: [{ type: "paragraph", position: position(inline, "Text ^[Footnote Target [[Other|Alias]]] tail") }],
      },
    },
    {
      name: "outer footnote containing an earlier inline footnote and a nested list",
      text: overlapping,
      cache: {
        footnotes: [
          { id: "a", position: position(overlapping, "[^a]: Before ^[inline]\n>     - Parent\n>       - Target") },
          { id: "[inline0", position: position(overlapping, "inline") },
        ],
        listItems: [
          { parent: -1, position: position(overlapping, "- Parent") },
          { parent: 1, position: position(overlapping, "- Target") },
        ],
        sections: [{ type: "blockquote", position: position(overlapping, overlapping) }],
      },
    },
    {
      name: "footnote definition exceeding the excerpt line budget",
      text: longDefinition,
      cache: {
        footnotes: [{ id: "a", position: position(longDefinition, longDefinition) }],
        sections: [{ type: "footnoteDefinition", position: position(longDefinition, longDefinition) }],
      },
    },
    {
      name: "footnote definition section without its specific metadata",
      text: "[^a]: Target",
      cache: { sections: [{ type: "footnoteDefinition", position: position("[^a]: Target", "[^a]: Target") }] },
    },
    {
      name: "reference definition section without its specific metadata",
      text: "[ref]: Target.md",
      cache: { sections: [{ type: "definition", position: position("[ref]: Target.md", "[ref]: Target.md") }] },
    },
  ];
  for (const [name, usage, id] of [
    ["full reference link", "[Target][ref]", "ref"],
    ["collapsed reference link", "[Target][]", "Target"],
    ["shortcut reference link", "[Target]", "Target"],
  ] as const) {
    const definition = `[${id}]: Other.md`;
    const text = `See ${usage}.\n\n${definition}`;
    fixtures.push({
      name,
      text,
      cache: { referenceLinks: [{ id, link: "Other.md", position: position(text, definition) }] },
    });
  }
  for (const kind of ["heading", "list"] as const) {
    for (const reference of ["footnote", "reference"] as const) {
      const label = reference === "footnote" ? "Label[^a]" : "[Label][ref]";
      const firstLine = kind === "heading" ? `## ${label}` : `- ${label}`;
      const definition = reference === "footnote" ? "[^a]: Definition" : "[ref]: Other.md";
      const text = `${firstLine}\n${kind === "heading" ? "Target" : "  - Target"}\n\n${definition}`;
      const cache: CachedMetadata =
        reference === "footnote"
          ? {
              footnoteRefs: [{ id: "a", position: position(text, "[^a]") }],
              footnotes: [{ id: "a", position: position(text, definition) }],
            }
          : { referenceLinks: [{ id: "ref", link: "Other.md", position: position(text, definition) }] };
      if (kind === "heading") cache.headings = [{ heading: label, level: 2, position: position(text, firstLine) }];
      else
        cache.listItems = [
          { parent: -1, position: position(text, firstLine) },
          { parent: 0, position: position(text, "- Target") },
        ];
      fixtures.push({ name: `${reference} in a ${kind} ancestor`, text, cache });
    }
  }
  return fixtures;
}

const CACHE: CachedMetadata = {
  headings: [
    { heading: "Notes", level: 1, position: position(SOURCE, "# Notes") },
    { heading: "Research", level: 2, position: position(SOURCE, "## Research") },
    { heading: "Next", level: 2, position: position(SOURCE, "## Next") },
  ],
  listItems: [
    { parent: -4, position: position(SOURCE, "- Parent") },
    { parent: 4, position: position(SOURCE, "- **Matched** [[Target|Alias]]") },
    { parent: 5, position: position(SOURCE, "- Child") },
    { parent: -4, position: position(SOURCE, "- Sibling") },
  ],
  links: [
    {
      link: "Target",
      displayText: "Alias",
      original: "[[Target|Alias]]",
      position: position(SOURCE, "[[Target|Alias]]"),
    },
  ],
};

function excerpt(text = SOURCE, cache = CACHE, term = "Target") {
  const offset = text.indexOf(term);
  const start = text.lastIndexOf("\n", offset) + 1;
  const newline = text.indexOf("\n", offset);
  const index = createContextIndex(cache);
  if (index === null) throw new Error("Fixture index exceeds budget");
  return searchExcerpt(text, start, newline < 0 ? text.length : newline, [[offset, offset + term.length]], index);
}

describe("search excerpts", () => {
  it("shows enclosing headings and list parents, plus children but no siblings", () => {
    const result = excerpt();
    expect(result?.crumbs).toEqual([
      { text: "Notes", line: 0, kind: "heading", marker: "H1" },
      { text: "Research", line: 2, kind: "heading", marker: "H2" },
      { text: "Parent", line: 4, kind: "list", marker: "•" },
    ]);
    expect(result?.markdown).toBe("- **Matched** [[Target|Alias]]\n  - Child");
    expect(result?.terms).toEqual([["Target", "Alias"]]);
  });

  it("does not keep a previous sibling heading as an ancestor", () => {
    expect(excerpt(SOURCE, CACHE, "Other")?.crumbs.map((crumb) => crumb.text)).toEqual(["Notes", "Next"]);
  });

  it("handles a list starting on line zero without creating a parent cycle", () => {
    const text = "- Parent\n  - Child\n- Sibling";
    const cache: CachedMetadata = {
      listItems: [
        { parent: -1, position: position(text, "- Parent") },
        { parent: 0, position: position(text, "- Child") },
        { parent: -1, position: position(text, "- Sibling") },
      ],
    };
    expect(excerpt(text, cache, "Child")?.crumbs).toEqual([{ text: "Parent", line: 0, kind: "list", marker: "•" }]);
    expect(excerpt(text, cache, "Sibling")?.crumbs).toEqual([]);
    expect(excerpt(text, cache, "Parent")?.markdown).toBe("- Parent\n  - Child");
  });

  it("uses native list parents and preserves mixed tab/space nesting", () => {
    const text = "- Root\n    - Parent\n\t\t- Child\n- Sibling\n";
    // Captured from Obsidian 1.14.4: a list item's cached start can include
    // part of its indentation; parent is the reliable hierarchy information.
    const cache: CachedMetadata = {
      listItems: [
        { parent: -1, position: position(text, "- Root") },
        { parent: 0, position: position(text, "  - Parent") },
        { parent: 1, position: position(text, "- Child") },
        { parent: -1, position: position(text, "- Sibling") },
      ],
    };
    expect(excerpt(text, cache, "Child")?.crumbs.map((crumb) => crumb.text)).toEqual(["Root", "Parent"]);
    expect(excerpt(text, cache, "Parent")?.markdown).toBe("- Parent\n    - Child");
    expect(excerpt(text, cache, "Sibling")?.crumbs).toEqual([]);
  });

  it("retains actual heading levels when an ancestor skips from H2 to H4", () => {
    const text = "## Section\n\n#### Detail\n\nTarget";
    const cache: CachedMetadata = {
      headings: [
        { heading: "Section", level: 2, position: position(text, "## Section") },
        { heading: "Detail", level: 4, position: position(text, "#### Detail") },
      ],
    };
    expect(excerpt(text, cache)?.crumbs).toEqual([
      { text: "Section", line: 0, kind: "heading", marker: "H2" },
      { text: "Detail", line: 2, kind: "heading", marker: "H4" },
    ]);
  });

  it("numbers ordered ancestors by displayed ordinal and resets for bullets and delimiter changes", () => {
    const { text, cache } = listFixture(
      ["4. Parent A", -1],
      ["   - Match A", 0],
      ["1. Parent B", -1],
      ["   - Match B", 2],
      ["2) Parent C", -1],
      ["   - Match C", 4],
      ["1) Parent D", -1],
      ["   - Match D", 6],
      ["- Parent E", -1],
      ["  - Match E", 8],
      ["7. Parent F", -1],
      ["   - Match F", 10],
      ["1. Parent G", -1],
      ["   - Match G", 12],
    );
    expect(
      ["A", "B", "C", "D", "E", "F", "G"].map((suffix) =>
        excerpt(text, cache, `Match ${suffix}`)?.crumbs.map((crumb) => crumb.marker),
      ),
    ).toEqual([["4."], ["5."], ["2."], ["3."], ["•"], ["7."], ["8."]]);
  });

  it("keeps numbering independent for different native sibling parents", () => {
    const { text, cache } = listFixture(
      ["- Root A", -1],
      ["  3. First A", 0],
      ["  1. Second A", 0],
      ["     - Match A", 2],
      ["- Root B", -1],
      ["  8. First B", 4],
      ["  1. Second B", 4],
      ["     - Match B", 6],
    );
    expect(excerpt(text, cache, "Match A")?.crumbs.map(({ text, marker }) => [text, marker])).toEqual([
      ["Root A", "•"],
      ["Second A", "4."],
    ]);
    expect(excerpt(text, cache, "Match B")?.crumbs.map(({ text, marker }) => [text, marker])).toEqual([
      ["Root B", "•"],
      ["Second B", "9."],
    ]);
  });

  it("restarts a nested ordered run after a separating paragraph", () => {
    const { text, cache } = listFixture(
      ["- Root", -1],
      ["  3. First", 0],
      "",
      "  Paragraph separating lists.",
      "",
      ["  1. Second", 0],
      ["     - Target", 5],
    );
    expect(excerpt(text, cache)?.crumbs.map(({ text, marker }) => [text, marker])).toEqual([
      ["Root", "•"],
      ["Second", "1."],
    ]);
  });

  it("continues an ordered run after text included in the previous native item's position", () => {
    const text = "- Root\n  1. First\n     Continuation\n  1. Target";
    // Native metadata extends the first item's position through its continuation.
    const cache: CachedMetadata = {
      listItems: [
        { parent: -1, position: position(text, "- Root") },
        { parent: 0, position: position(text, "1. First\n     Continuation") },
        { parent: 0, position: position(text, "1. Target") },
      ],
    };
    expect(excerpt(text, cache)).toMatchObject({ markdown: "1. Target", listStart: 2 });
  });

  it.each([
    ["quote boundary", "\n\n  > Quote between lists\n\n"],
    ["over-budget whitespace", `\n${" ".repeat(4000)}\n`],
  ])("keeps an ordered fragment native across an uncertain %s", (_name, gap) => {
    const text = `- Root\n  1. First${gap}  1. Target`;
    const cache: CachedMetadata = {
      listItems: [
        { parent: -1, position: position(text, "- Root") },
        { parent: 0, position: position(text, "1. First") },
        { parent: 0, position: position(text, "1. Target") },
      ],
    };
    expect(excerpt(text, cache)).toBeNull();
  });

  it("keeps a quoted ordered match native when root item ranges overlap", () => {
    const text = "1. First\n> 7. Target";
    // Native worker gives both containers parent=-1; the outer item covers the quote.
    const cache: CachedMetadata = {
      listItems: [
        { parent: -1, position: position(text, text) },
        { parent: -1, position: position(text, "7. Target") },
      ],
    };
    expect(excerpt(text, cache)).toBeNull();
  });

  it("omits an uncertain ordered ancestor without discarding the match", () => {
    const text = "1. First\n> 7. Parent\n>    - Target";
    const cache: CachedMetadata = {
      listItems: [
        { parent: -1, position: position(text, text) },
        { parent: -1, position: position(text, "7. Parent") },
        { parent: 1, position: position(text, "- Target") },
      ],
    };
    expect(excerpt(text, cache)).toMatchObject({ markdown: ">    - Target", crumbs: [] });
  });

  it("keeps a new root list's numbering separate from an earlier paragraph-separated group", () => {
    const { text, cache } = listFixture(
      ["5. Earlier", -1],
      "",
      "Paragraph between root lists.",
      "",
      ["2. Later", -4],
      ["1. Target", -4],
    );
    expect(excerpt(text, cache)).toMatchObject({ markdown: "1. Target", listStart: 3 });
  });

  it.each([
    ["LF", "\n"],
    ["CRLF", "\r\n"],
  ])("counts an empty first ordered item with %s line endings", (_name, newline) => {
    const text = `5.${newline}1. Target`;
    const cache: CachedMetadata = {
      listItems: [
        { parent: -1, position: position(text, "5.") },
        { parent: -1, position: position(text, "1. Target") },
      ],
    };
    expect(excerpt(text, cache)).toMatchObject({ markdown: "1. Target", listStart: 6 });
  });

  it.each([".", ")"])("preserves the first body item's displayed number with the %s delimiter", (delimiter) => {
    const { text, cache } = listFixture(
      [`3${delimiter} Earlier`, -1],
      [`1${delimiter} Target`, -1],
      ["   - Child", 1],
      [`1${delimiter} Later`, -1],
    );
    expect(excerpt(text, cache)).toMatchObject({
      markdown: `1${delimiter} Target\n   - Child`,
      listStart: 4,
    });
  });

  it("keeps an indented body item's number separately while normalizing its indentation", () => {
    const { text, cache } = listFixture(["- Root", -1], ["  8. First", 0], ["  1. Target", 0]);
    expect(excerpt(text, cache)).toMatchObject({ markdown: "1. Target", listStart: 9 });
  });

  it("preserves earlier numbered items when the native excerpt was manually expanded", () => {
    const { text, cache } = listFixture(["3. Earlier", -1], ["1. Target", -1]);
    const index = createContextIndex(cache);
    if (index === null) throw new Error("Missing index");
    const target = text.indexOf("Target");
    expect(searchExcerpt(text, 0, text.length, [[target, target + 6]], index)).toMatchObject({
      markdown: text,
      listStart: 3,
    });
  });

  it("keeps manually expanded context instead of narrowing it to the first match", () => {
    const index = createContextIndex(CACHE);
    if (index === null) throw new Error("Missing index");
    const start = SOURCE.indexOf("- Parent");
    const end = SOURCE.indexOf("- Sibling") + "- Sibling".length;
    const match = SOURCE.indexOf("Target");
    const result = searchExcerpt(SOURCE, start, end, [[match, match + 6]], index);
    expect(result?.markdown).toContain("Parent");
    expect(result?.markdown).toContain("Sibling");
    expect(result?.markdown).toContain("- Parent\n  - **Matched**");
  });

  it("collects every native match and treats regular-expression characters literally", () => {
    const text = "a+b and c.d";
    const index = createContextIndex({});
    if (index === null) throw new Error("Missing index");
    expect(
      searchExcerpt(
        text,
        0,
        text.length,
        [
          [0, 3],
          [8, 11],
        ],
        index,
      )?.terms,
    ).toEqual([["a+b"], ["c.d"]]);
  });

  it("falls back to the native fragment when surrounding context is huge", () => {
    const text = `Match\n${"long context\n".repeat(1000)}`;
    expect(
      excerpt(text, { sections: [{ type: "paragraph", position: position(text, text.trimEnd()) }] }, "Match")?.markdown,
    ).toBe("Match");
  });

  it("refuses huge native fragments and invalid match offsets", () => {
    const index = createContextIndex({});
    if (index === null) throw new Error("Missing index");
    expect(searchExcerpt("x".repeat(5000), 0, 5000, [[0, 1]], index)).toBeNull();
    expect(searchExcerpt("text", 0, 4, [[5, 6]], index)).toBeNull();
    expect(searchExcerpt("text", 0, 4, [[2, 1]], index)).toBeNull();
  });

  it("bounds metadata indexing", () => {
    const heading = { heading: "Heading", level: 1, position: position("Heading", "Heading") };
    expect(createContextIndex({ headings: Array.from({ length: 20001 }, () => heading) })).toBeNull();
  });

  it("renders code sections as literal native fragments without interpreting Markdown", () => {
    const text = "```query\n**Target** [[literal]]\n```";
    expect(excerpt(text, { sections: [{ type: "code", position: position(text, text) }] })).toMatchObject({
      kind: "code",
      markdown: "**Target** [[literal]]",
      crumbs: [],
    });
  });

  it.each([
    "See ![[Target]]",
    "![Target](https://example.com/image.png)",
    'Target <img src="https://example.com/image.png">',
  ])("preserves media syntax for the inert native parser: %s", (text) => {
    expect(excerpt(text, {})?.markdown).toBe(text);
  });

  it("preserves complete ancestor Markdown up to the budget and omits oversized ancestors", () => {
    const heading = `**${"h".repeat(508)}**`;
    const text = `# ${heading}\nTarget`;
    const result = excerpt(text, { headings: [{ heading, level: 1, position: position(text, `# ${heading}`) }] });
    expect(result?.crumbs[0]?.text).toBe(heading);
    const oversized = `${heading}x`;
    const longText = `# ${oversized}\nTarget`;
    expect(
      excerpt(longText, {
        headings: [{ heading: oversized, level: 1, position: position(longText, `# ${oversized}`) }],
      }),
    ).toMatchObject({ markdown: "Target", crumbs: [] });
  });

  it.each([
    "![[Embedded]]",
    "`$= dv.current()`",
    "`= this.file.name`",
    "`custom: Run()`",
    "`Code`",
    '<img src="remote.png">',
  ])("preserves rich ancestor syntax for the parser without postprocessors: %s", (label) => {
    const text = `# ${label}\nTarget`;
    expect(
      excerpt(text, { headings: [{ heading: label, level: 1, position: position(text, `# ${label}`) }] })?.crumbs[0]
        ?.text,
    ).toBe(label);
  });

  it.each([
    "`$= dv.current()`",
    "`= this.file.name`",
    "`custom: Run()`",
    "`Code`",
    "<code>$= dv.current()</code>",
    "<pre>custom: Run()</pre>",
  ])("preserves body code for inert parsing: %s", (code) => {
    expect(excerpt(`Target ${code}`, {})).toMatchObject({ kind: "markdown", markdown: `Target ${code}` });
  });

  it("preserves more than 32 distinct native terms", () => {
    const text = Array.from({ length: 40 }, (_, i) => `word${i}`).join(" ");
    const index = createContextIndex({});
    if (index === null) throw new Error("Missing index");
    const ranges = Array.from(
      text.matchAll(/word\d+/gu),
      (match) => [match.index, match.index + match[0].length] as [number, number],
    );
    expect(searchExcerpt(text, 0, text.length, ranges, index)?.terms).toHaveLength(40);
  });
});

describe("document-dependent excerpts", () => {
  it("allows a plain paragraph exactly after an outer footnote containing an earlier inline footnote", () => {
    const definition = "> [^a]: Before ^[inline]\n>     - Parent\n>       - Earlier";
    const text = `${definition}\n\nTarget`;
    const index = createContextIndex({
      footnotes: [
        { id: "a", position: position(text, definition.slice(2)) },
        { id: "[inline0", position: position(text, "inline") },
      ],
      sections: [
        { type: "blockquote", position: position(text, definition) },
        { type: "paragraph", position: position(text, "Target") },
      ],
    });
    if (index === null) throw new Error("Missing fixture index");
    const target = text.indexOf("Target");
    expect(searchExcerpt(text, definition.length, text.length, [[target, target + 6]], index)?.markdown).toBe(
      "\n\nTarget",
    );
  });

  it.each(["footnotes", "footnoteRefs", "referenceLinks"] as const)(
    "includes %s in the shared metadata indexing budget",
    (kind) => {
      const span = position("Target", "Target");
      const cache: CachedMetadata = {
        headings: Array.from({ length: 10000 }, () => ({ heading: "Target", level: 1, position: span })),
        [kind]: Array.from({ length: 10001 }, () => ({ id: "a", link: "Other.md", position: span })),
      };
      expect(createContextIndex(cache)).toBeNull();
    },
  );

  it("allows a plain fragment starting exactly at the end of frontmatter", () => {
    const yaml = "---\ntitle: Note\n---";
    const text = `${yaml}\n\nTarget`;
    const cache: CachedMetadata = {
      frontmatterPosition: position(text, yaml),
      sections: [
        { type: "yaml", position: position(text, yaml) },
        { type: "paragraph", position: position(text, "Target") },
      ],
    };
    const index = createContextIndex(cache);
    if (index === null) throw new Error("Missing fixture index");
    const offset = text.indexOf("Target");
    expect(searchExcerpt(text, yaml.length, text.length, [[offset, offset + 6]], index)?.markdown).toBe("\n\nTarget");
  });

  it("treats both ends of a footnote reference as exclusive boundaries for adjacent fragments", () => {
    const text = "Target [^a] After\n\n[^a]: Definition";
    const reference = position(text, "[^a]");
    const index = createContextIndex({
      footnoteRefs: [{ id: "a", position: reference }],
      footnotes: [{ id: "a", position: position(text, "[^a]: Definition") }],
    });
    if (index === null) throw new Error("Missing fixture index");
    expect(searchExcerpt(text, 0, reference.start.offset, [[0, 6]], index)?.markdown).toBe("Target ");
    const after = position(text, "After");
    expect(
      searchExcerpt(text, reference.end.offset, after.end.offset, [[after.start.offset, after.end.offset]], index)
        ?.markdown,
    ).toBe(" After");
  });

  it.each(["footnote", "reference"])("allows a plain paragraph between adjacent %s definition ranges", (kind) => {
    const first = kind === "footnote" ? "[^a]: Before" : "[a]: Before.md";
    const last = kind === "footnote" ? "[^b]: After" : "[b]: After.md";
    const text = `${first}\n\nTarget\n\n${last}`;
    const firstPosition = position(text, first);
    const lastPosition = position(text, last);
    const cache: CachedMetadata = {
      sections: [
        { type: kind === "footnote" ? "footnoteDefinition" : "definition", position: firstPosition },
        { type: "paragraph", position: position(text, "Target") },
        { type: kind === "footnote" ? "footnoteDefinition" : "definition", position: lastPosition },
      ],
    };
    if (kind === "footnote")
      cache.footnotes = [
        { id: "a", position: firstPosition },
        { id: "b", position: lastPosition },
      ];
    else
      cache.referenceLinks = [
        { id: "a", link: "Before.md", position: firstPosition },
        { id: "b", link: "After.md", position: lastPosition },
      ];
    const index = createContextIndex(cache);
    if (index === null) throw new Error("Missing fixture index");
    const target = text.indexOf("Target");
    expect(
      searchExcerpt(text, firstPosition.end.offset, lastPosition.start.offset, [[target, target + 6]], index)?.markdown,
    ).toBe("\n\nTarget\n\n");
  });

  it.each([
    ["wiki link", "[[Target]]", "[[Target]]"],
    ["inline link", "[Target](Other.md)", "[Target](Other.md)"],
    ["note embed", "![[Target]]", "![[Target]]"],
  ])("preserves a known %s when unrelated reference definitions exist", (_name, syntax, expected) => {
    const text = `See ${syntax}\n\n[ref]: Elsewhere.md`;
    const link = {
      link: syntax === "[Target](Other.md)" ? "Other.md" : "Target",
      displayText: "Target",
      original: syntax,
      position: position(text, syntax),
    };
    const cache: CachedMetadata = {
      referenceLinks: [{ id: "ref", link: "Elsewhere.md", position: position(text, "[ref]: Elsewhere.md") }],
      ...(syntax.startsWith("!") ? { embeds: [link] } : { links: [link] }),
    };
    expect(excerpt(text, cache)?.markdown).toBe(`See ${expected}`);
  });

  it.each(["heading", "list"])("preserves a known link in a %s ancestor beside reference definitions", (kind) => {
    const label = kind === "heading" ? "[[Other|Label]]" : "[Label](Other.md)";
    const firstLine = kind === "heading" ? `## ${label}` : `- ${label}`;
    const text = `${firstLine}\n${kind === "heading" ? "Target" : "  - Target"}\n\n[ref]: Elsewhere.md`;
    const cache: CachedMetadata = {
      referenceLinks: [{ id: "ref", link: "Elsewhere.md", position: position(text, "[ref]: Elsewhere.md") }],
      links: [
        {
          link: kind === "heading" ? "Other" : "Other.md",
          displayText: "Label",
          original: label,
          position: position(text, label),
        },
      ],
    };
    if (kind === "heading") cache.headings = [{ heading: label, level: 2, position: position(text, firstLine) }];
    else
      cache.listItems = [
        { parent: -1, position: position(text, firstLine) },
        { parent: 0, position: position(text, "- Target") },
      ];
    expect(excerpt(text, cache)?.crumbs.map((crumb) => crumb.text)).toEqual([label]);
  });
});

describe("rendered match highlighting", () => {
  it("highlights multiple literal matches across formatting nodes", () => {
    const el = createDiv();
    el.appendText("a+b and ");
    el.createEl("strong").textContent = "Multi";
    el.appendText("word then c.d");
    highlightExcerpt(el, [["a+b"], ["Multiword"], ["c.d"]]);
    expect(el.textContent).toBe("a+b and Multiword then c.d");
    expect(Array.from(el.querySelectorAll(".search-result-file-matched-text"), (span) => span.textContent)).toEqual([
      "a+b",
      "Multi",
      "word",
      "c.d",
    ]);
    expect(el.querySelector("strong")?.textContent).toBe("Multi");
  });

  it("reports incomplete coverage while preserving visible highlights and accepts explicit aliases", () => {
    const el = createDiv({ text: "Visible label" });
    expect(highlightExcerpt(el, [["Visible"], ["hidden.example"]])).toBe(false);
    expect(el.querySelector(".search-result-file-matched-text")?.textContent).toBe("Visible");
    const alias = createDiv({ text: "Visible label" });
    expect(highlightExcerpt(alias, [["Visible"], ["Target", "label"]])).toBe(true);
    expect(alias.querySelectorAll(".search-result-file-matched-text")).toHaveLength(2);
  });

  it("does not interpret query text as HTML or a regular expression", () => {
    const el = createDiv({ text: "<script> a.*b aZZb" });
    highlightExcerpt(el, [["<script>"], ["a.*b"]]);
    expect(el.querySelector("script")).toBeNull();
    expect(el.querySelectorAll(".search-result-file-matched-text")).toHaveLength(2);
  });
});

// These fixtures are native parseSync section HTML, not a test Markdown parser.
// Unknown Markdown deliberately fails so a source/extraction change needs review.
interface ParserReceiver {
  text: string;
  parseFinish(text: string, result: unknown): void;
}
const htmlFixtures = new Map<string, string | string[]>();
const parsedMarkdown: string[] = [];
const sanitizedTrees: Element[][] = [];
const parserDescriptor = Object.getOwnPropertyDescriptor(MarkdownPreviewRenderer.prototype, "parseSync");
const parser = vi.fn(function (this: ParserReceiver) {
  parsedMarkdown.push(this.text);
  const html = htmlFixtures.get(this.text);
  if (html === undefined) throw new Error(`Missing native parser fixture: ${this.text}`);
  this.parseFinish(this.text, { sections: (typeof html === "string" ? [html] : html).map((html) => ({ html })) });
});
function nativeHtml(markdown: string, html: string | string[]) {
  htmlFixtures.set(markdown, html);
}
function highlights(el: ParentNode): string[] {
  return Array.from(el.querySelectorAll(".search-result-file-matched-text"), (node) => node.textContent);
}

class TestPlugin extends Plugin {}
const handles: PatchHandle[] = [];
class Intersections {
  static readonly instances: Intersections[] = [];
  targets = new Set<Element>();
  constructor(
    readonly callback: IntersectionObserverCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    Intersections.instances.push(this);
  }
  observe(el: Element) {
    this.targets.add(el);
  }
  unobserve(el: Element) {
    this.targets.delete(el);
  }
  disconnect() {
    this.targets.clear();
  }
  send(visible: boolean, targets = Array.from(this.targets)) {
    this.callback(
      targets.map((target) => ({
        target,
        isIntersecting: visible,
        intersectionRatio: visible ? 1 : 0,
        boundingClientRect: target.getBoundingClientRect(),
        intersectionRect: target.getBoundingClientRect(),
        rootBounds: null,
        time: 0,
      })),
      this as unknown as IntersectionObserver,
    );
  }
}
// Minimal native class snapshots keep prototype hooks, native controls and real
// MutationObserver delivery. jsdom only substitutes viewport/layout measurements.
class NativeInfinityScroll {
  invalidate = vi.fn();
  measured = vi.fn();
  measure(parent: NativeResult, item: NativeMatch) {
    this.measured(parent, item);
    return 137;
  }
}
class NativeHolder {
  el = document.body.createDiv({ cls: "search-result-container" });
  resultDomLookup = new Map<string, NativeResult>();
  infinityScroll = new NativeInfinityScroll();
  constructor() {
    Object.defineProperty(this.el, "offsetParent", { configurable: true, value: document.body });
  }
  addResult(path: string) {
    const result = new NativeResult(this, path);
    this.resultDomLookup.set(path, result);
    return result;
  }
}
class NativeResult {
  file: { extension: string; path: string };
  vChildren: { _children: NativeMatch[] } = { _children: [] };
  constructor(
    readonly parentDom: NativeHolder,
    path: string,
  ) {
    this.file = { extension: "md", path };
  }
  renderContentMatches() {
    this.vChildren._children = [new NativeMatch(this)];
    for (const match of this.vChildren._children) this.parentDom.el.append(match.el);
  }
}
class NativeMatch {
  el = createDiv({ cls: "search-result-file-match" });
  content = "**Target**";
  cache: CachedMetadata = {};
  start = 0;
  end = this.content.length;
  matches: Array<[number, number]> = [[2, 8]];
  showMoreBeforeEl = createDiv({ cls: "search-result-hover-button mod-top" });
  showMoreAfterEl = createDiv({ cls: "search-result-hover-button mod-bottom" });
  constructor(readonly parentDom: NativeResult) {
    this.render();
  }
  render() {
    this.el.empty();
    this.el.createSpan({ text: this.content });
    this.el.append(this.showMoreBeforeEl, this.showMoreAfterEl);
  }
}
function setup(enabled = true) {
  const app = App.createConfigured__();
  const holder = new NativeHolder();
  const result = holder.addResult("Note.md");
  result.renderContentMatches();
  const match = result.vChildren._children[0];
  if (match === undefined) throw new Error("Missing native match");
  vi.spyOn(app.workspace, "iterateAllLeaves").mockImplementation((callback) => {
    callback({ view: { dom: holder } } as unknown as WorkspaceLeaf);
  });
  vi.spyOn(app.workspace, "onLayoutReady").mockImplementation((callback) => {
    callback();
  });
  const plugin = new TestPlugin(app, {
    id: "test",
    name: "test",
    author: "test",
    version: "1",
    minAppVersion: "1",
    description: "test",
  });
  const state = { enabled };
  const setConfig = vi.fn();
  const handle = searchContext.register(plugin.asOriginalType2__(), {
    isEnabled: () => state.enabled,
    getConfig: (_key, fallback) => fallback,
    setConfig,
  });
  handles.push(handle);
  return { app, holder, match, handle, state, setConfig, plugin };
}
function setMatchContent(match: NativeMatch, content: string, cache: CachedMetadata = {}, term = "Target") {
  const offset = content.indexOf(term);
  if (offset < 0) throw new Error("Missing fixture match");
  match.content = content;
  match.cache = cache;
  match.start = content.lastIndexOf("\n", offset) + 1;
  const newline = content.indexOf("\n", offset);
  match.end = newline < 0 ? content.length : newline;
  match.matches = [[offset, offset + term.length]];
  match.render();
}
async function visible() {
  await vi.runOnlyPendingTimersAsync();
  for (const observer of Intersections.instances) observer.send(true);
  await vi.runOnlyPendingTimersAsync();
}
function preview(match: NativeMatch): HTMLElement | null {
  return match.el.querySelector(".micropatches-search-context");
}
function richAncestors(match: NativeMatch) {
  const content = "# **Topic**\n\n- [[Elsewhere#Section|Alias]]\n  - *Parent* detail\n    - Target";
  setMatchContent(match, content, {
    headings: [{ heading: "**Topic**", level: 1, position: position(content, "# **Topic**") }],
    listItems: [
      { parent: -1, position: position(content, "- [[Elsewhere#Section|Alias]]") },
      { parent: 2, position: position(content, "- *Parent* detail") },
      { parent: 3, position: position(content, "- Target") },
    ],
  });
  nativeHtml(
    "- <span>**Topic**</span>\n- <span>[[Elsewhere#Section|Alias]]</span>\n- <span>*Parent* detail</span>",
    '<ul><li><span><strong>Topic</strong></span></li><li><span><a class="internal-link" href="Elsewhere#Section" data-href="Elsewhere#Section">Alias</a></span></li><li><span><em>Parent</em> detail</span></li></ul>',
  );
}

beforeEach(async () => {
  const { sanitizeHTMLToDom: originalSanitize } = await vi.importActual<typeof obsidian>("obsidian");
  vi.useFakeTimers();
  Intersections.instances.length = 0;
  vi.stubGlobal("IntersectionObserver", Intersections);
  htmlFixtures.clear();
  parsedMarkdown.length = 0;
  sanitizedTrees.length = 0;
  parser.mockImplementation(function (this: ParserReceiver) {
    parsedMarkdown.push(this.text);
    const html = htmlFixtures.get(this.text);
    if (html === undefined) throw new Error(`Missing native parser fixture: ${this.text}`);
    this.parseFinish(this.text, { sections: (typeof html === "string" ? [html] : html).map((html) => ({ html })) });
  });
  Object.defineProperty(MarkdownPreviewRenderer.prototype, "parseSync", { configurable: true, value: parser });
  vi.mocked(obsidian.sanitizeHTMLToDom).mockImplementation((html) => {
    const fragment = originalSanitize(html);
    sanitizedTrees.push(Array.from(fragment.querySelectorAll("*")));
    return fragment;
  });
  nativeHtml("**Target**", "<p><strong>Target</strong></p>");
  nativeHtml("Target", "<p>Target</p>");
  nativeHtml("- Target", "<ul><li>Target</li></ul>");
});
afterEach(() => {
  for (const handle of handles.splice(0)) handle.cleanup();
  if (parserDescriptor === undefined) Reflect.deleteProperty(MarkdownPreviewRenderer.prototype, "parseSync");
  else Object.defineProperty(MarkdownPreviewRenderer.prototype, "parseSync", parserDescriptor);
  document.body.empty();
  vi.useRealTimers();
});

// Native worker outputs (Obsidian 1.14.4): parseSync has one HTML section per
// source block and a final synthetic footnotes section, including empty stubs.
const NOTE_REFERENCE =
  '<sup class="footnote-ref" data-footnote-id="fnref-1"><a class="footnote-link" href="#fn-1" data-footref="a">[1]</a></sup>';
function noteSection(text: string) {
  return `<section class="footnotes"><hr><ol>\n<li data-footnote-id="fn-1" data-line="-1">${text}<a class="footnote-backref footnote-link" href="#fnref-1">↩︎</a></li>\n</ol></section>`;
}

describe("document-dependent native parsing", () => {
  it.each(documentContextFixtures())(
    "extracts $name without losing its supporting definitions",
    ({ name, text, cache }) => {
      const value = excerpt(text, cache);
      expect(value).not.toBeNull();
      const inline = [
        "frontmatter properties",
        "invalid YAML without frontmatter metadata",
        "footnote definition exceeding the excerpt line budget",
        "reference definition section without its specific metadata",
      ];
      const footnote = [
        "list inside a footnote definition",
        "footnote definition in a quote",
        "outer footnote containing an earlier inline footnote and a nested list",
      ];
      let kind = "markdown";
      if (inline.includes(name)) kind = "inline";
      if (footnote.includes(name)) kind = "footnote";
      expect(value?.kind).toBe(kind);
      expect(value?.markdown).toContain("Target");
      if (footnote.includes(name)) expect(value).toMatchObject({ footnote: "a", crumbs: [], definitions: "" });
      for (const definition of cache.referenceLinks ?? [])
        expect(value?.definitions).toContain(
          text.slice(definition.position.start.offset, definition.position.end.offset),
        );
      if (name.includes("ancestor")) expect(value?.crumbs).toHaveLength(1);
    },
  );

  it("sorts copied reference metadata and supplies definitions without changing native caches", () => {
    const text = "See [Target][a].\n\n[a]: First.md\n[b]: Last.md";
    const first = { id: "a", link: "First.md", position: position(text, "[a]: First.md") };
    const last = { id: "b", link: "Last.md", position: position(text, "[b]: Last.md") };
    const cache = { referenceLinks: [last, first] };
    expect(excerpt(text, cache)?.definitions).toBe("[a]: First.md\n\n[b]: Last.md\n\n");
    expect(cache.referenceLinks).toEqual([last, first]);
  });

  it("shares a footnote placeholder between references without including unrelated definition bodies", () => {
    const text = "Target [^a] [^a]\n\n[^a]: Secret definition\n\n^[inline]";
    const cache: CachedMetadata = {
      footnotes: [
        { id: "a", position: position(text, "[^a]: Secret definition") },
        { id: "[inline0", position: position(text, "inline") },
      ],
      footnoteRefs: [{ id: "a", position: position(text, "[^a]") }],
    };
    expect(excerpt(text, cache)?.definitions).toBe("[^a]: \u200b\n\n");
  });

  it("bounds supporting definitions even when the visible snippet is small", () => {
    const definition = `[ref]: ${"x".repeat(4000)}`;
    const text = `Target\n\n${definition}`;
    expect(
      excerpt(text, { referenceLinks: [{ id: "ref", link: "x", position: position(text, definition) }] }),
    ).toBeNull();
  });
});

describe("native preview sanitizer", () => {
  it("uses native sections and sanitizer without constructing a renderer or invoking postprocessors", () => {
    const render = vi.spyOn(MarkdownRenderer, "render");
    const construct = vi.spyOn(MarkdownPreviewRenderer.prototype, "constructor__");
    nativeHtml("blocks", ["<h2>Title</h2>", "<p><strong>Bold</strong> and <code>$= dv.current()</code></p>"]);
    const el = createDiv();
    expect(renderPreview(el, "blocks")).toBe(true);
    expect(el.querySelector("h2")?.getAttribute("dir")).toBe("auto");
    expect(el.querySelector("strong")?.textContent).toBe("Bold");
    expect(el.querySelector("code")?.textContent).toBe("$= dv.current()");
    expect(parser).toHaveBeenCalledOnce();
    expect(obsidian.sanitizeHTMLToDom).toHaveBeenCalledOnce();
    expect(render).not.toHaveBeenCalled();
    expect(construct).not.toHaveBeenCalled();
  });

  it.each([
    null,
    {},
    { sections: "wrong" },
    { sections: [null] },
    { sections: [{ html: 7 }] },
    { sections: Array.from({ length: 513 }, () => ({ html: "" })) },
    { sections: [{ html: "x".repeat(128001) }] },
  ])("rejects an incompatible native parse result before touching the caller DOM", (result) => {
    parser.mockImplementationOnce(function (this: ParserReceiver) {
      this.parseFinish(this.text, result);
    });
    const el = createDiv();
    const original = el.createSpan({ text: "Original" });
    expect(renderPreview(el, "Target")).toBe(false);
    expect(Array.from(el.childNodes)).toEqual([original]);
    expect(obsidian.sanitizeHTMLToDom).not.toHaveBeenCalled();
  });

  it("does not parse oversized source or depend on asynchronous parse completion", () => {
    const el = createDiv();
    expect(renderPreview(el, "x".repeat(64001))).toBe(false);
    expect(parser).not.toHaveBeenCalled();
    parser.mockImplementationOnce(() => undefined);
    expect(renderPreview(el, "Target")).toBe(false);
    Reflect.deleteProperty(MarkdownPreviewRenderer.prototype, "parseSync");
    expect(renderPreview(el, "Target")).toBe(false);
    expect(obsidian.sanitizeHTMLToDom).not.toHaveBeenCalled();
  });

  it("removes resource-bearing markup in the inert template before calling the live sanitizer", () => {
    nativeHtml(
      "media",
      '<p><span class="internal-embed" src="Other#Part" alt="Note alias"></span><img src="https://remote.test/a.png" alt="Picture"><audio src="sound.mp3"></audio><video src="movie.mp4"></video><iframe src="https://remote.test/frame"></iframe><object data="object.pdf"></object><embed src="embed.pdf"><picture><source srcset="https://remote.test/b.png"><img src="last.png"></picture></p>',
    );
    const el = createDiv();
    expect(renderPreview(el, "media")).toBe(true);
    const passed = vi.mocked(obsidian.sanitizeHTMLToDom).mock.calls[0]?.[0];
    expect(passed).not.toMatch(/<(?:img|audio|video|iframe|object|embed|picture|source)\b|\bsrc(?:set)?=/u);
    expect(el.querySelectorAll("a")).toHaveLength(8);
    expect(el.querySelector(".internal-link")?.getAttribute("data-href")).toBe("Other#Part");
    expect(el.querySelector(".internal-link")?.textContent).toBe("Note alias");
    expect(el.querySelector("a[href='https://remote.test/a.png']")?.textContent).toBe("Picture");
  });

  it("keeps forbidden nodes and attributes out of the sanitizer and escapes a closing template", () => {
    nativeHtml(
      "unsafe",
      '</template><script>execute()</script><style>body{display:none}</style><link href="remote.css"><meta http-equiv="refresh" content="0"><base href="https://evil.test"><svg><image href="remote.png"></image></svg><math><mi>hidden</mi></math><details><p onclick="execute()" style="background:url(remote.png)" id="foreign">Safe <strong>format</strong></p></details><input type="text" value="private"><input type="checkbox" checked oninput="execute()"><a href="javascript:execute()">Bad URL</a>',
    );
    const el = createDiv();
    expect(renderPreview(el, "unsafe")).toBe(true);
    const passed = vi.mocked(obsidian.sanitizeHTMLToDom).mock.calls[0]?.[0];
    expect(passed).not.toMatch(/<(?:script|style|link|meta|base|svg|math|details)\b|\s(?:onclick|oninput|style|id)=/u);
    expect(el.querySelector("strong")?.textContent).toBe("format");
    expect(el.querySelectorAll("input")).toHaveLength(1);
    expect(el.querySelector("input")?.disabled).toBe(true);
    expect(el.querySelector("input")?.checked).toBe(true);
    expect(el.querySelector("a")?.getAttribute("href")).toBeNull();
    expect(el.textContent).not.toContain("execute()");
  });

  it.each([
    ["Other%20Note.md#Heading", "Other Note.md#Heading"],
    ["../Other%20Note.md", "../Other Note.md"],
    ["./Cafe%CC%81.md", "./Café.md"],
    ["Other%C2%A0Note.md", "Other Note.md"],
  ])("normalizes native relative links %s without changing their visible alias", (href, expected) => {
    nativeHtml("relative", `<p><a class="external-link" href="${href}">Alias</a></p>`);
    const el = createDiv();
    expect(renderPreview(el, "relative")).toBe(true);
    const link = el.querySelector("a");
    expect(link?.getAttribute("data-href")).toBe(expected);
    expect(link?.className).toBe("internal-link");
    expect(link?.textContent).toBe("Alias");
    expect(link?.getAttribute("target")).toBe("_blank");
    expect(link?.getAttribute("rel")).toBe("noopener nofollow");
  });

  it("preserves existing wiki destinations, external URLs, tags and local footnote anchors", () => {
    nativeHtml(
      "links",
      '<a class="internal-link" href="Literal%20Name" data-href="Literal%20Name">Wiki</a><a class="external-link" href="https://remote.test">Web</a><a href="//remote.test">Protocol relative</a><a class="tag" href="#tag">#tag</a><a class="footnote-link" href="#fn-1" data-footref="[inline0">[1]</a><a href="Bad%Name">Malformed</a><a href="Empty.md"></a>',
    );
    const el = createDiv();
    expect(renderPreview(el, "links")).toBe(true);
    const links = Array.from(el.querySelectorAll("a"));
    expect(links[0]?.getAttribute("data-href")).toBe("Literal%20Name");
    expect(links[1]?.classList.contains("internal-link")).toBe(false);
    expect(links[2]?.classList.contains("internal-link")).toBe(false);
    expect(links[3]?.getAttribute("data-href")).toBeNull();
    expect(links[4]?.getAttribute("data-href")).toBeNull();
    expect(links[5]?.getAttribute("data-href")).toBeNull();
    expect(links[6]?.textContent).toBe("Empty.md");
  });
});

describe("rendered search content", () => {
  it("keeps visible aliases when a search matches a hidden destination", async () => {
    const { match } = setup();
    const text = "[Alias](https://example.test/Target%20Note)";
    setMatchContent(match, text);
    nativeHtml(text, '<p><a class="external-link" href="https://example.test/Target%20Note">Alias</a></p>');
    await visible();
    expect(preview(match)?.textContent).toBe("Alias");
    expect(highlights(match.el)).toEqual(["Alias"]);
    expect(match.el.querySelector(".micropatches-search-context-source")).toBeNull();
  });

  it("matches decoded destinations and preserves the caller's alias alternatives", () => {
    const el = createDiv();
    el.createEl("a", { href: "https://example.test/Target%20Note", text: "Alias" });
    const terms = [["Target Note"]];
    expect(highlightExcerpt(el, terms)).toBe(true);
    expect(highlights(el)).toEqual(["Alias"]);
    expect(terms).toEqual([["Target Note"]]);
  });

  it("keeps a literal matched token when native parsing hides Markdown syntax", async () => {
    const { match } = setup();
    setMatchContent(match, "**Target**", {}, "**");
    await visible();
    expect(preview(match)?.querySelector("strong")?.textContent).toBe("Target");
    expect(preview(match)?.querySelector(".micropatches-search-context-source")?.textContent).toBe("**");
    expect(highlights(match.el)).toEqual(["**"]);
  });

  it("renders paragraph formatting, links and inline code without executing a processor", async () => {
    const { match } = setup();
    const render = vi.spyOn(MarkdownRenderer, "render");
    const text = "**Target** `$= dv.current()` [[Other|Alias]]";
    setMatchContent(match, text);
    nativeHtml(
      text,
      '<p><strong>Target</strong> <code>$= dv.current()</code> <a class="internal-link" href="Other" data-href="Other">Alias</a></p>',
    );
    await visible();
    expect(preview(match)?.querySelector("code")?.textContent).toBe("$= dv.current()");
    expect(preview(match)?.querySelector("a")?.textContent).toBe("Alias");
    expect(highlights(match.el)).toEqual(["Target"]);
    expect(render).not.toHaveBeenCalled();
  });

  it("renders a matched code section literally without invoking the native parser", async () => {
    const { match } = setup();
    const text = "```query\n**Target** [[Literal]] <img src=remote.png>\n```";
    setMatchContent(match, text, { sections: [{ type: "code", position: position(text, text) }] });
    await visible();
    expect(preview(match)?.querySelector("pre > code")?.textContent).toBe(
      "**Target** [[Literal]] <img src=remote.png>",
    );
    expect(preview(match)?.querySelector("a, img, strong")).toBeNull();
    expect(parser).not.toHaveBeenCalled();
    expect(highlights(match.el)).toEqual(["Target"]);
  });

  it("renders invalid YAML inline without turning YAML delimiters into Markdown blocks", async () => {
    const { match } = setup();
    const text = '---\nbroken: [\nTarget: <img src="remote.png">\n---';
    setMatchContent(match, text, { sections: [{ type: "yaml", position: position(text, text) }] });
    nativeHtml(
      "<span>Target: &#60;img src=&#34;remote.png&#34;&#62;</span>",
      '<span>Target: &lt;img src="remote.png"&gt;</span>',
    );
    await visible();
    expect(parsedMarkdown).toEqual(["<span>Target: &#60;img src=&#34;remote.png&#34;&#62;</span>"]);
    expect(preview(match)?.textContent).toBe('Target: <img src="remote.png">');
    expect(preview(match)?.querySelector("img, hr, h2")).toBeNull();
  });

  it("keeps an expanded YAML fragment inline and preserves its line boundaries", async () => {
    const { match } = setup();
    const text = "---\ntitle: Note\n---\n\nTarget";
    setMatchContent(match, text, { frontmatterPosition: position(text, "---\ntitle: Note\n---") });
    match.start = 0;
    nativeHtml(
      "<span>---<br>title: Note<br>---<br><br>Target</span>",
      "<span>---<br>title: Note<br>---<br><br>Target</span>",
    );
    await visible();
    expect(preview(match)?.querySelectorAll("br")).toHaveLength(4);
    expect(preview(match)?.querySelector("hr, h2")).toBeNull();
  });

  it("resolves reference links using complete source definitions while keeping their aliases", async () => {
    const { app, match } = setup();
    const text = "See [Target alias][ref].\n\n[ref]: Other%20Note.md#Section";
    setMatchContent(match, text, {
      referenceLinks: [
        { id: "ref", link: "Other%20Note.md#Section", position: position(text, "[ref]: Other%20Note.md#Section") },
      ],
    });
    nativeHtml(
      "[ref]: Other%20Note.md#Section\n\nSee [Target alias][ref].",
      '<p>See <a class="external-link" href="Other%20Note.md#Section">Target alias</a>.</p>',
    );
    const open = vi.spyOn(app.workspace, "openLinkText").mockResolvedValue(undefined);
    await visible();
    const link = preview(match)?.querySelector("a");
    expect(link?.textContent).toBe("Target alias");
    expect(link?.getAttribute("data-href")).toBe("Other Note.md#Section");
    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(open).toHaveBeenCalledWith("Other Note.md#Section", "Note.md", false);
  });

  it("turns a named footnote reference into a source link and removes its synthetic placeholder", async () => {
    const { app, match } = setup();
    const text = "Target [^a]\n\n[^a]: Full definition outside the snippet";
    setMatchContent(match, text, {
      footnoteRefs: [{ id: "a", position: position(text, "[^a]") }],
      footnotes: [{ id: "a", position: position(text, "[^a]: Full definition outside the snippet") }],
    });
    nativeHtml("[^a]: \u200b\n\nTarget [^a]", [`<p>Target ${NOTE_REFERENCE}</p>`, noteSection("\u200b")]);
    const open = vi.spyOn(app.workspace, "openLinkText").mockResolvedValue(undefined);
    await visible();
    const link = preview(match)?.querySelector("a");
    expect(link?.textContent).toBe("[^a]");
    expect(link?.className).toBe("internal-link");
    expect(preview(match)?.querySelector(".footnotes")).toBeNull();
    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(open).toHaveBeenCalledWith("#[^a]", "Note.md", false);
  });

  it.each([false, true])(
    "lifts a matched named footnote body out of its native section (quoted=%s)",
    async (quoted) => {
      const { match } = setup();
      const raw = "[^a]: **Target** [[Other|Alias]]";
      const text = quoted ? `> ${raw}` : raw;
      setMatchContent(match, text, {
        footnotes: [{ id: "a", position: position(text, raw) }],
        sections: [{ type: quoted ? "blockquote" : "footnoteDefinition", position: position(text, text) }],
      });
      nativeHtml(`[^a]\n\n${text}`, [
        `<p>${NOTE_REFERENCE}</p>`,
        noteSection('<strong>Target</strong> <a class="internal-link" href="Other" data-href="Other">Alias</a>'),
      ]);
      await visible();
      const body = preview(match)?.querySelector(".micropatches-search-context-body");
      expect(body?.firstElementChild?.textContent).toBe("[^a]");
      expect(body?.querySelector("strong")?.textContent).toBe("Target");
      expect(body?.querySelector("a[data-href='Other']")?.textContent).toBe("Alias");
      expect(body?.querySelector(".footnotes, .footnote-backref")).toBeNull();
      expect(highlights(match.el)).toEqual(["Target"]);
    },
  );

  it("keeps inline footnotes local and scrolls to their own native target", async () => {
    const { app, match } = setup();
    const text = "Before ^[Inline Target [[Other|Alias]]] after.";
    setMatchContent(match, text, {
      footnotes: [{ id: "[inline0", position: position(text, "Inline Target [[Other|Alias]]") }],
    });
    nativeHtml(text, [
      '<p>Before <sup class="footnote-ref" data-footnote-id="fnref-1"><a class="footnote-link" href="#fn-1" data-footref="[inline0">[1]</a></sup> after.</p>',
      noteSection('Inline Target <a class="internal-link" href="Other" data-href="Other">Alias</a>'),
    ]);
    const open = vi.spyOn(app.workspace, "openLinkText").mockResolvedValue(undefined);
    await visible();
    const note = preview(match)?.querySelector<HTMLElement>("li[data-footnote-id='fn-1']");
    if (note === null || note === undefined) throw new Error("Missing native inline footnote");
    const scroll = vi.fn();
    note.scrollIntoView = scroll;
    preview(match)
      ?.querySelector("a[data-footref]")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(scroll).toHaveBeenCalledExactlyOnceWith({ block: "nearest" });
    expect(open).not.toHaveBeenCalled();
    expect(highlights(note)).toEqual(["Target"]);
    expect(note.querySelector("a[data-href='Other']")?.textContent).toBe("Alias");
  });
});

describe("rendered ancestor hierarchy", () => {
  it("retains the sanitized native nodes and container while nesting rich ancestors", async () => {
    const { match, handle } = setup();
    richAncestors(match);
    await visible();
    const host = preview(match);
    const labels = host?.querySelector(".micropatches-search-context-tree");
    const nodes = sanitizedTrees[1] ?? [];
    const list = nodes.find((node) => node.tagName === "UL");
    const items = nodes.filter((node) => node.tagName === "LI");
    expect(parser).toHaveBeenCalledTimes(2);
    expect(host?.firstElementChild).toBe(labels);
    expect(labels?.firstElementChild).toBe(list);
    expect(items).toHaveLength(3);
    expect(items.every((item) => labels?.contains(item) === true)).toBe(true);
    expect(items[1]?.parentElement?.parentElement).toBe(items[0]);
    expect(items[2]?.parentElement?.parentElement).toBe(items[1]);
    expect(host?.querySelector(".micropatches-search-context-body")?.parentElement?.parentElement?.parentElement).toBe(
      items[2],
    );
    expect(items[0]?.querySelector(".micropatches-search-context-location strong")).toBe(
      nodes.find((node) => node.tagName === "STRONG"),
    );
    expect(items[1]?.querySelector("a")?.getAttribute("data-href")).toBe("Elsewhere#Section");
    expect(items[2]?.querySelector(".micropatches-search-context-location em")?.textContent).toBe("Parent");
    const markers = Array.from(host?.querySelectorAll(".micropatches-search-context-marker") ?? []);
    expect(markers.map((marker) => marker.textContent)).toEqual(["H1", "", ""]);
    expect(markers.slice(1).every((marker) => marker.classList.contains("is-bullet"))).toBe(true);
    expect(
      markers.every((marker) => marker.closest("a") === null && marker.getAttribute("aria-hidden") === "true"),
    ).toBe(true);
    expect(host?.querySelectorAll("button, a a")).toHaveLength(0);
    handle.cleanup();
    expect(labels?.isConnected).toBe(false);
  });

  it.each([1, 6, 40])("uses two native parses for an ancestor chain of depth %i", async (depth) => {
    const { match } = setup();
    const lines = Array.from({ length: depth }, (_, i) => `${"  ".repeat(i)}- Ancestor ${i}`);
    lines.push(`${"  ".repeat(depth)}- Target`);
    const text = lines.join("\n");
    setMatchContent(match, text, {
      listItems: lines.map((line, i) => ({ parent: i - 1, position: position(text, line.trimStart()) })),
    });
    const expectedLabels = Array.from(
      { length: Math.min(depth, 12) },
      (_, i) => `Ancestor ${Math.max(0, depth - 12) + i}`,
    );
    const nativeItems = expectedLabels.map((label) => `<li><span>${label}</span></li>`).join("");
    nativeHtml(expectedLabels.map((label) => `- <span>${label}</span>`).join("\n"), `<ul>${nativeItems}</ul>`);
    await visible();
    expect(parser).toHaveBeenCalledTimes(2);
    expect(preview(match)?.querySelectorAll(".micropatches-search-context-ancestor")).toHaveLength(
      expectedLabels.length,
    );
    expect(preview(match)?.querySelector(".micropatches-search-context-match")?.textContent).toBe("Target");
  });

  it.each(["[ ] TODO", "> quoted", "# literal", "1. Introduction", "---"])(
    "preserves block syntax as a literal heading label: %s",
    async (label) => {
      const { match } = setup();
      const text = `# ${label}\nTarget`;
      setMatchContent(match, text, {
        headings: [{ heading: label, level: 1, position: position(text, `# ${label}`) }],
      });
      nativeHtml(`- <span>${label}</span>`, `<ul><li><span>${label}</span></li></ul>`);
      await visible();
      expect(parsedMarkdown).toEqual(["Target", `- <span>${label}</span>`]);
      expect(preview(match)?.querySelector(".micropatches-search-context-location")?.textContent).toBe(label);
      expect(preview(match)?.querySelector("input, blockquote, h1, ol, hr")).toBeNull();
    },
  );

  it("puts H2, H4 and the displayed ordered ordinal outside anchors with accurate accessibility", async () => {
    const { match } = setup();
    const { text, cache } = listFixture(
      "## **Section**",
      "",
      "#### [[Elsewhere|Alias]]",
      "",
      ["3. Earlier", -4],
      ["1. Parent", -4],
      ["   - Target", 5],
    );
    cache.headings = [
      { heading: "**Section**", level: 2, position: position(text, "## **Section**") },
      { heading: "[[Elsewhere|Alias]]", level: 4, position: position(text, "#### [[Elsewhere|Alias]]") },
    ];
    setMatchContent(match, text, cache);
    nativeHtml(
      "- <span>**Section**</span>\n- <span>[[Elsewhere|Alias]]</span>\n- <span>Parent</span>",
      '<ul><li><span><strong>Section</strong></span></li><li><span><a class="internal-link" href="Elsewhere" data-href="Elsewhere">Alias</a></span></li><li><span>Parent</span></li></ul>',
    );
    await visible();
    const host = preview(match);
    const headings = Array.from(host?.querySelectorAll("[role='heading']") ?? []);
    expect(headings.map((label) => label.getAttribute("aria-level"))).toEqual(["2", "4"]);
    const markers = Array.from(host?.querySelectorAll(".micropatches-search-context-marker") ?? []);
    expect(markers.map((marker) => marker.textContent)).toEqual(["H2", "H4", "4."]);
    expect(markers.every((marker) => marker.closest("a") === null)).toBe(true);
    expect(parser).toHaveBeenCalledTimes(2);
  });

  it("keeps ordered source indentation and updates OL.start from 1 to 10 after parsing", async () => {
    const { match } = setup();
    const { text, cache } = listFixture(["9. Earlier", -1], ["1. Target", -1], ["   - Child", 1]);
    setMatchContent(match, text, cache);
    nativeHtml("1. Target\n   - Child", "<ol><li>Target<ul><li>Child</li></ul></li></ol>");
    await visible();
    expect(parsedMarkdown).toEqual(["1. Target\n   - Child"]);
    expect(preview(match)?.querySelector("ol")?.start).toBe(10);
    expect(preview(match)?.querySelector("ol > li > ul > li")?.textContent).toBe("Child");
  });

  it("decorates an actual matched native heading while retaining rich links", async () => {
    const { match } = setup();
    const text = "#### **Target** [[Other|Alias]]";
    setMatchContent(match, text, {
      headings: [{ heading: "**Target** [[Other|Alias]]", level: 4, position: position(text, text) }],
    });
    nativeHtml(
      text,
      '<h4><strong>Target</strong> <a class="internal-link" href="Other" data-href="Other">Alias</a></h4>',
    );
    await visible();
    const heading = preview(match)?.querySelector("h4");
    expect(heading?.querySelector(".micropatches-search-context-marker")?.textContent).toBe("H4");
    expect(heading?.querySelector("strong")).toBe(sanitizedTrees[0]?.find((node) => node.tagName === "STRONG"));
    expect(heading?.querySelector("a")?.textContent).toBe("Alias");
    expect(parser).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "preserves native tight/loose task structure and checkbox identity (loose=%s)",
    async (loose) => {
      const { match } = setup();
      const text = "- [x] Target with enough text to wrap\n  - [ ] Child";
      setMatchContent(match, text, {
        listItems: [
          { parent: -1, position: position(text, "- [x] Target with enough text to wrap") },
          { parent: 0, position: position(text, "- [ ] Child") },
        ],
      });
      const label = '<input class="task-list-item-checkbox" type="checkbox" checked> Target with enough text to wrap';
      const nativeLabel = loose ? `<p>${label}</p>` : label;
      nativeHtml(
        text,
        `<ul class="contains-task-list"><li class="task-list-item is-checked" data-task="x">${nativeLabel}<ul class="contains-task-list"><li class="task-list-item" data-task=" "><input class="task-list-item-checkbox" type="checkbox"> Child</li></ul></li></ul>`,
      );
      await visible();
      const host = preview(match);
      const inputs = Array.from(host?.querySelectorAll("input") ?? []);
      expect(inputs).toEqual(sanitizedTrees[0]?.filter((node) => node.tagName === "INPUT"));
      expect(inputs.map((input) => input.checked)).toEqual([true, false]);
      expect(inputs.every((input) => input.disabled)).toBe(true);
      expect(inputs[0]?.parentElement?.tagName).toBe(loose ? "P" : "LI");
      expect(inputs[1]?.closest("ul")?.parentElement?.tagName).toBe("LI");
      expect(host?.querySelector("li > ul > li")?.textContent).toBe(" Child");
      const before = inputs[0]?.checked;
      inputs[0]?.click();
      expect(inputs[0]?.checked).toBe(before);
    },
  );

  it("routes aliases to their destination and plain ancestor labels to exact source lines", async () => {
    const { app, match } = setup();
    richAncestors(match);
    const open = vi.spyOn(app.workspace, "openLinkText").mockResolvedValue(undefined);
    const leaf = app.workspace.getLeaf();
    const openFile = vi.spyOn(leaf, "openFile").mockResolvedValue(undefined);
    vi.spyOn(app.workspace, "getLeaf").mockReturnValue(leaf);
    await visible();
    preview(match)
      ?.querySelector("a[data-href='Elsewhere#Section']")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    preview(match)
      ?.querySelector("a[data-context-line='3']")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(open).toHaveBeenCalledExactlyOnceWith("Elsewhere#Section", "Note.md", false);
    expect(openFile).toHaveBeenCalledExactlyOnceWith(match.parentDom.file, { eState: { line: 3 } });
  });

  it.each([
    "<p>Topic</p>",
    "<ul><li>One</li><li>Extra</li></ul>",
    "<ul><div>Wrong child</div></ul>",
    "<ul><li>Topic</li></ul><section class='footnotes'><ol><li>Inline note</li></ol></section>",
  ])("keeps the body if the optional native ancestor output is incompatible: %s", async (html) => {
    const { match } = setup();
    const text = "# Topic\nTarget";
    setMatchContent(match, text, { headings: [{ heading: "Topic", level: 1, position: position(text, "# Topic") }] });
    nativeHtml("- <span>Topic</span>", html);
    await visible();
    expect(preview(match)?.querySelector(".micropatches-search-context-body")?.textContent).toBe("Target");
    expect(preview(match)?.querySelector(".micropatches-search-context-tree")).toBeNull();
    expect(highlights(match.el)).toEqual(["Target"]);
  });
});

describe("native search lifecycle", () => {
  it("does nothing while disabled and installs when toggled on", async () => {
    const { state, handle } = setup(false);
    await visible();
    expect(parser).not.toHaveBeenCalled();
    expect(Intersections.instances).toHaveLength(0);
    state.enabled = true;
    handle.onToggle?.(true);
    await visible();
    expect(parser).toHaveBeenCalledOnce();
  });

  it("renders only intersecting matches, keeps native controls and does not persist state", async () => {
    const { match, setConfig } = setup();
    const click = vi.fn();
    match.showMoreAfterEl.addEventListener("click", click);
    await vi.runOnlyPendingTimersAsync();
    expect(parser).not.toHaveBeenCalled();
    await visible();
    expect(preview(match)).not.toBeNull();
    expect(match.showMoreBeforeEl.parentElement).toBe(match.el);
    expect(match.showMoreAfterEl.parentElement).toBe(match.el);
    match.showMoreAfterEl.click();
    expect(click).toHaveBeenCalledOnce();
    expect(setConfig).not.toHaveBeenCalled();
    expect(Intersections.instances.every((observer) => observer.options?.rootMargin === "300px 0px")).toBe(true);
  });

  it("keeps a completed preview stable through repeated intersection and same-tick reinsertion", async () => {
    const { holder, match } = setup();
    const component = vi.spyOn(Component.prototype, "constructor__");
    match.el.setCssProps({ height: "160px" });
    await visible();
    const host = preview(match);
    for (let cycle = 0; cycle < 3; cycle++) {
      for (const observer of Intersections.instances) {
        observer.send(false);
        observer.send(false);
        observer.send(true);
        observer.send(true);
      }
      await vi.runOnlyPendingTimersAsync();
      expect(preview(match)).toBe(host);
    }
    match.el.remove();
    holder.el.append(match.el);
    await vi.runOnlyPendingTimersAsync();
    expect(preview(match)).toBe(host);
    expect(parser).toHaveBeenCalledOnce();
    expect(component).not.toHaveBeenCalled();
    expect(holder.infinityScroll.invalidate).toHaveBeenCalledExactlyOnceWith(match);
    expect(match.el.style.height).toBe("160px");
    expect(match.el.style.getPropertyValue("--micropatches-search-context-height")).toBe("160px");
    expect(match.el.classList.contains("micropatches-search-context-placeholder")).toBe(false);
    expect(Intersections.instances.flatMap((observer) => Array.from(observer.targets))).toEqual([match.el]);
  });

  it("reserves measured height across detach/reinsert and cleans parked rows without erasing foreign styles", async () => {
    const originalMeasure: unknown = Reflect.get(NativeInfinityScroll.prototype, "measure");
    const { holder, match, handle } = setup();
    const originals = Array.from(match.el.childNodes);
    match.el.setCssProps({ height: "160px", width: "320px" });
    await visible();
    expect(Reflect.get(NativeInfinityScroll.prototype, "measure")).not.toBe(originalMeasure);
    match.el.setCssProps({ height: "240px" });
    expect(holder.infinityScroll.measure(match.parentDom, match)).toBe(137);
    expect(holder.infinityScroll.measured).toHaveBeenCalledExactlyOnceWith(match.parentDom, match);
    expect(match.el.style.getPropertyValue("--micropatches-search-context-height")).toBe("240px");

    match.el.remove();
    await vi.runOnlyPendingTimersAsync();
    expect(Array.from(match.el.childNodes)).toEqual(originals);
    expect(match.el.classList.contains("micropatches-search-context-placeholder")).toBe(true);
    expect(holder.infinityScroll.invalidate).toHaveBeenCalledOnce();
    expect(Intersections.instances.every((observer) => observer.targets.size === 0)).toBe(true);
    holder.el.append(match.el);
    await Promise.resolve();
    for (const observer of Intersections.instances) observer.send(true);
    expect(match.el.classList.contains("micropatches-search-context-placeholder")).toBe(true);
    expect(parser).toHaveBeenCalledOnce();
    await vi.runOnlyPendingTimersAsync();
    expect(parser).toHaveBeenCalledTimes(2);
    expect(preview(match)).not.toBeNull();
    expect(match.el.classList.contains("micropatches-search-context-placeholder")).toBe(false);
    expect(holder.infinityScroll.invalidate).toHaveBeenCalledTimes(2);

    match.el.remove();
    await vi.runOnlyPendingTimersAsync();
    handle.cleanup();
    expect(match.el.classList.contains("micropatches-search-context-placeholder")).toBe(false);
    expect(match.el.style.getPropertyValue("--micropatches-search-context-height")).toBe("");
    expect(match.el.style.height).toBe("240px");
    expect(match.el.style.width).toBe("320px");
    expect(holder.infinityScroll.invalidate).toHaveBeenCalledTimes(3);
    expect(Reflect.get(NativeInfinityScroll.prototype, "measure")).toBe(originalMeasure);
  });

  it("releases a hidden pane's preview and keeps its size until the pane becomes visible", async () => {
    const { holder, match } = setup();
    const originals = Array.from(match.el.childNodes);
    match.el.setCssProps({ height: "180px" });
    await visible();
    Object.defineProperty(holder.el, "offsetParent", { value: null });
    for (const observer of Intersections.instances) observer.send(false);
    expect(Array.from(match.el.childNodes)).toEqual(originals);
    expect(match.el.classList.contains("micropatches-search-context-placeholder")).toBe(true);
    expect(match.el.style.getPropertyValue("--micropatches-search-context-height")).toBe("180px");
    expect(holder.infinityScroll.invalidate).toHaveBeenCalledOnce();
    for (const observer of Intersections.instances) observer.send(false);
    expect(parser).toHaveBeenCalledOnce();
    Object.defineProperty(holder.el, "offsetParent", { value: document.body });
    await visible();
    expect(parser).toHaveBeenCalledTimes(2);
    expect(preview(match)).not.toBeNull();
    expect(match.el.classList.contains("micropatches-search-context-placeholder")).toBe(false);
    expect(holder.infinityScroll.invalidate).toHaveBeenCalledTimes(2);
  });

  it.each(["intersection", "layout change"])(
    "releases already-offscreen rows when a hidden pane is detected by %s",
    async (trigger) => {
      const { app, holder, match } = setup();
      const other = holder.addResult("Other.md");
      other.renderContentMatches();
      const second = other.vChildren._children[0];
      if (second === undefined) throw new Error("Missing second row");
      const originals = [Array.from(match.el.childNodes), Array.from(second.el.childNodes)];
      match.el.setCssProps({ height: "160px" });
      second.el.setCssProps({ height: "200px" });
      await visible();
      await vi.runOnlyPendingTimersAsync();
      expect(parser).toHaveBeenCalledTimes(2);
      const observer = Intersections.instances[0];
      if (observer === undefined) throw new Error("Missing observer");
      observer.send(false, [match.el]);
      expect(preview(match)).not.toBeNull();
      Object.defineProperty(holder.el, "offsetParent", { value: null });
      if (trigger === "intersection") observer.send(false, [second.el]);
      else app.workspace.trigger("layout-change");
      await vi.runOnlyPendingTimersAsync();
      expect(Array.from(match.el.childNodes)).toEqual(originals[0]);
      expect(Array.from(second.el.childNodes)).toEqual(originals[1]);
      expect([match, second].every((row) => row.el.classList.contains("micropatches-search-context-placeholder"))).toBe(
        true,
      );
      expect(holder.infinityScroll.invalidate).toHaveBeenCalledTimes(2);
      expect(parser).toHaveBeenCalledTimes(2);
    },
  );

  it("clears reserved height before a real native row render", async () => {
    const { match } = setup();
    match.el.setCssProps({ height: "160px" });
    await visible();
    match.el.remove();
    await vi.runOnlyPendingTimersAsync();
    expect(match.el.classList.contains("micropatches-search-context-placeholder")).toBe(true);
    match.render();
    expect(match.el.classList.contains("micropatches-search-context-placeholder")).toBe(false);
    expect(match.el.style.getPropertyValue("--micropatches-search-context-height")).toBe("");
    expect(match.el.style.height).toBe("160px");
    expect(parser).toHaveBeenCalledOnce();
  });

  it.each(["metadata limit", "parser incompatibility"])(
    "clears reserved height when reentry falls back due to %s",
    async (reason) => {
      const { holder, match } = setup();
      const originals = Array.from(match.el.childNodes);
      match.el.setCssProps({ height: "160px" });
      await visible();
      match.el.remove();
      await vi.runOnlyPendingTimersAsync();
      if (reason === "metadata limit")
        match.cache = {
          headings: Array.from({ length: 20001 }, () => ({
            heading: "Title",
            level: 1,
            position: position("**Target**", "Target"),
          })),
        };
      else
        parser.mockImplementationOnce(function (this: ParserReceiver) {
          this.parseFinish(this.text, {});
        });
      holder.el.append(match.el);
      await visible();
      expect(Array.from(match.el.childNodes)).toEqual(originals);
      expect(preview(match)).toBeNull();
      expect(match.el.classList.contains("micropatches-search-context-placeholder")).toBe(false);
      expect(match.el.style.getPropertyValue("--micropatches-search-context-height")).toBe("");
      expect(match.el.style.height).toBe("160px");
      expect(holder.infinityScroll.invalidate).toHaveBeenCalledTimes(2);
    },
  );

  it("recreates previews and click handlers when a collapsed result is expanded repeatedly", async () => {
    const { app, holder, match, handle } = setup();
    const text = "[[Target#Heading]]";
    setMatchContent(match, text);
    nativeHtml(
      text,
      '<p><a class="internal-link" href="Target#Heading" data-href="Target#Heading">Target#Heading</a></p>',
    );
    const group = holder.el.createDiv({ cls: "search-result-file-matches" });
    group.append(match.el);
    const originals = Array.from(match.el.childNodes);
    const open = vi.spyOn(app.workspace, "openLinkText").mockResolvedValue(undefined);
    const native = vi.fn();
    match.el.addEventListener("click", native);
    await visible();
    for (let cycle = 0; cycle < 3; cycle++) {
      group.remove();
      await vi.runOnlyPendingTimersAsync();
      expect(Array.from(match.el.childNodes)).toEqual(originals);
      holder.el.append(group);
      await visible();
      expect(parser).toHaveBeenCalledTimes(cycle + 2);
      expect(match.el.querySelectorAll(".micropatches-search-context")).toHaveLength(1);
      expect(match.showMoreAfterEl.parentElement).toBe(match.el);
      preview(match)
        ?.querySelector("a")
        ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
      expect(open).toHaveBeenCalledTimes(cycle + 1);
      expect(open).toHaveBeenLastCalledWith("Target#Heading", "Note.md", false);
      expect(native).not.toHaveBeenCalled();
    }
    handle.cleanup();
    expect(Array.from(match.el.childNodes)).toEqual(originals);
  });

  it("processes one visible row per timer tick and removes offscreen queued rows", async () => {
    const { holder, match } = setup();
    const others = [holder.addResult("Second.md"), holder.addResult("Third.md")];
    for (const result of others) result.renderContentMatches();
    const second = others[0]?.vChildren._children[0];
    const third = others[1]?.vChildren._children[0];
    if (second === undefined || third === undefined) throw new Error("Missing queued rows");
    await vi.runOnlyPendingTimersAsync();
    const observer = Intersections.instances[0];
    if (observer === undefined) throw new Error("Missing observer");
    observer.send(true);
    await vi.advanceTimersToNextTimerAsync();
    expect(parser).toHaveBeenCalledOnce();
    expect(preview(match)).not.toBeNull();
    expect(preview(second)).toBeNull();
    observer.send(false, [second.el]);
    await vi.advanceTimersToNextTimerAsync();
    expect(parser).toHaveBeenCalledTimes(2);
    expect(preview(second)).toBeNull();
    expect(preview(third)).not.toBeNull();
    await vi.runAllTimersAsync();
    expect(parser).toHaveBeenCalledTimes(2);
  });

  it("drops a queued row on unload before it invokes the parser", async () => {
    const { match, handle } = setup();
    const originals = Array.from(match.el.childNodes);
    await vi.runOnlyPendingTimersAsync();
    for (const observer of Intersections.instances) observer.send(true);
    handle.cleanup();
    await vi.runAllTimersAsync();
    expect(parser).not.toHaveBeenCalled();
    expect(Array.from(match.el.childNodes)).toEqual(originals);
    expect(Intersections.instances.every((observer) => observer.targets.size === 0)).toBe(true);
  });

  it("keeps native text if parseSync throws and continues to the next queued row", async () => {
    const { holder, match } = setup();
    const originals = Array.from(match.el.childNodes);
    const other = holder.addResult("Other.md");
    other.renderContentMatches();
    parser.mockImplementationOnce(() => {
      throw new Error("Native parser unavailable");
    });
    await visible();
    await vi.runOnlyPendingTimersAsync();
    expect(Array.from(match.el.childNodes)).toEqual(originals);
    expect(other.vChildren._children[0]?.el.querySelector(".micropatches-search-context")).not.toBeNull();
    expect(parser).toHaveBeenCalledTimes(2);
  });

  it("uses the newest native fragment and also observes future results", async () => {
    const { holder, match } = setup();
    await visible();
    nativeHtml("Updated Target", "<p>Updated <em>Target</em></p>");
    setMatchContent(match, "Updated Target");
    await vi.runOnlyPendingTimersAsync();
    expect(preview(match)?.textContent).toBe("Updated Target");
    const other = holder.addResult("New.md");
    other.renderContentMatches();
    await visible();
    expect(other.vChildren._children[0]?.el.querySelector(".micropatches-search-context")).not.toBeNull();
    expect(parser).toHaveBeenCalledTimes(3);
  });

  it("restores native prototype hooks, DOM and listeners on disable and can enable again", async () => {
    const originals = [
      Reflect.get(NativeHolder.prototype, "addResult") as unknown,
      Reflect.get(NativeResult.prototype, "renderContentMatches") as unknown,
      Reflect.get(NativeMatch.prototype, "render") as unknown,
      Reflect.get(NativeInfinityScroll.prototype, "measure") as unknown,
    ];
    const { match, state, handle } = setup();
    const nodes = Array.from(match.el.childNodes);
    const click = vi.fn();
    match.showMoreAfterEl.addEventListener("click", click);
    await visible();
    state.enabled = false;
    handle.onToggle?.(false);
    expect(Array.from(match.el.childNodes)).toEqual(nodes);
    expect([
      Reflect.get(NativeHolder.prototype, "addResult") as unknown,
      Reflect.get(NativeResult.prototype, "renderContentMatches") as unknown,
      Reflect.get(NativeMatch.prototype, "render") as unknown,
      Reflect.get(NativeInfinityScroll.prototype, "measure") as unknown,
    ]).toEqual(originals);
    match.showMoreAfterEl.click();
    expect(click).toHaveBeenCalledOnce();
    state.enabled = true;
    handle.onToggle?.(true);
    await visible();
    expect(parser).toHaveBeenCalledTimes(2);
    expect(preview(match)).not.toBeNull();
  });

  it("does not rescan all known results on ordinary workspace events", async () => {
    const { app, holder } = setup();
    const values = vi.spyOn(holder.resultDomLookup, "values");
    await visible();
    expect(values).toHaveBeenCalledOnce();
    for (let i = 0; i < 10; i++) app.workspace.trigger("active-leaf-change", null);
    await vi.runOnlyPendingTimersAsync();
    expect(values).toHaveBeenCalledOnce();
  });

  it.each(["previewMode", "editMode"])(
    "discovers existing queries in %s and releases them with their native owner",
    async (mode) => {
      const { app, holder, match } = setup();
      document.body.createDiv({ cls: "internal-query" }).append(holder.el);
      const owner = Object.assign(new Component(), { dom: holder, containerEl: holder.el });
      owner.load();
      vi.spyOn(app.workspace, "iterateAllLeaves").mockImplementation((callback) => {
        callback({ view: { [mode]: { _children: [owner] } } } as unknown as WorkspaceLeaf);
      });
      await visible();
      expect(parser).toHaveBeenCalledOnce();
      expect(owner._children).toHaveLength(1);
      owner.unload();
      expect(preview(match)).toBeNull();
      expect(Intersections.instances.every((observer) => observer.targets.size === 0)).toBe(true);
    },
  );

  it("releases a search leaf through its native Component owner", async () => {
    const { app, holder, match } = setup();
    const owner = Object.assign(new Component(), {
      dom: holder,
      previewMode: null,
      editMode: null,
      backlink: null,
      backlinks: null,
    });
    owner.load();
    vi.spyOn(app.workspace, "iterateAllLeaves").mockImplementation((callback) =>
      callback({ view: owner } as unknown as WorkspaceLeaf),
    );
    await visible();
    expect(owner._children).toHaveLength(1);
    owner.unload();
    expect(preview(match)).toBeNull();
    expect(Intersections.instances.every((observer) => observer.targets.size === 0)).toBe(true);
  });

  it("does not create roots for detached foreign holders through shared native prototype hooks", async () => {
    const { app } = setup();
    await visible();
    const foreign = new NativeHolder();
    foreign.el.remove();
    const result = foreign.addResult("Foreign.md");
    result.renderContentMatches();
    await vi.runOnlyPendingTimersAsync();
    expect(Intersections.instances).toHaveLength(1);
    expect(parser).toHaveBeenCalledOnce();
    document.body.createDiv({ cls: "internal-query" }).append(foreign.el);
    const owner = Object.assign(new Component(), { dom: foreign, containerEl: foreign.el });
    owner.load();
    vi.spyOn(app.workspace, "iterateAllLeaves").mockImplementation((callback) =>
      callback({ view: { previewMode: { _children: [owner] } } } as unknown as WorkspaceLeaf),
    );
    app.workspace.trigger("layout-change");
    await visible();
    expect(Intersections.instances).toHaveLength(2);
    expect(parser).toHaveBeenCalledTimes(2);
    expect(result.vChildren._children[0]?.el.querySelector(".micropatches-search-context")).not.toBeNull();
    owner.unload();
  });

  it("only queues query discovery in its postprocessor, without adding another render child", async () => {
    const register = vi.spyOn(TestPlugin.prototype, "registerMarkdownPostProcessor");
    const { app } = setup();
    const iterate = vi.spyOn(app.workspace, "iterateAllLeaves");
    const process = register.mock.calls[0]?.[0];
    if (process === undefined) throw new Error("Missing postprocessor");
    const container = createDiv();
    container.createDiv({ cls: "internal-query" });
    const addChild = vi.fn();
    await process(container, { addChild } as unknown as Parameters<typeof process>[1]);
    await process(container, { addChild } as unknown as Parameters<typeof process>[1]);
    expect(addChild).not.toHaveBeenCalled();
    await vi.runOnlyPendingTimersAsync();
    expect(iterate).toHaveBeenCalledOnce();
    expect(parser).not.toHaveBeenCalled();
  });

  it("releases a disconnected holder on workspace scan", async () => {
    const { app, holder, match } = setup();
    await visible();
    holder.el.remove();
    vi.spyOn(app.workspace, "iterateAllLeaves").mockImplementation(() => undefined);
    app.workspace.trigger("layout-change");
    await vi.runOnlyPendingTimersAsync();
    expect(preview(match)).toBeNull();
    expect(Intersections.instances.every((observer) => observer.targets.size === 0)).toBe(true);
  });

  it("ignores unsupported canvas results even after native hooks are installed", async () => {
    const { holder } = setup();
    await visible();
    const result = holder.addResult("Board.canvas");
    result.file.extension = "canvas";
    result.renderContentMatches();
    await visible();
    expect(parser).toHaveBeenCalledOnce();
  });
});

describe("native search link navigation", () => {
  it("routes internal links and middle clicks without invoking the native row", async () => {
    const { app, match } = setup();
    const text = "[[Target#Heading]]";
    setMatchContent(match, text);
    nativeHtml(text, '<p><a class="internal-link" href="Target#Heading" data-href="Target#Heading">Target</a></p>');
    const open = vi.spyOn(app.workspace, "openLinkText").mockResolvedValue(undefined);
    const native = vi.fn();
    match.el.addEventListener("click", native);
    match.el.addEventListener("auxclick", native);
    await visible();
    const link = preview(match)?.querySelector("a");
    link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    link?.dispatchEvent(new MouseEvent("auxclick", { button: 1, bubbles: true, cancelable: true }));
    expect(open).toHaveBeenCalledTimes(2);
    expect(open.mock.calls[0]?.slice(0, 2)).toEqual(["Target#Heading", "Note.md"]);
    expect(native).not.toHaveBeenCalled();
  });

  it("sends native hover-link data with the source file and search owner", async () => {
    const { app, holder, match } = setup();
    const text = "[[Target|Alias]]";
    setMatchContent(match, text);
    nativeHtml(text, '<p><a class="internal-link" href="Target" data-href="Target">Alias</a></p>');
    const trigger = vi.spyOn(app.workspace, "trigger");
    await visible();
    const link = preview(match)?.querySelector("a");
    const event = new MouseEvent("mouseover", { bubbles: true });
    link?.dispatchEvent(event);
    expect(trigger).toHaveBeenCalledWith(
      "hover-link",
      expect.objectContaining({
        event,
        source: "search",
        hoverParent: holder,
        targetEl: link,
        linktext: "Target",
        sourcePath: "Note.md",
      }),
    );
  });

  it("keeps external link default navigation while stopping native row navigation", async () => {
    const { match } = setup();
    const text = "[Target website](https://example.test)";
    setMatchContent(match, text);
    nativeHtml(text, '<p><a class="external-link" href="https://example.test">Target website</a></p>');
    const native = vi.fn();
    match.el.addEventListener("click", native);
    await visible();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    // This handler runs after the patch's handler, preventing jsdom navigation
    // only after checking the patch preserved the browser's default action.
    preview(match)?.addEventListener("click", (event) => {
      expect(event.defaultPrevented).toBe(false);
      event.preventDefault();
    });
    preview(match)?.querySelector("a")?.dispatchEvent(event);
    expect(native).not.toHaveBeenCalled();
  });

  it("opens a clicked tag through native search", async () => {
    const { app, match } = setup();
    setMatchContent(match, "#Target");
    nativeHtml("#Target", '<p><a class="tag" href="#Target">#Target</a></p>');
    const side = vi.spyOn(app.workspace, "ensureSideLeaf").mockResolvedValue(app.workspace.getLeaf());
    await visible();
    preview(match)
      ?.querySelector("a")
      ?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(side).toHaveBeenCalledWith("search", "left", {
      active: true,
      reveal: true,
      state: { query: "tag:#Target" },
    });
  });
});
