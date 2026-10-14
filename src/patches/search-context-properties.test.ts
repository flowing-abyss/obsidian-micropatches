import * as obsidian from "obsidian";
import type { FrontmatterLinkCache } from "obsidian";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isPropertyMatchRow, renderProperties } from "./search-context";

vi.mock("obsidian", async (importOriginal) => ({
  ...(await importOriginal<typeof obsidian>()),
  renderMatches: vi.fn(),
}));

type PropertyRow = Parameters<typeof renderProperties>[1];
type PropertyHit = PropertyRow["matches"][number];

const parent = { type: "property-result" };
const isParent = (value: unknown): value is typeof parent => value === parent;
const RAW = "[[Target|Alias]]";
const LINK: FrontmatterLinkCache = { key: "related", link: "Target", original: RAW, displayText: "Alias" };

function row(
  frontmatter: Record<string, unknown>,
  matches: PropertyHit[],
  links: FrontmatterLinkCache[] = [],
): PropertyRow {
  return {
    el: createDiv(),
    parentDom: parent,
    cache: { frontmatter, frontmatterLinks: links },
    matches,
    render: vi.fn(),
  };
}

function highlights(el: HTMLElement): string[] {
  return Array.from(el.querySelectorAll(".search-result-file-matched-text"), (mark) => mark.textContent);
}

function render(value: PropertyRow): HTMLElement {
  const el = createDiv();
  expect(renderProperties(el, value)).toBe(true);
  return el;
}

function expectUnchanged(value: PropertyRow): void {
  const el = createDiv();
  const original = el.createSpan({ text: "Original native result" });
  const listener = vi.fn();
  original.addEventListener("click", listener);
  expect(renderProperties(el, value)).toBe(false);
  expect(Array.from(el.childNodes)).toEqual([original]);
  original.click();
  expect(listener).toHaveBeenCalledOnce();
}

beforeEach(() => {
  // The upstream renderMatches mock is a no-op. Implement its public DOM/range
  // contract here so assertions exercise real text nodes and highlighted spans.
  vi.mocked(obsidian.renderMatches).mockImplementation((el, text, matches, offset = 0) => {
    let cursor = 0;
    for (const [start, end] of matches ?? []) {
      const from = Math.max(0, start - offset);
      const to = Math.min(text.length, end - offset);
      if (to <= from) continue;
      el.append(text.slice(cursor, from));
      const mark = createSpan();
      mark.className = "suggestion-highlight";
      mark.textContent = text.slice(from, to);
      el.append(mark);
      cursor = to;
    }
    el.append(text.slice(cursor));
  });
});

