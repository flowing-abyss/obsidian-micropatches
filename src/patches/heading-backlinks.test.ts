import { Text } from "@codemirror/state";
import type { CachedMetadata, HeadingCache, MarkdownPostProcessorContext, PluginManifest, Pos } from "obsidian";
import type * as Mocks from "obsidian-test-mocks/obsidian";
import { App, Plugin } from "obsidian-test-mocks/obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PatchContext } from "../patch";
import {
  buildReferencePreview,
  compareSources,
  documentHeading,
  headingBacklinks,
  headingSignature,
  isHeadingSubpath,
  locateReference,
  markdownHeading,
  normalizedHeading,
  refineApproximatePosition,
  rewriteReferenceHeading,
  sourceReferences,
  withoutClosingHashes,
} from "./heading-backlinks";

// The mock resolves no subpath; resolve "#Heading" against the cached headings as Obsidian does.
vi.mock("obsidian", async (importOriginal) => {
  const obsidian = await importOriginal<typeof Mocks>();
  return {
    ...obsidian,
    resolveSubpath: (cache: CachedMetadata, subpath: string) => {
      const wanted = obsidian.stripHeading(subpath.slice(1));
      const current = cache.headings?.find(({ heading }) => obsidian.stripHeading(heading) === wanted);
      return current === undefined
        ? null
        : { type: "heading", current, next: null, start: current.position.start, end: null };
    },
  };
});

type Source = Parameters<typeof compareSources>[0];
type Reference = Parameters<typeof locateReference>[1];

function source(overrides: Partial<Source>): Source {
  return {
    sourceFilePath: "a.md",
    sourceFileName: "a",
    lineNumber: 0,
    columnNumber: 0,
    startOffset: 0,
    endOffset: 0,
    previewText: "",
    originalText: "",
    originalOrdinal: 0,
    positionIsApproximate: false,
    propertyKey: null,
    ...overrides,
  };
}

function pos(text: string, from: number, to: number): Pos {
  const loc = (offset: number) => {
    const lineStart = text.lastIndexOf("\n", offset - 1) + 1;
    return { line: text.slice(0, lineStart).split("\n").length - 1, col: offset - lineStart, offset };
  };
  return { start: loc(from), end: loc(to) };
}

function reference(text: string, original: string, from: number, overrides: Partial<Reference> = {}): Reference {
  return {
    link: "a#H",
    original,
    position: pos(text, from, from + original.length),
    originalOrdinal: 0,
    positionIsApproximate: false,
    propertyKey: null,
    ...overrides,
  };
}

function heading(text: string, level: number, line: number): HeadingCache {
  return { heading: text, level, position: { start: { line, col: 0, offset: 0 }, end: { line, col: 0, offset: 0 } } };
}

const frontmatterNote = '---\nup: "[[a#H]]"\nrel: "[[a#H]]"\n---\nBody [[a#H]] and ![[a#H]]';
const frontmatter = pos(frontmatterNote, 0, frontmatterNote.indexOf("\n---\n") + 4);

