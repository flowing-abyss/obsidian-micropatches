import { type App, Plugin, PluginSettingTab, Setting } from "obsidian";
import type { Patch, PatchHandle } from "./patch";
import { cursorRepeatThrottle } from "./patches/cursor-repeat-throttle";
import { hideTrafficLights } from "./patches/hide-traffic-lights";

const PATCHES: Patch[] = [cursorRepeatThrottle, hideTrafficLights];

interface MicropatchesSettings {
  enabled: Record<string, boolean>;
}

function defaultSettings(): MicropatchesSettings {
  return { enabled: Object.fromEntries(PATCHES.map((patch) => [patch.id, true])) };
}

export default class MicropatchesPlugin extends Plugin {
  override settings: MicropatchesSettings = defaultSettings();
  private handles = new Map<string, PatchHandle>();

  override async onload(): Promise<void> {
    await this.loadSettings();

    for (const patch of PATCHES) {
      const handle = patch.register(this, () => this.settings.enabled[patch.id] ?? true);
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
    this.settings = { enabled: { ...defaultSettings().enabled, ...(data?.enabled ?? {}) } };
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async setPatchEnabled(id: string, enabled: boolean): Promise<void> {
    this.settings.enabled[id] = enabled;
    await this.saveSettings();
    this.handles.get(id)?.onToggle?.(enabled);
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
    }
  }
}
