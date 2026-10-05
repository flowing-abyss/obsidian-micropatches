import type { BasesEntry, BasesEntryGroup, BasesPropertyId, PluginManifest } from "obsidian";
import { App, Component, NumberValue, Plugin, StringValue } from "obsidian-test-mocks/obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PatchContext, PatchHandle } from "../patch";
import { basesGroups, changeValue, groupRule, hasFileLookup } from "./bases-groups";

type Expression = NonNullable<NonNullable<Parameters<typeof groupRule>[1][string]>["formula"]>;
const ident = (id: string): Expression => ({ type: "ident", id });
const literal = (value: unknown): Expression => ({ type: "primitive", value });
const access = (object: string, index: string): Expression => ({ type: "object_access", object: ident(object), index });
const contains = (property: string, value: string): Expression => ({
  type: "function",
  name: "contains",
  subject: ident(property),
  args: [literal(value)],
});
const iff = (condition: Expression, label: unknown, otherwise: Expression): Expression => ({
  type: "function",
  name: "if",
  subject: null,
  args: [condition, literal(label), otherwise],
});
const equals = (property: string, value: unknown): Expression => ({
  type: "comparison",
  operator: "==",
  left: ident(property),
  right: literal(value),
});
const direct = { property: "status", mode: "direct" as const, branches: [] };
const kanban = iff(
  contains("status", "🟦"),
  "① In progress",
  iff(contains("status", "🟥"), "② Todo", iff(contains("status", "🟩"), "③ Done", literal("Other"))),
);

function ruleFor(expression: Expression) {
  const rule = groupRule("formula.kanban", { kanban: { formula: expression } });
  if (!rule) throw new Error("Expected a reversible formula");
  return rule;
}

