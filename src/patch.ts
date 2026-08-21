import type { Plugin, SettingGroupItem } from "obsidian";

export type Cleanup = () => void;

export interface PatchHandle {
  cleanup: Cleanup;
  onToggle?: (enabled: boolean) => void;
  onConfigChange?: (key: string, value: unknown) => void;
}

export interface PatchContext {
  isEnabled(): boolean;
  getConfig<T>(key: string, defaultValue: T): T;
  setConfig<T>(key: string, value: T): Promise<void>;
}

export interface Patch {
  id: string;
  name: string;
  description: string;
  register(plugin: Plugin, ctx: PatchContext): PatchHandle;
  /**
   * Optional extra settings, nested under this patch's enable toggle in the
   * declarative settings tab. `key` builds a config key namespaced to this
   * patch (e.g. key("offset") -> "scroll-offset.config.offset") for use in
   * each item's `control.key`.
   */
  settingDefinitions?(ctx: PatchContext, key: (configKey: string) => string): SettingGroupItem[];
}
