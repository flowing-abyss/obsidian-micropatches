import {
  type App,
  type ButtonComponent,
  FuzzySuggestModal,
  Notice,
  type Plugin,
  type SettingGroupItem,
} from "obsidian";
import type { Patch, PatchContext, PatchHandle } from "../patch";

type Corner = "topLeft" | "topRight" | "bottomLeft" | "bottomRight";
type Modifier = "shift" | "ctrl" | "alt" | "meta";

interface CommandLike {
  id: string;
  name: string;
}

interface AppWithCommands extends App {
  commands: {
    commands: Record<string, CommandLike>;
    executeCommandById(id: string): boolean;
  };
}

const DEFAULT_MODIFIER: Modifier = "shift";
// Distances from the corner point, in px. Inside HINT_RADIUS the corner glows
// brighter the closer the pointer gets; inside TRIGGER_RADIUS it fires.
export const TRIGGER_RADIUS = 64;
export const HINT_RADIUS = 240;
const GLOW_CLASS = "micropatches-hot-corner";

const MODIFIER_OPTIONS: Record<Modifier, string> = {
  shift: "Shift",
  ctrl: "Ctrl",
  alt: "Alt / Option",
  meta: "Cmd / Win",
};

const MODIFIER_KEYS: Record<Modifier, string> = {
  shift: "Shift",
  ctrl: "Control",
  alt: "Alt",
  meta: "Meta",
};

const CORNERS: Record<Corner, string> = {
  topLeft: "Top-left corner",
  topRight: "Top-right corner",
  bottomLeft: "Bottom-left corner",
  bottomRight: "Bottom-right corner",
};

interface WindowState {
  glow: HTMLElement | null;
  hide: () => void;
  onMove: (event: MouseEvent) => void;
  onKeyup: (event: KeyboardEvent) => void;
}

export function modifierHeld(event: MouseEvent, modifier: Modifier): boolean {
  if (modifier === "shift") return event.shiftKey;
  if (modifier === "ctrl") return event.ctrlKey;
  if (modifier === "alt") return event.altKey;
  return event.metaKey;
}

export function nearestCorner(win: Window, x: number, y: number): { corner: Corner; distance: number } {
  const right = x > win.innerWidth / 2;
  const bottom = y > win.innerHeight / 2;
  const dx = right ? win.innerWidth - 1 - x : x;
  const dy = bottom ? win.innerHeight - 1 - y : y;
  let corner: Corner;
  if (bottom) corner = right ? "bottomRight" : "bottomLeft";
  else corner = right ? "topRight" : "topLeft";
  return { corner, distance: Math.hypot(dx, dy) };
}

// "QuickAdd: Create note" -> "Create note": the glow label names the action,
// not the plugin it comes from.
export function commandLabel(name: string): string {
  const separator = name.indexOf(": ");
  return separator === -1 ? name : name.slice(separator + 2);
}

class CommandSuggestModal extends FuzzySuggestModal<CommandLike | null> {
  // getItems() runs on every keystroke; the modal is short-lived, so the
  // sorted list is built once.
  private readonly items: Array<CommandLike | null>;

  constructor(
    app: AppWithCommands,
    private readonly onChoose: (command: CommandLike | null) => void,
  ) {
    super(app);
    this.items = [null, ...Object.values(app.commands.commands).sort((a, b) => a.name.localeCompare(b.name))];
    this.setPlaceholder("Choose a command for this corner…");
  }

  override getItems(): Array<CommandLike | null> {
    return this.items;
  }

  override getItemText(command: CommandLike | null): string {
    return command?.name ?? "None";
  }

  override onChooseItem(command: CommandLike | null): void {
    this.onChoose(command);
  }
}