describe("group property changes", () => {
  it.each([
    ["Todo", "Done", "Done"],
    [["Todo"], "Done", ["Done"]],
    ["Todo", ["Done"], "Done"],
    [
      ["A", "B"],
      ["C", "D"],
      ["C", "D"],
    ],
    [1, 0, 0],
    [true, false, false],
    ["1", "0", "0"],
    ["2026-01-01", "2026-12-31", "2026-12-31"],
    [["[[Projects/A]]"], ["[[Projects/B|Bee]]"], ["[[Projects/B|Bee]]"]],
    [undefined, ["Done"], ["Done"]],
    [["Todo"], null, null],
    ["None", "", ""],
    ["Todo", "None", "None"],
    [["Todo"], [], []],
  ])("keeps the stored value and type: %j → %j", (current, target, expected) => {
    expect(changeValue(direct, current, target)).toEqual({ value: expected });
  });

  it("does not squeeze a multi-value group into a text property", () => {
    expect(changeValue(direct, "A", ["B", "C"])).toHaveProperty("reason");
  });

  it("checks scalar types inside one-item list groups too", () => {
    expect(changeValue(direct, "Todo", [0])).toHaveProperty("reason");
    expect(changeValue(direct, false, ["Done"])).toHaveProperty("reason");
    expect(changeValue(direct, 3, [0])).toEqual({ value: 0 });
  });

  it("replaces a formula marker inside text, preserving surrounding text", () => {
    expect(changeValue(ruleFor(kanban), "  🟥 / review  ", "③ Done")).toEqual({ value: "  🟩 / review  " });
  });

  it("replaces all status markers while keeping unrelated list elements and their types", () => {
    const current = ["🟦", "review", "🟥", 42, false, "🟩"];
    expect(changeValue(ruleFor(kanban), current, "③ Done")).toEqual({ value: ["review", 42, false, "🟩"] });
    expect(current).toEqual(["🟦", "review", "🟥", 42, false, "🟩"]);
  });

  it("does not interpret punctuation as regex syntax or replace an inserted value again", () => {
    const expr = iff(contains("status", "a+b"), "A", iff(contains("status", "[x]"), "B", literal("Other")));
    expect(changeValue(ruleFor(expr), "a+b / [x] a+b", "B")).toEqual({ value: "[x] /  " });
  });

  it("matches native case-insensitive text contains without changing other text", () => {
    const expr = iff(contains("status", "todo"), "A", iff(contains("status", "done"), "B", literal("Other")));
    expect(changeValue(ruleFor(expr), "TODO / Review", "B")).toEqual({ value: "done / Review" });
  });

  it("does not remove typed list values that resemble string markers", () => {
    const expr = iff(contains("status", "false"), "A", iff(contains("status", "null"), "B", literal("Other")));
    expect(changeValue(ruleFor(expr), ["false", false, null, 0], "B")).toEqual({ value: [false, null, 0, "null"] });
  });

  it("adds an explicit marker to an empty value", () => {
    expect(changeValue(ruleFor(kanban), undefined, "③ Done")).toEqual({ value: "🟩" });
    expect(changeValue(ruleFor(kanban), [], "③ Done")).toEqual({ value: ["🟩"] });
  });

  it("does not invent a fallback value, replace unrelated text, or convert numbers to text", () => {
    const rule = ruleFor(kanban);
    expect(changeValue(rule, "🟥", "Other")).toHaveProperty("reason");
    expect(changeValue(rule, "custom status", "③ Done")).toHaveProperty("reason");
    expect(changeValue(rule, 1, "③ Done")).toHaveProperty("reason");
  });

  it("rejects duplicate output labels", () => {
    const expr = iff(contains("status", "a"), "Same", iff(contains("status", "b"), "Same", literal("Other")));
    expect(changeValue(ruleFor(expr), "a", "Same")).toHaveProperty("reason");
  });

  it("writes numeric equality branches as numbers", () => {
    const rule = ruleFor(iff(equals("score", 0), "Zero", iff(equals("score", 1), "One", literal("Other"))));
    expect(changeValue(rule, 1, "Zero")).toEqual({ value: 0 });
    expect(changeValue(rule, "1", "Zero")).toHaveProperty("reason");
  });

  it("supports both sides of boolean conditions without coercing text", () => {
    const rule = ruleFor(iff(ident("done"), "Yes", literal("No")));
    expect(changeValue(rule, true, "No")).toEqual({ value: false });
    expect(changeValue(rule, false, "Yes")).toEqual({ value: true });
    expect(changeValue(rule, "false", "Yes")).toHaveProperty("reason");
  });
});

describe("formula write rules", () => {
  it("resolves note properties, bracket access and formula aliases", () => {
    expect(groupRule("note.status", {})).toEqual(direct);
    expect(ruleFor(access("note", "status"))).toEqual(direct);
    expect(ruleFor({ type: "array_access", array: ident("note"), index: literal("my status") }).property).toBe(
      "my status",
    );
    expect(
      groupRule("formula.alias", { alias: { formula: access("formula", "kanban") }, kanban: { formula: kanban } }),
    ).toMatchObject({ property: "status", mode: "contains" });
  });

  it("rejects cycles, unknown syntax, file properties and multi-property formulas", () => {
    expect(groupRule("formula.a", { a: { formula: access("formula", "a") } })).toBeNull();
    expect(groupRule("file.name", {})).toBeNull();
    expect(groupRule("formula.unknown", {})).toBeNull();
    expect(
      groupRule("formula.a", { a: { formula: { type: "addition", left: ident("a"), right: ident("b") } } }),
    ).toBeNull();
    expect(
      groupRule("formula.a", {
        a: { formula: iff(contains("status", "a"), "A", iff(contains("priority", "b"), "B", literal("Other"))) },
      }),
    ).toBeNull();
  });
});

