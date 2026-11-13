import { forceParsing, StreamLanguage, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formattedTarget, inlineCodeTarget } from "./inline-code-copy";

type Token = [name: string, text: string];
const BOLD_MARKER = "formatting_formatting-strong_strong";
const ITALIC_IN_BOLD_MARKER = "em_formatting_formatting-em_strong";
const views: EditorView[] = [];

// Use real CodeMirror parsing and DOM position mapping around the HyperMD
// tokens captured from Obsidian. Decorations supply Obsidian's CSS classes.
function createEditor(lines: Token[][], completeParse = true) {
  const offsets: number[] = [];
  const rangesByLine: Array<Array<{ name: string; from: number; to: number }>> = [];
  let offset = 0;
  const ranges = lines.flatMap((line) => {
    offsets.push(offset);
    const parts = line.map(([name, text]) => {
      const from = offset;
      offset += text.length;
      return { name, from, to: offset };
    });
    rangesByLine.push(parts);
    offset++;
    return parts;
  });
  const language = StreamLanguage.define({
    startState: () => ({ line: -1 }),
    // A content tag ensures every fixture token is emitted. The extra
    // HyperMD tags stay in the node names for the real boundary walker.
    tokenTable: {
      formatting: [],
      "formatting-strong": [],
      "formatting-em": [],
      "formatting-em-end": [],
      "formatting-strong-end": [],
      "formatting-code": [],
      "inline-code": [],
      em: [],
    },
    token(stream, state) {
      if (stream.sol()) state.line++;
      const position = (offsets[state.line] ?? 0) + stream.pos;
      const part = rangesByLine[state.line]?.find(({ from, to }) => from <= position && position < to);
      if (part === undefined) throw new Error("Missing fixture token");
      stream.pos += part.to - position;
      return `${part.name.replaceAll("_", " ")} content`;
    },
    mergeTokens: false,
  });
  const parent = document.body.createDiv({ cls: "markdown-source-view mod-cm6" });
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: lines.map((line) => line.map(([, text]) => text).join("")).join("\n"),
      extensions: [
        language,
        EditorView.decorations.of(
          Decoration.set(
            ranges.map(({ name, from, to }) =>
              Decoration.mark({
                class: name
                  .split("_")
                  .map((tag) => `cm-${tag}`)
                  .join(" "),
              }).range(from, to),
            ),
          ),
        ),
      ],
    }),
  });
  views.push(view);
  // Tests of offscreen content need the complete existing tree, as supplied
  // by Obsidian after its parser has caught up with the document.
  if (completeParse) expect(forceParsing(view, view.state.doc.length, 100)).toBe(true);
  const span = (text: string): HTMLElement => {
    const element = Array.from(view.contentDOM.querySelectorAll<HTMLElement>("span")).find(
      (element) => element.textContent === text,
    );
    if (element === undefined) throw new Error(`Missing editor span: ${text}`);
    return element;
  };
  return { view, span };
}

const editor = (...lines: Token[][]) => createEditor(lines);

afterEach(() => {
  for (const view of views.splice(0)) view.destroy();
  document.body.empty();
});

