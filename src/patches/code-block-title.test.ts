import { StreamLanguage } from "@codemirror/language";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { MarkdownPostProcessorContext } from "obsidian";
import { App, MarkdownView, Plugin } from "obsidian-test-mocks/obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codeBlockTitle, FENCE, parseInfo } from "./code-block-title";

class TestPlugin extends Plugin {}

function setup(enabled = true) {
  const app = App.createConfigured__();
  const plugin = new TestPlugin(app, {
    id: "test",
    name: "Test",
    author: "test",
    version: "0.0.0",
    minAppVersion: "0.0.0",
    description: "",
  });
  const handle = codeBlockTitle.register(plugin.asOriginalType2__(), {
    isEnabled: () => enabled,
    getConfig: <T>(_key: string, defaultValue: T) => defaultValue,
    setConfig: () => Promise.resolve(),
  });
  return { app, plugin, handle };
}

function codeAttributes(el: Element): Record<string, string> {
  return Object.fromEntries(
    Array.from(el.attributes)
      .filter(({ name }) => name.startsWith("data-code-"))
      .map(({ name, value }) => [name, value]),
  );
}

function fence(line: string): { run: string; info: string } | null {
  const match = FENCE.exec(line);
  return match === null ? null : { run: match[1] ?? "", info: match[2] ?? "" };
}

