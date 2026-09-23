import type { MarkdownPostProcessorContext, PluginManifest } from "obsidian";
import { App, MarkdownRenderer, Plugin } from "obsidian-test-mocks/obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PatchContext } from "../patch";
import {
  configuredDistance,
  footnoteSidenotes,
  inlineCodeRanges,
  isEscaped,
  isSide,
  markdownLines,
  parseDefinitions,
  parsedFootnotes,
  positionInRanges,
  renderedFootnoteNumber,
  resolveRenderedId,
  serializeDefinition,
} from "./footnote-sidenotes";

function excludedLines(source: string): string[] {
  return markdownLines(source)
    .filter(({ excluded }) => excluded)
    .map(({ content }) => content);
}

function definition(source: string, id = "a") {
  const found = parseDefinitions(source).get(id);
  if (found === undefined) throw new Error(`No definition for ${id}`);
  return found;
}

// What an edited sidenote writes back into the note.
function replaceDefinition(source: string, id: string, text: string): string {
  const { from, to } = definition(source, id);
  return source.slice(0, from) + serializeDefinition(text) + source.slice(to);
}

function codeSpans(source: string): string[] {
  return inlineCodeRanges(markdownLines(source)).map(({ from, to }) => source.slice(from, to));
}

function renderedReference(label: string, ids: { sup?: string; footref?: string; href?: string } = {}): HTMLElement {
  const sup = createEl("sup", { cls: "footnote-ref" });
  if (ids.sup !== undefined) sup.id = ids.sup;
  const link = sup.createEl("a", { text: label });
  if (ids.footref !== undefined) link.dataset["footref"] = ids.footref;
  if (ids.href !== undefined) link.setAttribute("href", ids.href);
  return sup;
}

describe("markdownLines", () => {
  it("splits lines at their offsets, without line endings", () => {
    expect(markdownLines("a\r\nbc\n\nd").map(({ from, content }) => [from, content])).toEqual([
      [0, "a"],
      [3, "bc"],
      [6, ""],
      [7, "d"],
    ]);
  });

  it("excludes frontmatter closed by --- or ...", () => {
    expect(excludedLines("---\ntitle: x\n---\nbody")).toEqual(["---", "title: x", "---"]);
    expect(excludedLines("\uFEFF---\na: 1\n...\nbody")).toEqual(["\uFEFF---", "a: 1", "..."]);
  });

  it("treats --- as frontmatter only on the first line", () => {
    expect(excludedLines("body\n---\nx\n---")).toEqual([]);
  });

  it("excludes fenced code until a closing fence of the same kind and at least the same length", () => {
    const source = ["text", "````md", "```", "~~~~", "```` js", "[^a]", "   ````", "after"].join("\n");
    expect(excludedLines(source)).toEqual(["````md", "```", "~~~~", "```` js", "[^a]", "   ````"]);
    expect(excludedLines("~~~\ncode\n~~~\nafter")).toEqual(["~~~", "code", "~~~"]);
  });

  it("keeps an unclosed fence open to the end and ignores fences indented four spaces", () => {
    expect(excludedLines("```\na\n\nb")).toEqual(["```", "a", "", "b"]);
    expect(excludedLines("    ```\nnot code")).toEqual([]);
  });

  it("excludes the inside of multi-line HTML and Obsidian comments, but not the line that opens them", () => {
    expect(excludedLines("before <!--\nhidden\n-->\nafter")).toEqual(["hidden", "-->"]);
    expect(excludedLines("%%\nhidden\n%%\nafter")).toEqual(["hidden", "%%"]);
    expect(excludedLines("a <!-- b --> c\n%% d %% e\nafter")).toEqual([]);
  });

  it("reads comment markers in inline code as text", () => {
    expect(excludedLines("Type `%%` or ``<!--`` to comment.\nafter")).toEqual([]);
    expect(excludedLines("`%%` then %%\nhidden\n%%")).toEqual(["hidden", "%%"]);
  });

  it("opens no fence inside a comment", () => {
    expect(excludedLines("<!--\n```\n-->\nafter")).toEqual(["```", "-->"]);
    expect(excludedLines("%%\n```js\n%%\nafter")).toEqual(["```js", "%%"]);
  });
});

