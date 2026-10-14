import { App, Plugin } from "obsidian-test-mocks/obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PatchHandle } from "../patch";
import { formattedTarget, formattedTextRange, inlineCodeCopy, inlineCodeTarget } from "./inline-code-copy";

const TICK = "cm-formatting cm-formatting-code cm-inline-code";
const CODE = "cm-inline-code";
const FLASH = "is-micropatches-copy-confirmed";

// An editor line: [classes, text] pairs become spans, bare strings text nodes.
function editorLine(...parts: Array<string | [string, string]>): HTMLElement[] {
  const line = document.body.createDiv({ cls: "markdown-source-view mod-cm6" }).createDiv({ cls: "cm-line" });
  const spans: HTMLElement[] = [];
  for (const part of parts) {
    if (typeof part === "string") line.append(part);
    else spans.push(line.createSpan({ cls: part[0], text: part[1] }));
  }
  return spans;
}

// Spans come back from arrays, so they may be undefined under noUncheckedIndexedAccess.
const codeTarget = (el: Element | undefined) => (el === undefined ? undefined : inlineCodeTarget(el));

function reading(): HTMLElement {
  return document.body.createDiv({ cls: "markdown-rendered" }).createEl("p");
}

afterEach(() => {
  window.getSelection()?.removeAllRanges();
  document.body.empty();
  document.body.className = "";
});

describe("inlineCodeTarget", () => {
  it("copies inline code in reading mode", () => {
    const code = reading().createEl("code", { text: "npm i" });

    expect(inlineCodeTarget(code)).toEqual({ text: "npm i", elements: [code] });
  });

  it("ignores code blocks and code outside rendered Markdown", () => {
    expect(inlineCodeTarget(reading().createEl("pre").createEl("code", { text: "npm i" }))).toBeNull();
    expect(inlineCodeTarget(document.body.createEl("code", { text: "npm i" }))).toBeNull();
  });

  it("copies the content, not the backticks, from any part of editor code", () => {
    const [open, content, close] = editorLine("run ", [TICK, "`"], [CODE, "npm i"], [TICK, "`"], " now");

    for (const part of [open, content, close]) {
      expect(codeTarget(part)).toEqual({ text: "npm i", elements: [open, content, close] });
    }
  });

  it("copies editor code whose backticks are hidden", () => {
    const [content] = editorLine("run ", [CODE, "npm i"], " now");

    expect(codeTarget(content)).toEqual({ text: "npm i", elements: [content] });
  });

  it("copies the code next to the clicked backtick, not a neighbour's", () => {
    const spans = editorLine([TICK, "`"], [CODE, "a"], [TICK, "`"], " ", [TICK, "`"], [CODE, "b"], [TICK, "`"]);

    expect(codeTarget(spans[2])?.text).toBe("a");
    expect(codeTarget(spans[3])?.text).toBe("b");
  });

  it("skips a neighbour whose backticks are hidden", () => {
    const [before, open, content, close] = editorLine([CODE, "z"], " ", [TICK, "`"], [CODE, "a"], [TICK, "`"]);

    expect(codeTarget(open)).toEqual({ text: "a", elements: [open, content, close] });
    expect(codeTarget(before)).toEqual({ text: "z", elements: [before] });
  });

  it("ignores ordinary editor text", () => {
    const [strong] = editorLine(["cm-strong", "bold"]);

    expect(codeTarget(strong)).toBeNull();
  });
});

