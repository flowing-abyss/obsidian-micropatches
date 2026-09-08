# Micropatches

[![Available in Obsidian](https://img.shields.io/badge/Available%20in%20Obsidian-7C3AED?logo=obsidian&logoColor=white&style=flat-square)](https://obsidian.md/plugins?id=micropatches)
[![Release](https://github.com/flowing-abyss/obsidian-micropatches/actions/workflows/release.yml/badge.svg)](https://github.com/flowing-abyss/obsidian-micropatches/actions/workflows/release.yml)
[![Downloads](https://img.shields.io/github/downloads/flowing-abyss/obsidian-micropatches/total?style=flat-square&label=downloads&color=blue)](https://github.com/flowing-abyss/obsidian-micropatches/releases)

![Micropatches](assets/banner.png)

A small Obsidian plugin with targeted fixes and quality of life tweaks.

## Patches

1. Cursor repeat throttle
   Holding an arrow key could snowball into a multi second freeze. This coalesces held-arrow repeats into one CodeMirror update per animation frame instead of one per repeat event. It also preserves CodeMirror's cursor-side state so vertical Shift selection crosses soft wraps one visual line per keypress. Horizontal and other modified arrow commands remain native. It supports Vim insert, normal and visual modes while stepping aside for pending Vim commands, suggester popups and IME composition.

2. Scroll offset
   Keeps a minimum distance between the cursor and the top or bottom edge of the editor. Percentage or fixed pixels, both configurable.

3. Hide traffic lights, macOS only
   Hides the native window buttons through Electron's window API and removes the reserved tab bar space, for every open desktop window.

4. Bases auto search
   Opens the search bar the first time a Bases view is shown.

5. Instant UI, off by default
   Collapses animation and transition durations to near zero across the UI, while keeping completion events and fill mode intact so nothing gets stuck invisible. Spinners and other continuous indicators are exempted.

6. Code block language and title
   Exposes fenced code block language, optional title and plain-text state to themes in both Live Preview and reading mode. It only supplies metadata for styling; it does not change rendering or copy behavior by itself.

7. Copy inline code on click
   Copies inline code on click in the editor and reading mode without adding buttons or controls, then briefly confirms a successful copy. Copying highlighted text is available as an optional setting and defaults off.

8. Footnotes in the margin
   Shows editable footnotes beside the document in Live Preview and reading mode. Choose the side and distance; crowded notes collapse into rows that expand on hover or click. The original footnote list remains at the end.

9. Periodic note breadcrumbs
   Adds the previous and next existing period to a periodic note's breadcrumb. The muted next period creates a new note when the sequence reaches its end. Requires Periodic Notes 1.0.0 or newer.

10. Backlinks defaults
    Sets consistent collapse, context, sorting, unlinked-section, and hidden default-filter behavior for linked and unlinked mentions.

11. Heading backlinks
    Marks headings that have incoming links. Hover or activate the link indicator to see every source with context; choose a source to open its exact link in a new tab. An opt-in setting updates incoming links after you rename a heading and move the caret away, switch notes, or close the tab, with one short notice per updated link. Works in the editor and reading mode.

Each patch can be switched on or off separately in Settings or with its `Toggle …` command, no reload needed. All patches are disabled by default so every change is an explicit opt-in.