describe("parseDefinitions", () => {
  it("reads a definition's id, text and the range of its body", () => {
    const source = "Text[^a].\n\n[^a]: The note.";
    expect(definition(source)).toEqual({ id: "a", text: "The note.", from: source.indexOf("The"), to: source.length });
  });

  it("takes any whitespace, or none, after the colon out of the body", () => {
    for (const source of ["[^a]:Body", "[^a]: Body", "[^a]:\t  Body"]) {
      const { text, from, to } = definition(source);
      expect(text).toBe("Body");
      expect(source.slice(from, to)).toBe("Body");
    }
  });

  it("accepts an empty first line followed by an indented body", () => {
    expect(definition("[^a]:\n    Body").text).toBe("Body");
    expect(definition("[^a]:   ")).toMatchObject({ text: "", from: 8, to: 8 });
  });

  it("collects indented continuation lines, keeping blank lines between them", () => {
    const source = "[^a]: First\n    second\n\n    third\n\tfourth\n\nnot part of it";
    const { text, to } = definition(source);
    expect(text).toBe("First\nsecond\n\nthird\nfourth");
    expect(to).toBe(source.indexOf("fourth") + "fourth".length);
  });

  it("strips at most one level of indentation from continuation lines", () => {
    expect(definition("[^a]: List\n    - item\n        - nested").text).toBe("List\n- item\n    - nested");
  });

  it("ends a definition at its last indented line", () => {
    expect(definition("[^a]: One\n\n\nNext").to).toBe("[^a]: One".length);
  });

  it("reads an indented definition marker as part of the previous body", () => {
    const definitions = parseDefinitions("[^a]: One\n    [^b]: Two");
    expect(Array.from(definitions.keys())).toEqual(["a"]);
    expect(definitions.get("a")?.text).toBe("One\n[^b]: Two");
  });

  it("reads consecutive definitions with any id", () => {
    const definitions = parseDefinitions("[^a]: One\n[^my note]: Two\n[^x.y-1]: Three");
    expect(Array.from(definitions.values(), ({ id, text }) => [id, text])).toEqual([
      ["a", "One"],
      ["my note", "Two"],
      ["x.y-1", "Three"],
    ]);
  });

  it("ignores definitions in frontmatter, code and comments, and markers that don't start a line", () => {
    const source = [
      "---",
      "[^f]: frontmatter",
      "---",
      "```",
      "[^c]: code",
      "```",
      "%%",
      "[^o]: comment",
      "%%",
      "Text [^m]: mid-line",
      "[^]: no id",
      "[^real]: yes",
    ].join("\n");
    expect(Array.from(parseDefinitions(source).keys())).toEqual(["real"]);
  });

  it("rejects a long line of spaces after the colon quickly", () => {
    const started = performance.now();
    expect(parseDefinitions(`[^a]:${" ".repeat(100_000)}\r!`).size).toBe(0);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe("editing a definition", () => {
  it("indents continuation lines and drops carriage returns", () => {
    expect(serializeDefinition("  one\r\ntwo\r\n\r\nthree  ")).toBe("one\n    two\n    \n    three");
  });

  it("round-trips any text through the definition's range", () => {
    const source = "Intro[^a] and[^b].\n\n[^a]: Old\n    old two\n\n[^b]: Other\n\nAfter";
    for (const text of ["plain", "one\ntwo", "para\n\nnext para", "- item\n    - nested", "tab\n\tindented"]) {
      const edited = replaceDefinition(source, "a", text);
      expect(definition(edited).text).toBe(text);
      expect(definition(edited, "b").text).toBe("Other");
      expect(edited.endsWith("\n\n[^b]: Other\n\nAfter")).toBe(true);
    }
  });

  it("keeps the note's CRLF line endings around the replaced body", () => {
    expect(replaceDefinition("[^a]: Old\r\n    more\r\nAfter", "a", "New")).toBe("[^a]: New\r\nAfter");
  });
});

describe("inline code", () => {
  it("pairs backtick runs of equal length", () => {
    expect(codeSpans("a `b` c ``d ` e`` f")).toEqual(["`b`", "``d ` e``"]);
  });

  it("leaves unmatched and escaped backticks as text", () => {
    expect(codeSpans("a ` b")).toEqual([]);
    expect(codeSpans("\\`not code\\`")).toEqual([]);
    expect(codeSpans("\\``code`")).toEqual(["`code`"]);
  });

  it("spans lines of one paragraph, but not a blank line or fenced code", () => {
    expect(codeSpans("a `b\nc` d")).toEqual(["`b\nc`"]);
    expect(codeSpans("a `b\n\nc` d")).toEqual([]);
    expect(codeSpans("a `b\n```\nx\n```\nc` d")).toEqual([]);
  });

  it("counts backslashes to tell whether a character is escaped", () => {
    expect([1, 2, 3].map((slashes) => isEscaped(`${"\\".repeat(slashes)}[`, slashes))).toEqual([true, false, true]);
    expect(isEscaped("[", 0)).toBe(false);
  });

  it("treats excluded ranges as half-open", () => {
    const ranges = [
      { from: 0, to: 2 },
      { from: 5, to: 8 },
    ];
    expect([0, 1, 2, 4, 5, 7, 8].map((position) => positionInRanges(position, ranges))).toEqual([
      true,
      true,
      false,
      false,
      true,
      true,
      false,
    ]);
  });
});

describe("parsedFootnotes", () => {
  it("numbers footnotes by their first reference and ignores undefined ids", () => {
    const source = "B[^b] A[^a] again[^b] missing[^x]\n\n[^a]: A\n[^b]: B";
    const { references, order, numberById } = parsedFootnotes(source);
    expect(references.map(({ id, from, to }) => [id, source.slice(from, to)])).toEqual([
      ["b", "[^b]"],
      ["a", "[^a]"],
      ["b", "[^b]"],
    ]);
    expect(order).toEqual(["b", "a"]);
    expect(Array.from(numberById)).toEqual([
      ["b", 1],
      ["a", 2],
    ]);
  });

  it("skips references in inline code, fenced code and comments", () => {
    const source = "Code `[^a]` and ``x ` [^a]``.\n```\n[^a]\n```\n%%\n[^a]\n%%\nReal[^a]\n\n[^a]: Note";
    expect(parsedFootnotes(source).references.map(({ from }) => from)).toEqual([source.indexOf("[^a]\n\n")]);
  });

  it("counts a reference followed by a colon in the middle of a line", () => {
    const source = "The rules[^a]: first\n\n[^a]: x";
    expect(parsedFootnotes(source).references.map(({ from }) => from)).toEqual([source.indexOf("[^a]")]);
  });

  it("finds definitions after a comment marker in inline code", () => {
    expect(Array.from(parseDefinitions("Type `%%` to comment[^a].\n\n[^a]: x").keys())).toEqual(["a"]);
  });

  it("numbers by the first reference the caller doesn't exclude", () => {
    const source = "\\[^a] [^b] \\\\[^a]\n\n[^a]: A\n[^b]: B";
    const { references, order } = parsedFootnotes(source, (position) => isEscaped(source, position));
    expect(references.map(({ from }) => from)).toEqual([source.indexOf("[^b]"), source.indexOf("[^a]", 2)]);
    expect(order).toEqual(["b", "a"]);
  });

  it("lists ids longest first", () => {
    expect(parsedFootnotes("[^n]: 1\n[^note-long]: 2\n[^note]: 3").idsByLength).toEqual(["note-long", "note", "n"]);
  });
});

describe("rendered references", () => {
  const idsByLength = ["note-long", "note"];

  it("resolves a rendered id with a per-render suffix to the longest matching definition", () => {
    expect(resolveRenderedId(renderedReference("1", { sup: "fnref-note-long-3f2a" }), [], idsByLength)).toBe(
      "note-long",
    );
    expect(resolveRenderedId(renderedReference("1", { footref: "note" }), [], idsByLength)).toBe("note");
    expect(resolveRenderedId(renderedReference("1", { href: "#fn-note-9" }), [], idsByLength)).toBe("note");
  });

  it("falls back to the displayed number", () => {
    const order = ["note", "note-long"];
    expect(resolveRenderedId(renderedReference("[2]", { sup: "fnref-2-abc" }), order, idsByLength)).toBe("note-long");
    expect(resolveRenderedId(renderedReference("[3]"), order, idsByLength)).toBeNull();
    expect(resolveRenderedId(renderedReference("†"), order, idsByLength)).toBeNull();
  });

  it("reads the number shown in the reference's link", () => {
    expect(renderedFootnoteNumber(renderedReference("[12]"))).toBe(12);
    expect(renderedFootnoteNumber(renderedReference("†"))).toBeNull();
    expect(renderedFootnoteNumber(createEl("sup", { text: "3" }))).toBeNull();
  });
});

describe("settings", () => {
  it("accepts only left or right as the side", () => {
    expect(["left", "right", "Left", "", null].map(isSide)).toEqual([true, true, false, false, false]);
  });

  it("clamps the distance and falls back to the default for non-numbers", () => {
    expect([undefined, "40", Number.NaN, Infinity, -5, 1000, 12.5].map(configuredDistance)).toEqual([
      32, 32, 32, 32, 0, 240, 12.5,
    ]);
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

  function register(files: Record<string, string>, enabled = true) {
    // jsdom has no ResizeObserver; the patch creates one per window.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    vi.spyOn(MarkdownRenderer, "render").mockImplementation((_app, markdown, el) => {
      el.textContent = markdown;
      return Promise.resolve();
    });
    const plugin = new TestPlugin(App.createConfigured__({ files }), manifest);
    const ctx: PatchContext = {
      isEnabled: () => enabled,
      getConfig: <T>(_key: string, defaultValue: T): T => defaultValue,
      setConfig: () => Promise.resolve(),
    };
    return { plugin, handle: footnoteSidenotes.register(plugin.asOriginalType2__(), ctx) };
  }

  async function postProcess(plugin: Plugin, el: HTMLElement, sourcePath: string): Promise<void> {
    const context: MarkdownPostProcessorContext = {
      docId: "test",
      sourcePath,
      frontmatter: undefined,
      addChild: () => undefined,
      getSectionInfo: () => null,
    };
    for (const processor of plugin.markdownPostProcessors__) await processor(el, context);
  }

  afterEach(() => {
    vi.useRealTimers();
    document.body.empty();
  });

  it("shows each footnote once, beside its first rendered reference, and removes it on cleanup", async () => {
    vi.useFakeTimers();
    const { plugin, handle } = register({
      "note.md": "One[^a] two[^b] again[^a]\n\n[^a]: First\n[^b]: Second\n    continued",
    });
    const section = document.body.createDiv({ cls: "markdown-reading-view" }).createDiv();
    const paragraph = section.createEl("p");
    const references = [
      renderedReference("[1]", { sup: "fnref-a-x1" }),
      renderedReference("[2]", { sup: "fnref-b-x1" }),
      renderedReference("[1]", { sup: "fnref-a-x1-1" }),
    ];
    paragraph.append(...references);

    await postProcess(plugin, section, "note.md");

    const notes = references.map((reference) =>
      reference.querySelector<HTMLElement>(".micropatches-footnote-sidenote"),
    );
    expect(notes.map((note) => note?.dataset["number"])).toEqual(["1", "2", undefined]);
    expect(notes.map((note) => note?.querySelector(".micropatches-footnote-content")?.textContent)).toEqual([
      "First",
      "Second\ncontinued",
      undefined,
    ]);

    handle.cleanup();
    expect(section.querySelector(".micropatches-footnote-sidenote, .micropatches-footnote-anchor")).toBeNull();
    expect(document.getElementById("micropatches-footnote-sidenotes-style")).toBeNull();
  });

  it("leaves references alone while the patch is off", async () => {
    const { plugin, handle } = register({ "note.md": "One[^a]\n\n[^a]: First" }, false);
    const section = document.body.createDiv({ cls: "markdown-reading-view" });
    section.append(renderedReference("[1]", { sup: "fnref-a-x1" }));

    await postProcess(plugin, section, "note.md");

    expect(section.querySelector(".micropatches-footnote-sidenote")).toBeNull();
    handle.cleanup();
  });
});
