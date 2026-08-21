import { MarkdownView, Plugin, type MarkdownPostProcessorContext } from "obsidian";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, ViewPlugin, type DecorationSet, type EditorView, type ViewUpdate } from "@codemirror/view";
import type { Patch, PatchContext, PatchHandle } from "../patch";

// CommonMark permits up to three spaces before a fence. Each blockquote
// level adds its own `>` prefix; accepting that prefix is essential for
// callouts and quoted code blocks, while still rejecting a four-space
// indented code literal.
const FENCE = /^(?: {0,3}>[ \t]?)* {0,3}(`{3,}|~{3,})(.*)$/;

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
      const linesBySection = new Map<string, string[]>();
      for (const pre of Array.from(el.querySelectorAll("pre"))) {
        if (pre.querySelector("code") === null) continue;
        const section = mdCtx.getSectionInfo(pre);
        if (section === null) continue;
        let lines = linesBySection.get(section.text);
        if (lines === undefined) {
          lines = section.text.split("\n");
          linesBySection.set(section.text, lines);
        }
        const first = lines[section.lineStart];
        if (first === undefined) continue;
        const fence = FENCE.exec(first);
        if (fence === null) continue;
        const info = parseInfo(fence[2] ?? "");
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
      const { doc } = view.state;
      const viewport = view.viewport;
      // Markdown's Lezer tree already knows which fences enclose the
      // viewport. Obsidian's Markdown mode exposes one HyperMD-codeblock
      // syntax node per code row (rather than the stock Lezer FencedCode
      // parent), so collecting only those nodes makes scroll cost
      // proportional to visible code, not to the line number reached in a
      // long document.
      const tree = ensureSyntaxTree(view.state, viewport.to, 50) ?? syntaxTree(view.state);
      const rows: Array<{ from: number; name: string }> = [];
      tree.iterate({
        from: viewport.from,
        to: viewport.to,
        enter(node): void {
          if (node.name.includes("HyperMD-codeblock")) rows.push({ from: node.from, name: node.name });
        },
      });
      if (rows.length === 0) return builder.finish();

      let current: FenceInfo | null = null;
      if (!rows[0]?.name.includes("HyperMD-codeblock-begin")) {
        // The opening row may sit above the viewport. Walk backward only
        // within the currently visible code block to recover its info;
        // unlike the previous line-1 scan, this never crosses the nearest
        // fence and is independent of document position.
        for (let n = doc.lineAt(rows[0]?.from ?? viewport.from).number - 1; n >= 1; n--) {
          const fence = FENCE.exec(doc.line(n).text);
          if (fence === null) continue;
          current = parseInfo(fence[2] ?? "");
          break;
        }
      }

      for (const row of rows) {
        const line = doc.lineAt(row.from);
        const begins = row.name.includes("HyperMD-codeblock-begin");
        const ends = row.name.includes("HyperMD-codeblock-end");
        if (begins) {
          const fence = FENCE.exec(line.text);
          current = fence === null ? null : parseInfo(fence[2] ?? "");
        }
        if (current !== null) {
          const attributes: Record<string, string> = {};
          if (current.language === "") attributes["data-code-plain"] = "";
          if (begins) {
            if (current.language !== "") attributes["data-code-language"] = current.language;
            if (current.title !== null) attributes["data-code-title"] = current.title;
          }
          if (Object.keys(attributes).length !== 0) {
            builder.add(line.from, line.from, Decoration.line({ attributes }));
          }
        }
        if (ends) current = null;
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
      cleanup: (): void => {
        for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
          const view = leaf.view;
          if (!(view instanceof MarkdownView)) continue;
          for (const element of Array.from(
            view.containerEl.querySelectorAll("pre[data-code-language], pre[data-code-title], pre[data-code-plain]"),
          )) {
            const pre = element as HTMLElement;
            pre.removeAttribute("data-code-language");
            pre.removeAttribute("data-code-title");
            pre.removeAttribute("data-code-plain");
          }
        }
      },
      // Toggling off has to repaint: the reading-mode post-processor only
      // runs on render, so already-rendered blocks keep their attributes
      // until something forces them through it again.
      onToggle: (): void => {
        plugin.app.workspace.updateOptions();
        for (const leaf of plugin.app.workspace.getLeavesOfType("markdown")) {
          const view = leaf.view;
          if (view instanceof MarkdownView) view.previewMode.rerender(true);
        }
      },
    };
  },
};