describe("formatted text in a CodeMirror editor", () => {
  const nested: Token[] = [
    [BOLD_MARKER, "**"],
    ["strong", "outer "],
    [ITALIC_IN_BOLD_MARKER, "*"],
    ["em_strong", "inner"],
    [ITALIC_IN_BOLD_MARKER, "*"],
    ["strong", " tail"],
    [BOLD_MARKER, "**"],
  ];

  it("chooses the nearest enabled format through the real syntax tree and DOM mapping", () => {
    const { span } = editor(nested);
    const inner = span("inner");

    expect(formattedTarget(inner, ["strong", "em"])?.text).toBe("inner");
    expect(formattedTarget(inner, ["strong"])?.text).toBe("outer inner tail");
    expect(formattedTarget(span("outer "), ["em"])).toBeNull();
  });

  it("returns all rendered parts of the chosen fragment for feedback", () => {
    const { view, span } = editor(nested);
    const inner = span("inner");
    const result = formattedTarget(inner, ["strong"]);
    const expected = Array.from(view.contentDOM.querySelectorAll("span:not(.cm-formatting-strong)"));

    expect(new Set(result?.elements)).toEqual(new Set(expected));
    expect(formattedTarget(inner, ["strong", "em"])?.elements).toEqual([inner]);
  });

  it("does not copy a previously found outer candidate after the time budget expires", () => {
    const { span } = editor(nested);
    vi.spyOn(performance, "now").mockReturnValueOnce(0).mockReturnValue(26);
    expect(formattedTarget(span("inner"), ["strong", "em"])).toBeNull();
  });

  it.each([
    [5, "one"],
    [8, "two"],
  ])("uses click position %i inside a shared delimiter span to copy %s", (position, text) => {
    const { view, span } = editor([
      [BOLD_MARKER, "**"],
      ["strong", "one"],
      [BOLD_MARKER, "**__"],
      ["strong", "two"],
      [BOLD_MARKER, "__"],
    ]);
    const coords = vi.spyOn(view, "posAtCoords").mockReturnValue(position);
    const event = new MouseEvent("click", { clientX: 25, clientY: 10 });

    expect(formattedTarget(span("**__"), ["strong"], event)?.text).toBe(text);
    expect(coords).toHaveBeenCalledWith({ x: 25, y: 10 });
  });

  it.each([null, 0, 12])("falls back to the clicked DOM span when coordinates resolve to %s", (position) => {
    const { view, span } = editor([
      [BOLD_MARKER, "**"],
      ["strong", "one"],
      [BOLD_MARKER, "**__"],
      ["strong", "two"],
      [BOLD_MARKER, "__"],
    ]);
    const coords = vi.spyOn(view, "posAtCoords").mockReturnValue(position);

    expect(formattedTarget(span("**__"), ["strong"], new MouseEvent("click"))?.text).toBe("one");
    expect(coords).toHaveBeenCalled();
  });

  it("copies multiline content beyond the mounted DOM and limits feedback to visible spans", () => {
    const lines: Token[][] = Array.from({ length: 200 }, (_, index) => [["strong", `line ${index}`]]);
    lines[0]?.unshift([BOLD_MARKER, "**"]);
    lines[lines.length - 1]?.push([BOLD_MARKER, "**"]);
    const { view, span } = editor(...lines);
    const domAtPos = vi.spyOn(view, "domAtPos");
    const result = formattedTarget(span("line 0"), ["strong"]);

    expect(view.contentDOM.textContent).not.toContain("line 199");
    expect(result?.text).toBe(Array.from({ length: 200 }, (_, index) => `line ${index}`).join("\n"));
    expect(result?.elements.length).toBeGreaterThan(1);
    expect(result?.elements.every((element) => element.isConnected)).toBe(true);
    expect(
      domAtPos.mock.calls.every(([position]) =>
        view.visibleRanges.some(({ from, to }) => position >= from && position < to),
      ),
    ).toBe(true);
  });

  it("finishes an incomplete parse before copying a long multiline fragment", () => {
    const lines: Token[][] = Array.from({ length: 1000 }, (_, index) => [["strong", `line ${index}`]]);
    lines[0]?.unshift([BOLD_MARKER, "**"]);
    lines[lines.length - 1]?.push([BOLD_MARKER, "**"]);
    const { view, span } = createEditor(lines, false);
    expect(syntaxTree(view.state).length).toBeLessThan(view.state.doc.length);
    expect(formattedTarget(span("line 0"), ["strong"])?.text).toBe(
      Array.from({ length: 1000 }, (_, index) => `line ${index}`).join("\n"),
    );
  });

  it("does not copy an incomplete fragment when a long line was skipped by the parser", () => {
    const { view, span } = editor([
      [BOLD_MARKER, "**"],
      ["strong", "first"],
      ...Array.from({ length: 120 }, (): Token => ["strong", "x".repeat(100)]),
      [BOLD_MARKER, "**"],
    ]);
    expect(syntaxTree(view.state)).toHaveLength(view.state.doc.length);
    expect(formattedTarget(span("first"), ["strong"])).toBeNull();
  });

  it("bounds feedback DOM lookups for a densely formatted line", () => {
    const parts: Token[] = [
      [BOLD_MARKER, "**"],
      ["strong", "first"],
    ];
    for (let index = 0; index < 100; index++) {
      parts.push([ITALIC_IN_BOLD_MARKER, "*"], ["em_strong", "b"], [ITALIC_IN_BOLD_MARKER, "*"], ["strong", "a"]);
    }
    parts.push([BOLD_MARKER, "**"]);
    const { view, span } = editor(parts);
    const lookups = vi.spyOn(view, "domAtPos");
    expect(formattedTarget(span("first"), ["strong"])?.text).toBe(`first${"ba".repeat(100)}`);
    expect(lookups.mock.calls.length).toBeLessThanOrEqual(64);
  });
});

