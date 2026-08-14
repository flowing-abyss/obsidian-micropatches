import { Prec } from "@codemirror/state";
import { EditorView, type PluginValue, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { Plugin, SettingGroupItem } from "obsidian";
import type { Patch, PatchContext, PatchHandle } from "../patch";

interface Config {
  percentageMode: boolean;
  offset: number;
}

const DEFAULT_CONFIG: Config = { percentageMode: true, offset: 25 };

function calcRequiredOffset(container: HTMLElement, cursorHeight: number, config: Config): number {
  const maxOffset = (container.offsetHeight - cursorHeight) / 2;
  const requiredOffset = config.percentageMode ? (container.offsetHeight * config.offset) / 100 : config.offset;
  return Math.max(0, Math.min(requiredOffset, maxOffset));
}

function createExtension(getConfig: () => Config, isEnabled: () => boolean) {
  return Prec.highest(
    ViewPlugin.fromClass(
      class implements PluginValue {
        margin = 0;
        active = true;

        update(update: ViewUpdate): void {
          if (!update.selectionSet) return;
          const view = update.view;
          view.requestMeasure({
            read: () => view.coordsAtPos(view.state.selection.main.head),
            write: (cursor) => {
              if (!cursor) return;
              this.margin = this.active ? calcRequiredOffset(view.dom, cursor.bottom - cursor.top + 5, getConfig()) : 0;
            },
          });
        }
      },
      {
        // A click means the user is deliberately looking somewhere else;
        // don't yank the view back with a margin until they start typing
        // or navigating with the keyboard again.
        eventHandlers: {
          mousedown(): void {
            this.active = false;
          },
          keydown(): void {
            this.active = true;
          },
        },
        provide: (plugin) =>
          EditorView.scrollMargins.of((view) => {
            if (!isEnabled()) return null;
            const value = view.plugin(plugin);
            return value ? { top: value.margin, bottom: value.margin } : null;
          }),
      },
    ),
  );
}

/**
 * Replaces the third-party "Scroll Offset" plugin (unmaintained, last
 * touched mid-2025). That plugin registered the same idea twice: a clean
 * CM6 ViewPlugin using scrollMargins + requestMeasure (kept here, unchanged
 * in spirit), and a second, entirely dead code path through Obsidian's
 * legacy CodeMirror-5 compatibility layer (`registerCodeMirror` /
 * `cm.on("cursorActivity", ...)`) — `app.workspace.iterateCodeMirrors`
 * yields zero editors in current Obsidian, so that whole half of the
 * plugin's code never ran. This keeps only the real, active mechanism.
 *
 * Keeps a minimum distance between the cursor and the top/bottom edge of
 * the editor while typing or navigating, so the current line never sits
 * flush against the edge. Temporarily suspended right after a mouse click
 * (until the next keypress) so clicking somewhere doesn't yank the view.
 */
export const scrollOffset: Patch = {
  id: "scroll-offset",
  name: "Scroll offset",
  description:
    "Keeps a minimum distance between the cursor and the top/bottom of the editor. Suspended right after a mouse click so clicking doesn't yank the view; resumes on the next keypress.",

  register(plugin: Plugin, ctx: PatchContext): PatchHandle {
    const getConfig = (): Config => ({
      percentageMode: ctx.getConfig("percentageMode", DEFAULT_CONFIG.percentageMode),
      offset: ctx.getConfig("offset", DEFAULT_CONFIG.offset),
    });

    plugin.registerEditorExtension(createExtension(getConfig, () => ctx.isEnabled()));

    return { cleanup: (): void => {} };
  },

  settingDefinitions(_ctx: PatchContext, key: (configKey: string) => string): SettingGroupItem[] {
    return [
      {
        name: "Use percentage",
        desc: "On, distance is a percentage of the editor's height. Off, a fixed number of pixels.",
        control: {
          type: "toggle",
          key: key("percentageMode"),
          defaultValue: DEFAULT_CONFIG.percentageMode,
        },
      },
      {
        name: "Distance",
        desc: "Percent of editor height, or pixels if percentage mode is off. 0 disables the margin.",
        control: {
          type: "number",
          key: key("offset"),
          defaultValue: DEFAULT_CONFIG.offset,
          min: 0,
        },
      },
    ];
  },
};
