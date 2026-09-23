import {
  type App,
  type ButtonComponent,
  FuzzySuggestModal,
  Notice,
  Platform,
  type Plugin,
  type SettingGroupItem,
} from "obsidian";
import type { Patch, PatchContext, PatchHandle } from "../patch";

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

interface WindowState {
  reset: () => void;
  onKeydown: (event: KeyboardEvent) => void;
  onKeyup: (event: KeyboardEvent) => void;
}

// A tap is a press shorter than TAP_MAX_MS; the second tap must start within
// DOUBLE_TAP_GAP_MS of the first one ending. Longer presses are holds (e.g.
// Shift held for Hot corners or a selection), not taps.
export const TAP_MAX_MS = 250;
export const DOUBLE_TAP_GAP_MS = 350;

const MODIFIERS: Record<string, Modifier> = {
  Shift: "shift",
  Control: "ctrl",
  Alt: "alt",
  Meta: "meta",
};

// Outside macOS a lone Win/Super tap opens the system menu and takes focus
// away, so a double tap can never complete — that slot is not offered there.
const MODIFIER_NAMES: Partial<Record<Modifier, string>> = Platform.isMacOS
  ? { shift: "Shift", ctrl: "Control", alt: "Option", meta: "Command" }
  : { shift: "Shift", ctrl: "Ctrl", alt: "Alt" };

function otherModifierHeld(event: KeyboardEvent, modifier: Modifier): boolean {
  return (
    (modifier !== "shift" && event.shiftKey) ||
    (modifier !== "ctrl" && event.ctrlKey) ||
    (modifier !== "alt" && event.altKey) ||
    (modifier !== "meta" && event.metaKey)
  );
}

class CommandSuggestModal extends FuzzySuggestModal<CommandLike | null> {
  // getItems() runs on every keystroke; the modal is short-lived, so the
  // sorted list is built once.
  private readonly items: Array<CommandLike | null>;

  constructor(
    app: AppWithCommands,
    modifierName: string,
    private readonly onChoose: (command: CommandLike | null) => void,
  ) {
    super(app);
    this.items = [null, ...Object.values(app.commands.commands).sort((a, b) => a.name.localeCompare(b.name))];
    this.setPlaceholder(`Choose a command for double ${modifierName}…`);
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
 * Double-tap commands: tapping a modifier key twice in quick succession runs
 * the command assigned to it (like double Shift in JetBrains IDEs). Only
 * modifiers are supported on purpose — a lone modifier tap does nothing, so
 * there is no conflict with typing and no need to delay input, which a
 * double-tap on a printable key would require.
 *
 * A tap is a clean, short press of one modifier: no other key or mouse
 * button in between, no other modifier held, no auto-repeat. Typing
 * capitals, shortcuts such as Cmd+C, Shift-clicks and long holds therefore
 * never count. A keyup lost to an app switch (Cmd+Tab) is covered by the
 * window blur reset.
 */
export const doubleTapCommands: Patch = {
  id: "double-tap-commands",
  name: "Double-tap commands",
  description: "Runs a command when a modifier key (Shift, Ctrl, Alt/Option, or Cmd) is tapped twice quickly.",

  register(plugin: Plugin, ctx: PatchContext): PatchHandle {
    const app = plugin.app as AppWithCommands;
    const windows = new Map<Window, WindowState>();

    const run = (modifier: Modifier): void => {
      const commandId = ctx.getConfig<string>(modifier, "");
      if (commandId === "") return;
      if (!app.commands.commands[commandId]) {
        new Notice(`Micropatches: double-tap command "${commandId}" not found.`);
        return;
      }
      try {
        app.commands.executeCommandById(commandId);
      } catch (error) {
        console.error(`Micropatches (double-tap-commands): command "${commandId}" failed`, error);
      }
    };

    const setupWindow = (win: Window): void => {
      if (windows.has(win)) return;

      let pressed: Modifier | null = null;
      let pressedAt = 0;
      let lastTap: Modifier | null = null;
      let lastTapAt = 0;

      const reset = (): void => {
        pressed = null;
        lastTap = null;
      };

      const onKeydown = (event: KeyboardEvent): void => {
        if (!ctx.isEnabled()) return;
        const modifier = MODIFIERS[event.key];
        if (modifier === undefined || otherModifierHeld(event, modifier)) {
          reset();
          return;
        }
        if (event.repeat) return;
        pressed = modifier;
        pressedAt = event.timeStamp;
      };

      const onKeyup = (event: KeyboardEvent): void => {
        const modifier = MODIFIERS[event.key];
        if (
          !ctx.isEnabled() ||
          modifier === undefined ||
          modifier !== pressed ||
          event.timeStamp - pressedAt > TAP_MAX_MS
        ) {
          reset();
          return;
        }
        pressed = null;
        if (lastTap === modifier && pressedAt - lastTapAt <= DOUBLE_TAP_GAP_MS) {
          reset();
          run(modifier);
          return;
        }
        lastTap = modifier;
        lastTapAt = event.timeStamp;
      };

      windows.set(win, { reset, onKeydown, onKeyup });
      win.document.addEventListener("keydown", onKeydown, true);
      win.document.addEventListener("keyup", onKeyup, true);
      win.document.addEventListener("mousedown", reset, true);
      win.addEventListener("blur", reset);
    };

    const teardownWindow = (win: Window): void => {
      const state = windows.get(win);
      if (!state) return;
      windows.delete(win);

      // win.document can legitimately be gone on a late "window-close".
      try {
        win.document.removeEventListener("keydown", state.onKeydown, true);
        win.document.removeEventListener("keyup", state.onKeyup, true);
        win.document.removeEventListener("mousedown", state.reset, true);
        win.removeEventListener("blur", state.reset);
      } catch (error) {
        console.error("Micropatches (double-tap-commands): teardown cleanup failed", error);
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
      onToggle: (): void => {
        for (const state of windows.values()) state.reset();
      },
    };
  },

  settingDefinitions(ctx: PatchContext, _key: (configKey: string) => string, app: App): SettingGroupItem[] {
    const commands = (app as AppWithCommands).commands;

    return (Object.entries(MODIFIER_NAMES) as Array<[Modifier, string]>).map(
      ([modifier, modifierName]): SettingGroupItem => ({
        name: `Double ${modifierName}`,
        desc: "Command to run.",
        render: (setting): void => {
          const label = (): string => {
            const id = ctx.getConfig<string>(modifier, "");
            return id !== "" ? (commands.commands[id]?.name ?? `Missing: ${id}`) : "Choose command…";
          };
          // Components are thenables (BaseComponent.then), so a promise
          // callback must never return one: resolving a promise with the
          // button makes it call button.then(resolve) forever and hangs the
          // renderer in a microtask loop.
          const assign = async (button: ButtonComponent, commandId: string): Promise<void> => {
            await ctx.setConfig(modifier, commandId);
            button.setButtonText(label());
          };
          const save = (button: ButtonComponent, commandId: string): void => {
            assign(button, commandId).catch((error: unknown) => {
              console.error("Micropatches (double-tap-commands): saving the command failed", error);
            });
          };
          const choose = (button: ButtonComponent): void => {
            new CommandSuggestModal(app as AppWithCommands, modifierName, (command) => {
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
      }),
    );
  },
};