describe("search context property values", () => {
  it("renders the native alias and highlights it when the destination matched", () => {
    const value = row({ related: RAW }, [{ key: "related", pos: [2, 8] }], [LINK]);
    const nativeRender = vi.fn();
    value.render = nativeRender;
    const el = render(value);
    const link = el.querySelector("a");
    expect(el.textContent).toBe("related: Alias");
    expect(link?.className).toBe("internal-link");
    expect(link?.getAttribute("href")).toBe("Target");
    expect(link?.getAttribute("data-href")).toBe("Target");
    expect(link?.getAttribute("aria-label")).toBe("Target");
    expect(highlights(el)).toEqual(["Alias"]);
    expect(el.querySelector(".suggestion-highlight")).toBeNull();
    expect(value.matches).toEqual([{ key: "related", pos: [2, 8] }]);
    expect(nativeRender).not.toHaveBeenCalled();
  });

  it("renders a property backlink's full native range and a Markdown-link value", () => {
    const original = "[Display](Other%20Note.md#Heading)";
    const el = render(
      row(
        { related: [RAW, original] },
        [
          { key: "related", subkey: ["0"], pos: [0, RAW.length] },
          { key: "related", subkey: [1], pos: [0, original.length] },
        ],
        [
          { ...LINK, key: "related.0" },
          { key: "related.1", original, link: "Other Note.md#Heading", displayText: "Display" },
        ],
      ),
    );
    expect(el.textContent).toBe("related: Alias, Display");
    expect(highlights(el)).toEqual(["Alias", "Display"]);
    expect(Array.from(el.querySelectorAll("a"), (link) => link.getAttribute("data-href"))).toEqual([
      "Target",
      "Other Note.md#Heading",
    ]);
  });

  it("keeps a visible alias match partial and merges overlapping native ranges", () => {
    const el = render(
      row(
        { related: RAW },
        [
          { key: "related", pos: [9, 12] },
          { key: "related", pos: [10, 11] },
        ],
        [LINK],
      ),
    );
    expect(el.querySelector("a")?.textContent).toBe("Alias");
    expect(highlights(el)).toEqual(["Ali"]);
  });

  it("preserves all array value hits, exact paths, and falsy decoded values", () => {
    const el = render(
      row(
        { related: [RAW, "Second", false, 0] },
        [
          { key: "related", subkey: [0], pos: [2, 8] },
          { key: "related", subkey: [1], pos: [0, 3] },
          { key: "related", subkey: [2], pos: [0, 5] },
          { key: "related", subkey: [3], pos: [0, 1] },
        ],
        [
          { ...LINK, key: "related.0" },
          { ...LINK, key: "different.1" },
        ],
      ),
    );
    expect(el.textContent).toBe("related: Alias, Second, false, 0");
    expect(highlights(el)).toEqual(["Alias", "Sec", "false", "0"]);
    expect(el.querySelectorAll("a")).toHaveLength(1);
  });

  it("does not parse Markdown, HTML or code in YAML strings or wiki aliases", () => {
    const source = "**bold** <img src='https://example.com/a'> `code`";
    const el = render(row({ text: source }, [{ key: "text", pos: [2, 6] }]));
    expect(el.textContent).toBe(`text: ${source}`);
    expect(el.querySelector("strong, img, code")).toBeNull();
    expect(highlights(el)).toEqual(["bold"]);
    const alias = "[[Target|**Alias**]]";
    const linked = render(
      row(
        { related: alias },
        [{ key: "related", pos: [2, 8] }],
        [{ ...LINK, original: alias, displayText: "**Alias**" }],
      ),
    );
    expect(linked.querySelector("a")?.textContent).toBe("**Alias**");
    expect(linked.querySelector("strong")).toBeNull();
  });

  it("only converts an exact metadata-owned whole value", () => {
    const el = render(row({ related: `See ${RAW}` }, [{ key: "related", pos: [6, 12] }], [LINK]));
    expect(el.textContent).toBe(`related: See ${RAW}`);
    expect(el.querySelector("a")).toBeNull();
    expect(highlights(el)).toEqual(["Target"]);
    const wrongPath = render(row({ related: RAW }, [{ key: "related", pos: [2, 8] }], [{ ...LINK, key: "other" }]));
    expect(wrongPath.querySelector("a")).toBeNull();
  });

  it("uses decoded values and native display text for subpaths", () => {
    const original = "[[Target#Heading]]";
    const el = render(
      row(
        { related: original },
        [{ key: "related", pos: [9, 16] }],
        [{ key: "related", original, link: "Target#Heading", displayText: "Target > Heading" }],
      ),
    );
    expect(el.textContent).toBe("related: Target > Heading");
    expect(highlights(el)).toEqual(["Heading"]);
    expect(el.querySelector("a")?.getAttribute("data-href")).toBe("Target#Heading");
  });

  it("supports a nested own-property path without following prototypes", () => {
    const meta: unknown = JSON.parse('{"nested":{"constructor":"[[Target|Alias]]"}}');
    const el = render(
      row(
        { meta },
        [{ key: "meta", subkey: ["nested", "constructor"], pos: [2, 8] }],
        [{ ...LINK, key: "meta.nested.constructor" }],
      ),
    );
    expect(el.textContent).toBe("meta: {nested: {constructor: Alias}}");
    expect(highlights(el)).toEqual(["Alias"]);
    const inherited: unknown = Object.create({ link: RAW });
    expectUnchanged(
      row({ meta: inherited }, [{ key: "meta", subkey: ["link"], pos: [2, 8] }], [{ ...LINK, key: "meta.link" }]),
    );
  });

  it("highlights key-only queries without inventing a value match", () => {
    const el = render(row({ related: RAW }, [{ key: "related" }], [LINK]));
    expect(el.textContent).toBe("related: Alias");
    expect(highlights(el)).toEqual(["related"]);
    expect(el.querySelector("a .search-result-file-matched-text")).toBeNull();
  });

  it("preserves native String representations for dates and null", () => {
    const date = new Date("2026-10-14T00:00:00Z");
    const el = render(row({ date }, [{ key: "date", pos: [0, 3] }]));
    expect(el.textContent).toBe(`date: ${String(date)}`);
    expect(highlights(el)).toEqual([String(date).slice(0, 3)]);
    expect(render(row({ empty: null }, [{ key: "empty", pos: [0, 4] }])).textContent).toBe("empty: null");
  });

  it("keeps unrepresentable or out-of-bounds matches atomic", () => {
    expectUnchanged(
      row(
        { related: [RAW, "short"] },
        [
          { key: "related", subkey: [0], pos: [2, 8] },
          { key: "related", subkey: [1], pos: [0, 9] },
        ],
        [{ ...LINK, key: "related.0" }],
      ),
    );
    expectUnchanged(row({ meta: { link: RAW } }, [{ key: "meta", subkey: ["missing"], pos: [0, 1] }]));
    expectUnchanged(row({ text: "abcdef" }, [{ key: "text", pos: [-1, 2] }]));
  });

  it("preserves direct native String(object) matches and rejects mixed opaque/descendant hits", () => {
    const meta = { nested: RAW };
    const el = render(row({ meta }, [{ key: "meta", pos: [1, 7] }], [{ ...LINK, key: "meta.nested" }]));
    expect(el.textContent).toBe("meta: [object Object]");
    expect(highlights(el)).toEqual(["object"]);
    expect(el.querySelector("a")).toBeNull();
    expectUnchanged(
      row(
        { meta },
        [
          { key: "meta", pos: [1, 7] },
          { key: "meta", subkey: ["nested"], pos: [2, 8] },
        ],
        [{ ...LINK, key: "meta.nested" }],
      ),
    );
  });

  it("shows the destination for an empty alias so the matched result stays visible", () => {
    const original = "[[Target|]]";
    const link = { ...LINK, original, displayText: "" };
    const matched = render(row({ related: original }, [{ key: "related", pos: [2, 8] }], [link]));
    expect(matched.textContent).toBe("related: Target");
    expect(matched.querySelector("a")?.getAttribute("data-href")).toBe("Target");
    expect(highlights(matched)).toEqual(["Target"]);
    const el = render(row({ related: original }, [{ key: "related" }], [link]));
    expect(el.textContent).toBe("related: Target");
    expect(highlights(el)).toEqual(["related"]);
  });

  it("bounds both source and displayed text without partially replacing the row", () => {
    expectUnchanged(row({ text: "x".repeat(4000) }, [{ key: "text", pos: [0, 1] }]));
    expectUnchanged(
      row({ related: RAW }, [{ key: "related", pos: [2, 8] }], [{ ...LINK, displayText: "x".repeat(4000) }]),
    );
    expect(render(row({ x: "a".repeat(3997) }, [{ key: "x", pos: [0, 1] }])).textContent).toHaveLength(4000);
  });

  it("bounds match count, value count, depth and metadata work", () => {
    expectUnchanged(
      row(
        { x: "a" },
        Array.from({ length: 101 }, () => ({ key: "x", pos: [0, 1] })),
      ),
    );
    expectUnchanged(row({ values: Array.from({ length: 401 }, () => "") }, [{ key: "values" }]));
    const deep: Record<string, unknown> = {};
    let current = deep;
    for (let index = 0; index < 13; index++) {
      const child: Record<string, unknown> = {};
      current["child"] = child;
      current = child;
    }
    expectUnchanged(row({ deep }, [{ key: "deep" }]));
    expectUnchanged(
      row(
        { related: RAW },
        [{ key: "related", pos: [2, 8] }],
        Array.from({ length: 20001 }, () => LINK),
      ),
    );
  });

  it("bounds repeated alias highlighting instead of creating thousands of marks", () => {
    const label = "a".repeat(2000);
    const original = `[[Target|${label}]]`;
    const el = render(
      row({ related: original }, [{ key: "related", pos: [9, 10] }], [{ ...LINK, original, displayText: label }]),
    );
    expect(el.querySelector("a")?.textContent).toBe(label);
    expect(highlights(el)).toEqual([label]);
  });
});