describe("Markdown copying in a CodeMirror editor", () => {
  it.each([
    [BOLD_MARKER, "**", "strong", ITALIC_IN_BOLD_MARKER, "*", "em", "**outer *inner***", "*inner*"],
    [
      "em_formatting_formatting-em",
      "*",
      "em",
      "em_formatting_formatting-strong_strong",
      "**",
      "strong",
      "*outer **inner***",
      "**inner**",
    ],
  ] as const)(
    "handles a shared closing marker after %s",
    (outerMarker, outer, outerFormat, innerMarker, inner, innerFormat, expectedOuter, expectedInner) => {
      const { span } = editor([
        [outerMarker, outer],
        [outerFormat, "outer "],
        [innerMarker, inner],
        ["em_strong", "inner"],
        ["em_formatting_formatting-em_formatting-em-end_formatting-strong_formatting-strong-end_strong", "***"],
      ]);
      expect(formattedTarget(span("outer "), [outerFormat], undefined, true)?.text).toBe(expectedOuter);
      expect(formattedTarget(span("inner"), [innerFormat, outerFormat], undefined, true)?.text).toBe(expectedInner);
    },
  );

  it.each([
    [ITALIC_IN_BOLD_MARKER, "*", "strong", "em", "*inner*", "***inner* outer**", BOLD_MARKER, "**"],
    [
      "em_formatting_formatting-strong_strong",
      "**",
      "em",
      "strong",
      "**inner**",
      "***inner** outer*",
      "em_formatting_formatting-em",
      "*",
    ],
  ] as const)(
    "handles a shared opening marker before %s",
    (innerMarker, inner, outerFormat, innerFormat, expectedInner, expectedOuter, outerMarker, outer) => {
      const { span } = editor([
        ["em_formatting_formatting-em_formatting-strong_strong", "***"],
        ["em_strong", "inner"],
        [innerMarker, inner],
        [outerFormat, " outer"],
        [outerMarker, outer],
      ]);
      expect(formattedTarget(span("inner"), [innerFormat, outerFormat], undefined, true)?.text).toBe(expectedInner);
      expect(formattedTarget(span(" outer"), [outerFormat], undefined, true)?.text).toBe(expectedOuter);
    },
  );

  it("preserves multiline source and nested formatting beyond the visible viewport", () => {
    const lines: Token[][] = Array.from({ length: 200 }, (_, i) => [["strong", `line ${i}`]]);
    lines[0]?.unshift([BOLD_MARKER, "**"]);
    lines[199]?.push(
      [ITALIC_IN_BOLD_MARKER, "*"],
      ["em_strong", "last"],
      [ITALIC_IN_BOLD_MARKER, "*"],
      [BOLD_MARKER, "**"],
    );
    const { view, span } = editor(...lines);
    expect(view.contentDOM.textContent).not.toContain("last");
    const content = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
    expect(formattedTarget(span("line 0"), ["strong"], undefined, true)?.text).toBe(`**${content}*last***`);
  });

  it.each(["`", "``", "```"])("copies the original code source using %s delimiters", (marker) => {
    const boundary = "formatting_formatting-code_inline-code";
    const { span } = editor(
      [
        [boundary, marker],
        ["inline-code", " first "],
      ],
      [
        ["inline-code", "second"],
        [boundary, marker],
      ],
    );
    for (const target of [span(marker), span(" first "), span("second")])
      expect(inlineCodeTarget(target, true)?.text).toBe(`${marker} first \nsecond${marker}`);
  });

  it("copies code with hidden delimiters from its source", () => {
    const boundary = "formatting_formatting-code_inline-code";
    const { view, span } = editor([
      [boundary, "``"],
      ["inline-code", " a`b "],
      [boundary, "``"],
    ]);
    for (const marker of view.contentDOM.querySelectorAll(".cm-formatting-code")) marker.className = "";
    expect(inlineCodeTarget(span(" a`b "), true)?.text).toBe("`` a`b ``");
  });

  it("does not copy an incomplete formatted source", () => {
    const { span } = editor([
      [BOLD_MARKER, "**"],
      ["strong", "incomplete"],
    ]);
    expect(formattedTarget(span("incomplete"), ["strong"], undefined, true)).toBeNull();
  });
});