describe("FENCE", () => {
  it("matches backtick and tilde fences", () => {
    expect(fence("```js")).toEqual({ run: "```", info: "js" });
    expect(fence("~~~python")).toEqual({ run: "~~~", info: "python" });
    expect(fence("```")).toEqual({ run: "```", info: "" });
    expect(fence("``js")).toBeNull();
  });

  it("takes the whole fence run", () => {
    expect(fence("````js")).toEqual({ run: "````", info: "js" });
    expect(fence("~~~~~ py")).toEqual({ run: "~~~~~", info: " py" });
  });

  it("allows up to three spaces of indentation", () => {
    expect(fence("   ```js")?.info).toBe("js");
    expect(fence("    ```js")).toBeNull();
    expect(fence("\t```js")).toBeNull();
  });

  it("accepts blockquote and callout prefixes", () => {
    for (const line of ["> ```js", ">```js", "> > ```js", ">\t```js", "  >  > ```js", ">    ```js", "   > ~~~js"]) {
      expect(fence(line)?.info, line).toBe("js");
    }
    expect(fence(">     ```js")).toBeNull();
    expect(fence("    > ```js")).toBeNull();
  });

  it("handles very deep quote prefixes in linear time", () => {
    const start = performance.now();
    expect(FENCE.exec(`${"> ".repeat(5000)}x`)).toBeNull();
    expect(FENCE.exec(`${">    ".repeat(5000)} x`)).toBeNull();
    expect(fence(`${"> ".repeat(5000)}\`\`\`js`)?.info).toBe("js");
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe("parseInfo", () => {
  it("takes the first word as the language", () => {
    expect(parseInfo("js")).toEqual({ language: "js", title: null });
    expect(parseInfo("  c++   {1,3} linenums ")).toEqual({ language: "c++", title: null });
  });

  it("gives a bare fence an empty language", () => {
    expect(parseInfo("")).toEqual({ language: "", title: null });
    expect(parseInfo("   ")).toEqual({ language: "", title: null });
  });

  it.each([
    ['js title:"main file.js"', "main file.js"],
    ["js title='main file.js'", "main file.js"],
    ["js title=main.js", "main.js"],
    ["js title: main.js", "main.js"],
    ["js TITLE = main.js", "main.js"],
    ['js {1,3} title="a.js" linenums', "a.js"],
    ['js title=""', ""],
  ])("reads the title from %s", (info, title) => {
    expect(parseInfo(info)).toEqual({ language: "js", title });
  });

  it("ignores parameters that only end in title", () => {
    expect(parseInfo("js subtitle=x")).toEqual({ language: "js", title: null });
    expect(parseInfo("js data-title=x")).toEqual({ language: "js", title: null });
  });

  it("reads a title only after the language", () => {
    expect(parseInfo("title:foo")).toEqual({ language: "title:foo", title: null });
  });

  it("rejects a language with a backtick, which is not a fence", () => {
    expect(parseInfo("js`")).toBeNull();
    expect(parseInfo("`js")).toBeNull();
  });
});

describe("reading mode", () => {
  // One <pre><code> per entry of `starts`: the line its section starts at,
  // or its first and last line, or null when Obsidian has no section info.
  async function render(
    text: string,
    starts: Array<number | [number, number] | null>,
    enabled = true,
  ): Promise<HTMLElement[]> {
    const { plugin } = setup(enabled);
    const el = createDiv();
    const pres: HTMLElement[] = starts.map(() => {
      const pre = el.createEl("pre");
      pre.createEl("code");
      return pre;
    });
    const context = {
      getSectionInfo: (target: HTMLElement) => {
        const lines = starts[pres.indexOf(target)] ?? null;
        if (lines === null) return null;
        const [lineStart, lineEnd] = typeof lines === "number" ? [lines, lines] : lines;
        return { text, lineStart, lineEnd };
      },
    } as unknown as MarkdownPostProcessorContext;
    for (const processor of plugin.markdownPostProcessors__) await processor(el, context);
    return pres;
  }

  it("exposes the language and title", async () => {
    const pres = await render('```ts title="a.ts"\nlet a;\n```', [0]);

    expect(pres.map(codeAttributes)).toEqual([{ "data-code-language": "ts", "data-code-title": "a.ts" }]);
  });

  it("marks a block without a language as plain", async () => {
    const pres = await render("```\nx\n```", [0]);

    expect(pres.map(codeAttributes)).toEqual([{ "data-code-plain": "" }]);
  });

  it("reads each block's own fence line", async () => {
    const pres = await render("> ~~~py\n> x\n> ~~~\n\n```\ny\n```", [0, 4]);

    expect(pres.map(codeAttributes)).toEqual([{ "data-code-language": "py" }, { "data-code-plain": "" }]);
  });

  it("reads the fences inside a callout, in order", async () => {
    const text = "> [!note] Files\n> ```js title:a.js\n> x\n> ```\n> text\n> ~~~\n> y\n> ~~~";
    const pres = await render(text, [
      [0, 7],
      [0, 7],
    ]);

    expect(pres.map(codeAttributes)).toEqual([
      { "data-code-language": "js", "data-code-title": "a.js" },
      { "data-code-plain": "" },
    ]);
  });

  it("reads the fences inside nested list items", async () => {
    const text = "- a\n  ```py\n  x\n  ```\n  - b\n    ```sh\n    y\n    ```";
    const pres = await render(text, [
      [0, 7],
      [0, 7],
    ]);

    expect(pres.map(codeAttributes)).toEqual([{ "data-code-language": "py" }, { "data-code-language": "sh" }]);
  });

  it("labels none of a list's blocks when one has no fence", async () => {
    const text = "- a\n\n        indented\n\n  ```js\n  x\n  ```";
    const pres = await render(text, [
      [0, 6],
      [0, 6],
    ]);

    expect(pres.map(codeAttributes)).toEqual([{}, {}]);
  });

  it("leaves blocks alone when their source is not a fence", async () => {
    const pres = await render("    indented code\n\n```js`x`", [0, null, 2]);

    expect(pres.map(codeAttributes)).toEqual([{}, {}, {}]);
  });

  it("does nothing while disabled", async () => {
    const pres = await render("```js\nx\n```", [0], false);

    expect(pres.map(codeAttributes)).toEqual([{}]);
  });

  async function openMarkdown(app: App): Promise<MarkdownView> {
    const leaf = app.workspace.getLeaf();
    await leaf.openFile(await app.vault.create("a.md", ""));
    expect(leaf.view).toBeInstanceOf(MarkdownView);
    return leaf.view as unknown as MarkdownView;
  }

  it("strips its attributes from open views on cleanup", async () => {
    const { app, handle } = setup();
    const view = await openMarkdown(app);
    const pre = view.containerEl.createEl("pre", {
      attr: { "data-code-language": "js", "data-code-title": "a.js", "data-code-plain": "" },
    });

    handle.cleanup();

    expect(codeAttributes(pre)).toEqual({});
  });

  it("re-renders reading views when toggled", async () => {
    const { app, handle } = setup();
    const view = await openMarkdown(app);
    const rerender = vi.spyOn(view.previewMode, "rerender");

    handle.onToggle?.(false);

    expect(rerender).toHaveBeenCalledWith(true);
  });
});

describe("live preview", () => {
  // Stand-in for Obsidian's HyperMD mode, which names one syntax node per
  // code row; fence rows also carry a begin or end name.
  const hyperMd = StreamLanguage.define<{ fence: string | null }>({
    startState: () => ({ fence: null }),
    token(stream, state) {
      const run = /^[\t ]*(?:> ?)*(`{3,}|~{3,})/.exec(stream.string)?.[1];
      stream.skipToEnd();
      if (state.fence === null) {
        if (run === undefined) return null;
        state.fence = run;
        return "comment HyperMD-codeblock HyperMD-codeblock-begin";
      }
      if (run?.startsWith(state.fence) === true) {
        state.fence = null;
        return "comment HyperMD-codeblock HyperMD-codeblock-end";
      }
      return "comment HyperMD-codeblock";
    },
  });

  let view: EditorView | undefined;
  afterEach(() => {
    view?.destroy();
  });

  function rows(doc: string, enabled = true): () => Array<Record<string, string>> {
    // The stream parser warns once about the made-up HyperMD tag names.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const { plugin } = setup(enabled);
    const editor = new EditorView({
      state: EditorState.create({ doc, extensions: [hyperMd, plugin.editorExtensions__ as Extension[]] }),
      parent: document.body,
    });
    view = editor;
    return () => Array.from(editor.contentDOM.querySelectorAll(".cm-line")).map(codeAttributes);
  }

  it("puts the language and title on the opening row only", () => {
    const attributes = rows('intro\n```ts title="a.ts"\nlet a;\n```\nafter');

    expect(attributes()).toEqual([{}, { "data-code-language": "ts", "data-code-title": "a.ts" }, {}, {}, {}]);
  });

  it("marks every row of a plain block, without leaking into the next block", () => {
    const attributes = rows("```\nplain\n```\n~~~py\nx\n~~~");
    const plain = { "data-code-plain": "" };

    expect(attributes()).toEqual([plain, plain, plain, { "data-code-language": "py" }, {}, {}]);
  });

  it("reads fences inside callouts", () => {
    const attributes = rows("> [!note]\n> ```js title:x\n> y\n> ```");

    expect(attributes()).toEqual([{}, { "data-code-language": "js", "data-code-title": "x" }, {}, {}]);
  });

  it("reads fences in nested list items, however far indented", () => {
    const attributes = rows("- a\n  - b\n    ```js title:x\n    y\n    ```");

    expect(attributes()).toEqual([{}, {}, { "data-code-language": "js", "data-code-title": "x" }, {}, {}]);
  });

  it("follows edits to the fence", () => {
    const attributes = rows("```js\nx\n```");
    view?.dispatch({ changes: { from: 3, to: 5, insert: "py title=b.py" } });

    expect(attributes()[0]).toEqual({ "data-code-language": "py", "data-code-title": "b.py" });
  });

  it("does nothing while disabled", () => {
    const attributes = rows("```\nx\n```\n```js\ny\n```", false);

    expect(attributes()).toEqual([{}, {}, {}, {}, {}, {}]);
  });
});