// Token names and splits are captured from Obsidian 1.14's HyperMD parser,
// including adjacent delimiter runs and the special triple-emphasis tokens.
function tokens(...parts: Array<string | [string, string]>) {
  type Token = Parameters<typeof formattedTextRange>[0];
  const nodes: Token[] = [];
  let source = "";
  for (const part of parts) {
    if (typeof part === "string") source += part;
    else {
      const previous = nodes[nodes.length - 1] ?? null;
      const node: Token = {
        name: part[0],
        from: source.length,
        to: source.length + part[1].length,
        prevSibling: previous,
        nextSibling: null,
      };
      if (previous !== null) previous.nextSibling = node;
      nodes.push(node);
      source += part[1];
    }
  }
  return {
    nodes,
    at(index: number, format: Parameters<typeof formattedTextRange>[2], offset = 0) {
      const node = nodes[index];
      if (node === undefined) throw new Error("Missing fixture token");
      return formattedTextRange(
        node,
        { sliceString: (from, to) => source.slice(from, to) },
        format,
        node.from + offset,
      );
    },
  };
}

describe("formatted text", () => {
  it.each([
    ["strong", "**"],
    ["strong", "__"],
    ["em", "*"],
    ["em", "_"],
    ["highlight", "=="],
  ] as const)("copies %s delimited by %s, including clicks on either marker", (format, marker) => {
    const boundary = `formatting_formatting-${format}_${format}`;
    const fixture = tokens([boundary, marker], [format, "text"], [boundary, marker]);
    for (const index of [0, 1, 2]) expect(fixture.at(index, format)?.text).toBe("text");
  });

  it("handles nested formatting independently", () => {
    const fixture = tokens(
      ["formatting_formatting-strong_strong", "**"],
      ["strong", "outer "],
      ["em_formatting_formatting-em_strong", "*"],
      ["em_strong", "inner"],
      ["em_formatting_formatting-em_strong", "*"],
      ["strong", " tail"],
      ["formatting_formatting-strong_strong", "**"],
    );
    expect(fixture.at(3, "strong")?.text).toBe("outer inner tail");
    expect(fixture.at(3, "em")?.text).toBe("inner");
    expect(fixture.at(1, "em")).toBeNull();
  });

  it.each(["***", "___"])("recognizes %s as both bold and italic boundaries", (marker) => {
    const boundary = "em_em_formatting_formatting-strong_strong";
    const fixture = tokens([boundary, marker], ["em_strong", "both"], [boundary, marker]);
    for (const format of ["em", "strong"] as const) {
      for (const index of [0, 1, 2]) expect(fixture.at(index, format)?.text).toBe("both");
    }
  });

  it.each([
    ["strong", "**", "__"],
    ["em", "*", "_"],
  ] as const)("keeps adjacent %s fragments separate even when their markers share one token", (format, left, right) => {
    const boundary = `formatting_formatting-${format}_${format}`;
    const fixture = tokens(
      [boundary, left],
      [format, "one"],
      [boundary, left + right],
      [format, "two"],
      [boundary, right],
    );
    expect(fixture.at(1, format)?.text).toBe("one");
    expect(fixture.at(3, format)?.text).toBe("two");
    expect(fixture.at(2, format)?.text).toBe("one");
    expect(fixture.at(2, format, left.length)?.text).toBe("two");
  });

  it("copies multiline fragments but never crosses unformatted gaps", () => {
    expect(tokens(["strong", "first"], "\n", ["strong", "second"]).at(0, "strong")?.text).toBe("first\nsecond");
    for (const gap of [" ", " and ", "\n\n"]) {
      expect(tokens(["strong", "one"], gap, ["strong", "two"]).at(0, "strong")?.text).toBe("one");
    }
  });

  it("omits nested syntax, escapes, link destinations and wiki-link targets", () => {
    const fixture = tokens(
      ["strong", "with "],
      ["formatting_formatting-code_inline-code_strong", "`"],
      ["inline-code_strong", "code"],
      ["formatting_formatting-code_inline-code_strong", "`"],
      ["strong", " "],
      ["formatting_formatting-link_link_strong", "["],
      ["link_strong", "link"],
      ["formatting_formatting-link_link_strong", "]"],
      ["formatting_formatting-link-string_string_strong_url", "("],
      ["string_strong_url", "https://example.com"],
      ["formatting_formatting-link-string_string_strong_url", ")"],
      ["strong", " "],
      ["formatting-link_formatting-link-start_strong", "[["],
      ["hmd-internal-link_link-has-alias_strong", "target"],
      ["hmd-internal-link_link-alias-pipe_strong", "|"],
      ["hmd-internal-link_link-alias_strong", "label"],
      ["formatting-link_formatting-link-end_strong", "]]"],
      ["strong", " "],
      ["formatting-escape_hmd-escape-backslash_strong", "\\"],
      ["escape_hmd-escape-char_strong", "*"],
    );
    expect(fixture.at(0, "strong")?.text).toBe("with code link label *");
  });

  it("keeps literal markers that Obsidian does not parse as formatting", () => {
    expect(tokens(["strong", "a __b__ c"]).at(0, "strong")?.text).toBe("a __b__ c");
  });

  it("keeps visible bare URLs and autolinks while omitting hidden comments", () => {
    const fixture = tokens(
      ["strong", "visit "],
      ["strong_url", "https://one.example"],
      ["strong", " and "],
      ["formatting_formatting-link_link_strong", "<"],
      ["link_url", "https://two.example"],
      ["formatting_formatting-link_link_strong", ">"],
      ["strong", " "],
      ["comment_comment-start_formatting_strong", "%%"],
      ["comment_strong", "hidden"],
      ["comment_comment-end_formatting_strong", "%%"],
      ["strong", "end"],
    );
    expect(fixture.at(0, "strong")?.text).toBe("visit https://one.example and https://two.example end");
    expect(fixture.at(10, "strong")?.text).toBe("visit https://one.example and https://two.example end");
  });

  it("copies text from inline HTML without its tags or attributes", () => {
    const fixture = tokens(
      ["formatting_formatting-strong_strong", "**"],
      ["strong", "a "],
      ["bracket_hmd-html-begin_tag", "<"],
      ["tag", "span"],
      " ",
      ["attribute", "title"],
      "=",
      ["string", '"metadata"'],
      ["bracket_tag", ">"],
      "b &amp; c",
      ["bracket_tag", "</"],
      ["tag", "span"],
      ["bracket_hmd-html-end_tag", ">"],
      ["strong", " d"],
      ["formatting_formatting-strong_strong", "**"],
    );
    expect(fixture.at(1, "strong")).toMatchObject({ text: "a b & c d", complete: true });
    expect(fixture.at(10, "strong")).toMatchObject({ text: "a b & c d", complete: true });
  });

  it.each([
    ["strong", "**"],
    ["em", "*"],
    ["highlight", "=="],
  ] as const)("does not mistake HTML outside %s for content beside a clicked marker", (format, marker) => {
    const boundary = `formatting_formatting-${format}_${format}`;
    const fixture = tokens(
      [boundary, marker],
      [format, "one"],
      [boundary, marker],
      ["bracket_hmd-html-begin_tag", "<"],
      ["tag", "u"],
      ["bracket_tag", ">"],
      "plain",
      ["bracket_tag", "</"],
      ["tag", "u"],
      ["bracket_hmd-html-end_tag", ">"],
      [boundary, marker],
      [format, "two"],
      [boundary, marker],
    );
    expect(fixture.at(2, format)).toMatchObject({ text: "one", complete: true });
    expect(fixture.at(9, format)).toMatchObject({ text: "two", complete: true });
  });

  it("skips ambiguous HTML beside a marker instead of copying the wrong side", () => {
    const boundary = "formatting_formatting-strong_strong";
    const fixture = tokens(
      [boundary, "**"],
      ["strong", "one"],
      ["bracket_hmd-html-begin_tag", "<"],
      ["tag", "u"],
      ["bracket_tag", ">"],
      "plain",
      ["bracket_tag", "</"],
      ["tag", "u"],
      ["bracket_hmd-html-end_tag", ">"],
      [boundary, "**__"],
      ["strong", "two"],
      [boundary, "__"],
    );
    expect(fixture.at(1, "strong")).toMatchObject({ text: "oneplain", complete: true });
    expect(fixture.at(8, "strong")).toBeNull();
    expect(fixture.at(8, "strong", 2)).toMatchObject({ text: "two", complete: true });
  });

  it.each([
    ["HyperMD-quote", "formatting_formatting-quote_quote_strong", "> "],
    ["HyperMD-list-line", "hmd-list-indent_hmd-list-indent-1", "  "],
  ])("crosses %s line wrappers without copying their continuation prefixes", (wrapperName, prefixName, prefix) => {
    type Token = Parameters<typeof formattedTextRange>[0];
    const fixture = tokens(
      ["formatting_formatting-strong_strong", "**"],
      ["strong", "first"],
      "\n",
      [prefixName, prefix],
      ["strong", "second"],
      ["formatting_formatting-strong_strong", "**"],
    );
    const wrap = (children: Token[]): Token => {
      const first = children[0];
      const last = children[children.length - 1];
      if (first === undefined || last === undefined) throw new Error("Empty wrapper fixture");
      const parent: Token = {
        name: wrapperName,
        from: first.from,
        to: last.to,
        prevSibling: null,
        nextSibling: null,
        firstChild: first,
        lastChild: last,
      };
      first.prevSibling = null;
      last.nextSibling = null;
      for (const child of children) child.parent = parent;
      return parent;
    };
    const firstLine = wrap(fixture.nodes.slice(0, 2));
    const secondLine = wrap(fixture.nodes.slice(2));
    firstLine.nextSibling = secondLine;
    secondLine.prevSibling = firstLine;
    expect(fixture.at(1, "strong")?.text).toBe("first\nsecond");
    expect(fixture.at(3, "strong")?.text).toBe("first\nsecond");
  });

  it.each([
    ["mark", "highlight"],
    ["strong", "strong"],
    ["em", "em"],
  ] as const)("copies rendered %s only when enabled", (tag, format) => {
    const el = reading().createEl(tag, { text: "Text" });
    expect(formattedTarget(el, [])).toBeNull();
    expect(formattedTarget(el, [format])).toEqual({ text: "Text", elements: [el] });
    expect(formattedTarget(document.body.createEl(tag), [format])).toBeNull();
    expect(formattedTarget(reading().createEl("pre").createEl(tag), [format])).toBeNull();
  });

  it("chooses the nearest enabled rendered fragment", () => {
    const bold = reading().createEl("strong");
    bold.append("outer ");
    const italic = bold.createEl("em", { text: "Inner" });
    bold.append(" tail");
    expect(formattedTarget(italic, ["strong", "em"])?.text).toBe("Inner");
    expect(formattedTarget(italic, ["strong"])?.text).toBe("outer Inner tail");
  });
});

