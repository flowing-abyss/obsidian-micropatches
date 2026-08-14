import type { Plugin } from "obsidian";

export type Cleanup = () => void;

export interface PatchHandle {
  cleanup: Cleanup;
  onToggle?: (enabled: boolean) => void;
}

export interface Patch {
  id: string;
  name: string;
  description: string;
  register(plugin: Plugin, isEnabled: () => boolean): PatchHandle;
}