describe("file dependencies in projected sorting", () => {
  const formulas = {
    self: { formula: ident("FILE") },
    chain: { formula: access("formula", "sELf") },
    noteAlias: { formula: ident("note") },
    cycle: { formula: access("formula", "cycle") },
  };
  it("finds backlinks through file aliases, nested receivers and brackets", () => {
    for (const owner of [
      ident("file"),
      access("formula", "self"),
      access("formula", "chain"),
      { type: "array_access", array: ident("file"), index: literal("file") },
      { type: "function", name: "list", args: [access("formula", "self")] },
    ]) {
      expect(hasFileLookup({ type: "object_access", object: owner, index: "backlinks" }, formulas, false)).toBe(true);
    }
  });
  it("checks dynamic property access on a file alias", () => {
    expect(
      hasFileLookup({ type: "array_access", array: access("formula", "self"), index: ident("field") }, formulas, false),
    ).toBe(true);
  });
  it("rejects backlinks reached through a lambda value", () => {
    const mapped = {
      type: "function",
      name: "map",
      subject: { type: "function", name: "list", args: [ident("file")] },
      args: [{ type: "object_access", object: access("value", "backlinks"), index: "length" }],
    };
    expect(hasFileLookup(mapped, formulas, false)).toBe(true);
  });
  it("allows ordinary note properties named backlinks and terminates alias cycles", () => {
    expect(hasFileLookup(access("note", "backlinks"), formulas, false)).toBe(false);
    expect(
      hasFileLookup(
        { type: "object_access", object: access("formula", "noteAlias"), index: "backlinks" },
        formulas,
        false,
      ),
    ).toBe(false);
    expect(
      hasFileLookup({ type: "object_access", object: access("formula", "cycle"), index: "backlinks" }, formulas, false),
    ).toBe(false);
  });
});

class TestPlugin extends Plugin {}
const manifest: PluginManifest = {
  id: "micropatches",
  name: "Micropatches",
  author: "test",
  version: "0.0.0",
  minAppVersion: "1.13.0",
  description: "test",
};
const prefix = "micropatches-bases-groups";

function fakeBase(app: App) {
  const root = document.body.createDiv();
  root.createDiv("bases-toolbar").createDiv("bases-toolbar-sort-menu");
  const viewContainerEl = root.createDiv("bases-view");
  const content = viewContainerEl.createDiv("bases-table-container");
  const source: BasesEntryGroup[] = ["A", "B"].map((name) => ({
    key: StringValue.create__(name).asOriginalType__(),
    entries: [{ file: { path: `${name}.md`, basename: name, extension: "md" } } as BasesEntry],
    hasKey: () => true,
  }));
  const data = {
    data: source.flatMap((group) => group.entries),
    groupedDataCache: source,
    get groupedData() {
      return this.groupedDataCache;
    },
  };
  const view = {
    type: "table",
    config: { groupBy: { property: "formula.label" as BasesPropertyId } },
    data,
    scrollEl: viewContainerEl,
    groups: [] as Array<{ tableEl: HTMLElement; tbodyEl: HTMLElement }>,
    rows: [] as Array<{ el: HTMLElement; entry: BasesEntry }>,
    displayed: [] as number[],
    display: vi.fn(() => {
      content.empty();
      view.groups = data.groupedData.map((group) => {
        const tableEl = content.createDiv("bases-table");
        tableEl.createDiv("bases-group-heading").createSpan({ text: group.key?.toString() ?? "Empty" });
        return { tableEl, tbodyEl: tableEl.createDiv("bases-tbody") };
      });
      view.updateVirtualDisplay();
    }),
    updateVirtualDisplay: vi.fn(() => {
      view.rows = [];
      view.displayed = data.groupedData.map((group, index) => {
        const body = view.groups[index]?.tbodyEl;
        body?.empty();
        for (const entry of group.entries) {
          const el = body?.createDiv("bases-tr");
          if (!el) continue;
          el.createDiv("bases-td");
          view.rows.push({ el, entry });
        }
        return group.entries.length;
      });
    }),
  };
  const controller = Object.assign(new Component(), {
    query: { file: "Test.base" },
    viewName: "Table",
    viewContainerEl,
    view,
    applySearchQuery: (entries: BasesEntry[]) => entries,
  });
  controller.load();
  app.vault.on("config-changed", () => undefined, controller);
  return { controller, view, source, root };
}

