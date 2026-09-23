import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { App, Plugin } from "obsidian-test-mocks/obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { calcRequiredOffset, scrollOffset } from "./scroll-offset";

describe("calcRequiredOffset", () => {
  it("reads the offset as a percentage of the editor height", () => {
    expect(calcRequiredOffset(800, 20, { percentageMode: true, offset: 25 })).toBe(200);
  });

  it("reads the offset as pixels outside percentage mode", () => {
    expect(calcRequiredOffset(800, 20, { percentageMode: false, offset: 25 })).toBe(25);
  });

  it("caps the margin so the cursor line still fits between both margins", () => {
    expect(calcRequiredOffset(400, 20, { percentageMode: true, offset: 90 })).toBe(190);
    expect(calcRequiredOffset(400, 20, { percentageMode: false, offset: 1000 })).toBe(190);
  });

  it("never goes negative", () => {
    expect(calcRequiredOffset(10, 20, { percentageMode: false, offset: 25 })).toBe(0);
    expect(calcRequiredOffset(800, 20, { percentageMode: false, offset: -5 })).toBe(0);
  });
});

describe("scroll margin", () => {
  class TestPlugin extends Plugin {}
  let view: EditorView | undefined;

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    view?.destroy();
    vi.useRealTimers();
  });

  // A 400px editor whose cursor line is 15px tall (20px with the patch's padding).
  function editor(config: Record<string, unknown> = {}, isEnabled = () => true) {
    const plugin = new TestPlugin(App.createConfigured__(), {
      id: "test",
      name: "Test",
      author: "test",
      version: "0.0.0",
      minAppVersion: "0.0.0",
      description: "",
    });
    scrollOffset.register(plugin.asOriginalType2__(), {
      isEnabled,
      getConfig: <T>(key: string, defaultValue: T) => (key in config ? (config[key] as T) : defaultValue),
      setConfig: () => Promise.resolve(),
    });
    const editorView = new EditorView({
      state: EditorState.create({ doc: "a\nb\nc", extensions: plugin.editorExtensions__ as Extension[] }),
      parent: document.body,
    });
    view = editorView;
    vi.spyOn(editorView, "coordsAtPos").mockReturnValue({ left: 0, right: 0, top: 0, bottom: 15 });
    Object.defineProperty(editorView.dom, "offsetHeight", { value: 400 });

    const moveCursor = async (anchor: number) => {
      editorView.dispatch({ selection: { anchor } });
      await vi.advanceTimersByTimeAsync(50);
    };
    const margins = () => editorView.state.facet(EditorView.scrollMargins).map((margin) => margin(editorView));
    const fire = (event: Event) => editorView.contentDOM.dispatchEvent(event);
    return { moveCursor, margins, fire };
  }

  it("keeps a quarter of the editor height by default", async () => {
    const { moveCursor, margins } = editor();

    await moveCursor(2);

    expect(margins()).toEqual([{ top: 100, bottom: 100 }]);
  });

  it("uses the configured pixel distance", async () => {
    const { moveCursor, margins } = editor({ percentageMode: false, offset: 40 });

    await moveCursor(2);

    expect(margins()).toEqual([{ top: 40, bottom: 40 }]);
  });

  it("drops the margin after a click until the next key press", async () => {
    const { moveCursor, margins, fire } = editor();
    await moveCursor(2);

    fire(new MouseEvent("mousedown", { bubbles: true }));
    await moveCursor(4);
    expect(margins()).toEqual([{ top: 0, bottom: 0 }]);

    fire(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowDown" }));
    await moveCursor(2);
    expect(margins()).toEqual([{ top: 100, bottom: 100 }]);
  });

  it("gives no margin once disabled", async () => {
    let enabled = true;
    const { moveCursor, margins } = editor({}, () => enabled);
    await moveCursor(2);

    enabled = false;

    expect(margins()).toEqual([null]);
  });
});