/**
 * Hot corners: moving the mouse into a corner of the Obsidian window while a
 * modifier key is held runs the command assigned to that corner. While the
 * modifier is held, a corner that has a command glows as the pointer comes
 * within HINT_RADIUS (brighter the closer it gets) and fires once the pointer
 * is within TRIGGER_RADIUS. A small label next to the arc names the command.
 *
 * A corner only fires on a deliberate approach: the pointer must have been
 * seen outside the trigger zone with the modifier already held and no mouse
 * button down. Pressing the modifier while the pointer is parked in a corner
 * (typing capitals, Shift-clicking the status bar) and Shift-dragging a text
 * selection toward a corner never fire. After firing, the corner goes dark
 * and stays inert until the pointer leaves the hint radius, moves to another
 * corner, or the modifier is released.
 */
export const hotCorners: Patch = {
  id: "hot-corners",
  name: "Hot corners",
  description:
    "Runs a command when the mouse enters a corner of the window while a modifier key (Shift by default) is held. Corners with a command glow as the pointer approaches.",

  register(plugin: Plugin, ctx: PatchContext): PatchHandle {
    const app = plugin.app as AppWithCommands;
    const windows = new Map<Window, WindowState>();

    const setupWindow = (win: Window): void => {
      if (windows.has(win)) return;

      let armed = false;
      let spent: Corner | null = null;
      let visible = false;

      // Runs on every mouse move in the app, so it must stay DOM-free
      // unless the glow is actually showing.
      const hide = (): void => {
        if (!visible) return;
        visible = false;
        state.glow?.removeClasses(["is-visible", "is-fired"]);
      };

      const show = (corner: Corner, commandId: string, proximity: number, fired: boolean): void => {
        if (!state.glow) {
          state.glow = win.document.body.createDiv({ cls: GLOW_CLASS });
          state.glow.createSpan({ cls: `${GLOW_CLASS}-label` });
        }
        state.glow.dataset["corner"] = corner;
        state.glow.setCssProps({
          "--micropatches-hot-corner-size": `${HINT_RADIUS}px`,
          "--micropatches-hot-corner-trigger": `${TRIGGER_RADIUS}px`,
          "--micropatches-hot-corner-proximity": proximity.toFixed(3),
        });
        if (state.glow.dataset["command"] !== commandId) {
          state.glow.dataset["command"] = commandId;
          state.glow.firstElementChild?.setText(commandLabel(app.commands.commands[commandId]?.name ?? ""));
        }
        state.glow.addClass("is-visible");
        // is-fired plays a short confirmation pulse that ends fully faded.
        state.glow.toggleClass("is-fired", fired);
        visible = true;
      };

      const onMove = (event: MouseEvent): void => {
        if (
          !ctx.isEnabled() ||
          event.buttons !== 0 ||
          !modifierHeld(event, ctx.getConfig("modifier", DEFAULT_MODIFIER))
        ) {
          armed = false;
          spent = null;
          hide();
          return;
        }
        const { corner, distance } = nearestCorner(win, event.clientX, event.clientY);
        if (spent !== null && (corner !== spent || distance > HINT_RADIUS)) spent = null;
        const commandId = ctx.getConfig<string>(corner, "");
        if (commandId === "" || distance > HINT_RADIUS) {
          armed = true;
          hide();
          return;
        }
        if (spent !== null) return;
        if (distance > TRIGGER_RADIUS) {
          armed = true;
          show(corner, commandId, (HINT_RADIUS - distance) / (HINT_RADIUS - TRIGGER_RADIUS), false);
          return;
        }
        if (!armed) return;
        armed = false;
        spent = corner;

        if (!app.commands.commands[commandId]) {
          hide();
          new Notice(`Micropatches: hot corner command "${commandId}" not found.`);
          return;
        }
        let executed = false;
        try {
          executed = app.commands.executeCommandById(commandId);
        } catch (error) {
          console.error(`Micropatches (hot-corners): command "${commandId}" failed`, error);
        }
        if (executed) show(corner, commandId, 1, true);
        else hide();
      };

      // Releasing the modifier produces no mousemove.
      const onKeyup = (event: KeyboardEvent): void => {
        if (event.key !== MODIFIER_KEYS[ctx.getConfig("modifier", DEFAULT_MODIFIER)]) return;
        armed = false;
        spent = null;
        hide();
      };

      const state: WindowState = { glow: null, hide, onMove, onKeyup };
      windows.set(win, state);
      // Capture phase: canvas and graph views stop propagation of mouse events.
      win.document.addEventListener("mousemove", onMove, true);
      win.document.addEventListener("keyup", onKeyup, true);
      win.document.documentElement.addEventListener("mouseleave", hide);
      win.addEventListener("blur", hide);
    };

    const teardownWindow = (win: Window): void => {
      const state = windows.get(win);
      if (!state) return;
      windows.delete(win);

      // win.document can legitimately be gone on a late "window-close".
      try {
        state.glow?.remove();
        win.document.removeEventListener("mousemove", state.onMove, true);
        win.document.removeEventListener("keyup", state.onKeyup, true);
        win.document.documentElement.removeEventListener("mouseleave", state.hide);
        win.removeEventListener("blur", state.hide);
      } catch (error) {
        console.error("Micropatches (hot-corners): teardown cleanup failed", error);
      }
    };

    setupWindow(window);
    // Popouts that were open before this loaded (the plugin enabled later)
    // fire no "window-open". Once unloaded, not even the main window is set up.
    plugin.app.workspace.onLayoutReady(() => {
      if (!windows.has(window)) return;
      plugin.app.workspace.iterateAllLeaves((leaf) => {
        setupWindow(leaf.view.containerEl.win);
      });
    });
    plugin.registerEvent(
      plugin.app.workspace.on("window-open", (_workspaceWindow, win) => {
        setupWindow(win);
      }),
    );
    plugin.registerEvent(
      plugin.app.workspace.on("window-close", (_workspaceWindow, win) => {
        teardownWindow(win);
      }),
    );

    return {
      cleanup: (): void => {
        for (const win of Array.from(windows.keys())) teardownWindow(win);
      },
      onToggle: (enabled: boolean): void => {
        if (!enabled) for (const state of windows.values()) state.hide();
      },
    };
  },

  settingDefinitions(ctx: PatchContext, key: (configKey: string) => string, app: App): SettingGroupItem[] {
    const commands = (app as AppWithCommands).commands;

    return [
      {
        name: "Modifier key",
        desc: "A corner only glows and fires while this key is held.",
        control: {
          type: "dropdown",
          key: key("modifier"),
          defaultValue: DEFAULT_MODIFIER,
          options: MODIFIER_OPTIONS,
        },
      },
      ...(Object.keys(CORNERS) as Corner[]).map((corner): SettingGroupItem => ({
        name: CORNERS[corner],
        desc: "Command to run.",
        render: (setting): void => {
          const label = (): string => {
            const id = ctx.getConfig<string>(corner, "");
            return id !== "" ? (commands.commands[id]?.name ?? `Missing: ${id}`) : "Choose command…";
          };
          // Components are thenables (BaseComponent.then), so a promise
          // callback must never return one: resolving a promise with the
          // button makes it call button.then(resolve) forever and hangs the
          // renderer in a microtask loop.
          const assign = async (button: ButtonComponent, commandId: string): Promise<void> => {
            await ctx.setConfig(corner, commandId);
            button.setButtonText(label());
          };
          const save = (button: ButtonComponent, commandId: string): void => {
            assign(button, commandId).catch((error: unknown) => {
              console.error("Micropatches (hot-corners): saving the command failed", error);
            });
          };
          const choose = (button: ButtonComponent): void => {
            new CommandSuggestModal(app as AppWithCommands, (command) => {
              save(button, command?.id ?? "");
            }).open();
          };
          let commandButton: ButtonComponent | undefined;
          setting.addButton((button) => {
            commandButton = button;
            button.setButtonText(label()).onClick(() => {
              choose(button);
            });
          });
          setting.addExtraButton((clear) => {
            clear
              .setIcon("x")
              .setTooltip("Clear")
              .onClick(() => {
                if (commandButton) save(commandButton, "");
              });
          });
        },
      })),
    ];
  },
};
