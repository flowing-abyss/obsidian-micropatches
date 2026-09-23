import { App, type MarkdownView, moment, Plugin, type TFile } from "obsidian-test-mocks/obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  basename,
  findAllConfiguredMetadata,
  getPeriodicNotesApi,
  isInConfiguredFolder,
  labelForDate,
  periodicBreadcrumbs,
  trimSlashes,
} from "./periodic-breadcrumbs";

type Api = NonNullable<ReturnType<typeof getPeriodicNotesApi>>;
type Note = Parameters<typeof labelForDate>[1];
type CalendarSet = ReturnType<Api["calendarSetManager"]["getCalendarSets"]>[number];
type Granularity = Note["granularity"];

function note(calendarSet: string, granularity: Granularity, filePath: string, date: string): Note {
  return { calendarSet, granularity, filePath, date: moment(date) };
}

// A daily note in the "main" set, dated by its file name.
function daily(filePath: string): Note {
  return note("main", "day", filePath, basename(filePath));
}

// The slice of the Periodic Notes plugin the patch relies on.
function fakeApi(sets: CalendarSet[], notes: Note[], activeId = "main") {
  const cachedFiles = new Map<string, Map<string, Note>>();
  const add = (added: Note): void => {
    cachedFiles.set(
      added.calendarSet,
      (cachedFiles.get(added.calendarSet) ?? new Map<string, Note>()).set(added.filePath, added),
    );
  };
  notes.forEach(add);
  const find = (filePath: string, calendarSet = activeId) => cachedFiles.get(calendarSet)?.get(filePath) ?? null;
  const api: Api = {
    findInCache: (filePath) => find(filePath),
    getPeriodicNote: () => null,
    createPeriodicNote: () => Promise.reject(new Error("Unexpected create")),
    cache: { cachedFiles, find },
    calendarSetManager: { getActiveId: () => activeId, getCalendarSets: () => sets },
  };
  return { api, add };
}

