# Micropatches

An Obsidian plugin made of small, independent patches. `pnpm verify` is the quality gate (format, lint, dead code, types, tests, build), and CI runs the same.

- One patch is one TypeScript file in `src/patches/`, listed in `src/main.ts`. Patches share nothing but `src/patch.ts`, and lint enforces that.
- Every patch is registered at load, enabled or not. It checks `ctx.isEnabled()` and follows `onToggle` and `onConfigChange`. `cleanup()` undoes everything the patch did, including DOM, classes, wrapped methods, listeners and popout windows, so toggling or unloading never needs a reload.

## Testing in the real vault

Obsidian must be running with Settings → General → Command line interface enabled.

```sh
obsidian vault="dev-vault-micropatches" eval code="(async () => { … })()"
obsidian vault="dev-vault-micropatches" dev:dom selector=".bases-toolbar" text
obsidian vault="dev-vault-micropatches" dev:css selector=".bases-toolbar" prop=gap
obsidian vault="dev-vault-micropatches" dev:screenshot path=/tmp/shot.png
obsidian vault="dev-vault-micropatches" dev:errors
obsidian vault="dev-vault-micropatches" dev:console   # after dev:debug on
obsidian vault="dev-vault-micropatches" devtools
```

To install a build:

1. Copy `main.js` and `styles.css` into `<vault>/.obsidian/plugins/micropatches/`. `app.vault.adapter.basePath` gives the vault path.
2. In `eval`, run `app.plugins.disablePlugin("micropatches")`, then `app.plugins.enablePlugin("micropatches")`.

Useful in `eval`:

- `app.plugins.plugins.micropatches.setPatchEnabled(id, true)` switches a patch.
- `require("electron").remote.getCurrentWebContents().sendInputEvent(…)` sends trusted keys and mouse moves.
