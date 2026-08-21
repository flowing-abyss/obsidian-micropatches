import { type App, Plugin, PluginSettingTab, type SettingDefinitionItem, type SettingGroupItem } from "obsidian";
import type { Patch, PatchContext, PatchHandle } from "./patch";
import { basesAutoSearch } from "./patches/bases-auto-search";
import { codeBlockTitle } from "./patches/code-block-title";
import { cursorRepeatThrottle } from "./patches/cursor-repeat-throttle";
import { hideTrafficLights } from "./patches/hide-traffic-lights";
import { inlineCodeCopy } from "./patches/inline-code-copy";
import { instantUi } from "./patches/instant-ui";
import { scrollOffset } from "./patches/scroll-offset";

const PATCHES: Patch[] = [
  cursorRepeatThrottle,
  scrollOffset,
  hideTrafficLights,
  basesAutoSearch,
  instantUi,
  codeBlockTitle,
  inlineCodeCopy,
];

// Bugfixes/replacements default on; anything that changes how the UI *feels*
// (not just fixing or replacing something) defaults off so it's an explicit
// opt-in.
const DEFAULT_OFF = new Set<string>([instantUi.id]);

interface MicropatchesSettings {
  enabled: Record<string, boolean>;
  config: Record<string, Record<string, unknown>>;
}

function defaultSettings(): MicropatchesSettings {
  return {
    enabled: Object.fromEntries(PATCHES.map((patch) => [patch.id, !DEFAULT_OFF.has(patch.id)])),
    config: {},
  };
}

export default class MicropatchesPlugin extends Plugin {
  override settings: MicropatchesSettings = defaultSettings();
  private handles = new Map<string, PatchHandle>();

  override async onload(): Promise<void> {
    await this.loadSettings();

    for (const patch of PATCHES) {
      const handle = patch.register(this, this.contextFor(patch.id));
      this.handles.set(patch.id, handle);
    }

    this.addSettingTab(new MicropatchesSettingTab(this.app, this));
  }

  override onunload(): void {
    for (const [id, handle] of this.handles) {
      try {
        handle.cleanup();
      } catch (error) {
        console.error(`Micropatches (${id}): cleanup failed`, error);
      }
    }
    this.handles.clear();
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) as Partial<MicropatchesSettings> | null;
    const defaults = defaultSettings();
    this.settings = {
      enabled: { ...defaults.enabled, ...(data?.enabled ?? {}) },
      config: { ...defaults.config, ...(data?.config ?? {}) },
    };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async setPatchEnabled(id: string, enabled: boolean): Promise<void> {
    this.settings.enabled[id] = enabled;
    await this.saveSettings();
    this.handles.get(id)?.onToggle?.(enabled);
  }

  async setPatchConfig(id: string, key: string, value: unknown): Promise<void> {
    await this.contextFor(id).setConfig(key, value);
    this.handles.get(id)?.onConfigChange?.(key, value);
  }

  contextFor(id: string): PatchContext {
    return {
      isEnabled: () => this.settings.enabled[id] ?? true,
      getConfig: <T>(key: string, defaultValue: T): T => {
        const value = this.settings.config[id]?.[key];
        return value === undefined ? defaultValue : (value as T);
      },
      setConfig: async <T>(key: string, value: T): Promise<void> => {
        this.settings.config[id] ??= {};
        this.settings.config[id][key] = value;
        await this.saveSettings();
      },
    };
  }
}

// Setting keys are namespaced as "<patchId>.enabled" and
// "<patchId>.config.<configKey>" so the tab's single flat getControlValue /
// setControlValue can route each change back to the right patch.
function parseKey(key: string): { patchId: string; kind: "enabled" | "config"; configKey: string } {
  const [patchId = "", kind = "", ...rest] = key.split(".");
  return { patchId, kind: kind === "config" ? "config" : "enabled", configKey: rest.join(".") };
}

class MicropatchesSettingTab extends PluginSettingTab {
  private readonly plugin: MicropatchesPlugin;

  constructor(app: App, plugin: MicropatchesPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  override getSettingDefinitions(): SettingDefinitionItem[] {
    return PATCHES.map((patch): SettingDefinitionItem => {
      const ctx = this.plugin.contextFor(patch.id);
      const toggle: SettingGroupItem = {
        name: patch.name,
        desc: patch.description,
        control: { type: "toggle", key: `${patch.id}.enabled`, defaultValue: !DEFAULT_OFF.has(patch.id) },
      };

      const extra = patch.settingDefinitions?.(ctx, (configKey) => `${patch.id}.config.${configKey}`) ?? [];
      if (extra.length === 0) return toggle;

      const items: SettingGroupItem[] = [
        toggle,
        ...extra.map((item): SettingGroupItem => ({ ...item, visible: () => ctx.isEnabled() })),
      ];
      return { type: "group", items };
    });
  }

  override getControlValue(key: string): unknown {
    const { patchId, kind, configKey } = parseKey(key);
    if (kind === "enabled") return this.plugin.settings.enabled[patchId];
    return this.plugin.settings.config[patchId]?.[configKey];
  }

  override async setControlValue(key: string, value: unknown): Promise<void> {
    const { patchId, kind, configKey } = parseKey(key);
    if (kind === "enabled") {
      await this.plugin.setPatchEnabled(patchId, Boolean(value));
    } else {
      await this.plugin.setPatchConfig(patchId, configKey, value);
    }
  }
}
