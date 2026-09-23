import type { PluginManifest } from "obsidian";
import { App, Plugin } from "obsidian-test-mocks/obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import MicropatchesPlugin from "./main";

const manifest: PluginManifest = {
  id: "micropatches",
  name: "Micropatches",
  author: "test",
  version: "0.0.0",
  minAppVersion: "1.13.0",
  description: "test",
};

async function load(data: unknown = null): Promise<{ plugin: MicropatchesPlugin; mock: Plugin }> {
  const app = App.createConfigured__();
  const plugin = new MicropatchesPlugin(app.asOriginalType__(), manifest);
  const mock = Plugin.fromOriginalType2__(plugin);
  mock.data__ = data;
  await plugin.onload();
  return { plugin, mock };
}

// Patches may add commands of their own; every patch has a toggle.
function toggles(mock: Plugin): Array<{ id: string; name: string }> {
  return Array.from(mock.commands__.values()).filter(({ id }) => id.startsWith("toggle-"));
}

function patchIds(mock: Plugin): string[] {
  return toggles(mock).map(({ id }) => id.slice("toggle-".length));
}

// Anything a patch leaves in the page: its classes, elements and styles.
function traces(): string[] {
  const found = new Set<string>();
  for (const el of [document.documentElement, ...Array.from(document.querySelectorAll("*"))]) {
    for (const name of Array.from(el.classList)) if (name.includes("micropatches")) found.add(`.${name}`);
    if (el.id.includes("micropatches")) found.add(`#${el.id}`);
  }
  return Array.from(found);
}

describe("Micropatches", () => {
  beforeEach(() => {
    // jsdom has no ResizeObserver; footnote sidenotes create one per window.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe(): void {}
        unobserve(): void {}
        disconnect(): void {}
      },
    );
  });

  afterEach(() => {
    document.body.className = "";
    document.body.empty();
  });

  it("starts with every patch off", async () => {
    const { plugin, mock } = await load();

    expect(new Set(Object.keys(plugin.settings.enabled))).toEqual(new Set(patchIds(mock)));
    expect(Object.values(plugin.settings.enabled).every((enabled) => !enabled)).toBe(true);
    plugin.onunload();
  });

  it("keeps saved choices over the defaults", async () => {
    const { plugin } = await load({ enabled: { "instant-ui": true }, config: { "scroll-offset": { offset: 7 } } });

    expect(plugin.settings.enabled["instant-ui"]).toBe(true);
    expect(plugin.settings.enabled["focus-mode"]).toBe(false);
    expect(plugin.contextFor("scroll-offset").getConfig("offset", 0)).toBe(7);
    plugin.onunload();
  });

  it("has one toggle command per patch, with unique ids", async () => {
    const { plugin, mock } = await load();

    const ids = patchIds(mock);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z]+(?:-[a-z]+)*$/);
    for (const { name } of toggles(mock)) expect(name).toMatch(/^Toggle \S/);
    plugin.onunload();
  });

  it("applies and saves a toggle at once", async () => {
    const { plugin, mock } = await load();

    await plugin.setPatchEnabled("instant-ui", true);
    expect(document.body.classList.contains("micropatches-instant-ui")).toBe(true);
    expect(mock.data__).toMatchObject({ enabled: { "instant-ui": true } });

    await plugin.setPatchEnabled("instant-ui", false);
    expect(document.body.classList.contains("micropatches-instant-ui")).toBe(false);
    expect(mock.data__).toMatchObject({ enabled: { "instant-ui": false } });
    plugin.onunload();
  });

  it("stores patch settings under the patch's id", async () => {
    const { plugin, mock } = await load();

    await plugin.setPatchConfig("scroll-offset", "offset", 5);

    expect(plugin.contextFor("scroll-offset").getConfig("offset", 0)).toBe(5);
    expect(mock.data__).toMatchObject({ config: { "scroll-offset": { offset: 5 } } });
    plugin.onunload();
  });

  it("routes settings tab keys to the patch they name", async () => {
    const { plugin, mock } = await load();
    const tab = mock.settingTabs__[0] as unknown as {
      getControlValue(key: string): unknown;
      setControlValue(key: string, value: unknown): Promise<void>;
    };

    await tab.setControlValue("scroll-offset.enabled", true);
    await tab.setControlValue("scroll-offset.config.offset", 12);

    expect(tab.getControlValue("scroll-offset.enabled")).toBe(true);
    expect(tab.getControlValue("scroll-offset.config.offset")).toBe(12);
    expect(plugin.settings.enabled["scroll-offset"]).toBe(true);
    plugin.onunload();
  });

  it("leaves nothing behind after unloading with every patch on", async () => {
    const first = await load();
    const enabled = Object.fromEntries(patchIds(first.mock).map((id) => [id, true]));
    first.plugin.onunload();
    const before = traces();
    const { plugin } = await load({ enabled });

    expect(traces().length).toBeGreaterThan(before.length);
    plugin.onunload();
    expect(traces()).toEqual(before);
  });
});
