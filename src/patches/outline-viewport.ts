import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import { editorInfoField, MarkdownView, type Editor } from "obsidian";
import type { Patch } from "../patch";

interface OutlineView {
  followCursor: boolean;
  findActiveHeading: (this: OutlineView, owner: unknown) => unknown;
  getOwner(): unknown;
  setHighlightedItem(item: unknown): void;
  onToggleFollowCursor(): void;
}

interface PreviewSection {
  start: { line: number };
  lines: number;
  height: number;
  computed: boolean;
  shown: boolean;
}

interface PreviewRenderer {
  previewEl: HTMLElement;
  topSpace: number;
  sections: PreviewSection[];
}

function isOutline(value: unknown): value is OutlineView {
  if (!value || typeof value !== "object") return false;
  const view = value as Partial<OutlineView>;
  return (
    typeof view.findActiveHeading === "function" &&
    typeof view.getOwner === "function" &&
    typeof view.setHighlightedItem === "function" &&
    typeof view.followCursor === "boolean" &&
    typeof view.onToggleFollowCursor === "function"
  );
}

// Reading mode virtualizes its DOM too. Use the renderer's measured sections,
// including offscreen ones, and skip folded content. Keep this private API
// boundary guarded so incompatible versions fall back to native tracking.
function readingLine(view: MarkdownView): number | null {
  const renderer = (view.previewMode as unknown as { renderer?: Partial<PreviewRenderer> }).renderer;
  if (!renderer || !renderer.previewEl || typeof renderer.topSpace !== "number" || !Array.isArray(renderer.sections))
    return null;
  const { previewEl, sections } = renderer;
  if (!previewEl.clientHeight) return null;
  const target = previewEl.scrollTop + previewEl.clientHeight / 2;
  let top = renderer.topSpace;
  let line = 0;
  for (const section of sections) {
    if (
      typeof section.start?.line !== "number" ||
      typeof section.lines !== "number" ||
      !Number.isFinite(section.height) ||
      typeof section.shown !== "boolean" ||
      !section.computed
    )
      return null;
    if (!section.shown) continue;
    if (section.lines > 0) line = section.start.line;
    top += section.height;
    if (top >= target) return line;
  }
  return line;
}

/**
 * Retains Outline's own tree, owner resolution, highlighting and Follow
 * behavior. Only its notion of the active heading changes. No cursor moves,
 * synthetic selection events, note scrolling or polling are involved.
 */
