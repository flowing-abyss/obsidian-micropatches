import type { PluginManifest } from "obsidian";
import { App, Plugin } from "obsidian-test-mocks/obsidian";
import { afterEach, describe, expect, it, vi } from "vitest";
import { instantUi } from "./instant-ui";

const CLASS = "micropatches-instant-ui";
const manifest: PluginManifest = {
  id: "micropatches",
  name: "Micropatches",
  author: "test",
  version: "0.0.0",
  minAppVersion: "1.13.0",
  description: "test",
};

class TestPlugin extends Plugin {}

const cleanups: Array<() => void> = [];

function setup(app = App.createConfigured__(), enabled = true) {
  const state = { enabled };
  const handle = instantUi.register(new TestPlugin(app, manifest).asOriginalType2__(), {
    isEnabled: () => state.enabled,
    getConfig: <T>(_key: string, defaultValue: T): T => defaultValue,
    setConfig: () => Promise.resolve(),
  });
  const setEnabled = (value: boolean): void => {
    state.enabled = value;
    handle.onToggle?.(value);
  };
  cleanups.push(handle.cleanup);
  return { app, handle, setEnabled };
}

function popout(): Window {
  const win = document.body.createEl("iframe").contentWindow;
  if (!win) throw new Error("jsdom gave the iframe no window");
  return win;
}

const hasClass = (win: Window): boolean => win.document.body.classList.contains(CLASS);

// jsdom has no Web Animations API. Keep the native call and its result
// separate so tests can detect changed arguments, receivers or return values.
function animationApi(win: Window = window, timing: EffectTiming = {}) {
  const prototype: { animate: Element["animate"] } = (win.document.defaultView ?? window).Element.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "animate");
  const updateTiming = vi.fn();
  const animation = {
    timeline: win.document.timeline,
    effect: {
      getTiming: () => ({ duration: 200, iterations: 1, ...timing }),
      updateTiming,
    },
  } as unknown as Animation;
  const animate = vi.fn<Element["animate"]>(() => animation);
  Object.defineProperty(prototype, "animate", { value: animate, configurable: true, writable: true });
  cleanups.push(() => {
    if (descriptor !== undefined) Object.defineProperty(prototype, "animate", descriptor);
    else Reflect.deleteProperty(prototype, "animate");
  });
  return { prototype, animate, animation, updateTiming };
}

