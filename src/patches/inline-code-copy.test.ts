import { App, Plugin } from "obsidian-test-mocks/obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PatchHandle } from "../patch";
import { highlightedTarget, inlineCodeCopy, inlineCodeTarget } from "./inline-code-copy";

const TICK = "cm-formatting cm-formatting-code cm-inline-code";
const CODE = "cm-inline-code";
const MARKS = "cm-formatting cm-formatting-highlight cm-highlight";
const STARS = "cm-formatting cm-formatting-strong cm-highlight cm-strong";
const HIGHLIGHT = "cm-highlight";
const WIDGET = "cm-widget";
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
const highlightTarget = (el: Element | undefined) => (el === undefined ? undefined : highlightedTarget(el));

function reading(): HTMLElement {
  return document.body.createDiv({ cls: "markdown-rendered" }).createEl("p");
}

afterEach(() => {
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

describe("highlightedTarget", () => {
  it("copies a highlight in reading mode", () => {
    const mark = reading().createEl("mark", { text: "Key idea" });

    expect(highlightedTarget(mark)).toEqual({ text: "Key idea", elements: [mark] });
  });

  it("joins a highlight split by nested formatting across hidden-syntax widgets", () => {
    const spans = editorLine(
      "see ",
      [HIGHLIGHT, "a "],
      [WIDGET, ""],
      [`${HIGHLIGHT} cm-strong`, "b"],
      [WIDGET, ""],
      [HIGHLIGHT, " c"],
      " after",
    );
    const [first, , bold, , last] = spans;

    expect(highlightTarget(bold)).toEqual({ text: "a b c", elements: [first, bold, last] });
  });

  it("leaves revealed formatting markers out of the text", () => {
    const spans = editorLine(
      [MARKS, "=="],
      [HIGHLIGHT, "a "],
      [STARS, "**"],
      [`${HIGHLIGHT} cm-strong`, "b"],
      [STARS, "**"],
      [MARKS, "=="],
    );

    expect(highlightTarget(spans[3])).toEqual({ text: "a b", elements: spans });
  });

  it("stops at visible text between two highlights", () => {
    const [first] = editorLine([HIGHLIGHT, "a"], " and ", [HIGHLIGHT, "b"]);

    expect(highlightTarget(first)).toEqual({ text: "a", elements: [first] });
  });
});

describe("click to copy", () => {
  class TestPlugin extends Plugin {}
  let state = { enabled: true, copyHighlights: false };
  let writeText = vi.fn();
  let handles: PatchHandle[] = [];

  function register(): PatchHandle {
    const plugin = new TestPlugin(App.createConfigured__(), {
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
        key === "copyHighlights" ? (state.copyHighlights as T) : defaultValue,
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
    state = { enabled: true, copyHighlights: false };
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
