import {
  type App,
  BasesEntry,
  type BasesEntryGroup,
  type BasesPropertyId,
  type BasesQueryResult,
  type BasesViewConfig,
  Component,
  ListValue,
  Notice,
  NullValue,
  parseFrontMatterTags,
  type Plugin,
  setIcon,
  Value,
} from "obsidian";
import type { Patch, PatchContext, PatchHandle } from "../patch";

type Scalar = string | number | boolean | null;
type StoredValue = Scalar | Scalar[] | undefined;
interface Branch {
  value: Scalar;
  label: Scalar;
}
interface Rule {
  property: string;
  mode: "direct" | "contains" | "equals";
  branches: Branch[];
}
interface Expression {
  type?: string;
  id?: string;
  name?: string;
  operator?: string;
  value?: unknown;
  object?: Expression;
  array?: Expression;
  index?: string | Expression;
  subject?: Expression | null;
  args?: Expression[];
  left?: Expression;
  right?: Expression;
}
interface Formula {
  formula?: Expression;
}

// The public Bases API exposes values, but not the table renderer, parsed
// expressions, or entry construction. Guard these internals before using them.
interface Entry extends BasesEntry {
  ctx?: { filter?: { test(entry: BasesEntry): boolean } | null; local?: BasesEntry | null };
  frontmatter?: Record<string, unknown>;
  note?: {
    constructor: { fromFrontMatter?: (app: App, file: BasesEntry["file"], fm: Record<string, unknown>) => unknown };
    objectAccess?(key: string): Value | null;
  };
  implicit?: {
    getProps(): unknown;
    getTags(): Value;
    getLinks(): Value;
    getBacklinks(): Value;
    objectAccess(key: string): Value | null;
  };
}
interface Config extends BasesViewConfig {
  groupBy?: { property: BasesPropertyId };
  getLimit?(): number;
}
interface NativeFolding {
  isGroupCollapsed(group: BasesEntryGroup): boolean;
  toggleGroupCollapsed(group: BasesEntryGroup): void;
}
interface Table extends Partial<NativeFolding> {
  type: string;
  config: Config;
  data?: BasesQueryResult & { groupedDataCache?: BasesEntryGroup[] | null; applySort?(entries: BasesEntry[]): void };
  groups: Array<{ tableEl: HTMLElement; tbodyEl: HTMLElement }>;
  rows: Array<{ el: HTMLElement; entry: Entry }>;
  scrollEl: HTMLElement;
  display: (this: Table) => void;
  updateVirtualDisplay: (this: Table) => void;
  createTransaction?(
    apply: (
      changes: Array<{ file: Entry["file"]; start: Record<string, unknown>; end: Record<string, unknown> }>,
    ) => Promise<void>,
  ): Promise<void>;
}
interface Controller {
  query?: { file?: unknown; formulas?: Record<string, Formula | undefined> } | null;
  viewName?: string;
  view: unknown;
  results?: Map<unknown, BasesEntry>;
  viewContainerEl: HTMLElement;
  applySearchQuery(entries: BasesEntry[], order: BasesPropertyId[]): BasesEntry[];
  getSearchQuery?(): string | null;
  addChild(child: Component): unknown;
  removeChild(child: Component): unknown;
}
interface State {
  controller: Controller;
  view: Table;
  hook: Component;
  restore(): void;
  nativeFolding: NativeFolding | null;
  folded: Set<string>;
  rows: WeakMap<HTMLElement, Entry>;
  tables: WeakMap<HTMLElement, { table: Table["groups"][number]; group: BasesEntryGroup }>;
  file: unknown;
  toolbar: HTMLElement | null;
}
interface RowTarget {
  state: State;
  entry: Entry;
  group: BasesEntryGroup;
}
interface Move {
  property: string;
  value: StoredValue;
  before: Record<string, unknown>;
  index: number;
}
type Plan = { move: Move; reason?: never } | { reason: string; move?: never };
interface Clip {
  el: HTMLElement;
  x: boolean;
  y: boolean;
  scroll: boolean;
}
interface Drag extends RowTarget {
  pointerId: number;
  x: number;
  y: number;
  active: boolean;
  origin: HTMLElement;
  sourceEl: HTMLElement;
  lastMove: PointerEvent | null;
  frame: number | null;
  scroll: boolean;
  previewText: string | null;
  data: Table["data"];
  preview: HTMLElement | null;
  line: HTMLElement | null;
  targetEl: HTMLElement | null;
  plan: Plan | null;
  target: BasesEntryGroup | null;
  targetTable: Table["groups"][number] | null;
  revealTimer: number | null;
  revealAnchor: { x: number; y: number } | null;
  revealPause: { x: number; y: number } | null;
  clips: Clip[];
  scrolling: HTMLElement | null;
}

const PREFIX = "micropatches-bases-groups";
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

