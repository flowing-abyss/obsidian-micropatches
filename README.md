# Micropatches

A small Obsidian plugin that fixes specific core editor bugs and performance issues, and replaces a few tiny unmaintained community plugins with the same behavior kept in one place.

## Install via BRAT

1. Install the BRAT plugin from Community Plugins if you don't have it already.
2. Open BRAT settings and add a beta plugin using this repo, flowing-abyss/obsidian-micropatches.
3. Enable Micropatches in Community Plugins.

## Patches

1. Cursor repeat throttle
   Holding an arrow key could snowball into a multi second freeze. This coalesces held-key repeats into one CodeMirror update per animation frame instead of one per repeat event, and steps aside for suggester popups, vim mode and IME composition.

2. Scroll offset
   Replaces the third party Scroll Offset plugin. Keeps a minimum distance between the cursor and the top or bottom edge of the editor. Percentage or fixed pixels, both configurable.

3. Hide traffic lights, macOS only
   Moves the native window buttons off screen and removes the reserved tab bar space, for every open window.

4. Bases auto search
   Replaces the third party Bases Auto Search plugin. Opens the search bar the first time a Bases view is shown.

5. Instant UI, off by default
   Collapses animation and transition durations to near zero across the UI, while keeping completion events and fill mode intact so nothing gets stuck invisible. Spinners and other continuous indicators are exempted.

Each patch can be switched on or off separately in Settings, no reload needed.
