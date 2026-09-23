import { MarkdownView, type Plugin, type MarkdownPostProcessorContext } from "obsidian";
import { ensureSyntaxTree, syntaxTree } from "@codemirror/language";
import { RangeSetBuilder } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import type { Patch, PatchContext, PatchHandle } from "../patch";

// CommonMark permits up to three spaces before a fence. Each blockquote
// level adds its own `>` prefix; accepting that prefix is essential for
// callouts and quoted code blocks, while still rejecting a four-space
// indented code literal. No two parts can match the same spaces, so deep
// quotes don't backtrack exponentially.
export const FENCE = /^ {0,3}(?:>(?: {0,4}|\t {0,3}))*(`{3,}(?!`)|~{3,}(?!~))(.*)$/;

// A row Obsidian's parser already marks as a fence may be indented any
// amount, as in a nested list item.
const OPENING_ROW = /^[\t ]*(?:>[\t ]*)*(`{3,}(?!`)|~{3,}(?!~))(.*)$/;

// A callout, quote or list: one section, however many code blocks it holds.
const CONTAINER = /^ {0,3}(?:>|[-+*][\t ]|\d{1,9}[.)][\t ])/;

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
export function parseInfo(info: string): FenceInfo | null {
  const trimmed = info.trim();
  if (trimmed === "") return { language: "", title: null };
  const language = trimmed.split(/\s+/)[0] ?? "";
  if (language.includes("`")) return null;
  const match = /\stitle\s*[:=]\s*("([^"]*)"|'([^']*)'|(\S+))/i.exec(trimmed.slice(language.length));
  const title = match ? (match[2] ?? match[3] ?? match[4] ?? null) : null;
  return { language, title };
}

// The fenced blocks among a container's lines, in order.
function containedFences(lines: string[]): FenceInfo[] {
  const fences: FenceInfo[] = [];
  let open: string | null = null;
  for (const line of lines) {
    const match = OPENING_ROW.exec(line);
    const run = match?.[1];
    const rest = match?.[2] ?? "";
    if (open !== null) {
      if (run !== undefined && run[0] === open[0] && run.length >= open.length && rest.trim() === "") open = null;
      continue;
    }
    const info = run === undefined ? null : parseInfo(rest);
    if (info === null) continue;
    fences.push(info);
    open = run ?? null;
  }
  return fences;
}

// The fences behind a section's code blocks, in order.
function sectionFences(lines: string[]): FenceInfo[] {
  const first = lines[0] ?? "";
  if (CONTAINER.test(first)) return containedFences(lines);
  const fence = FENCE.exec(first);
  const info = fence === null ? null : parseInfo(fence[2] ?? "");
  return info === null ? [] : [info];
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

// Indented code has no fence: unless every block has one, which fence
// belongs to which block is unknown, and none is labelled.
function label(pres: HTMLElement[], fences: FenceInfo[]): void {
  if (pres.length !== fences.length) return;
  pres.forEach((pre, index) => {
    const info = fences[index];
    if (info !== undefined) apply(pre, info);
  });
}

function codeBlocks(el: HTMLElement): HTMLElement[] {
  return Array.from(el.querySelectorAll("pre")).filter((pre) => pre.querySelector("code") !== null);
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
      const linesByText = new Map<string, string[]>();
      const sections = new Map<string, { lines: string[]; pres: HTMLElement[] }>();
      let unplaced = false;
      for (const pre of codeBlocks(el)) {
        const section = mdCtx.getSectionInfo(pre);
        if (section === null) {
          unplaced = true;
          continue;
        }
        const key = `${section.lineStart}:${section.lineEnd}`;
        let group = sections.get(key);
        if (group === undefined) {
          let lines = linesByText.get(section.text);
          if (lines === undefined) {
            lines = section.text.split("\n");
            linesByText.set(section.text, lines);
          }
          group = { lines: lines.slice(section.lineStart, section.lineEnd + 1), pres: [] };
          sections.set(key, group);
        }
        group.pres.push(pre);
      }
      for (const { lines, pres } of sections.values()) label(pres, sectionFences(lines));

      // Live preview draws a callout as a widget, and its code blocks come
      // with no section. Once the widget is in the editor, the callout's
      // source starts at the line it sits on.
      const embed = unplaced ? el.closest<HTMLElement>(".cm-embed-block") : null;
      if (embed) {
        el.win.requestAnimationFrame(() => {
          labelEmbed(embed);
        });
      }
    });

    const labelEmbed = (embed: HTMLElement): void => {
      const editorEl = embed.closest<HTMLElement>(".cm-editor");
      if (!ctx.isEnabled() || !embed.isConnected || !editorEl) return;
      const view = EditorView.findFromDOM(editorEl);
      if (!view) return;
      const { doc } = view.state;
      let line;
      try {
        line = doc.lineAt(view.posAtDOM(embed));
      } catch {
        return;
      }
      const lines: string[] = [];
      while (/^ {0,3}>/.test(line.text)) {
        lines.push(line.text);
        if (line.number === doc.lines) break;
        line = doc.line(line.number + 1);
      }
      label(codeBlocks(embed), containedFences(lines));
    };

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
      if (rows[0]?.name.includes("HyperMD-codeblock-begin") !== true) {
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
          const fence = OPENING_ROW.exec(line.text);
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