function scalar(value: unknown): value is Scalar {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function stored(value: unknown): value is StoredValue {
  return value === undefined || scalar(value) || (Array.isArray(value) && value.every(scalar));
}

function reference(node: Expression | undefined): string | null {
  if (
    node?.type === "ident" &&
    typeof node.id === "string" &&
    !["file", "formula", "this", "note", "value", "index"].includes(node.id.toLowerCase())
  )
    return `note.${node.id}`;
  let owner: Expression | undefined;
  if (node?.type === "object_access") owner = node.object;
  if (node?.type === "array_access") owner = node.array;
  const index = node?.index;
  let name: unknown = index;
  if (typeof index !== "string") name = index?.type === "primitive" ? index.value : null;
  const namespace = owner?.id?.toLowerCase();
  if (owner?.type !== "ident" || !["note", "formula"].includes(namespace ?? "") || typeof name !== "string")
    return null;
  return `${namespace ?? ""}.${name}`;
}

function formulaFor(formulas: Record<string, Formula | undefined>, name: string): Formula | undefined {
  return (
    formulas[name] ?? formulas[Object.keys(formulas).find((key) => key.toLowerCase() === name.toLowerCase()) ?? ""]
  );
}

function containsFileValue(
  node: unknown,
  formulas: Record<string, Formula | undefined>,
  seen = new Set<unknown>(),
): boolean {
  if (node === null || typeof node !== "object" || seen.has(node)) return false;
  seen.add(node);
  const expression = node as Expression;
  // Lambda values may be files from the collection being mapped or reduced.
  if (expression.type === "ident" && ["file", "value", "acc"].includes(expression.id?.toLowerCase() ?? "")) return true;
  const owner = expression.object ?? expression.array;
  const key = typeof expression.index === "string" ? expression.index : expression.index?.value;
  if (owner?.id?.toLowerCase() === "this" && typeof key === "string" && key.toLowerCase() === "file") return true;
  const ref = reference(expression);
  if (ref?.startsWith("formula.") === true && containsFileValue(formulaFor(formulas, ref.slice(8)), formulas, seen))
    return true;
  return Object.values(node).some((child: unknown) => containsFileValue(child, formulas, seen));
}

export function hasFileLookup(
  node: unknown,
  formulas: Record<string, Formula | undefined>,
  self: boolean,
  seen = new Set<unknown>(),
): boolean {
  if (node === null || typeof node !== "object" || seen.has(node)) return false;
  seen.add(node);
  const expression = node as Expression;
  if (self && expression.type === "ident" && expression.id?.toLowerCase() === "this") return true;
  if (expression.type === "function" && ["file", "asfile"].includes(expression.name?.toLowerCase() ?? "")) return true;
  const owner = expression.object ?? expression.array;
  const key = typeof expression.index === "string" ? expression.index : expression.index?.value;
  if (expression.type === "array_access" && owner?.id?.toLowerCase() === "formula" && typeof key !== "string")
    return true;
  if (
    ((typeof key === "string" && key.toLowerCase() === "backlinks") ||
      (expression.type === "array_access" && typeof key !== "string")) &&
    containsFileValue(owner, formulas)
  )
    return true;
  const ref = reference(expression);
  if (ref?.startsWith("formula.") === true && hasFileLookup(formulaFor(formulas, ref.slice(8)), formulas, self, seen))
    return true;
  return Object.values(node).some((child: unknown) => hasFileLookup(child, formulas, self, seen));
}

// Only invert expressions whose writes are explicit in the expression itself.
// No evaluating JavaScript, guessing from a label, or copying another note's
// unrelated metadata. Native Bases evaluates the proposed result once more.
export function groupRule(
  property: string,
  formulas: Record<string, Formula | undefined>,
  seen = new Set<string>(),
): Rule | null {
  if (property.startsWith("note.")) return { property: property.slice(5), mode: "direct", branches: [] };
  if (!property.startsWith("formula.") || seen.has(property) || seen.size > 20) return null;
  seen.add(property);
  let node = formulaFor(formulas, property.slice(8))?.formula;
  const alias = reference(node);
  if (alias !== null) return groupRule(alias, formulas, seen);
  const branches: Branch[] = [];
  let field: string | null = null;
  let mode: Rule["mode"] = "equals";
  while (node?.type === "function" && node.name === "if" && node.subject == null && node.args?.length === 3) {
    const [condition, output, otherwise] = node.args;
    if (output?.type !== "primitive" || !scalar(output.value)) return null;
    let ref: string | null;
    let value: unknown;
    let nextMode: Rule["mode"];
    if (condition?.type === "function" && condition.name === "contains" && condition.args?.length === 1) {
      ref = reference(condition.subject ?? undefined);
      value = condition.args[0]?.type === "primitive" ? condition.args[0].value : undefined;
      if (typeof value !== "string" || value === "") return null;
      nextMode = "contains";
    } else if (condition?.type === "comparison" && condition.operator === "==") {
      ref = reference(condition.left);
      value = condition.right?.type === "primitive" ? condition.right.value : undefined;
      nextMode = "equals";
    } else {
      ref = reference(condition);
      value = true;
      nextMode = "equals";
      // A truthiness condition is writable only as a boolean. The actual
      // property's type is checked when preparing the change.
    }
    if (ref?.startsWith("note.") !== true || !scalar(value) || (field !== null && (field !== ref || mode !== nextMode)))
      return null;
    field = ref;
    mode = nextMode;
    branches.push({ value, label: output.value });
    if (branches.length > 100) return null;
    if (typeof value === "boolean" && otherwise?.type === "primitive" && scalar(otherwise.value)) {
      branches.push({ value: !value, label: otherwise.value });
    }
    node = otherwise;
  }
  if (field === null || node?.type !== "primitive" || !scalar(node.value)) return null;
  return { property: field.slice(5), mode, branches };
}

function fieldName(fm: Record<string, unknown>, property: string): string {
  return Object.keys(fm).find((key) => key.toLowerCase() === property.toLowerCase()) ?? property;
}

export function changeValue(
  rule: Rule,
  current: StoredValue,
  target: StoredValue,
): { value: StoredValue } | { reason: string } {
  if (rule.mode === "direct") {
    if (target == null) return { value: null };
    if (current != null && !Array.isArray(current) && !Array.isArray(target) && typeof current !== typeof target) {
      return { reason: "These groups use different property types." };
    }
    if (Array.isArray(current) && !Array.isArray(target)) return { value: [target] };
    if (!Array.isArray(current) && current != null && Array.isArray(target)) {
      if (target.length !== 1) return { reason: "This group requires a list; the source property is a scalar." };
      return changeValue(rule, current, target[0]);
    }
    return { value: Array.isArray(target) ? [...target] : target };
  }
  const branches = rule.branches.filter((branch) => branch.label === target);
  if (branches.length !== 1) return { reason: "This formula does not specify one unambiguous value for this group." };
  const next = branches[0]?.value;
  if (next === undefined) return { reason: "This formula has no writable value for this group." };
  if (rule.mode === "equals") {
    if (Array.isArray(current) || (current != null && typeof current !== typeof next))
      return { reason: "This formula would change the property's type." };
    return { value: next };
  }
  if (typeof next !== "string") return { reason: "This formula requires a text value." };
  const tokens = rule.branches
    .map((branch) => branch.value)
    .filter((value): value is string => typeof value === "string");
  if (Array.isArray(current))
    return { value: [...current.filter((item) => typeof item !== "string" || !tokens.includes(item)), next] };
  if (current == null || current === "") return { value: next };
  if (typeof current !== "string") return { reason: "This formula requires text or a list." };
  const matches = tokens.filter((token) => current.toLowerCase().includes(token.toLowerCase()));
  if (matches.length === 0) return { reason: "The current text has no explicit formula value to replace." };
  // Remove all recognized markers so an earlier if-branch cannot win. Keep
  // other text, including whitespace and punctuation, exactly as written.
  let inserted = false;
  const pattern = [...new Set(matches)]
    .sort((a, b) => b.length - a.length)
    .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const value = current.replace(new RegExp(pattern, "gi"), () => {
    const replacement = inserted ? "" : next;
    inserted = true;
    return replacement;
  });
  return { value };
}

function cleanFrontmatter(fm: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(fm).filter(([key]) => key !== "position"));
}

function fingerprint(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(fingerprint).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${fingerprint(item)}`)
      .join(",")}}`;
  }
  return value === undefined ? "undefined" : JSON.stringify(value);
}

