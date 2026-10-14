import { forceParsing, StreamLanguage, syntaxTree } from "@codemirror/language";
import { EditorState } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formattedTarget } from "./inline-code-copy";

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
    // `strong` supplies a real highlighting tag; these extra HyperMD tags
    // stay in the syntax node names without needing their own highlighting.
    tokenTable: { formatting: [], "formatting-strong": [], "formatting-em": [], em: [] },
    token(stream, state) {
      if (stream.sol()) state.line++;
      const position = (offsets[state.line] ?? 0) + stream.pos;
      const part = rangesByLine[state.line]?.find(({ from, to }) => from <= position && position < to);
      if (part === undefined) throw new Error("Missing fixture token");
      stream.pos += part.to - position;
      return part.name.replaceAll("_", " ");
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