describe("click to copy", () => {
  class TestPlugin extends Plugin {}
  let state = { enabled: true, copyHighlights: false, copyBold: false, copyItalic: false };
  let writeText = vi.fn();
  let handles: PatchHandle[] = [];

  function register(app = App.createConfigured__()): PatchHandle {
    const plugin = new TestPlugin(app, {
      id: "test",
      name: "Test",
      author: "test",
      version: "0.0.0",
      minAppVersion: "0.0.0",
      description: "",
    });
    const handle = inlineCodeCopy.register(plugin.asOriginalType2__(), {
      isEnabled: () => state.enabled,
      getConfig: <T>(key: string, defaultValue: T) =>
        key in state ? (state[key as keyof typeof state] as T) : defaultValue,
      setConfig: () => Promise.resolve(),
    });
    handles.push(handle);
    return handle;
  }

  async function click(el: Element | undefined, button = 0): Promise<void> {
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true, button }));
    await vi.advanceTimersByTimeAsync(0);
  }

  const bodyClasses = () => Array.from(document.body.classList);

  beforeEach(() => {
    vi.useFakeTimers();
    state = { enabled: true, copyHighlights: false, copyBold: false, copyItalic: false };
    writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
  });

  afterEach(() => {
    for (const handle of handles) handle.cleanup();
    handles = [];
    vi.useRealTimers();
  });

  it("copies on a primary click and briefly marks what was copied", async () => {
    register();
    const spans = editorLine([TICK, "`"], [CODE, "npm i"], [TICK, "`"]);

    await click(spans[1]);

    expect(writeText).toHaveBeenCalledWith("npm i");
    expect(spans.map((span) => span.hasClass(FLASH))).toEqual([true, true, true]);
    await vi.advanceTimersByTimeAsync(200);
    expect(spans.some((span) => span.hasClass(FLASH))).toBe(false);
  });

  it("declares both new settings with disabled defaults", () => {
    const settings = inlineCodeCopy.settingDefinitions?.(
      {
        isEnabled: () => true,
        getConfig: <T>(_key: string, defaultValue: T) => defaultValue,
        setConfig: () => Promise.resolve(),
      },
      (key) => key,
      App.createConfigured__().asOriginalType__(),
    );
    expect(settings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ control: { type: "toggle", key: "copyBold", defaultValue: false } }),
        expect.objectContaining({ control: { type: "toggle", key: "copyItalic", defaultValue: false } }),
      ]),
    );
  });

  it("ignores other buttons and clicks outside inline code", async () => {
    register();
    const code = reading().createEl("code", { text: "npm i" });

    await click(code, 1);
    await click(code, 2);
    await click(reading());

    expect(writeText).not.toHaveBeenCalled();
  });

  it("does nothing while disabled", async () => {
    const handle = register();
    expect(bodyClasses()).toEqual(["micropatches-inline-code-copy"]);

    state.enabled = false;
    handle.onToggle?.(false);
    await click(reading().createEl("code", { text: "npm i" }));

    expect(writeText).not.toHaveBeenCalled();
    expect(bodyClasses()).toEqual([]);
  });

  it("copies highlights only when that option is on", async () => {
    const handle = register();
    const mark = reading().createEl("mark", { text: "Key idea" });

    await click(mark);
    expect(writeText).not.toHaveBeenCalled();

    state.copyHighlights = true;
    handle.onConfigChange?.("copyHighlights", true);
    await click(mark);

    expect(writeText).toHaveBeenCalledWith("Key idea");
    expect(bodyClasses()).toEqual(["micropatches-inline-code-copy", "micropatches-highlight-copy"]);
  });

  it.each([
    ["copyBold", "strong"],
    ["copyItalic", "em"],
  ] as const)("toggles %s independently without reloading", async (key, tag) => {
    const handle = register();
    const bold = reading().createEl("strong", { text: "Bold" });
    const italic = reading().createEl("em", { text: "Italic" });
    await click(bold);
    await click(italic);
    expect(writeText).not.toHaveBeenCalled();

    state[key] = true;
    handle.onConfigChange?.(key, true);
    await click(bold);
    await click(italic);
    expect(writeText).toHaveBeenCalledExactlyOnceWith(tag === "strong" ? "Bold" : "Italic");

    state[key] = false;
    handle.onConfigChange?.(key, false);
    await click(bold);
    await click(italic);
    expect(writeText).toHaveBeenCalledOnce();
    expect(bold.hasClass(FLASH) || italic.hasClass(FLASH)).toBe(false);
    expect(bodyClasses()).toEqual(["micropatches-inline-code-copy"]);
  });

  it("keeps inline code priority inside optional formatting", async () => {
    state.copyHighlights = state.copyBold = state.copyItalic = true;
    register();
    const bold = reading().createEl("mark").createEl("strong").createEl("em");
    bold.append("run ");
    await click(bold.createEl("code", { text: "npm i" }));
    expect(writeText).toHaveBeenCalledExactlyOnceWith("npm i");
  });

  it.each([{ shiftKey: true }, { ctrlKey: true }, { metaKey: true }, { altKey: true }, { detail: 2 }])(
    "leaves modified and multi-click gestures alone (%j)",
    async (init) => {
      state.copyBold = true;
      register();
      const event = new MouseEvent("click", { bubbles: true, cancelable: true, ...init });
      reading().createEl("strong", { text: "Text" }).dispatchEvent(event);
      await vi.advanceTimersByTimeAsync(0);
      expect(writeText).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    },
  );

  it("leaves links, buttons, selections and handled events alone", async () => {
    state.copyBold = true;
    register();
    const paragraph = reading();
    await click(paragraph.createEl("a").createEl("strong", { text: "Link" }));
    await click(paragraph.createEl("button").createEl("strong", { text: "Button" }));
    const bold = paragraph.createEl("strong", { text: "Selected" });
    const range = document.createRange();
    range.selectNodeContents(bold);
    window.getSelection()?.addRange(range);
    await click(bold);
    window.getSelection()?.removeAllRanges();
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    event.preventDefault();
    bold.dispatchEvent(event);
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).not.toHaveBeenCalled();
  });

  it.each(["toggle", "config", "cleanup"] as const)(
    "does not restore feedback after %s while clipboard writing is pending",
    async (action) => {
      state.copyBold = true;
      const handle = register();
      let finish = (): void => {};
      writeText.mockReturnValue(
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      );
      const bold = reading().createEl("strong", { text: "Text" });
      await click(bold);
      if (action === "cleanup") handle.cleanup();
      else if (action === "toggle") {
        state.enabled = false;
        handle.onToggle?.(false);
      } else {
        state.copyBold = false;
        handle.onConfigChange?.("copyBold", false);
      }
      finish();
      await vi.advanceTimersByTimeAsync(0);
      expect(bold.hasClass(FLASH)).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it("uses each popout's clipboard and cleans it up on close", async () => {
    const app = App.createConfigured__();
    state.copyBold = true;
    const handle = register(app);
    const win = document.body.createEl("iframe").contentWindow;
    if (win === null) throw new Error("Missing iframe window");
    const popoutWrite = vi.fn(() => Promise.resolve());
    Object.defineProperty(win.navigator, "clipboard", { value: { writeText: popoutWrite }, configurable: true });
    const bold = document.body.createEl("strong", { text: "Popout" });
    win.document.body.classList.add("markdown-rendered");
    win.document.body.append(bold);
    app.workspace.trigger("window-open", {}, win);
    expect(win.document.body.classList.contains("micropatches-bold-copy")).toBe(true);
    await click(bold);
    expect(popoutWrite).toHaveBeenCalledExactlyOnceWith("Popout");
    expect(writeText).not.toHaveBeenCalled();
    app.workspace.trigger("window-close", {}, win);
    expect(win.document.body.classList.contains("micropatches-bold-copy")).toBe(false);
    expect(bold.classList.contains(FLASH)).toBe(false);
    await click(bold);
    expect(popoutWrite).toHaveBeenCalledOnce();
    handle.cleanup();
  });

  it("logs instead of throwing when the clipboard is unavailable", async () => {
    vi.stubGlobal("navigator", {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    register();

    await click(reading().createEl("code", { text: "npm i" }));

    expect(error).toHaveBeenCalledOnce();
  });

  it("removes its listener, classes and marks on cleanup", async () => {
    state.copyHighlights = true;
    const handle = register();
    const code = reading().createEl("code", { text: "npm i" });
    await click(code);

    handle.cleanup();
    await click(code);

    expect(writeText).toHaveBeenCalledOnce();
    expect(code.hasClass(FLASH)).toBe(false);
    expect(bodyClasses()).toEqual([]);
  });
});