function keyOf(value: Value | undefined): string {
  if (!value || value instanceof NullValue) return "null";
  if (value instanceof ListValue)
    return `list:[${Array.from({ length: value.length() }, (_, index) => keyOf(value.get(index))).join(",")}]`;
  return JSON.stringify([(value.constructor as typeof Value).type, value.toString()]);
}

function foldKey(state: State, group: BasesEntryGroup): string {
  return JSON.stringify([state.controller.viewName, state.view.config.groupBy?.property, keyOf(group.key)]);
}

function isFolded(state: State, group: BasesEntryGroup): boolean {
  return state.nativeFolding?.isGroupCollapsed(group) ?? state.folded.has(foldKey(state, group));
}

function setFolded(state: State, group: BasesEntryGroup, folded: boolean): boolean {
  if (isFolded(state, group) === folded) return false;
  if (state.nativeFolding) state.nativeFolding.toggleGroupCollapsed(group);
  else if (folded) state.folded.add(foldKey(state, group));
  else state.folded.delete(foldKey(state, group));
  return true;
}

function groupLabel(group: BasesEntryGroup): string {
  if (!group.key || group.key instanceof NullValue) return "Empty";
  if (group.key instanceof ListValue && group.key.length() === 0) return "Empty list";
  const label = group.key.toString();
  return label === "" ? '""' : label;
}

function clippingParents(el: HTMLElement): Clip[] {
  const clips: Clip[] = [];
  for (let current: HTMLElement | null = el; current; current = current.parentElement) {
    const style = current.win.getComputedStyle(current);
    const x = /auto|scroll|hidden|clip/.test(style.overflowX);
    const y = /auto|scroll|hidden|clip/.test(style.overflowY);
    if (x || y || current === el) clips.push({ el: current, x, y, scroll: /auto|scroll/.test(style.overflowY) });
  }
  return clips;
}

function visibleBounds(el: HTMLElement, clips: Clip[]): { top: number; bottom: number; left: number; right: number } {
  const rect = el.getBoundingClientRect();
  const bounds = {
    top: Math.max(0, rect.top),
    bottom: Math.min(el.win.innerHeight, rect.bottom),
    left: Math.max(0, rect.left),
    right: Math.min(el.win.innerWidth, rect.right),
  };
  for (const clip of clips) {
    const parent = clip.el.getBoundingClientRect();
    if (clip.y) {
      bounds.top = Math.max(bounds.top, parent.top);
      bounds.bottom = Math.min(bounds.bottom, parent.bottom);
    }
    if (clip.x) {
      bounds.left = Math.max(bounds.left, parent.left);
      bounds.right = Math.min(bounds.right, parent.right);
    }
  }
  return bounds;
}

function insertionPoint(
  state: State,
  table: Table["groups"][number],
  group: BasesEntryGroup,
  index: number,
  clips: Clip[],
): { folded: boolean; top: number; left: number; width: number; viewportTop: number; viewportBottom: number } {
  const { scrollEl } = state.view;
  const bounds = visibleBounds(scrollEl, clips);
  const rect = table.tbodyEl.getBoundingClientRect();
  const scale = scrollEl.offsetHeight > 0 ? scrollEl.getBoundingClientRect().height / scrollEl.offsetHeight : 1;
  const rendered = table.tbodyEl.querySelector<HTMLElement>(".bases-tr")?.getBoundingClientRect().height ?? 0;
  const measured = rendered > 0 ? 0 : parseFloat(table.tbodyEl.getCssPropertyValue("--bases-table-row-height"));
  const fallback = (measured > 0 ? measured : 30) * scale;
  const rowHeight = rendered > 0 ? rendered : fallback;
  const headerBottom = scrollEl.querySelector(".bases-thead")?.getBoundingClientRect().bottom ?? bounds.top;
  return {
    folded: isFolded(state, group),
    top: rect.top + index * rowHeight,
    left: Math.max(rect.left, bounds.left),
    width: Math.max(0, Math.min(rect.right, bounds.right) - Math.max(rect.left, bounds.left)),
    viewportTop: Math.max(bounds.top, Math.min(headerBottom, bounds.bottom)),
    viewportBottom: bounds.bottom,
  };
}

function isTable(value: unknown): value is Table {
  const view = value as Partial<Table> | null;
  return (
    view?.type === "table" &&
    Array.isArray(view.groups) &&
    Array.isArray(view.rows) &&
    typeof view.display === "function" &&
    typeof view.updateVirtualDisplay === "function" &&
    view.scrollEl?.instanceOf(HTMLElement) === true
  );
}

function isController(value: unknown): value is Controller {
  const c = value as Partial<Controller> | null;
  return (
    c != null &&
    typeof c.addChild === "function" &&
    typeof c.removeChild === "function" &&
    typeof c.applySearchQuery === "function" &&
    c.viewContainerEl?.instanceOf(HTMLElement) === true
  );
}

function projectEntry(
  app: App,
  entry: Entry,
  fm: Record<string, unknown>,
): { entry: Entry; reliable(): boolean } | null {
  const fromFrontMatter = entry.note?.constructor.fromFrontMatter;
  if (!entry.ctx || typeof fromFrontMatter !== "function") return null;
  const Constructor = BasesEntry as unknown as new (ctx: Entry["ctx"], file: Entry["file"]) => Entry;
  const projected = new Constructor(entry.ctx, entry.file);
  projected.frontmatter = fm;
  projected.note = fromFrontMatter(app, entry.file, fm) as NonNullable<Entry["note"]>;
  const implicit = projected.implicit;
  if (
    !implicit ||
    typeof implicit.getProps !== "function" ||
    typeof implicit.getTags !== "function" ||
    typeof implicit.getLinks !== "function" ||
    typeof implicit.getBacklinks !== "function" ||
    typeof implicit.objectAccess !== "function"
  )
    return null;
  // Native file.hasProperty and file.hasTag read the metadata cache, not note.
  // Project them too, including body tags and native tag hierarchy semantics.
  const tags = [
    ...(app.metadataCache.getFileCache(entry.file)?.tags?.map((tag) => tag.tag) ?? []),
    ...(parseFrontMatterTags(fm) ?? []),
  ];
  const tagProps = fromFrontMatter(app, entry.file, { tags: [...new Set(tags)] }) as Entry["note"];
  const tagList = tagProps?.objectAccess?.("tags");
  if (!tagList) return null;
  implicit.getProps = () => projected.note;
  implicit.getTags = () => tagList;
  let reliable = true;
  const access = implicit.objectAccess.bind(implicit);
  implicit.objectAccess = (key) => {
    if (["mtime", "size"].includes(key.toLowerCase())) reliable = false;
    return access(key);
  };
  for (const method of ["getLinks", "getBacklinks"] as const) {
    const original = implicit[method].bind(implicit);
    implicit[method] = () => {
      reliable = false;
      return original();
    };
  }
  // Formula evaluation catches exceptions. Keep a flag instead of throwing
  // when a formula reads file metadata we cannot predict before a disk write.
  return { entry: projected, reliable: () => reliable };
}