describe("native property row adapter", () => {
  it("accepts scalar, indexed-value and key-only native shapes", () => {
    for (const matches of [
      [{ key: "related", pos: [0, 1] }],
      [{ key: "related", subkey: [0], pos: [0, 1] }],
      [{ key: "related" }],
    ] satisfies PropertyHit[][])
      expect(isPropertyMatchRow(row({ related: [RAW] }, matches), isParent)).toBe(true);
  });

  const malformed: Array<[string, (value: PropertyRow) => unknown]> = [
    ["unknown parent", (value) => ({ ...value, parentDom: {} })],
    ["missing element", (value) => ({ ...value, el: {} })],
    ["missing render method", (value) => ({ ...value, render: null })],
    ["missing frontmatter", (value) => ({ ...value, cache: {} })],
    ["empty matches", (value) => ({ ...value, matches: [] })],
    ["content-offset matches", (value) => ({ ...value, matches: [[0, 1]] })],
    ["mixed keys", (value) => ({ ...value, matches: [{ key: "a" }, { key: "b" }] })],
    ["invalid key", (value) => ({ ...value, matches: [{ key: 123 }] })],
    ["negative offset", (value) => ({ ...value, matches: [{ key: "related", pos: [-1, 2] }] })],
    ["fractional offset", (value) => ({ ...value, matches: [{ key: "related", pos: [0.5, 2] }] })],
    ["empty range", (value) => ({ ...value, matches: [{ key: "related", pos: [2, 2] }] })],
    ["reversed range", (value) => ({ ...value, matches: [{ key: "related", pos: [2, 1] }] })],
    ["non-finite range", (value) => ({ ...value, matches: [{ key: "related", pos: [0, Infinity] }] })],
    ["negative index", (value) => ({ ...value, matches: [{ key: "related", subkey: [-1], pos: [0, 1] }] })],
    ["object subkey", (value) => ({ ...value, matches: [{ key: "related", subkey: [{}], pos: [0, 1] }] })],
    ["indexed hit without offsets", (value) => ({ ...value, matches: [{ key: "related", subkey: [0] }] })],
    ["too many matches", (value) => ({ ...value, matches: Array.from({ length: 101 }, () => ({ key: "related" })) })],
  ];

  it.each(malformed)("rejects %s", (_name, change) => {
    expect(isPropertyMatchRow(change(row({ related: RAW }, [{ key: "related", pos: [2, 8] }], [LINK])), isParent)).toBe(
      false,
    );
  });
});
