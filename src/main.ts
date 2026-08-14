import { type App, Plugin, PluginSettingTab, Setting } from "obsidian";
import type { Patch, PatchContext, PatchHandle } from "./patch";
import { basesAutoSearch } from "./patches/bases-auto-search";
import { cursorRepeatThrottle } from "./patches/cursor-repeat-throttle";
import { hideTrafficLights } from "./patches/hide-traffic-lights";
import { instantUi } from "./patches/instant-ui";
import { scrollOffset } from "./patches/scroll-offset";

const PATCHES: Patch[] = [cursorRepeatThrottle, scrollOffset, hideTrafficLights, basesAutoSearch, instantUi];

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
    for (const handle of this.handles.values()) handle.cleanup();
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

class MicropatchesSettingTab extends PluginSettingTab {
  private readonly plugin: MicropatchesPlugin;

  constructor(app: App, plugin: MicropatchesPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  override display(): void {
    const { containerEl } = this;
    containerEl.empty();

    for (const patch of PATCHES) {
      new Setting(containerEl)
        .setName(patch.name)
        .setDesc(patch.description)
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.enabled[patch.id] ?? true).onChange(async (value) => {
            await this.plugin.setPatchEnabled(patch.id, value);
          }),
        );

      patch.renderSettings?.(containerEl, this.plugin.contextFor(patch.id));
    }
  }
}