function movePlan(app: App, drag: RowTarget, target: BasesEntryGroup): Plan {
  const { state, entry, group } = drag;
  const { view, controller } = state;
  const property = view.config.groupBy?.property;
  if (property === undefined || !view.data || !entry.frontmatter || entry.file.extension !== "md")
    return { reason: "This row has no writable note properties." };
  if (Value.looseEquals(group.key ?? null, target.key ?? null)) return { reason: "Already in this group." };
  const rule = groupRule(property, controller.query?.formulas ?? {});
  if (
    !rule ||
    rule.property === "" ||
    ["__proto__", "constructor", "prototype", "position"].includes(rule.property.toLowerCase())
  )
    return { reason: "This grouping is calculated; no unambiguous property change is available." };
  const before = cleanFrontmatter(entry.frontmatter);
  if (Object.keys(before).filter((key) => key.toLowerCase() === rule.property.toLowerCase()).length > 1) {
    return { reason: "The note has conflicting spellings of this property name." };
  }
  const key = fieldName(before, rule.property);
  const current = before[key];
  let desired: unknown;
  if (rule.mode === "direct") {
    const donor = target.entries[0] as Entry | undefined;
    const fm = donor?.frontmatter;
    desired = fm?.[fieldName(fm, rule.property)];
  } else {
    desired = (target.key as (Value & { data?: unknown }) | undefined)?.data;
  }
  if (!stored(current) || !stored(desired)) return { reason: "This property has an unsupported or nested value." };
  const change = changeValue(rule, current, desired);
  if ("reason" in change) return change;
  if (fingerprint(change.value) === fingerprint(current)) return { reason: "The property already has this value." };
  const formulas = controller.query?.formulas ?? {};
  const self = entry.ctx?.local?.file === entry.file;
  const search = typeof controller.getSearchQuery === "function" ? controller.getSearchQuery() : undefined;
  const properties = [
    ...view.config.getSort().map((sort) => sort.property),
    ...(search === null || search === "" ? [] : view.config.getOrder()),
  ];
  // file(...) and link.asFile() create separate native file values, bypassing
  // this entry's projected metadata. Inspect only filters and active ordering.
  if (
    hasFileLookup(entry.ctx?.filter, formulas, self) ||
    properties.some(
      (id) =>
        id.toLowerCase() === "file.backlinks" ||
        (id.startsWith("formula.") && hasFileLookup(formulaFor(formulas, id.slice(8)), formulas, self)),
    )
  )
    return { reason: "This view uses file lookups whose result cannot be predicted before saving." };
  const fm = { ...before };
  if (change.value === undefined) delete fm[key];
  else fm[key] = change.value;
  const projection = projectEntry(app, entry, fm);
  if (!projection || !Value.looseEquals(projection.entry.getValue(property), target.key ?? null))
    return { reason: "This change would not place the note in the selected group." };
  const projected = projection.entry;
  if (
    projected.ctx?.filter?.test(projected) === false ||
    controller.applySearchQuery([projected], view.config.getOrder()).length === 0
  )
    return { reason: "This change would hide the note under the current filters." };
  if (typeof view.data.applySort !== "function")
    return { reason: "The sorted position is unavailable in this version of Bases." };
  if (typeof view.createTransaction !== "function")
    return { reason: "Undoable moves are unavailable in this version of Bases." };
  const entries = [...target.entries.filter((item) => item.file !== entry.file), projected];
  entries.sort((a, b) => collator.compare(a.file.path, b.file.path));
  view.data.applySort(entries);
  const limit = view.config.getLimit?.() ?? 0;
  if (limit > 0) {
    if (!controller.results) return { reason: "The position within this result limit is unavailable." };
    const all = controller.applySearchQuery(Array.from(controller.results.values()), view.config.getOrder());
    all.sort((a, b) => collator.compare(a.file.path, b.file.path));
    view.data.applySort(all);
    const first = view.data.data[0];
    const start = first ? all.indexOf(first) : -1;
    if (start < 0) return { reason: "The current page changed. Try again." };
    const after = all.map((item) => (item.file === entry.file ? projected : item));
    after.sort((a, b) => collator.compare(a.file.path, b.file.path));
    view.data.applySort(after);
    const index = after.indexOf(projected);
    if (index < start || index >= start + limit) return { reason: "This note would move outside the current page." };
    entries.splice(
      0,
      entries.length,
      ...after
        .slice(start, start + limit)
        .filter((item) => Value.looseEquals(item.getValue(property), target.key ?? null)),
    );
  }
  if (!projection.reliable())
    return { reason: "This view depends on file metadata that changes when the note is saved." };
  return {
    move: {
      property: key,
      value: change.value,
      before,
      index: entries.indexOf(projected),
    },
  };
}

/** Uses native group folding when available (Obsidian 1.14+), otherwise a
 * temporary render model that leaves query results intact.
 * Moves write only frontmatter, after Bases itself has validated the prediction.
 */
