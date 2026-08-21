import { MarkdownView, Plugin, type MarkdownPostProcessorContext } from "obsidian";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import type { Patch, PatchContext, PatchHandle } from "../patch";

const FENCE = /^(\s*)(`{3,}|~{3,})(.*)$/;

interface FenceInfo {
  language: string;
  title: string | null;
}

/**
 * Parses a fence's info string. The first whitespace-delimited word is the
 * language; a `title:` / `title=` parameter anywhere after it is the title,
 * quoted or not. Anything else in the info string is left alone — other
 * plugins put their own parameters there.
 */
function parseInfo(info: string): FenceInfo | null {
  const trimmed = info.trim();
  if (trimmed === "") return { language: "", title: null };
  const language = trimmed.split(/\s+/)[0] ?? "";
  if (language.includes("`")) return null;
  const match = /\btitle\s*[:=]\s*("([^"]*)"|'([^']*)'|(\S+))/i.exec(trimmed);
  const title = match ? (match[2] ?? match[3] ?? match[4] ?? null) : null;
  return { language, title };
}

function apply(el: HTMLElement, info: FenceInfo): void {
  if (info.language !== "") {
    el.setAttribute("data-code-language", info.language);
    el.removeAttribute("data-code-plain");
  } else {
    el.removeAttribute("data-code-language");
    el.setAttribute("data-code-plain", "");
  }
  if (info.title !== null) el.setAttribute("data-code-title", info.title);
  else el.removeAttribute("data-code-title");
}

/**
 * Exposes a fenced code block's language and optional title to CSS, in both
 * reading mode and live preview.
 *
 * Obsidian renders the language name only in live preview, as an absolutely
 * positioned `.code-block-flair` chip, and offers reading mode nothing at
 * all — so a theme cannot draw one header for both modes, because in one of
 * them the text does not exist in the DOM. CSS also cannot read a class
 * name, so even live preview's `language-python` is unprintable.
 *
 * This patch writes `data-code-language`, `data-code-title` and
 * `data-code-plain` onto the relevant block rows in each mode. The plain
 * marker is repeated on every Live Preview row because CodeMirror does not
 * wrap a fenced block in one element; without that range marker CSS cannot
 * distinguish a language-less body from a syntax-highlighted one. It changes
 * no rendering of its own: with no theme rule reading the attributes, nothing
 * about the block looks different.
 */
export const codeBlockTitle: Patch = {
  id: "code-block-title",
  name: "Code block language and title",
  description:
    "Exposes a fenced block's language and optional `title:` as data attributes in both reading mode and live preview, so a theme can render one consistent header.",

  register(plugin: Plugin, ctx: PatchContext): PatchHandle {
    // Reading mode. getSectionInfo gives the source lines behind the
    // rendered element, which is the only way back to the info string —
    // the rendered <code> keeps the language as a class and drops
    // everything else on the fence.
    plugin.registerMarkdownPostProcessor((el: HTMLElement, mdCtx: MarkdownPostProcessorContext) => {
      if (!ctx.isEnabled()) return;
      for (const pre of Array.from(el.querySelectorAll("pre"))) {
        if (pre.querySelector("code") === null) continue;
        const section = mdCtx.getSectionInfo(pre);
        if (section === null) continue;
        const first = section.text.split("\n")[section.lineStart];
        if (first === undefined) continue;
        const fence = FENCE.exec(first);
        if (fence === null) continue;
        const info = parseInfo(fence[3] ?? "");
        if (info !== null) apply(pre, info);
      }
    });

    // Live preview. Language/title metadata belongs on the begin row, which
    // the theme paints as the header band. A language-less block additionally
    // marks every row in its range: CodeMirror emits sibling lines rather than
    // a wrapper, so this is the only robust way for CSS to give an arbitrary
    // multi-line plain block one treatment without leaking into later fences.
    const decorate = (view: EditorView): DecorationSet => {
      const builder = new RangeSetBuilder<Decoration>();
      if (!ctx.isEnabled()) return builder.finish();
      const doc = view.state.doc;
      // State has to be tracked from line 1: whether a fence opens or
      // closes a block is not decidable from the line itself. Only lines
      // inside the rendered viewport get a decoration, so the cost is one
      // regex per line and no allocation for the rest.
      const viewportTo = view.viewport.to;
      let open: { marker: string; plain: boolean } | null = null;
      for (let n = 1; n <= doc.lines; n++) {
        const line = doc.line(n);
        if (line.from > viewportTo) break;
        const fence = FENCE.exec(line.text);
        if (open !== null) {
          if (open.plain && line.to >= view.viewport.from) {
            builder.add(line.from, line.from, Decoration.line({ attributes: { "data-code-plain": "" } }));
          }
          if (fence !== null) {
            const marker = fence[2] ?? "";
            const rest = fence[3] ?? "";
            if (marker[0] === open.marker[0] && marker.length >= open.marker.length && rest.trim() === "") {
              open = null;
            }
          }
          continue;
        }
        if (fence === null) continue;
        const marker = fence[2] ?? "";
        const rest = fence[3] ?? "";
        const info = parseInfo(rest);
        open = { marker, plain: info?.language === "" };
        if (info === null || line.to < view.viewport.from) continue;
        const attributes: Record<string, string> = {};
        if (info.language !== "") attributes["data-code-language"] = info.language;
        else attributes["data-code-plain"] = "";
        if (info.title !== null) attributes["data-code-title"] = info.title;
        if (Object.keys(attributes).length === 0) continue;
        builder.add(line.from, line.from, Decoration.line({ attributes }));
      }
      return builder.finish();
    };

    const viewPlugin = ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        constructor(view: EditorView) {
          this.decorations = decorate(view);
        }
        update(update: ViewUpdate): void {
          if (update.docChanged || update.viewportChanged) this.decorations = decorate(update.view);
        }
      },
      { decorations: (value) => value.decorations },
    );

    plugin.registerEditorExtension(viewPlugin);

    return {
      cleanup: (): void => {},
      // Toggling off has to repaint: the reading-mode post-processor only
      // runs on render, so already-rendered blocks keep their attributes
      // until something forces them through it again.
      onToggle: (): void => {
        for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
          const view = leaf.view;
          if (view instanceof MarkdownView) view.previewMode.rerender(true);
        }
      },
    };
  },
};