describe("Instant UI", () => {
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
    document.body.className = "";
    document.body.empty();
  });

  it("puts the body class on while enabled", () => {
    const { handle, setEnabled } = setup(undefined, false);
    expect(hasClass(window)).toBe(false);

    setEnabled(true);
    expect(hasClass(window)).toBe(true);
    setEnabled(false);
    expect(hasClass(window)).toBe(false);
    handle.cleanup();
  });

  it("removes the class on cleanup", () => {
    const { handle } = setup();
    expect(hasClass(window)).toBe(true);

    handle.cleanup();
    expect(hasClass(window)).toBe(false);
  });

  it("covers a popout from opening until it closes", () => {
    const { app, handle, setEnabled } = setup();
    const win = popout();

    app.workspace.trigger("window-open", {}, win);
    expect(hasClass(win)).toBe(true);
    setEnabled(false);
    expect(hasClass(win)).toBe(false);
    setEnabled(true);
    expect(hasClass(win)).toBe(true);

    app.workspace.trigger("window-close", {}, win);
    expect(hasClass(win)).toBe(false);
    setEnabled(false);
    setEnabled(true);
    expect(hasClass(win)).toBe(false);
    handle.cleanup();
  });

  it("covers popouts that were open before loading, once the layout is ready", () => {
    const app = App.createConfigured__();
    const win = popout();
    win.document.body.append(app.workspace.openPopoutLeaf().view.containerEl);
    const { handle } = setup(app);
    expect(hasClass(win)).toBe(false);

    app.workspace.setLayoutReady__();
    expect(hasClass(win)).toBe(true);
    handle.cleanup();
    expect(hasClass(win)).toBe(false);
  });

  it("sets nothing up when unloaded before the layout is ready", () => {
    const app = App.createConfigured__();
    const win = popout();
    win.document.body.append(app.workspace.openPopoutLeaf().view.containerEl);
    setup(app).handle.cleanup();

    app.workspace.setLayoutReady__();
    expect(hasClass(window)).toBe(false);
    expect(hasClass(win)).toBe(false);
  });

  describe("Web Animations API", () => {
    const options: Array<number | KeyframeAnimationOptions> = [
      200,
      Object.freeze({ duration: 200, delay: 40, endDelay: 30, fill: "forwards", direction: "reverse" }),
    ];

    it.each(options)("shortens %j without replacing the native animation or changing its arguments", (timing) => {
      const { animate, animation, updateTiming } = animationApi();
      setup();
      const target = document.body.createDiv();
      const frames = [{ opacity: 0 }, { opacity: 1 }];

      expect(target.animate(frames, timing)).toBe(animation);
      expect(animate).toHaveBeenCalledExactlyOnceWith(frames, timing);
      expect(animate.mock.contexts[0]).toBe(target);
      expect(updateTiming).toHaveBeenCalledExactlyOnceWith({ duration: 0.001, delay: 0, endDelay: 0 });
    });

    it("installs once, restores on disable and can be enabled again", () => {
      const { prototype, animate, updateTiming } = animationApi();
      const { setEnabled } = setup(undefined, false);
      const target = document.body.createDiv();
      expect(prototype.animate).toBe(animate);
      target.animate([], 200);
      expect(updateTiming).not.toHaveBeenCalled();

      setEnabled(true);
      const firstWrapper = prototype.animate;
      setEnabled(true);
      expect(prototype.animate).toBe(firstWrapper);
      target.animate([], 200);
      expect(updateTiming).toHaveBeenCalledOnce();

      setEnabled(false);
      expect(prototype.animate).toBe(animate);
      target.animate([], 200);
      expect(updateTiming).toHaveBeenCalledOnce();

      setEnabled(true);
      firstWrapper.call(target, [], 200);
      expect(updateTiming).toHaveBeenCalledOnce();
      target.animate([], 200);
      expect(updateTiming).toHaveBeenCalledTimes(2);
    });

    it.each([
      "loader-spinner",
      "loader-cube",
      "sk-cube",
      "status-spinner",
      "loading-icon",
      "progress-bar-line",
      "progress-bar-subline",
      "cm-fat-cursor-mark",
      "cm-animate-fat-cursor",
      "node-insert-event",
      "hmd-file-uploading",
      "mod-pending",
    ])("preserves %s animations and animations of their children", (cls) => {
      const { animate, updateTiming } = animationApi();
      setup();
      const target = document.body.createDiv({ cls });

      target.animate([], 200);
      target.createSpan().animate([], 200);

      expect(animate).toHaveBeenCalledTimes(2);
      expect(updateTiming).not.toHaveBeenCalled();
    });

    it.each([
      { parent: "cm-cursorLayer", child: "cm-cursor" },
      { parent: "editingToolbarCommandsubItem1", child: "subitem" },
    ])("preserves the $parent / $child CSS exception", ({ parent, child }) => {
      const { updateTiming } = animationApi();
      setup();
      document.body.createDiv({ cls: parent }).createDiv({ cls: child }).animate([], 200);
      expect(updateTiming).not.toHaveBeenCalled();
    });

    it.each([{ iterations: Infinity }, { duration: Infinity }])("preserves unbounded timing %j", (timing) => {
      const { updateTiming } = animationApi(window, timing);
      setup();
      document.body.createDiv().animate([], timing);
      expect(updateTiming).not.toHaveBeenCalled();
    });

    it("leaves custom timelines and animations without effects alone", () => {
      const { animation, updateTiming } = animationApi();
      setup();
      const target = document.body.createDiv();
      animation.timeline = {} as AnimationTimeline;
      target.animate([], 200);
      animation.timeline = null;
      target.animate([], 200);
      animation.timeline = document.timeline;
      animation.effect = null;
      target.animate([], 200);
      expect(updateTiming).not.toHaveBeenCalled();
    });

    it("preserves errors from the original method", () => {
      const { animate, updateTiming } = animationApi();
      const error = new TypeError("Invalid keyframes");
      animate.mockImplementationOnce(() => {
        throw error;
      });
      setup();
      expect(() => document.body.createDiv().animate([], 200)).toThrow(error);
      expect(updateTiming).not.toHaveBeenCalled();
    });

    it("restores the method and leaves saved wrappers inactive after cleanup", () => {
      const { prototype, animate, updateTiming } = animationApi();
      const descriptor = Object.getOwnPropertyDescriptor(prototype, "animate");
      const { handle } = setup();
      const saved = prototype.animate;

      handle.cleanup();

      expect(prototype.animate).toBe(animate);
      expect(Object.getOwnPropertyDescriptor(prototype, "animate")).toEqual(descriptor);
      saved.call(document.body, [], 200);
      expect(updateTiming).not.toHaveBeenCalled();
    });

    it("does not overwrite a later wrapper on cleanup", () => {
      const { prototype, updateTiming } = animationApi();
      const { handle } = setup();
      const saved = prototype.animate;
      const laterWrapper: Element["animate"] = function (this: Element, ...args): Animation {
        return saved.apply(this, args);
      };
      prototype.animate = laterWrapper;

      handle.cleanup();

      expect(prototype.animate).toBe(laterWrapper);
      document.body.animate([], 200);
      expect(updateTiming).not.toHaveBeenCalled();
    });

    it("wraps and restores each popout's own animation API", () => {
      const main = animationApi();
      const win = popout();
      const other = animationApi(win);
      const { app, handle, setEnabled } = setup();

      app.workspace.trigger("window-open", {}, win);
      win.document.body.animate([], 200);
      expect(other.updateTiming).toHaveBeenCalledOnce();
      expect(main.updateTiming).not.toHaveBeenCalled();

      setEnabled(false);
      expect(main.prototype.animate).toBe(main.animate);
      expect(other.prototype.animate).toBe(other.animate);
      setEnabled(true);
      app.workspace.trigger("window-close", {}, win);
      expect(other.prototype.animate).toBe(other.animate);
      expect(main.prototype.animate).not.toBe(main.animate);

      handle.cleanup();
      expect(main.prototype.animate).toBe(main.animate);
      app.workspace.trigger("window-open", {}, win);
      expect(other.prototype.animate).toBe(other.animate);
    });

    it("wraps a popout that was already open when the plugin loaded", () => {
      const app = App.createConfigured__();
      const win = popout();
      const { prototype, animate, updateTiming } = animationApi(win);
      win.document.body.append(app.workspace.openPopoutLeaf().view.containerEl);
      const { handle } = setup(app);
      expect(prototype.animate).toBe(animate);

      app.workspace.setLayoutReady__();
      win.document.body.animate([], 200);
      expect(updateTiming).toHaveBeenCalledOnce();

      handle.cleanup();
      expect(prototype.animate).toBe(animate);
    });
  });
});
