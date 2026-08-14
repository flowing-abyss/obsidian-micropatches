import type { Plugin } from "obsidian";

export type Cleanup = () => void;

export interface PatchHandle {
  cleanup: Cleanup;
  onToggle?: (enabled: boolean) => void;
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
  /** Optional extra settings UI, rendered right below the patch's on/off toggle. */
  renderSettings?(containerEl: HTMLElement, ctx: PatchContext): void;
}