export const basesGroups: Patch = {
  id: "bases-groups",
  name: "Bases groups",
  description:
    "Fold table groups and drag rows between them with a preview of the sorted position. Preserves property types and supports reversible grouping formulas.",
  register(plugin: Plugin, ctx: PatchContext): PatchHandle {
    const { app } = plugin;
    const states = new Map<Controller, State>();
    const windows = new Map<Window, () => void>();
    let drag: Drag | null = null;
    let suppressClick: Document | null = null;
    let unloaded = false;
    let queued = false;
    const writes = new Set<Entry["file"]>();

    const stopScrolling = (current: Drag): void => {
      const el = current.scrolling;
      if (!el) return;
      current.scrolling = null;
      el.scrollTo({ top: el.scrollTop, left: el.scrollLeft, behavior: "instant" });
    };

    const cancelDrag = (): void => {
      if (!drag) return;
      stopScrolling(drag);
      if (drag.frame !== null) drag.origin.win.cancelAnimationFrame(drag.frame);
      if (drag.revealTimer !== null) drag.origin.win.clearTimeout(drag.revealTimer);
      drag.preview?.remove();
      drag.line?.remove();
      drag.targetEl?.removeClass(`${PREFIX}-target`);
      drag.sourceEl.removeClass(`${PREFIX}-dragging`);
      drag.origin.doc.body.removeClass(`${PREFIX}-moving`);
      drag = null;
    };

    const removeDom = (state: State): void => {
      state.toolbar?.remove();
      state.toolbar = null;
      const root = state.controller.viewContainerEl;
      state.rows = new WeakMap();
      state.tables = new WeakMap();
      for (const el of root.querySelectorAll(`.${PREFIX}-toggle`)) el.remove();
      for (const el of root.querySelectorAll(`.${PREFIX}-folded`)) el.removeClass(`${PREFIX}-folded`);
    };

    const toggle = (state: State, group: BasesEntryGroup): void => {
      cancelDrag();
      setFolded(state, group, !isFolded(state, group));
      state.view.display();
    };

    const tableAt = (
      state: State,
      el: Element | null,
    ): { table: Table["groups"][number]; group: BasesEntryGroup } | undefined => {
      for (let current = el; current && current !== state.controller.viewContainerEl; current = current.parentElement) {
        const target = state.tables.get(current as HTMLElement);
        if (target) return target;
      }
      return undefined;
    };

    const decorate = (state: State, headers: boolean): void => {
      const { controller, view } = state;
      if (!ctx.isEnabled() || unloaded || states.get(controller) !== state || controller.view !== view) return;
      if (!view.config.groupBy || !view.data) {
        removeDom(state);
        return;
      }
      if (headers) {
        const groups = view.data.groupedData;
        if (state.toolbar?.isConnected !== true) {
          state.toolbar =
            controller.viewContainerEl.parentElement
              ?.querySelector(".bases-toolbar")
              ?.createDiv({ cls: `bases-toolbar-item ${PREFIX}-actions` }) ?? null;
          state.toolbar?.createEl("button", { cls: "clickable-icon" }).addEventListener("click", () => {
            cancelDrag();
            const current = view.data?.groupedData ?? [];
            const expand = current.every((group) => isFolded(state, group));
            for (const group of current) setFolded(state, group, !expand);
            view.display();
          });
        }
        const sort = state.toolbar?.parentElement?.querySelector(".bases-toolbar-sort-menu");
        if (state.toolbar && sort && state.toolbar.nextElementSibling !== sort) sort.before(state.toolbar);
        state.tables = new WeakMap();
        for (let index = 0; index < groups.length; index++) {
          const group = groups[index];
          const table = view.groups[index];
          if (!group || !table) continue;
          const target = { table, group };
          if (drag?.state === state && drag.target === group) drag.targetTable = table;
          state.tables.set(table.tableEl, target);
          state.tables.set(table.tbodyEl, target);
          if (state.nativeFolding) continue;
          const heading = table.tableEl.querySelector<HTMLElement>(".bases-group-heading");
          if (!heading) continue;
          const folded = state.folded.has(foldKey(state, group));
          table.tableEl.toggleClass(`${PREFIX}-folded`, folded);
          let button = heading.querySelector<HTMLButtonElement>(`.${PREFIX}-toggle`);
          if (!button) {
            button = heading.createEl("button", { cls: `clickable-icon ${PREFIX}-toggle` });
            heading.prepend(button);
            button.addEventListener("click", (evt) => {
              evt.preventDefault();
              evt.stopPropagation();
              const current = tableAt(state, evt.currentTarget as HTMLElement);
              if (current) toggle(state, current.group);
            });
          }
          button.setAttribute("aria-expanded", String(!folded));
          button.setAttribute(
            "aria-label",
            `${folded ? "Expand" : "Collapse"} ${groupLabel(group)} (${group.entries.length})`,
          );
          if (button.dataset["folded"] !== String(folded)) {
            button.dataset["folded"] = String(folded);
            setIcon(button, folded ? "chevron-right" : "chevron-down");
          }
        }
      }
      const action = state.toolbar?.querySelector("button");
      if (action) {
        const groups = view.data.groupedData;
        const expand = groups.length > 0 && groups.every((group) => isFolded(state, group));
        const label = expand ? "Expand all groups" : "Collapse all groups";
        action.disabled = groups.length === 0;
        if (action.getAttribute("aria-label") !== label) {
          action.setAttribute("aria-label", label);
          action.setAttribute("title", label);
          setIcon(action, expand ? "unfold-vertical" : "fold-vertical");
        }
      }
      for (const row of view.rows) {
        const moving = drag?.state === state && drag.active && drag.entry.file === row.entry.file;
        row.el.toggleClass(`${PREFIX}-dragging`, moving);
        if (moving && drag && drag.sourceEl !== row.el) {
          drag.sourceEl.removeClass(`${PREFIX}-dragging`);
          drag.sourceEl = row.el;
        }
        state.rows.set(row.el, row.entry);
      }
    };

    const forget = (controller: Controller): void => {
      const state = states.get(controller);
      if (!state) return;
      if (drag?.state === state) cancelDrag();
      states.delete(controller);
      state.restore();
      removeDom(state);
      controller.removeChild(state.hook);
      if (controller.view === state.view && state.view.data) state.view.display();
    };

    const attach = (controller: Controller, view: Table): void => {
      const hook = new Component();
      const restores: Array<() => void> = [];
      const state: State = {
        controller,
        view,
        hook,
        nativeFolding:
          typeof view.isGroupCollapsed === "function" && typeof view.toggleGroupCollapsed === "function"
            ? (view as NativeFolding)
            : null,
        folded: new Set(),
        rows: new WeakMap(),
        tables: new WeakMap(),
        file: controller.query?.file,
        toolbar: null,
        restore: () => {
          for (const restore of restores) restore();
        },
      };
      states.set(controller, state);
      hook.registerDomEvent(
        controller.viewContainerEl,
        "pointerdown",
        (evt) => {
          pointerDown(state, evt);
        },
        true,
      );
      hook.registerDomEvent(controller.viewContainerEl, "click", (evt) => {
        if (state.nativeFolding) return;
        if (evt.defaultPrevented || evt.button !== 0 || evt.ctrlKey || evt.metaKey || evt.altKey || evt.shiftKey)
          return;
        const node = evt.targetNode;
        if (node?.instanceOf(Element) !== true || !node.closest(".bases-group-heading")) return;
        if (
          node.closest<HTMLElement>("[contenteditable]")?.isContentEditable === true ||
          node.closest("a, .internal-link, button, input, select, textarea, [role='button']")
        )
          return;
        const current = tableAt(state, node);
        if (!current) return;
        evt.preventDefault();
        evt.stopPropagation();
        toggle(state, current.group);
      });
      let rendering = false;
      let sourceData: Table["data"];
      let sourceGroups: BasesEntryGroup[] | null = null;
      let sourceKey = "";
      let renderGroups: BasesEntryGroup[] = [];
      let tables: Table["groups"] | null = null;
      const resetModel = (): void => {
        sourceData = undefined;
        sourceGroups = null;
        renderGroups = [];
        tables = null;
      };
      restores.push(() => {
        resetModel();
        state.folded.clear();
      });
      for (const method of ["display", "updateVirtualDisplay"] as const) {
        const original = view[method];
        const hadOwn = Object.prototype.hasOwnProperty.call(view, method);
        const wrapper = (): void => {
          if (!rendering && controller.query?.file !== state.file) {
            state.folded.clear();
            state.file = controller.query?.file;
            sourceGroups = null;
          }
          if (
            rendering ||
            unloaded ||
            !ctx.isEnabled() ||
            states.get(controller) !== state ||
            controller.view !== view ||
            !view.data ||
            !view.config.groupBy
          ) {
            original.call(view);
            if (!rendering) {
              resetModel();
              decorate(state, method === "display");
            }
            return;
          }
          if (drag?.state === state && drag.data !== view.data) cancelDrag();
          if (state.nativeFolding) {
            // Native folding owns the data, selection, layout and saved state.
            rendering = true;
            try {
              original.call(view);
            } finally {
              rendering = false;
            }
            decorate(state, method === "display" || tables !== view.groups);
            tables = view.groups;
            return;
          }
          const data = view.data;
          const groups = data.groupedData;
          const cache = data.groupedDataCache;
          const key = JSON.stringify([controller.viewName, view.config.groupBy.property]);
          const refresh = method === "display" || sourceData !== data || sourceGroups !== groups || sourceKey !== key;
          if (refresh) {
            sourceData = data;
            sourceGroups = groups;
            sourceKey = key;
            renderGroups = groups.map((group, index) => {
              const folded = state.folded.has(foldKey(state, group));
              view.groups[index]?.tableEl.toggleClass(`${PREFIX}-folded`, folded);
              return folded
                ? Object.assign(
                    Object.create(Object.getPrototypeOf(group) as object | null) as BasesEntryGroup,
                    group,
                    {
                      entries: [],
                    },
                  )
                : group;
            });
          }
          rendering = true;
          data.groupedDataCache = renderGroups;
          try {
            original.call(view);
          } finally {
            if (cache === undefined) delete data.groupedDataCache;
            else data.groupedDataCache = cache;
            rendering = false;
          }
          decorate(state, refresh || tables !== view.groups);
          tables = view.groups;
        };
        view[method] = wrapper;
        restores.push(() => {
          if (view[method] !== wrapper) return;
          if (hadOwn) view[method] = original;
          else Reflect.deleteProperty(view, method);
        });
      }
      hook.register(() => {
        forget(controller);
      });
      controller.addChild(hook);
      if (view.data) view.display();
    };

    const sync = (): void => {
      queued = false;
      if (unloaded || !ctx.isEnabled()) return;
      const listeners = (app.vault as unknown as { _?: Record<string, Array<{ ctx?: unknown }> | undefined> })._;
      const live = new Set<Controller>();
      for (const { ctx: candidate } of listeners?.["config-changed"] ?? []) {
        if (!isController(candidate) || !isTable(candidate.view)) continue;
        live.add(candidate);
        if (states.get(candidate)?.view === candidate.view) continue;
        forget(candidate);
        attach(candidate, candidate.view);
      }
      for (const controller of states.keys()) if (!live.has(controller)) forget(controller);
    };

    const queueSync = (): void => {
      if (queued || unloaded || !ctx.isEnabled()) return;
      queued = true;
      queueMicrotask(sync);
    };

    function pointerDown(state: State, evt: PointerEvent): void {
      if (
        !ctx.isEnabled() ||
        unloaded ||
        writes.size > 0 ||
        evt.pointerType === "touch" ||
        evt.defaultPrevented ||
        evt.button !== 0 ||
        evt.ctrlKey ||
        evt.metaKey ||
        evt.altKey ||
        evt.shiftKey
      )
        return;
      const node = evt.targetNode;
      if (node?.instanceOf(Element) !== true) return;
      const editable = node.closest<HTMLElement>("[contenteditable]");
      if (
        (editable?.isContentEditable === true && editable.contains(node.doc.activeElement)) ||
        node.closest(
          "a, .internal-link, input, textarea, select, button, [role='checkbox'], .multi-select-pill-remove-button",
        )
      )
        return;
      const origin = node.closest<HTMLElement>(".bases-td");
      const sourceEl = origin?.closest<HTMLElement>(".bases-tr");
      const entry = sourceEl ? state.rows.get(sourceEl) : undefined;
      const group = tableAt(state, sourceEl ?? null)?.group;
      if (!origin || !sourceEl || !entry || !group) return;
      cancelDrag();
      drag = {
        state,
        entry,
        group,
        pointerId: evt.pointerId,
        x: evt.clientX,
        y: evt.clientY,
        active: false,
        origin,
        sourceEl,
        lastMove: null,
        frame: null,
        scroll: false,
        previewText: null,
        data: state.view.data,
        preview: null,
        line: null,
        targetEl: null,
        plan: null,
        target: null,
        targetTable: null,
        revealTimer: null,
        revealAnchor: null,
        revealPause: null,
        clips: [],
        scrolling: null,
      };
    }

    const revealInsertion = (current: Drag): void => {
      current.revealTimer = null;
      const { state, target, lastMove } = current;
      const move = current.plan?.move;
      // A queued frame may contain a newer pointer position and another group.
      // Let it resolve the target before pinning or scrolling anything.
      if (
        drag !== current ||
        current.frame !== null ||
        current.revealPause !== null ||
        !target ||
        !move ||
        !lastMove ||
        current.data !== state.view.data
      )
        return;
      // Pin the chosen group while the content moves under a stationary pointer.
      // A deliberate pointer movement resumes normal target selection.
      current.revealAnchor = { x: lastMove.clientX, y: lastMove.clientY };
      if (setFolded(state, target, false)) state.view.display();
      if (!current.targetTable) return;
      let outer: HTMLElement | null = null;
      for (const clip of current.clips) {
        if (clip.scroll && clip.el.scrollHeight > clip.el.clientHeight) outer = clip.el;
      }
      for (const clip of current.clips) {
        if (!clip.scroll || clip.el.scrollHeight <= clip.el.clientHeight) continue;
        const point = insertionPoint(state, current.targetTable, target, move.index, current.clips);
        if (point.top >= point.viewportTop + 12 && point.top <= point.viewportBottom - 12) break;
        const scale = clip.el.offsetHeight > 0 ? clip.el.getBoundingClientRect().height / clip.el.offsetHeight : 1;
        const top = clip.el.scrollTop + (point.top - (point.viewportTop + point.viewportBottom) / 2) / scale;
        // CodeMirror adjusts scrollTop while measuring its widgets, which
        // interrupts a smooth scroll before it reaches the insertion point.
        if (clip.el === outer && outer !== state.view.scrollEl && !outer.hasClass("cm-scroller")) {
          // A large instant jump can recycle a long Markdown embed and reset
          // its scroll position. Let the containing note virtualize gradually.
          current.scrolling = outer;
          outer.scrollTo({ top, behavior: "smooth" });
        } else clip.el.scrollTop = top;
      }
      state.view.updateVirtualDisplay();
      scheduleDrag(lastMove, false);
    };

    const updateDrag = (evt: PointerEvent, scroll: boolean): void => {
      const current = drag;
      if (current?.pointerId !== evt.pointerId || evt.doc !== current.origin.doc) return;
      if (!current.active && Math.hypot(evt.clientX - current.x, evt.clientY - current.y) < 6) return;
      const { state } = current;
      const { view } = state;
      if (
        unloaded ||
        !ctx.isEnabled() ||
        states.get(state.controller) !== state ||
        state.controller.view !== view ||
        current.data !== view.data
      ) {
        cancelDrag();
        return;
      }
      if (
        current.revealPause &&
        Math.hypot(evt.clientX - current.revealPause.x, evt.clientY - current.revealPause.y) >= 6
      )
        current.revealPause = null;
      if (
        current.revealAnchor &&
        Math.hypot(evt.clientX - current.revealAnchor.x, evt.clientY - current.revealAnchor.y) >= 6
      ) {
        stopScrolling(current);
        current.revealAnchor = null;
      }
      if (!current.active) {
        current.active = true;
        current.clips = clippingParents(view.scrollEl);
        suppressClick = current.origin.doc;
        current.origin.doc.getSelection()?.removeAllRanges();
        current.sourceEl = view.rows.find((row) => row.entry.file === current.entry.file)?.el ?? current.sourceEl;
        current.origin.doc.body.addClass(`${PREFIX}-moving`);
        current.sourceEl.addClass(`${PREFIX}-dragging`);
        current.preview = current.origin.doc.body.createDiv({
          cls: `${PREFIX}-preview`,
          attr: { role: "status", "aria-live": "polite" },
        });
        current.line = current.origin.doc.body.createDiv(`${PREFIX}-line`);
      }
      const found =
        current.revealAnchor && current.target && current.targetTable
          ? { group: current.target, table: current.targetTable }
          : tableAt(state, current.origin.doc.elementFromPoint(evt.clientX, evt.clientY));
      const target = found?.group ?? null;
      const table = found?.table;
      current.targetTable = table ?? null;
      if (target !== current.target) {
        if (current.revealTimer !== null) current.origin.win.clearTimeout(current.revealTimer);
        current.revealTimer = null;
        current.target = target;
        try {
          current.plan = target ? movePlan(app, current, target) : null;
        } catch (error) {
          console.error("Micropatches (bases-groups): preview failed", error);
          current.plan = { reason: "This move could not be calculated." };
        }
      }
      const move = current.plan?.move;
      const before = move?.before[move.property];
      const oldValue = before == null ? "Empty" : JSON.stringify(before);
      const newValue = move?.value == null ? "Empty" : JSON.stringify(move.value);
      const text = move
        ? `${move.property}\n${oldValue} → ${newValue}`
        : (current.plan?.reason ?? "Move over a group in this table");
      // Read geometry before writing the preview. Rendered row rectangles also
      // include Canvas scaling, unlike the table's unscaled CSS row height.
      const bounds = visibleBounds(view.scrollEl, current.clips);
      const point = move && table && target ? insertionPoint(state, table, target, move.index, current.clips) : null;
      const visible =
        point !== null && !point.folded && point.top >= point.viewportTop && point.top <= point.viewportBottom;
      if (text !== current.previewText) {
        current.previewText = text;
        current.preview?.empty();
        if (move) {
          current.preview?.createDiv({ cls: `${PREFIX}-property`, text: move.property });
          current.preview?.createDiv({ text: `${oldValue} → ${newValue}` });
        } else current.preview?.setText(text);
        current.preview?.toggleClass("is-blocked", !move);
      }
      current.preview?.setCssStyles({
        left: `${Math.max(8, Math.min(evt.clientX + 16, current.origin.win.innerWidth - 340))}px`,
        top: `${Math.max(8, Math.min(evt.clientY + 20, current.origin.win.innerHeight - 80))}px`,
      });
      const targetEl = move ? (table?.tableEl ?? null) : null;
      if (targetEl !== current.targetEl) {
        current.targetEl?.removeClass(`${PREFIX}-target`);
        current.targetEl = targetEl;
        targetEl?.addClass(`${PREFIX}-target`);
      }
      if (visible) {
        current.line?.setCssStyles({ top: `${point.top}px`, left: `${point.left}px`, width: `${point.width}px` });
        current.line?.show();
      } else current.line?.hide();
      if (point && !visible && !current.revealAnchor && !current.revealPause && current.revealTimer === null) {
        current.revealTimer = current.origin.win.setTimeout(() => {
          revealInsertion(current);
        }, 300);
      } else if (visible && current.revealTimer !== null) {
        current.origin.win.clearTimeout(current.revealTimer);
        current.revealTimer = null;
      }
      if (
        scroll &&
        !current.revealAnchor &&
        evt.clientX >= bounds.left &&
        evt.clientX <= bounds.right &&
        evt.clientY >= bounds.top &&
        evt.clientY <= bounds.bottom
      ) {
        let delta = 0;
        if (evt.clientY < bounds.top + 32) delta = -20;
        else if (evt.clientY > bounds.bottom - 32) delta = 20;
        for (const clip of current.clips) {
          if (delta === 0 || !clip.scroll) continue;
          const previous = clip.el.scrollTop;
          clip.el.scrollTop += delta;
          if (clip.el.scrollTop === previous) continue;
          scheduleDrag(evt, true);
          break;
        }
      }
    };

    const scheduleDrag = (evt: PointerEvent, scroll: boolean): void => {
      const current = drag;
      if (current?.pointerId !== evt.pointerId) return;
      current.lastMove = evt;
      current.scroll ||= scroll;
      if (current.frame !== null) return;
      current.frame = current.origin.win.requestAnimationFrame(() => {
        current.frame = null;
        const shouldScroll = current.scroll;
        current.scroll = false;
        if (drag === current && current.lastMove) updateDrag(current.lastMove, shouldScroll);
      });
    };

    const pointerMove = (evt: PointerEvent): void => {
      const current = drag;
      if (current?.pointerId !== evt.pointerId || evt.doc !== current.origin.doc) return;
      if (!current.active && Math.hypot(evt.clientX - current.x, evt.clientY - current.y) < 6) return;
      evt.preventDefault();
      evt.stopImmediatePropagation();
      scheduleDrag(evt, true);
    };

    const commit = async (current: Drag): Promise<void> => {
      if (
        !current.target ||
        writes.size > 0 ||
        unloaded ||
        !ctx.isEnabled() ||
        current.data !== current.state.view.data ||
        states.get(current.state.controller) !== current.state
      )
        return;
      const plan = movePlan(app, current, current.target);
      if (!plan.move) {
        new Notice(plan.reason);
        return;
      }
      const { move } = plan;
      const view = current.state.view;
      if (typeof view.createTransaction !== "function") return;
      writes.add(current.entry.file);
      try {
        await view.createTransaction(async (changes) => {
          await app.fileManager.processFrontMatter(current.entry.file, (frontmatter: Record<string, unknown>) => {
            if (unloaded || !ctx.isEnabled() || fingerprint(cleanFrontmatter(frontmatter)) !== fingerprint(move.before))
              throw new Error("The note changed during the drag. Try again.");
            const start = structuredClone(frontmatter);
            // Native undo assigns snapshots. Undefined lets the YAML writer
            // remove a newly added key; clearing an existing value uses null,
            // as native cell editing does, preserving undo history's key order.
            start[move.property] = frontmatter[move.property];
            frontmatter[move.property] = move.value;
            const end = structuredClone(frontmatter);
            changes.push({ file: current.entry.file, start, end });
          });
        });
      } catch (error) {
        console.error("Micropatches (bases-groups): move failed", error);
        new Notice(error instanceof Error ? error.message : "Could not move the note.");
      } finally {
        writes.delete(current.entry.file);
      }
    };

    const pointerUp = (evt: PointerEvent): void => {
      if (drag?.pointerId !== evt.pointerId || evt.doc !== drag.origin.doc) return;
      const current = drag;
      if (current.frame !== null) {
        current.origin.win.cancelAnimationFrame(current.frame);
        current.frame = null;
      }
      if (current.active || current.lastMove) {
        // Re-evaluate the release location; a pointerup need not have a final move.
        updateDrag(evt, false);
        evt.preventDefault();
      }
      if (drag !== current) return;
      cancelDrag();
      if (current.active && current.plan?.move)
        commit(current).catch((error: unknown) => {
          console.error("Micropatches (bases-groups): move failed", error);
        });
    };

    const setupWindow = (win: Window): void => {
      if (windows.has(win) || unloaded) return;
      const doc = win.document;
      const keydown = (evt: KeyboardEvent): void => {
        if (evt.key === "Escape") cancelDrag();
      };
      const onScroll = (): void => {
        if (drag?.lastMove && drag.origin.doc === doc) scheduleDrag(drag.lastMove, false);
      };
      const onWheel = (): void => {
        if (drag?.origin.doc !== doc) return;
        stopScrolling(drag);
        drag.revealAnchor = null;
        // Manual scrolling stays in control until the pointer moves again.
        if (drag.lastMove) drag.revealPause = { x: drag.lastMove.clientX, y: drag.lastMove.clientY };
        if (drag.revealTimer !== null) win.clearTimeout(drag.revealTimer);
        drag.revealTimer = null;
        if (drag.lastMove) scheduleDrag(drag.lastMove, false);
      };
      const resetClick = (): void => {
        cancelDrag();
        suppressClick = null;
      };
      const onClick = (evt: MouseEvent): void => {
        if (suppressClick !== doc || evt.detail === 0) return;
        suppressClick = null;
        evt.preventDefault();
        evt.stopImmediatePropagation();
      };
      const onDragStart = (evt: DragEvent): void => {
        const node = evt.targetNode;
        if (!drag || !node || !drag.origin.contains(node)) return;
        // Keep native row dragging in the same pointer stream as ordinary cells.
        // Links keep their native drag because pointerDown does not arm them.
        evt.preventDefault();
        evt.stopImmediatePropagation();
      };
      doc.addEventListener("pointerdown", resetClick, true);
      doc.addEventListener("click", onClick, true);
      doc.addEventListener("dragstart", onDragStart, true);
      doc.addEventListener("pointermove", pointerMove, { passive: false, capture: true });
      doc.addEventListener("pointerup", pointerUp, true);
      doc.addEventListener("pointercancel", cancelDrag);
      doc.addEventListener("keydown", keydown, true);
      doc.addEventListener("scroll", onScroll, true);
      doc.addEventListener("wheel", onWheel, { passive: true });
      win.addEventListener("blur", cancelDrag);
      const observer = new MutationObserver((records) => {
        if (
          records.some((record) =>
            [...Array.from(record.addedNodes), ...Array.from(record.removedNodes)].some(
              (node) =>
                node.instanceOf(Element) &&
                (node.matches(".bases-view, .bases-table-container") ||
                  node.querySelector(".bases-view, .bases-table-container") !== null),
            ),
          )
        )
          queueSync();
      });
      observer.observe(doc.body, { childList: true, subtree: true });
      windows.set(win, () => {
        observer.disconnect();
        doc.removeEventListener("pointerdown", resetClick, true);
        doc.removeEventListener("click", onClick, true);
        doc.removeEventListener("dragstart", onDragStart, true);
        doc.removeEventListener("pointermove", pointerMove, true);
        doc.removeEventListener("pointerup", pointerUp, true);
        doc.removeEventListener("pointercancel", cancelDrag);
        doc.removeEventListener("keydown", keydown, true);
        doc.removeEventListener("scroll", onScroll, true);
        doc.removeEventListener("wheel", onWheel);
        win.removeEventListener("blur", cancelDrag);
      });
    };

    const clear = (): void => {
      cancelDrag();
      suppressClick = null;
      for (const controller of states.keys()) forget(controller);
      for (const teardown of windows.values()) teardown();
      windows.clear();
    };
    const install = (): void => {
      if (unloaded || !ctx.isEnabled()) return;
      setupWindow(window);
      app.workspace.iterateAllLeaves((leaf) => {
        setupWindow(leaf.view.containerEl.win);
      });
      sync();
    };
    plugin.registerEvent(app.workspace.on("layout-change", queueSync));
    plugin.registerEvent(
      app.workspace.on("window-open", (_workspaceWindow, win) => {
        if (ctx.isEnabled()) {
          setupWindow(win);
          queueSync();
        }
      }),
    );
    plugin.registerEvent(
      app.workspace.on("window-close", (_workspaceWindow, win) => {
        if (drag?.origin.win === win) cancelDrag();
        if (suppressClick === win.document) suppressClick = null;
        windows.get(win)?.();
        windows.delete(win);
        queueSync();
      }),
    );
    app.workspace.onLayoutReady(install);
    return {
      cleanup: () => {
        unloaded = true;
        clear();
      },
      onToggle: (enabled) => {
        if (enabled) install();
        else clear();
      },
      onConfigChange: () => {
        cancelDrag();
        queueSync();
      },
    };
  },
};