describe("heading subpaths", () => {
  it("treats #heading as a heading subpath, but not a block or no subpath", () => {
    expect(["#Intro", "#Intro#Nested", "#^block", "", "Intro"].map(isHeadingSubpath)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});

describe("ATX headings", () => {
  it("drops a closing hash sequence only when whitespace precedes it", () => {
    const cases: Array<[string, string]> = [
      ["Title ##", "Title "],
      ["Title ##  \t", "Title "],
      ["Title\t#", "Title\t"],
      ["Title # ##", "Title # "],
      ["Title##", "Title##"],
      ["C#", "C#"],
      ["Title \\#", "Title \\#"],
      ["##", "##"],
      ["Title", "Title"],
      ["", ""],
    ];
    for (const [input, expected] of cases) expect(withoutClosingHashes(input), input).toBe(expected);
  });

  it("reads one to six hashes after up to three spaces", () => {
    expect(markdownHeading("# One")).toEqual({ heading: "One", level: 1 });
    expect(markdownHeading("   ### Three ###")).toEqual({ heading: "Three", level: 3 });
    expect(markdownHeading("######\tSix")).toEqual({ heading: "Six", level: 6 });
  });

  it("rejects lines that are not headings, and empty headings", () => {
    for (const line of ["    # Four spaces", "####### Seven", "#NoSpace", "#", "# ", "##   ", "## ##", "text # not"]) {
      expect(markdownHeading(line), line).toBeNull();
    }
  });

  it("handles long runs of spaces quickly", () => {
    const started = performance.now();
    expect(markdownHeading(`#${" ".repeat(100_000)}\r`)).toBeNull();
    expect(markdownHeading(`# a${" ".repeat(100_000)}#b`)?.level).toBe(1);
    expect(withoutClosingHashes(`a${" #".repeat(50_000)}x`)).toMatch(/x$/);
    expect(performance.now() - started).toBeLessThan(250);
  });

  it("compares headings ignoring case and punctuation", () => {
    expect(normalizedHeading("Hello, World!")).toBe(normalizedHeading("hello   world"));
  });
});

describe("documentHeading", () => {
  const at = (lines: string[], line = 1) => documentHeading(Text.of(lines), line);

  it("reads ATX and setext headings", () => {
    expect(at(["## ATX", "==="])).toEqual({ heading: "ATX", level: 2 });
    expect(at(["Title", "==="])).toEqual({ heading: "Title", level: 1 });
    expect(at(["Title", "  ---  "])).toEqual({ heading: "Title", level: 2 });
  });

  it("finds no heading without a valid underline or text", () => {
    expect(at(["Title"])).toBeNull();
    expect(at(["Title", "text"])).toBeNull();
    expect(at(["Title", "- - -"])).toBeNull();
    expect(at(["Title", "    ==="])).toBeNull();
    expect(at(["", "==="])).toBeNull();
  });
});

describe("sourceReferences", () => {
  it("lists links, embeds, then frontmatter links placed at the frontmatter", () => {
    const body = frontmatterNote.indexOf("[[a#H]]", frontmatter.end.offset);
    const embed = frontmatterNote.indexOf("![[a#H]]");
    const references = sourceReferences({
      links: [reference(frontmatterNote, "[[a#H]]", body)],
      embeds: [reference(frontmatterNote, "![[a#H]]", embed)],
      frontmatterPosition: frontmatter,
      frontmatterLinks: [
        { key: "up", link: "a#H", original: "[[a#H]]" },
        { key: "rel", link: "a#H", original: "[[a#H]]" },
        { key: "next", link: "b", original: "[[b]]" },
      ],
    });

    expect(
      references.map(({ original, propertyKey, originalOrdinal, positionIsApproximate, position }) => [
        original,
        propertyKey,
        originalOrdinal,
        positionIsApproximate,
        position.start.offset,
      ]),
    ).toEqual([
      ["[[a#H]]", null, 0, false, body],
      ["![[a#H]]", null, 0, false, embed],
      ["[[a#H]]", "up", 0, true, 0],
      ["[[a#H]]", "rel", 1, true, 0],
      ["[[b]]", "next", 0, true, 0],
    ]);
  });

  it("ignores frontmatter links without a frontmatter position", () => {
    expect(sourceReferences({ frontmatterLinks: [{ key: "up", link: "a#H", original: "[[a#H]]" }] })).toEqual([]);
  });
});

describe("previews", () => {
  it("shows the reference's own line with whitespace collapsed", () => {
    const text = "before\n  See   [[a#H]]\tnow  \nafter";
    const start = text.indexOf("[[");
    expect(buildReferencePreview(text, start, start + 7)).toBe("See [[a#H]] now");
    expect(buildReferencePreview("[[a#H]] first\nsecond", 0, 7)).toBe("[[a#H]] first");
    expect(buildReferencePreview("first\n[[a#H]] second", 6, 13)).toBe("[[a#H]] second");
  });

  it("trims long lines around the reference with ellipses", () => {
    const text = `${"x".repeat(200)} [[a#H]] ${"y".repeat(200)}`;
    const start = text.indexOf("[[");
    const preview = buildReferencePreview(text, start, start + 7);
    expect(preview).toMatch(/^…x+ \[\[a#H\]\] y+…$/);
    expect(preview.length).toBeLessThanOrEqual(180);

    const atEnd = `${"x".repeat(200)} [[a#H]]`;
    expect(buildReferencePreview(atEnd, atEnd.length - 7, atEnd.length)).toMatch(/^…x+ \[\[a#H\]\]$/);
  });

  it("locates a frontmatter link by its occurrence before previewing it", () => {
    const approximate = {
      startOffset: 0,
      endOffset: frontmatter.end.offset,
      originalText: "[[a#H]]",
      positionIsApproximate: true,
    };
    const second = source({ ...approximate, originalOrdinal: 1 });
    refineApproximatePosition(frontmatterNote, second);
    expect(second).toMatchObject({ lineNumber: 2, columnNumber: 6, positionIsApproximate: false });
    expect(frontmatterNote.slice(second.startOffset, second.endOffset)).toBe("[[a#H]]");
    expect(buildReferencePreview(frontmatterNote, second.startOffset, second.endOffset)).toBe('rel: "[[a#H]]"');

    // The third occurrence is in the body, past the frontmatter.
    const third = source({ ...approximate, originalOrdinal: 2 });
    refineApproximatePosition(frontmatterNote, third);
    expect(third).toMatchObject({ lineNumber: 0, startOffset: 0, positionIsApproximate: true });

    const exact = source({ originalText: "[[a#H]]", lineNumber: 4, startOffset: 42 });
    refineApproximatePosition(frontmatterNote, exact);
    expect(exact).toMatchObject({ lineNumber: 4, startOffset: 42 });
  });
});

describe("compareSources", () => {
  it("orders by file name, then path, line and column", () => {
    const sources = [
      source({ sourceFileName: "b", sourceFilePath: "b.md" }),
      source({ sourceFileName: "a", sourceFilePath: "z/a.md" }),
      source({ lineNumber: 5 }),
      source({ lineNumber: 2, columnNumber: 9 }),
      source({ lineNumber: 2, columnNumber: 3 }),
    ];
    sources.sort(compareSources);
    expect(sources.map((s) => `${s.sourceFilePath}:${s.lineNumber}:${s.columnNumber}`)).toEqual([
      "a.md:2:3",
      "a.md:2:9",
      "a.md:5:0",
      "z/a.md:0:0",
      "b.md:0:0",
    ]);
  });
});

describe("headingSignature", () => {
  it("changes when a heading's text, level or line changes", () => {
    const signature = headingSignature({ headings: [heading("A", 1, 0), heading("B", 2, 3)] });
    expect(headingSignature({ headings: [heading("A", 1, 0), heading("B", 2, 3)] })).toBe(signature);
    for (const changed of [heading("C", 2, 3), heading("B", 3, 3), heading("B", 2, 4)]) {
      expect(headingSignature({ headings: [heading("A", 1, 0), changed] })).not.toBe(signature);
    }
    expect(headingSignature(null)).toBe(headingSignature({}));
  });
});

describe("renaming links", () => {
  it("rewrites the heading of wikilinks and Markdown links", () => {
    const cases: Array<[string, string, string]> = [
      ["[[Note#Old]]", "New", "[[Note#New]]"],
      ["![[Note#Old|Shown]]", "New", "![[Note#New|Shown]]"],
      ["[[#Old]]", "New", "[[#New]]"],
      ["[text](Note.md#Old)", "New", "[text](Note.md#New)"],
      ["[text](<My Note.md#Old>)", "New Name", "[text](<My Note.md#New Name>)"],
      ["[text](My%20Note.md#Old%20Name)", "New Name", "[text](My%20Note.md#New%20Name)"],
      ["[text](Note.md#Old)", "New Name", "[text](Note.md#New%20Name)"],
      ['[text](Note.md#Old "Title")', "New", '[text](Note.md#New "Title")'],
      ["[text](Note(1).md#Old)", "New", "[text](Note(1).md#New)"],
    ];
    for (const [original, name, expected] of cases) {
      expect(rewriteReferenceHeading(original, name), original).toBe(expected);
    }
  });

  it("leaves links without a heading alone", () => {
    for (const original of ["[[Note]]", "[[Note|a#b]]", "[[Note#Old", "[text](Note.md)", "plain #text"]) {
      expect(rewriteReferenceHeading(original, "New"), original).toBeNull();
    }
  });

  it("uses a link's cached position while the text still matches", () => {
    const text = "x [[a#H]] y";
    expect(locateReference(text, reference(text, "[[a#H]]", 2), new Map())).toEqual({ from: 2, to: 9 });
  });

  it("finds a moved link at the occurrence nearest its cached position", () => {
    const text = `[[a#H]] ${"-".repeat(20)} [[a#H]] tail`;
    const second = text.lastIndexOf("[[a#H]]");
    expect(locateReference(text, reference(text, "[[a#H]]", second - 3), new Map())?.from).toBe(second);
    expect(locateReference(text, reference(text, "[[a#H]]", 5), new Map())?.from).toBe(0);
  });

  it("finds a frontmatter link by its occurrence within the frontmatter", () => {
    const inFrontmatter = (originalOrdinal: number) =>
      locateReference(
        frontmatterNote,
        reference(frontmatterNote, "[[a#H]]", 0, {
          position: frontmatter,
          originalOrdinal,
          positionIsApproximate: true,
        }),
        new Map(),
      );
    expect(inFrontmatter(1)?.from).toBe(frontmatterNote.indexOf('[[a#H]]"\n---'));
    expect(inFrontmatter(2)).toBeNull();
  });

  it("gives up on empty or missing link text", () => {
    const text = "x [[a#H]] y";
    expect(locateReference(text, reference(text, "", 2), new Map())).toBeNull();
    expect(locateReference(text, reference(text, "[[zz]]", 2), new Map())).toBeNull();
  });
});

describe("reading mode", () => {
  const manifest: PluginManifest = {
    id: "micropatches",
    name: "Micropatches",
    author: "test",
    version: "0.0.0",
    minAppVersion: "1.13.0",
    description: "test",
  };

  class TestPlugin extends Plugin {}

  function register(files: Record<string, string>) {
    const plugin = new TestPlugin(App.createConfigured__({ files }), manifest);
    const ctx: PatchContext = {
      isEnabled: () => true,
      getConfig: <T>(_key: string, defaultValue: T): T => defaultValue,
      setConfig: () => Promise.resolve(),
    };
    return { plugin, handle: headingBacklinks.register(plugin.asOriginalType2__(), ctx) };
  }

  async function postProcess(plugin: Plugin, el: HTMLElement, sourcePath: string): Promise<void> {
    const context: MarkdownPostProcessorContext = {
      docId: "test",
      sourcePath,
      frontmatter: undefined,
      addChild: () => undefined,
      getSectionInfo: (headingEl) => {
        const line = Number(headingEl.dataset["line"]);
        return { text: "", lineStart: line, lineEnd: line };
      },
    };
    for (const processor of plugin.markdownPostProcessors__) await processor(el, context);
  }

  afterEach(() => {
    vi.useRealTimers();
    document.body.empty();
  });

  it("marks linked headings and lists their sources with context", async () => {
    vi.useFakeTimers();
    const { plugin, handle } = register({
      "a.md": "# Intro\n\n## Details\ntext\n### Alone",
      "b.md": "See [[a#Details]] and [[a#Details|again]].",
      "notes/c.md": "Block [[a#^id]], whole [[a]].\nIntro [[a#Intro]], details [[a#Details]].",
    });
    await vi.runAllTimersAsync();

    const section = document.body.createDiv();
    const intro = section.createEl("h1", { text: "Intro", attr: { "data-line": "0" } });
    const details = section.createEl("h2", { text: "Details", attr: { "data-line": "2" } });
    const alone = section.createEl("h3", { text: "Alone", attr: { "data-line": "4" } });
    await postProcess(plugin, section, "a.md");

    const indicator = (headingEl: HTMLElement) =>
      headingEl.querySelector<HTMLButtonElement>(".micropatches-heading-backlink-indicator");
    expect(indicator(intro)?.getAttribute("aria-label")).toBe("1 link to this heading");
    expect(indicator(details)?.getAttribute("aria-label")).toBe("3 links to this heading");
    expect(indicator(alone)).toBeNull();

    indicator(details)?.click();
    await vi.runAllTimersAsync();

    const parts = [
      ".micropatches-heading-backlinks-filename",
      ".micropatches-heading-backlinks-line",
      ".micropatches-heading-backlinks-preview",
    ];
    const items = Array.from(document.querySelectorAll(".micropatches-heading-backlinks-item"), (item) =>
      parts.map((selector) => item.querySelector(selector)?.textContent),
    );
    expect(items).toEqual([
      ["b", ":1", "See [[a#Details]] and [[a#Details|again]]."],
      ["b", ":1", "See [[a#Details]] and [[a#Details|again]]."],
      ["c", ":2", "Intro [[a#Intro]], details [[a#Details]]."],
    ]);

    handle.cleanup();
    expect(document.querySelector(".micropatches-heading-backlinks-popover")).toBeNull();
    expect(document.querySelector(".micropatches-heading-backlink-indicator")).toBeNull();
  });
});