describe("trimSlashes", () => {
  it("trims leading and trailing slashes only", () => {
    expect(trimSlashes("/Journal/Daily/")).toBe("Journal/Daily");
    expect(trimSlashes("//Journal//Daily//")).toBe("Journal//Daily");
    expect(trimSlashes("Journal")).toBe("Journal");
    expect(trimSlashes("///")).toBe("");
    expect(trimSlashes("")).toBe("");
  });

  it("stays fast on long runs of slashes", () => {
    const start = performance.now();
    expect(trimSlashes(`${"/".repeat(100_000)}a${"/".repeat(100_000)}`)).toBe("a");
    expect(trimSlashes(`a${"/".repeat(100_000)}b`)).toHaveLength(100_002);
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe("isInConfiguredFolder", () => {
  it("accepts any file when no folder is configured", () => {
    expect(isInConfiguredFolder("2024-01-05.md", "")).toBe(true);
    expect(isInConfiguredFolder("Deep/2024-01-05.md", "/")).toBe(true);
  });

  it("accepts files in the folder or below it", () => {
    expect(isInConfiguredFolder("Journal/2024-01-05.md", "Journal")).toBe(true);
    expect(isInConfiguredFolder("Journal/2024/01/2024-01-05.md", "Journal")).toBe(true);
    expect(isInConfiguredFolder("Journal/Daily/2024-01-05.md", "/Journal/Daily/")).toBe(true);
  });

  it("rejects files elsewhere, including folders sharing a prefix", () => {
    expect(isInConfiguredFolder("2024-01-05.md", "Journal")).toBe(false);
    expect(isInConfiguredFolder("Journal2/2024-01-05.md", "Journal")).toBe(false);
    expect(isInConfiguredFolder("Journal/2024-01-05.md", "Journal/Daily")).toBe(false);
  });
});

describe("basename", () => {
  it("drops the folders and a Markdown extension", () => {
    expect(basename("Journal/2024/2024-01-05.md")).toBe("2024-01-05");
    expect(basename("2024-W01")).toBe("2024-W01");
    expect(basename("Journal/image.png")).toBe("image.png");
  });
});

describe("labelForDate", () => {
  it("formats with the configured format, keeping only the file name", () => {
    const { api } = fakeApi([{ id: "main", day: { enabled: true, format: "YYYY/MM/YYYY-MM-DD ddd" } }], []);
    const current = note("main", "day", "Daily/2024/01/2024-01-05 Fri.md", "2024-01-05");

    expect(labelForDate(api, current, moment("2024-01-06"))).toBe("2024-01-06 Sat");
  });

  it.each<[Granularity, string]>([
    ["day", "2024-01-05"],
    ["week", "2024-W01"],
    ["month", "2024-01"],
    ["quarter", "2024-Q1"],
    ["year", "2024"],
  ])("falls back to the default %s format", (granularity, label) => {
    const date = moment("2024-01-05");
    const unset = fakeApi([{ id: "main", [granularity]: { enabled: true } }], []).api;
    const empty = fakeApi([{ id: "main", [granularity]: { enabled: true, format: "" } }], []).api;
    const unknownSet = fakeApi([], []).api;

    for (const api of [unset, empty, unknownSet]) {
      expect(labelForDate(api, note("main", granularity, "x.md", "2024-01-05"), date)).toBe(label);
    }
  });
});

describe("findAllConfiguredMetadata", () => {
  const path = "Journal/2024-01-05.md";
  const sets: CalendarSet[] = [
    { id: "a", day: { enabled: true, folder: "Journal" } },
    { id: "b", day: { enabled: true } },
    { id: "off", day: { enabled: false } },
    { id: "elsewhere", day: { enabled: true, folder: "Elsewhere" } },
    { id: "missing", day: { enabled: true } },
  ];
  const notes = ["a", "b", "off", "elsewhere"].map((id) => note(id, "day", path, "2024-01-05"));

  it("puts the active calendar set first and skips sets that don't claim the file", () => {
    expect(findAllConfiguredMetadata(fakeApi(sets, notes, "b").api, path).map((n) => n.calendarSet)).toEqual([
      "b",
      "a",
    ]);
  });

  it("also reads the active set from getActiveSet", () => {
    const { api } = fakeApi(sets, notes);
    const setIds = (active: CalendarSet | string) => {
      api.calendarSetManager = { getActiveSet: () => active, getCalendarSets: () => sets };
      return findAllConfiguredMetadata(api, path).map((n) => n.calendarSet);
    };

    expect(setIds("b")).toEqual(["b", "a"]);
    expect(setIds({ id: "b" })).toEqual(["b", "a"]);
  });
});

describe("getPeriodicNotesApi", () => {
  it("accepts only a Periodic Notes plugin with the expected API", () => {
    const app = App.createConfigured__();
    let installed: unknown = null;
    Object.assign(app, { plugins: { getPlugin: (id: string) => (id === "periodic-notes" ? installed : null) } });
    const { api } = fakeApi([], []);

    expect(getPeriodicNotesApi(app.asOriginalType__())).toBeNull();
    installed = api;
    expect(getPeriodicNotesApi(app.asOriginalType__())).toBe(api);
    installed = { ...api, cache: { find: () => null } };
    expect(getPeriodicNotesApi(app.asOriginalType__())).toBeNull();
    installed = { ...api, calendarSetManager: { getCalendarSets: () => [] } };
    expect(getPeriodicNotesApi(app.asOriginalType__())).toBeNull();
  });
});

describe("breadcrumbs", () => {
  class TestPlugin extends Plugin {}
  const DAILY: CalendarSet = { id: "main", day: { enabled: true, folder: "Daily" } };
  const DAILY_FILES = ["Daily/2024-01-01.md", "Daily/2024-01-03.md", "Daily/2024-01-05.md"];
  let enabled = true;

  beforeEach(() => {
    vi.useFakeTimers();
    enabled = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function fileAt(app: App, path: string): TFile {
    const file = app.vault.getFileByPath(path);
    if (file === null) throw new Error(`No file at ${path}`);
    return file;
  }

  async function open(path: string, activeId = "main") {
    const files = [...DAILY_FILES, "Other/2024-01-04.md"];
    const app = App.createConfigured__({ files: Object.fromEntries(files.map((file) => [file, ""])) });
    // 2024-01-02 is still cached but its file is gone.
    const { api, add } = fakeApi([DAILY], [...files, "Daily/2024-01-02.md"].map(daily), activeId);
    Object.assign(app, { plugins: { getPlugin: (id: string) => (id === "periodic-notes" ? api : null) } });
    const leaf = app.workspace.getLeaf();
    await leaf.openFile(fileAt(app, path));
    const view = leaf.view as unknown as MarkdownView;
    view.containerEl.createDiv({ cls: "view-header-title-container" });

    const plugin = new TestPlugin(app, {
      id: "test",
      name: "Test",
      author: "test",
      version: "0.0.0",
      minAppVersion: "0.0.0",
      description: "",
    });
    const handle = periodicBreadcrumbs.register(plugin.asOriginalType2__(), {
      isEnabled: () => enabled,
      getConfig: <T>(_key: string, defaultValue: T) => defaultValue,
      setConfig: () => Promise.resolve(),
    });
    // Rendering waits two animation frames.
    vi.advanceTimersByTime(50);

    const buttons = () => Array.from(view.containerEl.querySelectorAll("button"));
    const crumbs = () =>
      buttons().map((button) => {
        const kind = button.className.replace("micropatches-periodic-breadcrumb ", "");
        const disabled = button.disabled ? " (disabled)" : "";
        return `${kind}: ${button.textContent} / ${button.getAttribute("aria-label")}${disabled}`;
      });
    return { app, api, add, view, handle, buttons, crumbs };
  }

  it("links the previous and next existing notes", async () => {
    const { crumbs } = await open("Daily/2024-01-03.md");

    expect(crumbs()).toEqual(["is-previous: 2024-01-01 / Open 2024-01-01", "is-next: 2024-01-05 / Open 2024-01-05"]);
  });

  it("disables previous at the oldest note", async () => {
    const { crumbs } = await open("Daily/2024-01-01.md");

    expect(crumbs()).toEqual([
      "is-previous: 2023-12-31 / No previous daily note (disabled)",
      "is-next: 2024-01-03 / Open 2024-01-03",
    ]);
  });

  it("offers to create the next note at the newest one", async () => {
    const { crumbs } = await open("Daily/2024-01-05.md");

    expect(crumbs()).toEqual([
      "is-previous: 2024-01-03 / Open 2024-01-03",
      "is-next is-create: 2024-01-06 / Create 2024-01-06",
    ]);
  });

  it("creates only in the active calendar set", async () => {
    const { crumbs } = await open("Daily/2024-01-05.md", "other");

    expect(crumbs()[1]).toBe("is-next: 2024-01-06 / No next daily note (disabled)");
  });

  it("adds nothing to notes outside the configured folder", async () => {
    const { crumbs } = await open("Other/2024-01-04.md");

    expect(crumbs()).toEqual([]);
  });

  it("opens the previous note in the same tab", async () => {
    const { buttons, view } = await open("Daily/2024-01-03.md");

    buttons()[0]?.click();

    await vi.waitFor(() => {
      expect(view.file?.path).toBe("Daily/2024-01-01.md");
    });
  });

  it("creates and opens the next period", async () => {
    const { app, api, add, buttons, view } = await open("Daily/2024-01-05.md");
    const create = vi.fn(async (granularity: Granularity, date: Note["date"]) => {
      const path = `Daily/${date.format("YYYY-MM-DD")}.md`;
      const file = await app.asOriginalType__().vault.create(path, "");
      add(note("main", granularity, path, date.format("YYYY-MM-DD")));
      return file;
    });
    api.createPeriodicNote = create;

    buttons()[1]?.click();

    await vi.waitFor(() => {
      expect(view.file?.path).toBe("Daily/2024-01-06.md");
    });
    expect(create).toHaveBeenCalledExactlyOnceWith("day", expect.anything());
  });

  it("picks up a note that Periodic Notes resolves later", async () => {
    const { app, add, crumbs } = await open("Daily/2024-01-03.md");
    const file = await app.vault.create("Daily/2024-01-04.md", "");
    add(daily(file.path));

    app.workspace.trigger("periodic-notes:resolve", "day", file);
    vi.advanceTimersByTime(50);

    expect(crumbs()[1]).toBe("is-next: 2024-01-04 / Open 2024-01-04");
  });

  it("removes its buttons when toggled off and on cleanup", async () => {
    const { view, crumbs, handle } = await open("Daily/2024-01-03.md");
    const container = view.containerEl.querySelector(".view-header-title-container");

    enabled = false;
    handle.onToggle?.(false);
    expect(crumbs()).toEqual([]);
    expect(container?.className).toBe("view-header-title-container");

    enabled = true;
    handle.onToggle?.(true);
    expect(crumbs()).toHaveLength(2);

    handle.cleanup();
    expect(crumbs()).toEqual([]);
    expect(container?.className).toBe("view-header-title-container");
  });
});
