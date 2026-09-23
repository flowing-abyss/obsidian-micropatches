import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Plugin as PluginOriginal, PluginManifest } from "obsidian";
import { App, Plugin } from "obsidian-test-mocks/obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cursorRepeatThrottle, getVimMode, hasPendingVimInput } from "./cursor-repeat-throttle";

const manifest: PluginManifest = {
  id: "micropatches",
  name: "Micropatches",
  author: "test",
  version: "0.0.0",
  minAppVersion: "1.13.0",
  description: "test",
};

class TestPlugin extends Plugin {}

describe("hasPendingVimInput", () => {
  it("is false without pending keys", () => {
    expect(hasPendingVimInput({})).toBe(false);
    expect(
      hasPendingVimInput({ inputState: { keyBuffer: [], motionRepeat: [], operator: null, prefixRepeat: [] } }),
    ).toBe(false);
  });

  it.each([{ keyBuffer: ["g"] }, { motionRepeat: ["3"] }, { operator: "d" }, { prefixRepeat: ["2"] }])(
    "is true with %o",
    (inputState) => {
      expect(hasPendingVimInput({ inputState })).toBe(true);
    },
  );
});

describe("getVimMode", () => {
  const handleKey = vi.fn();

  function modeFor(vim: object | undefined, { vimMode = true, adapter = true } = {}) {
    const plugin = { app: { vault: { getConfig: (key: string) => key === "vimMode" && vimMode } } };
    const view = {
      cm: vim && { state: { vim } },
      dom: { win: adapter ? { CodeMirror: { Vim: { handleKey } } } : {} },
    };
    return getVimMode(plugin as unknown as PluginOriginal, view as unknown as EditorView, "ArrowDown");
  }

  it("is off when Vim mode is off", () => {
    expect(modeFor({}, { vimMode: false })).toBe("off");
  });

  it("is insert in insert mode", () => {
    expect(modeFor({ insertMode: true })).toBe("insert");
  });

  it("gives up on pending input or a missing adapter", () => {
    expect(modeFor({ inputState: { keyBuffer: ["d"] } })).toBeNull();
    expect(modeFor(undefined)).toBeNull();
    expect(modeFor({}, { adapter: false })).toBeNull();
  });

  it("routes other modes through Vim's own key", () => {
    expect(modeFor({})).toMatchObject({ api: { handleKey }, key: "<Down>" });
  });
});