export const outlineViewport: Patch = {
  id: "outline-viewport",
  name: "Outline follows viewport",
  description:
    "Highlights the section at the center of the note while scrolling, in editing and reading modes. Enables Outline's Follow button by default; you can still turn it off manually.",

  register(plugin, ctx) {
    const editors = new Map<EditorView, { editor: Editor; line: number | null; path: string | undefined }>();
    const managed = new Map<OutlineView, () => void>();
    const readingRoots = new Map<HTMLElement, () => void>();
    const dirtyOutlines = new Set<OutlineView>();
    let pendingScan: number | null = null;
    let pendingHighlight: number | null = null;
    let disposed = false;
    let reportedError = false;

    const reportError = (error: unknown): void => {
      if (reportedError) return;
      reportedError = true;
      console.error("Micropatches (outline-viewport): native tracking restored for this update", error);
    };

    const getLine = (owner: unknown): number | null => {
      if (!(owner instanceof MarkdownView)) return null;
      if (owner.getMode() === "preview") return readingLine(owner);
      for (const record of editors.values()) {
        if (record.editor === owner.editor && record.path === owner.file?.path) return record.line;
      }
      return null;
    };

    const attach = (outline: OutlineView): void => {
      if (managed.has(outline)) return;
      const original = outline.findActiveHeading;
      const hadOwn = Object.prototype.hasOwnProperty.call(outline, "findActiveHeading");
      const replacement: OutlineView["findActiveHeading"] = function (this: OutlineView, owner) {
        if (!disposed && ctx.isEnabled()) {
          try {
            const line = getLine(owner);
            if (line !== null) {
              // Native reading-mode lookup accepts a source line and searches
              // the live tree. Its DOM cache can retain deleted headings.
              // This lookup context leaves the real view and caret untouched.
              return original.call(this, { getMode: () => "preview", scroll: line });
            }
          } catch (error) {
            reportError(error);
          }
        }
        return original.call(this, owner);
      };
      outline.findActiveHeading = replacement;
      managed.set(outline, () => {
        if (outline.findActiveHeading !== replacement) return;
        if (hadOwn) outline.findActiveHeading = original;
        else delete (outline as unknown as Record<string, unknown>)["findActiveHeading"];
        outline.setHighlightedItem(outline.findActiveHeading(outline.getOwner()));
      });
      // Use the button's own handler to update, reveal and persist Follow.
      // Only do this on attach; manual toggles remain effective afterwards.
      if (!outline.followCursor) outline.onToggleFollowCursor();
    };

    const queueHighlight = (owner?: MarkdownView | Editor): void => {
      if (disposed || !ctx.isEnabled()) return;
      for (const outline of managed.keys()) {
        const current = outline.getOwner();
        if (owner && current !== owner && (!(current instanceof MarkdownView) || current.editor !== owner)) continue;
        dirtyOutlines.add(outline);
      }
      if (pendingHighlight !== null || dirtyOutlines.size === 0) return;
      pendingHighlight = window.requestAnimationFrame(() => {
        pendingHighlight = null;
        if (disposed || !ctx.isEnabled()) return;
        for (const outline of dirtyOutlines) {
          if (managed.has(outline)) outline.setHighlightedItem(outline.findActiveHeading(outline.getOwner()));
        }
        dirtyOutlines.clear();
      });
    };

    const measure = (view: EditorView): void => {
      if (disposed || !ctx.isEnabled()) return;
      const editor = view.state.field(editorInfoField, false)?.editor;
      if (!editor) return;
      const followed = Array.from(managed.keys()).some((outline) => {
        const owner = outline.getOwner();
        return owner instanceof MarkdownView && owner.getMode() === "source" && owner.editor === editor;
      });
      if (!followed) return;
      view.requestMeasure({
        key: editors,
        read: () => {
          if (disposed || !ctx.isEnabled() || !view.inView) return null;
          const info = view.state.field(editorInfoField, false);
          if (!info?.editor) return null;
          const rect = view.scrollDOM.getBoundingClientRect();
          const top = Math.max(0, rect.top);
          const bottom = Math.min(view.dom.win.innerHeight, rect.bottom);
          if (bottom <= top) return null;
          const block = view.lineBlockAtHeight((top + bottom) / 2 - view.documentTop);
          return { editor: info.editor, path: info.file?.path, line: view.state.doc.lineAt(block.from).number - 1 };
        },
        write: (record) => {
          if (disposed || !ctx.isEnabled()) return;
          const previous = editors.get(view);
          if (record) editors.set(view, record);
          else if (previous) editors.set(view, { ...previous, line: null });
          if (
            previous?.editor !== record?.editor ||
            previous?.line !== record?.line ||
            previous?.path !== record?.path
          ) {
            queueHighlight(record?.editor ?? previous?.editor);
          }
        },
      });
    };

    const scan = (): void => {
      if (disposed || !ctx.isEnabled()) return;
      const seen = new Set<OutlineView>();
      for (const leaf of plugin.app.workspace.getLeavesOfType("outline")) {
        const outline: unknown = leaf.view;
        if (!isOutline(outline)) continue; // Includes deferred/unloaded leaves.
        seen.add(outline);
        attach(outline);
      }
      for (const [outline, restore] of managed) {
        if (seen.has(outline)) continue;
        restore();
        managed.delete(outline);
        dirtyOutlines.delete(outline);
      }

      const roots = new Set<HTMLElement>();
      const owners = new Set<Editor>();
      for (const outline of managed.keys()) {
        const view = outline.getOwner();
        if (!(view instanceof MarkdownView)) continue;
        if (view.getMode() === "source") owners.add(view.editor);
        const root = view.contentEl;
        roots.add(root);
        if (readingRoots.has(root)) continue;
        const onScroll = (): void => {
          if (view.getMode() === "preview") queueHighlight(view);
        };
        // Native markdown-scroll can be suppressed just after rendering.
        // Observe only Outline owners; scroll never rescans the workspace.
        root.addEventListener("scroll", onScroll, true);
        root.addEventListener("load", onScroll, true);
        const sizer = view.previewMode.containerEl.querySelector(".markdown-preview-sizer");
        const observer = new ResizeObserver(onScroll);
        if (sizer) observer.observe(sizer);
        readingRoots.set(root, () => {
          root.removeEventListener("scroll", onScroll, true);
          root.removeEventListener("load", onScroll, true);
          observer.disconnect();
        });
      }
      for (const [root, remove] of readingRoots) {
        if (roots.has(root)) continue;
        remove();
        readingRoots.delete(root);
      }
      for (const [view, record] of editors) {
        if (owners.has(record.editor)) measure(view);
      }
      queueHighlight();
    };

    function queueScan(): void {
      if (disposed || !ctx.isEnabled() || pendingScan !== null) return;
      pendingScan = window.requestAnimationFrame(() => {
        pendingScan = null;
        scan();
      });
    }

    plugin.registerEditorExtension(
      ViewPlugin.fromClass(
        class {
          constructor(readonly view: EditorView) {
            this.remember();
            measure(view);
          }
          remember(): void {
            const info = this.view.state.field(editorInfoField, false);
            if (info?.editor) editors.set(this.view, { editor: info.editor, path: info.file?.path, line: null });
          }
          update(update: ViewUpdate): void {
            if (update.docChanged) this.remember();
            if (update.docChanged || update.geometryChanged || update.viewportChanged) measure(update.view);
          }
          destroy(): void {
            editors.delete(this.view);
          }
        },
        {
          eventHandlers: {
            scroll(_event, view): void {
              measure(view);
            },
          },
        },
      ),
    );

    plugin.registerEvent(plugin.app.workspace.on("layout-change", queueScan));
    plugin.registerEvent(plugin.app.workspace.on("active-leaf-change", queueScan));
    plugin.registerEvent(plugin.app.workspace.on("file-open", queueScan));
    plugin.registerEvent(plugin.app.workspace.on("resize", queueScan));
    plugin.registerEvent(
      plugin.app.metadataCache.on("changed", (file) => {
        for (const outline of managed.keys()) {
          const owner = outline.getOwner();
          if (owner instanceof MarkdownView && owner.file === file) queueHighlight(owner);
        }
      }),
    );
    plugin.app.workspace.onLayoutReady(queueScan);

    const restoreAll = (): void => {
      if (pendingScan !== null) window.cancelAnimationFrame(pendingScan);
      if (pendingHighlight !== null) window.cancelAnimationFrame(pendingHighlight);
      pendingScan = null;
      pendingHighlight = null;
      dirtyOutlines.clear();
      for (const remove of readingRoots.values()) remove();
      readingRoots.clear();
      for (const restore of managed.values()) restore();
      managed.clear();
    };

    return {
      cleanup: (): void => {
        disposed = true;
        restoreAll();
        editors.clear();
      },
      onToggle: (enabled): void => {
        if (enabled) queueScan();
        else restoreAll();
      },
    };
  },
};