describe("group rendering and lifecycle", () => {
  let app: App;
  let enabled: boolean;
  let handle: PatchHandle;
  let plugin: TestPlugin;

  beforeEach(() => {
    app = App.createConfigured__();
    enabled = true;
    plugin = new TestPlugin(app, manifest);
    const ctx: PatchContext = {
      isEnabled: () => enabled,
      getConfig: <T>(_key: string, fallback: T) => fallback,
      setConfig: () => Promise.resolve(),
    };
    handle = basesGroups.register(plugin.asOriginalType2__(), ctx);
  });
  afterEach(() => {
    handle.cleanup();
    plugin.unload();
    document.body.empty();
    Reflect.deleteProperty(document, "elementFromPoint");
  });

  const fold = (base: ReturnType<typeof fakeBase>, index = 0) => {
    base.view.groups[index]?.tableEl.querySelector<HTMLButtonElement>(`.${prefix}-toggle`)?.click();
  };

  it("folds formula groups in the render model, preserving query entries and prototypes", () => {
    const base = fakeBase(app);
    app.workspace.setLayoutReady__();
    fold(base);
    expect(base.view.displayed).toEqual([0, 1]);
    expect(base.view.data.groupedData).toBe(base.source);
    expect(base.source[0]?.entries).toHaveLength(1);
    expect(base.view.data.data).toHaveLength(2);
    expect(base.view.groups[0]?.tableEl.querySelector("button")?.getAttribute("aria-expanded")).toBe("false");
    base.view.updateVirtualDisplay();
    expect(base.view.displayed).toEqual([0, 1]);
    fold(base);
    expect(base.view.displayed).toEqual([1, 1]);
  });

  it("keeps identities separate when labels match but value types differ", () => {
    const base = fakeBase(app);
    Object.assign(base.source[0] ?? {}, { key: StringValue.create__("1").asOriginalType__() });
    Object.assign(base.source[1] ?? {}, { key: NumberValue.create__(1).asOriginalType__() });
    app.workspace.setLayoutReady__();
    fold(base);
    expect(base.view.displayed).toEqual([0, 1]);
  });

  it("keeps different bases, views and grouping properties independent", () => {
    const a = fakeBase(app);
    const b = fakeBase(app);
    app.workspace.setLayoutReady__();
    fold(a);
    expect(b.view.displayed).toEqual([1, 1]);
    a.controller.viewName = "Other view";
    a.view.display();
    expect(a.view.displayed).toEqual([1, 1]);
    a.controller.viewName = "Table";
    a.view.config.groupBy.property = "note.status";
    a.view.display();
    expect(a.view.displayed).toEqual([1, 1]);
    a.view.config.groupBy.property = "formula.label";
    a.view.display();
    expect(a.view.displayed).toEqual([0, 1]);
  });

  it("uses one button before Sort and collapses mixed groups before expanding all", () => {
    const base = fakeBase(app);
    app.workspace.setLayoutReady__();
    const actions = base.root.querySelector(`.${prefix}-actions`);
    const button = actions?.querySelector("button");
    expect(actions?.querySelectorAll("button")).toHaveLength(1);
    expect(actions?.nextElementSibling?.className).toBe("bases-toolbar-sort-menu");
    fold(base);
    expect(base.view.displayed).toEqual([0, 1]);
    expect(button?.getAttribute("aria-label")).toBe("Collapse all groups");
    button?.click();
    expect(base.view.displayed).toEqual([0, 0]);
    expect(button?.getAttribute("aria-label")).toBe("Expand all groups");
    button?.click();
    expect(base.view.displayed).toEqual([1, 1]);
    expect(button?.getAttribute("aria-label")).toBe("Collapse all groups");
    expect(base.view.data.groupedData).toBe(base.source);
    expect(base.source.map((group) => group.entries.length)).toEqual([1, 1]);
  });

  it("updates the all-groups button after individual group clicks and disables it for no results", () => {
    const base = fakeBase(app);
    app.workspace.setLayoutReady__();
    const button = base.root.querySelector<HTMLButtonElement>(`.${prefix}-actions button`);
    fold(base, 0);
    fold(base, 1);
    expect(button?.getAttribute("aria-label")).toBe("Expand all groups");
    fold(base, 1);
    expect(button?.getAttribute("aria-label")).toBe("Collapse all groups");
    base.source.length = 0;
    base.view.display();
    expect(button?.disabled).toBe(true);
  });

  it("folds from the whole heading, its text, and the arrow without toggling twice", () => {
    const base = fakeBase(app);
    app.workspace.setLayoutReady__();
    const heading = () => base.view.groups[0]?.tableEl.querySelector<HTMLElement>(".bases-group-heading");
    heading()?.click();
    expect(base.view.displayed).toEqual([0, 1]);
    heading()?.querySelector("span")?.click();
    expect(base.view.displayed).toEqual([1, 1]);
    fold(base);
    expect(base.view.displayed).toEqual([0, 1]);
    enabled = false;
    handle.onToggle?.(false);
    heading()?.click();
    expect(base.view.displayed).toEqual([1, 1]);
  });

  it("preserves links, controls and modified clicks inside group headings", () => {
    const base = fakeBase(app);
    app.workspace.setLayoutReady__();
    const heading = base.view.groups[0]?.tableEl.querySelector<HTMLElement>(".bases-group-heading");
    heading?.createEl("a", { text: "Linked note", href: "#" }).click();
    heading?.createEl("button", { text: "Another control" }).click();
    for (const init of [{ ctrlKey: true }, { metaKey: true }, { altKey: true }, { shiftKey: true }, { button: 1 }]) {
      heading?.dispatchEvent(new MouseEvent("click", { bubbles: true, ...init }));
    }
    expect(base.view.displayed).toEqual([1, 1]);
  });

  it("folds and drags inside a non-editable widget in a Live Preview editor", () => {
    const base = fakeBase(app);
    const editor = document.body.createDiv({ attr: { contenteditable: "true" } });
    editor.append(base.root);
    base.root.setAttribute("contenteditable", "false");
    // jsdom does not implement the browser's isContentEditable property.
    Object.defineProperty(editor, "isContentEditable", { value: true });
    Object.defineProperty(base.root, "isContentEditable", { value: false });
    app.workspace.setLayoutReady__();
    base.view.groups[0]?.tableEl.querySelector<HTMLElement>(".bases-group-heading span")?.click();
    expect(base.view.displayed).toEqual([0, 1]);
    fold(base);
    const cell = base.view.rows[0]?.el.querySelector<HTMLElement>(".bases-td");
    const request = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    cell?.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: 10 }));
    document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 30 }));
    expect(request).toHaveBeenCalledOnce();
  });

  it("starts a different base expanded on its first render", () => {
    const base = fakeBase(app);
    app.workspace.setLayoutReady__();
    fold(base);
    base.controller.query.file = "Other.base";
    base.view.display();
    expect(base.view.displayed).toEqual([1, 1]);
  });

  it("does not add controls or change cell padding, including pooled rows", () => {
    const base = fakeBase(app);
    app.workspace.setLayoutReady__();
    const pooled = base.view.rows[0]?.el;
    expect(pooled?.querySelector("button")).toBeNull();
    expect(pooled?.querySelector<HTMLElement>(".bases-td")?.style.paddingInlineEnd).toBe("");
    pooled?.remove();
    enabled = false;
    handle.onToggle?.(false);
    expect(pooled?.querySelector("button")).toBeNull();
  });

  it("restores methods, rows and DOM on toggle and can enable again", () => {
    const base = fakeBase(app);
    const display = base.view.display;
    const update = base.view.updateVirtualDisplay;
    app.workspace.setLayoutReady__();
    fold(base);
    enabled = false;
    handle.onToggle?.(false);
    expect(base.view.display).toBe(display);
    expect(base.view.updateVirtualDisplay).toBe(update);
    expect(base.view.displayed).toEqual([1, 1]);
    expect(document.querySelector(`[class*="${prefix}"]`)).toBeNull();
    enabled = true;
    handle.onToggle?.(true);
    expect(base.root.querySelectorAll(`.${prefix}-toggle`)).toHaveLength(2);
  });

  it("stays inert when initially disabled, including late layout callbacks after cleanup", () => {
    const base = fakeBase(app);
    const display = base.view.display;
    enabled = false;
    app.workspace.setLayoutReady__();
    expect(base.view.display).toBe(display);
    handle.cleanup();
    enabled = true;
    handle.onToggle?.(true);
    expect(base.view.display).toBe(display);
  });

  it("restores the cache when native rendering throws", () => {
    const base = fakeBase(app);
    base.view.updateVirtualDisplay.mockImplementation(() => {
      throw new Error("render failed");
    });
    expect(() => {
      app.workspace.setLayoutReady__();
    }).toThrow("render failed");
    expect(base.view.data.groupedData).toBe(base.source);
    base.view.updateVirtualDisplay = vi.fn();
  });

  it("cleans up when its controller unloads", () => {
    const base = fakeBase(app);
    const display = base.view.display;
    app.workspace.setLayoutReady__();
    fold(base);
    base.controller.unload();
    expect(base.view.display).toBe(display);
    expect(base.root.querySelector(`[class*="${prefix}"]`)).toBeNull();
  });

  it("reuses the folded model and skips group headers during virtual scrolling", () => {
    const base = fakeBase(app);
    const native = base.view.updateVirtualDisplay;
    const render = native.getMockImplementation();
    const models: BasesEntryGroup[][] = [];
    native.mockImplementation(() => {
      models.push(base.view.data.groupedData);
      render?.();
    });
    app.workspace.setLayoutReady__();
    fold(base);
    const foldedModel = models[models.length - 1];
    const heading = base.view.groups[0]?.tableEl.querySelector<HTMLButtonElement>(`.${prefix}-toggle`);
    if (!heading) throw new Error("Expected a group heading");
    const attributes = vi.spyOn(heading, "setAttribute");
    const contains = base.view.groups.map((group) => vi.spyOn(group.tbodyEl, "contains"));
    base.view.updateVirtualDisplay();
    base.view.updateVirtualDisplay();
    expect(models[models.length - 1]).toBe(foldedModel);
    expect(models[models.length - 2]).toBe(foldedModel);
    expect(attributes).not.toHaveBeenCalled();
    for (const lookup of contains) expect(lookup).not.toHaveBeenCalled();
    expect(base.view.data.groupedData).toBe(base.source);
  });

  it("leaves a later wrapper intact without redecorating through its stale wrapper", () => {
    const base = fakeBase(app);
    app.workspace.setLayoutReady__();
    const wrapped = base.view.display;
    const later = vi.fn(() => {
      wrapped();
    });
    base.view.display = later;
    enabled = false;
    handle.onToggle?.(false);
    expect(base.view.display).toBe(later);
    later();
    expect(base.root.querySelector(`[class*="${prefix}"]`)).toBeNull();
    enabled = true;
    handle.onToggle?.(true);
    expect(base.root.querySelectorAll(`.${prefix}-toggle`)).toHaveLength(2);
    expect(base.root.querySelectorAll(`.${prefix}-actions`)).toHaveLength(1);
    enabled = false;
    handle.onToggle?.(false);
    expect(base.view.display).toBe(later);
    expect(base.root.querySelector(`[class*="${prefix}"]`)).toBeNull();
  });

  it("coalesces pointer moves and synchronously uses the release position", () => {
    const base = fakeBase(app);
    app.workspace.setLayoutReady__();
    const grip = base.view.rows[0]?.el.querySelector<HTMLElement>(".bases-td");
    if (!grip) throw new Error("Expected a row cell");
    const hit = vi.fn(() => base.view.groups[1]?.tableEl ?? null);
    Object.defineProperty(document, "elementFromPoint", { value: hit, configurable: true });
    const request = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(7);
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    const pointer = (type: string, x: number) =>
      new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientX: x, clientY: 20 });
    grip.dispatchEvent(pointer("pointerdown", 10));
    document.dispatchEvent(pointer("pointermove", 30));
    document.dispatchEvent(pointer("pointermove", 50));
    expect(request).toHaveBeenCalledTimes(1);
    expect(hit).not.toHaveBeenCalled();
    document.dispatchEvent(pointer("pointerup", 70));
    expect(cancel).toHaveBeenCalledWith(7);
    expect(hit).toHaveBeenCalledExactlyOnceWith(70, 20);
    expect(document.querySelector(`.${prefix}-preview`)).toBeNull();
  });

  it("leaves clicks and small movements native, but takes over a dragged row", () => {
    const base = fakeBase(app);
    app.workspace.setLayoutReady__();
    const cell = base.view.rows[0]?.el.querySelector<HTMLElement>(".bases-td");
    if (!cell) throw new Error("Expected a row cell");
    const grip = cell.createSpan({ text: "A", attr: { draggable: "true" } });
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => frames.push(callback));
    Object.defineProperty(document, "elementFromPoint", { value: () => null, configurable: true });
    const pointer = (type: string, x: number) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerType: "mouse",
        pointerId: 1,
        button: 0,
        clientX: x,
      });
    const down = pointer("pointerdown", 10);
    grip.dispatchEvent(down);
    expect(down.defaultPrevented).toBe(false);
    const smallMove = pointer("pointermove", 13);
    document.dispatchEvent(smallMove);
    expect(smallMove.defaultPrevented).toBe(false);
    expect(frames).toHaveLength(0);
    const start = new MouseEvent("dragstart", { bubbles: true, cancelable: true });
    grip.dispatchEvent(start);
    expect(start.defaultPrevented).toBe(true);
    document.dispatchEvent(pointer("pointermove", 30));
    expect(frames).toHaveLength(1);
    frames[0]?.(0);
    expect(document.querySelector(`.${prefix}-preview`)).not.toBeNull();
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector(`.${prefix}-preview`)).toBeNull();
    const releaseClick = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
    grip.dispatchEvent(releaseClick);
    expect(releaseClick.defaultPrevented).toBe(true);
    grip.dispatchEvent(pointer("pointerdown", 10));
    document.dispatchEvent(pointer("pointerup", 10));
    const click = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
    grip.dispatchEvent(click);
    expect(click.defaultPrevented).toBe(false);
    enabled = false;
    handle.onToggle?.(false);
    const nativeDrag = new MouseEvent("dragstart", { bubbles: true, cancelable: true });
    grip.dispatchEvent(nativeDrag);
    expect(nativeDrag.defaultPrevented).toBe(false);
  });

  it.each(["span", "a"] as const)("preserves native %s link dragging to targets outside the table", (tag) => {
    const base = fakeBase(app);
    app.workspace.setLayoutReady__();
    const cell = base.view.rows[0]?.el.querySelector<HTMLElement>(".bases-td");
    if (!cell) throw new Error("Expected a row cell");
    const link = cell.createEl(tag, {
      ...(tag === "span" ? { cls: "internal-link" } : {}),
      attr: { draggable: "true", href: "#A" },
    });
    const label = link.createSpan({ text: "A" });
    const request = vi.spyOn(window, "requestAnimationFrame");
    const onDragStart = vi.fn();
    const controller = new AbortController();
    document.addEventListener("dragstart", onDragStart, { signal: controller.signal });
    try {
      label.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: 10 }));
      const move = new PointerEvent("pointermove", { bubbles: true, cancelable: true, pointerId: 1, clientX: 30 });
      document.dispatchEvent(move);
      const start = new MouseEvent("dragstart", { bubbles: true, cancelable: true });
      link.dispatchEvent(start);
      expect(move.defaultPrevented).toBe(false);
      expect(start.defaultPrevented).toBe(false);
      expect(onDragStart).toHaveBeenCalledOnce();
      expect(request).not.toHaveBeenCalled();
      expect(document.querySelector(`.${prefix}-preview`)).toBeNull();
      document.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1, clientX: 30 }));
      const click = new MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 });
      label.dispatchEvent(click);
      expect(click.defaultPrevented).toBe(false);
    } finally {
      controller.abort();
    }
  });

  it("preserves touch scrolling, modified selection, and editing controls", () => {
    const base = fakeBase(app);
    app.workspace.setLayoutReady__();
    const cell = base.view.rows[0]?.el.querySelector<HTMLElement>(".bases-td");
    if (!cell) throw new Error("Expected a row cell");
    const request = vi.spyOn(window, "requestAnimationFrame");
    const move = () =>
      document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 50 }));
    for (const init of [
      { pointerType: "touch" },
      { shiftKey: true },
      { metaKey: true },
      { ctrlKey: true },
      { altKey: true },
    ]) {
      cell.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, ...init }));
      move();
    }
    const editors = ["true", "", "plaintext-only"].map((contenteditable) => {
      const editor = cell.createDiv({ attr: { contenteditable } });
      Object.defineProperty(editor, "isContentEditable", { value: true });
      return editor;
    });
    const controls = [
      cell.createEl("input"),
      cell.createEl("button"),
      ...editors,
      cell.createDiv("multi-select-pill-remove-button"),
    ];
    for (const control of controls) {
      control.tabIndex = 0;
      control.focus();
      control.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0 }));
      move();
    }
    expect(request).not.toHaveBeenCalled();
    expect(document.querySelector(`.${prefix}-preview`)).toBeNull();
  });

  it("can drag an idle text property before its contenteditable editor gains focus", () => {
    const base = fakeBase(app);
    app.workspace.setLayoutReady__();
    const cell = base.view.rows[0]?.el.querySelector<HTMLElement>(".bases-td");
    if (!cell) throw new Error("Expected a row cell");
    const editor = cell.createDiv({ attr: { contenteditable: "true", tabindex: "0" } });
    Object.defineProperty(editor, "isContentEditable", { value: true });
    const text = editor.createSpan({ text: "Todo" });
    const request = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
    text.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: 10 }));
    editor.focus();
    document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 30 }));
    expect(request).toHaveBeenCalledOnce();
  });

  it("cancels a pending drag frame when disabled", () => {
    const base = fakeBase(app);
    app.workspace.setLayoutReady__();
    const grip = base.view.rows[0]?.el.querySelector<HTMLElement>(".bases-td");
    if (!grip) throw new Error("Expected a row cell");
    const request = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(9);
    const cancel = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => undefined);
    grip.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: 10 }));
    document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 30 }));
    expect(request).toHaveBeenCalledTimes(1);
    enabled = false;
    handle.onToggle?.(false);
    expect(cancel).toHaveBeenCalledWith(9);
    expect(document.querySelector(`[class*="${prefix}"]`)).toBeNull();
  });

  it("removes the drag class after virtualization replaces the source row", () => {
    const base = fakeBase(app);
    app.workspace.setLayoutReady__();
    const grip = base.view.rows[0]?.el.querySelector<HTMLElement>(".bases-td");
    if (!grip) throw new Error("Expected a row cell");
    Object.defineProperty(document, "elementFromPoint", {
      value: () => base.view.groups[1]?.tableEl ?? null,
      configurable: true,
    });
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => frames.push(callback));
    grip.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1, button: 0, clientX: 10 }));
    document.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 30 }));
    frames[0]?.(0);
    expect(base.root.querySelectorAll(`.${prefix}-dragging`)).toHaveLength(1);
    base.view.updateVirtualDisplay();
    expect(base.root.querySelectorAll(`.${prefix}-dragging`)).toHaveLength(1);
    document.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1 }));
    expect(base.root.querySelector(`.${prefix}-dragging`)).toBeNull();
  });
});
