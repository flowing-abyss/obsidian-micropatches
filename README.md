# Micropatches

[![Available in Obsidian](https://img.shields.io/badge/Available%20in%20Obsidian-7C3AED?logo=obsidian&logoColor=white&style=flat-square)](https://obsidian.md/plugins?id=micropatches)

![Micropatches](assets/banner.png)

A small Obsidian plugin with targeted fixes and quality of life tweaks.

## Patches

1. Cursor repeat throttle
   Holding an arrow key could snowball into a multi second freeze. This coalesces held-key repeats into one CodeMirror update per animation frame instead of one per repeat event. It supports Vim insert, normal and visual modes while stepping aside for pending Vim commands, suggester popups and IME composition.

2. Scroll offset
   Keeps a minimum distance between the cursor and the top or bottom edge of the editor. Percentage or fixed pixels, both configurable.

3. Hide traffic lights, macOS only
   Moves the native window buttons off screen and removes the reserved tab bar space, for every open window.

4. Bases auto search
   Opens the search bar the first time a Bases view is shown.

5. Instant UI, off by default
   Collapses animation and transition durations to near zero across the UI, while keeping completion events and fill mode intact so nothing gets stuck invisible. Spinners and other continuous indicators are exempted.

6. Code block language and title
   Exposes fenced code block language, optional title and plain-text state to themes in both Live Preview and reading mode.

7. Copy inline code on click
   Copies inline code on click in the editor and reading mode without adding buttons or controls. Copying highlighted text is available as an optional setting and defaults off.

Each patch can be switched on or off separately in Settings, no reload needed.