describe("Cursor repeat throttle", () => {
  const cleanups: Array<() => void> = [];

  function setup(doc = "0123456789") {
    const app = App.createConfigured__();
    const suggest: { currentSuggest: unknown } = { currentSuggest: null };
    Object.assign(app.workspace, { editorSuggest: suggest });
    const plugin = new TestPlugin(app, manifest);
    const state = { enabled: true };
    const handle = cursorRepeatThrottle.register(plugin.asOriginalType2__(), {
      isEnabled: () => state.enabled,
      getConfig: <T>(_key: string, defaultValue: T): T => defaultValue,
      setConfig: () => Promise.resolve(),
    });
    const view = new EditorView({
      state: EditorState.create({ doc, extensions: plugin.editorExtensions__ as Extension[] }),
      parent: document.body,
    });
    // Keydowns the patch passes on. What it takes over is prevented and
    // stopped, so neither CodeMirror (Vim included) nor the app sees it.
    const passedOn = vi.fn();
    document.addEventListener("keydown", passedOn);
    cleanups.push(handle.cleanup, () => {
      view.destroy();
      document.removeEventListener("keydown", passedOn);
    });
    const dispatch = vi.spyOn(view, "dispatch");
    const press = (key: string, init: KeyboardEventInit = { repeat: true }): void => {
      view.contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init }));
    };
    const head = (): number => view.state.selection.main.head;
    return { app, handle, view, state, suggest, passedOn, dispatch, press, head };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom has no layout; CodeMirror's measuring only needs the method to exist.
    Object.defineProperty(Range.prototype, "getClientRects", { configurable: true, value: () => [] });
  });

  afterEach(() => {
    for (const cleanup of cleanups.splice(0)) cleanup();
    Reflect.deleteProperty(Range.prototype, "getClientRects");
    vi.useRealTimers();
    document.body.empty();
  });

  it("coalesces held-key repeats into one update per frame", () => {
    const { passedOn, dispatch, press, head } = setup();

    for (let i = 0; i < 5; i++) press("ArrowRight");
    expect(passedOn).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
    vi.advanceTimersToNextFrame();
    expect(dispatch).toHaveBeenCalledOnce();
    expect(head()).toBe(5);
  });

  it("stops at the end of the document", () => {
    const { press, head } = setup();

    for (let i = 0; i < 20; i++) press("ArrowRight");
    vi.advanceTimersToNextFrame();
    expect(head()).toBe(10);
  });

  it("leaves a first press to CodeMirror", () => {
    const { passedOn, dispatch, press } = setup();

    press("ArrowRight", {});
    vi.advanceTimersToNextFrame();
    expect(passedOn).toHaveBeenCalledOnce();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("applies queued moves before a different key", () => {
    const { press, head } = setup();

    for (let i = 0; i < 3; i++) press("ArrowRight");
    press("a", {});
    expect(head()).toBe(3);
  });

  it("applies queued moves before a change of direction", () => {
    const { dispatch, press, head } = setup();

    for (let i = 0; i < 3; i++) press("ArrowRight");
    press("ArrowLeft");
    expect(head()).toBe(3);
    vi.advanceTimersToNextFrame();
    expect(head()).toBe(2);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });

  it.each([{ ctrlKey: true }, { altKey: true }, { metaKey: true }, { shiftKey: true }, { isComposing: true }])(
    "leaves repeats with %o alone",
    (init) => {
      const { passedOn, press } = setup();

      press("ArrowRight", { repeat: true, ...init });
      expect(passedOn).toHaveBeenCalledOnce();
    },
  );

  it("stays out of the way of an open suggester", () => {
    const { suggest, passedOn, press } = setup();

    suggest.currentSuggest = {};
    press("ArrowDown");
    suggest.currentSuggest = null;
    document.body.createDiv({ cls: "suggestion-container" });
    press("ArrowDown");
    expect(passedOn).toHaveBeenCalledTimes(2);
  });

  it("does nothing while disabled", () => {
    const { state, passedOn, press } = setup();

    state.enabled = false;
    press("ArrowRight");
    expect(passedOn).toHaveBeenCalledOnce();
  });

  it("drops queued moves on cleanup", () => {
    const { handle, dispatch, press } = setup();

    for (let i = 0; i < 3; i++) press("ArrowRight");
    handle.cleanup();
    vi.advanceTimersToNextFrame();
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("drops queued moves when their window closes", () => {
    const { app, dispatch, press } = setup();

    for (let i = 0; i < 3; i++) press("ArrowRight");
    app.workspace.trigger("window-close", {}, window);
    vi.advanceTimersToNextFrame();
    press("a", {});
    expect(dispatch).not.toHaveBeenCalled();
  });

  describe("in Vim normal mode", () => {
    function setupVim() {
      const handleKey = vi.fn();
      vi.stubGlobal("CodeMirror", { Vim: { handleKey } });
      const editor = setup();
      editor.app.vault.setConfig("vimMode", true);
      const vim = { insertMode: false, inputState: {} };
      const cm = { state: { vim } };
      Object.assign(editor.view, { cm });
      return { ...editor, handleKey, vim, cm };
    }

    it("sends held-key repeats to Vim as one counted motion", () => {
      const { handleKey, cm, press } = setupVim();

      for (let i = 0; i < 12; i++) press("ArrowDown");
      expect(handleKey).not.toHaveBeenCalled();
      vi.advanceTimersToNextFrame();
      expect(handleKey.mock.calls).toEqual([
        [cm, "1", "cursor-repeat-throttle"],
        [cm, "2", "cursor-repeat-throttle"],
        [cm, "<Down>", "cursor-repeat-throttle"],
      ]);
    });

    it("drops the motion if Vim left normal mode before the frame", () => {
      const { handleKey, vim, press } = setupVim();

      for (let i = 0; i < 3; i++) press("ArrowDown");
      vim.insertMode = true;
      vi.advanceTimersToNextFrame();
      expect(handleKey).not.toHaveBeenCalled();
    });
  });
});
