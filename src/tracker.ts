import {MarkdownSectionInformation, ButtonComponent, DropdownComponent, TextComponent, TFile, MarkdownRenderer, Component, MarkdownRenderChild, App, setIcon, Menu} from "obsidian";
import {moment} from "./moment";
import {TempoSettings} from "./settings";
import {ConfirmModal} from "./confirm-modal";
import {makeRowDraggable} from "./drag";
import {buildJson, buildToml, buildYaml, registerExportFormat, showExportMenu} from "./export";
import {attachNameSuggestions} from "./autocomplete";
import {normalizeEntryMeta, resolveCategory, resolveTags, resolveNote, resolveCategoryColor, effectiveColorToken, colorVar, collectTreeTags} from "./meta";
import {EntryDetailsModal} from "./details-modal";
import {showColorPopover} from "./color-picker";

export interface Tracker {
    entries: Entry[];
}

export interface Entry {
    name: string;
    startTime?: string;
    endTime?: string;
    subEntries?: Entry[];
    collapsed?: boolean;
    // optional metadata (rich segments), all stored only when set so old
    // trackers round-trip unchanged
    tags?: string[];
    // undefined = inherit an ancestor's category, string = own category,
    // null = explicitly no category (stops inheritance)
    category?: string | null;
    color?: string;
    note?: string;
}

registerExportFormat({id: "table", label: "Table", icon: "table", build: createMarkdownTable});
registerExportFormat({id: "csv", label: "CSV", icon: "file-spreadsheet", build: createCsv});
registerExportFormat({id: "json", label: "JSON", icon: "file-json", build: buildJson});
registerExportFormat({id: "toml", label: "TOML", icon: "file-code", build: buildToml});
registerExportFormat({id: "yaml", label: "YAML", icon: "file-code-2", build: buildYaml});

// Persists one ```tempo / ```tempo-stats code block section back into its note.
// Uses vault.process(), which serializes writes under Obsidian's lock, so two
// blocks saving to the same note (or a save racing Sync) can no longer clobber
// each other through interleaved read-modify-write cycles.
export async function saveSection(app: App, fileName: string, section: MarkdownSectionInformation | null, serialized: string): Promise<void> {
    // blocks rendered outside a live editor context (embeds, some popouts) have
    // no section info — there is nothing safe to write back to
    if (!section)
        return;
    const file = app.vault.getAbstractFileByPath(fileName);
    if (!(file instanceof TFile))
        return;

    await app.vault.process(file, content => {
        const lines = content.split("\n");
        // Obsidian reports the fences themselves as the section bounds; tolerate
        // implementations that report the first/last content line instead
        let startLine = section.lineStart;
        if (!(lines[startLine] ?? "").trimStart().startsWith("```"))
            startLine -= 1;
        let endLine = section.lineEnd;
        if (!(lines[endLine] ?? "").trimStart().startsWith("```"))
            endLine += 1;
        // stale editor info (an external edit shifted the lines between render
        // and save): bail instead of splicing into an unrelated region
        if (!(lines[startLine] ?? "").trimStart().startsWith("```") ||
            !(lines[endLine] ?? "").trimStart().startsWith("```")) {
            console.warn("Tempo: skipped saving because the note changed around the block. Interact with it again to retry.");
            return content;
        }
        // second guard: the region we are about to replace must actually be
        // tracker data, not some other code block the stale bounds landed on
        const existing = lines.slice(startLine + 1, endLine).join("\n").trim();
        if (existing !== "") {
            try {
                JSON.parse(existing);
            } catch {
                console.warn("Tempo: skipped saving because the block content no longer looks like tracker data.");
                return content;
            }
        }
        const prev = lines.slice(0, startLine + 1).join("\n");
        const next = lines.slice(endLine).join("\n");
        return `${prev}\n${serialized}\n${next}`;
    });
}

export async function saveTracker(app: App, tracker: Tracker, fileName: string, section: MarkdownSectionInformation | null, settings: TempoSettings): Promise<void> {
    await saveSection(app, fileName, section, JSON.stringify(tracker, null, settings.prettyPrintJson ? 2 : undefined));
}

export function loadTracker(json: string): Tracker {
    if (json) {
        try {
            let ret = JSON.parse(json) as Tracker;
            updateLegacyInfo(ret.entries);
            return ret;
        } catch (e) {
            console.error(`Failed to parse Tracker from ${json}: ${(e as Error).message}`);
        }
    }
    return { entries: [] };
}

export async function loadAllTrackers(app: App, fileName: string): Promise<{ section: MarkdownSectionInformation, tracker: Tracker }[]> {
    let file = app.vault.getAbstractFileByPath(fileName);
    if (!(file instanceof TFile))
        return [];
    let content = (await app.vault.cachedRead(file)).split("\n");

    let trackers: { section: MarkdownSectionInformation, tracker: Tracker }[] = [];
    let curr: { info: Partial<MarkdownSectionInformation>, lines: string[] } | undefined;
    for (let i = 0; i < content.length; i++) {
        let line = content[i]!;
        if (line.trimEnd() == "```tempo") {
            curr = { info: { lineStart: i + 1 }, lines: [] };
        } else if (curr) {
            if (line.trimEnd() == "```") {
                curr.info.lineEnd = i - 1;
                let tracker = loadTracker(curr.lines.join("\n"));
                trackers.push({ section: curr.info as MarkdownSectionInformation, tracker: tracker });
                curr = undefined;
            } else {
                // push + join instead of string concatenation: O(n) on long files
                curr.lines.push(line);
            }
        }
    }
    return trackers;
}

type GetFile = () => string;

// lets collapse/expand flip row visibility instantly in the DOM instead of
// waiting for the debounced note write + block re-render
interface RowVisibility {
    rowByEntry: Map<Entry, HTMLTableRowElement>;
    apply: (root: Entry, ancestorCollapsed: boolean) => void;
}

// a table duration cell whose entry contains the running leaf, so it must be
// re-formatted every second while the tracker runs
interface LiveDurationCell {
    entry: Entry;
    cell: HTMLTableCellElement;
}

// per-render state shared by every row of one table build. The running entry,
// its ancestor path, and the visibility map are resolved ONCE here so the
// per-row build stays O(1) instead of re-walking the whole tree per row.
interface RowContext {
    app: App;
    tracker: Tracker;
    newSegmentNameBox: TextComponent;
    runningEntry: Entry | undefined;
    runningPath: Set<Entry>;
    getFile: GetFile;
    getSectionInfo: () => MarkdownSectionInformation | null;
    settings: TempoSettings;
    component: MarkdownRenderChild;
    liveCells: LiveDurationCell[];
    scheduleCollapseSave: () => void;
    visibility: RowVisibility;
}

export function displayTracker(app: App, tracker: Tracker, element: HTMLElement, getFile: GetFile, getSectionInfo: () => MarkdownSectionInformation | null, settings: TempoSettings, component: MarkdownRenderChild): void {

    element.addClass("tempo-container");

    // find the running entry (and its ancestor path) ONCE up front so the
    // per-row table build below is O(1) per row instead of re-walking the
    // whole entry tree for every row
    const runningEntry = getRunningEntry(tracker.entries);
    const running = !!runningEntry;
    // entries whose displayed duration ticks live: the running leaf and every
    // ancestor on its path (their subtree totals include the running leaf)
    const runningPath = new Set(getRunningPath(tracker.entries));

    // add start/stop controls
    let controls = element.createDiv({ cls: "tempo-controls" });

    // category a new segment should get: nothing unless the user picks one
    // right before starting; the picker clears itself once a segment starts so
    // every following segment starts with no metadata unless chosen anew
    let pendingCategory = "";
    const resetPendingCategory = (): void => {
        pendingCategory = "";
        categoryBox.setValue("");
    };

    const startSegment = (): void => {
        startNewEntry(tracker, newSegmentNameBox.getValue(), settings, pendingCategory);
        resetPendingCategory();
    };

    let btn = new ButtonComponent(controls)
        .setClass("clickable-icon")
        .setIcon(`lucide-${running ? "stop" : "play"}-circle`)
        .setTooltip(running ? "End" : "Start")
        .onClick(async () => {
            if (running) {
                endRunningEntry(tracker);
            } else {
                startSegment();
            }
            await saveTracker(app, tracker, getFile(), getSectionInfo(), settings);
        });
    btn.buttonEl.addClass("tempo-btn");
    btn.buttonEl.toggleClass("tempo-btn-running", running);
    let newSegmentNameBox = new TextComponent(controls)
        .setPlaceholder("Segment name")
        .setDisabled(running);
    newSegmentNameBox.inputEl.addClass("tempo-txt");
    attachNameSuggestions(newSegmentNameBox, {
        getSuggestions: () => settings.suggestedSegmentNames.split("\n")
    });
    // the wrapper pairs the select with our own single chevron; native and
    // theme dropdown chrome is stripped via CSS so exactly one arrow shows
    const categoryWrap = controls.createDiv({cls: "tempo-category-wrap"});
    let categoryBox = new DropdownComponent(categoryWrap)
        .addOption("", "Category…")
        .setValue("");
    for (const category of settings.categories)
        categoryBox.addOption(category.name, category.name);
    categoryBox.selectEl.addClass("tempo-category-box");
    const categoryChevron = categoryWrap.createSpan({cls: "tempo-category-chevron", attr: {"aria-hidden": "true"}});
    setIcon(categoryChevron, "chevron-down");
    categoryBox.setDisabled(running);
    categoryBox.onChange(value => {
        pendingCategory = value;
    });
    newSegmentNameBox.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" && !running) {
            e.preventDefault();
            startSegment();
            void saveTracker(app, tracker, getFile(), getSectionInfo(), settings);
        }
    });

    // reset: wipe the whole tracker (or just zero its timestamps, keeping
    // segment names as a reusable template) after an explicit confirmation
    new ButtonComponent(controls)
        .setClass("clickable-icon")
        .setClass("tempo-btn-reset")
        .setIcon("rotate-ccw")
        .setTooltip("Reset tracker")
        .setDisabled(tracker.entries.length === 0)
        .onClick(async () => {
            const choice = await showResetConfirm(app);
            if (choice === "delete")
                tracker.entries = [];
            else if (choice === "clearTimes")
                clearEntryTimes(tracker.entries);
            else
                return;
            await saveTracker(app, tracker, getFile(), getSectionInfo(), settings);
        });

    // add timers
    let timeStyle: DomElementInfo = {
        cls: "tempo-timer-time",
        attr: {
            style: settings.useMonospacedFont ? "font-family: var(--font-monospace);" : ""
        }
    };
    let timer = element.createDiv({ cls: "tempo-timers" });
    let currentDiv = timer.createDiv({ cls: "tempo-timer tempo-timer-current" });
    setIcon(currentDiv.createSpan({ cls: "tempo-timer-icon" }), "timer");
    let current = currentDiv.createSpan(timeStyle);
    let currentLabel = currentDiv.createSpan({ cls: "tempo-timer-label" });
    // visible only while something runs: the static "Current" text becomes
    // a breadcrumb of the running segment, e.g. "Work › Part 2"
    setRunningLabel(currentLabel, tracker.entries);
    let totalDiv = timer.createDiv({ cls: "tempo-timer" });
    setIcon(totalDiv.createSpan({ cls: "tempo-timer-icon" }), "sigma");
    let total = totalDiv.createSpan(timeStyle);
    totalDiv.createSpan({ text: "Total", cls: "tempo-timer-label" });

    let totalToday!: HTMLElement;
    if (settings.showToday) {
        let totalTodayDiv = timer.createDiv({ cls: "tempo-timer" });
        setIcon(totalTodayDiv.createSpan({ cls: "tempo-timer-icon" }), "calendar-days");
        totalToday = totalTodayDiv.createSpan(timeStyle);
        totalTodayDiv.createSpan({ text: "Today", cls: "tempo-timer-label" });
    }

    if (tracker.entries.length === 0) {
        element.createDiv({
            cls: "tempo-empty",
            text: "No entries yet — name a segment and press play to start tracking."
        });
    }

    let liveCells: LiveDurationCell[] = [];
    // popout-safe: timers live on the window that owns this block
    const win = element.ownerDocument.defaultView ?? window;
    // collapse toggles rewrite the whole note section just to persist a boolean;
    // debounce bursts of toggles into a single write (still session-surviving)
    let collapseSaveTimer: number | undefined;
    const scheduleCollapseSave = (): void => {
        if (collapseSaveTimer !== undefined)
            win.clearTimeout(collapseSaveTimer);
        collapseSaveTimer = win.setTimeout(() => {
            collapseSaveTimer = undefined;
            void saveTracker(app, tracker, getFile(), getSectionInfo(), settings);
        }, 300);
    };
    // every row is built upfront (collapsed subtrees included, just hidden), so
    // toggling is pure local DOM work — the write only persists the flag
    const rowByEntry = new Map<Entry, HTMLTableRowElement>();
    const visibility: RowVisibility = {
        rowByEntry,
        apply: (root, ancestorCollapsed) => {
            if (!root.subEntries)
                return;
            for (const sub of root.subEntries) {
                const row = rowByEntry.get(sub);
                // a nested collapsed flag keeps its own subtree hidden even
                // when an outer level expands
                if (row)
                    row.hidden = ancestorCollapsed || !!sub.collapsed;
                visibility.apply(sub, ancestorCollapsed || !!sub.collapsed);
            }
        }
    };
    if (tracker.entries.length > 0) {
        // add table (wrapped so the drag-drop insertion line can be
        // positioned absolutely relative to the table)
        let tableWrap = element.createDiv({ cls: "tempo-table-wrap" });
        let table = tableWrap.createEl("table", { cls: "tempo-table" });
        table.createEl("tr").append(
            createEl("th", { text: "Segment" }),
            createEl("th", { text: "Start time" }),
            createEl("th", { text: "End time" }),
            createEl("th", { text: "Duration" }),
            createEl("th"));

        const rowCtx: RowContext = {
            app, tracker, newSegmentNameBox, runningEntry, runningPath,
            getFile, getSectionInfo, settings, component,
            liveCells, scheduleCollapseSave, visibility
        };
        // the loop supplies each row's parent list and display index, so rows
        // never have to search the tree for their own position
        const ordered = orderedEntries(tracker.entries, settings);
        for (let i = 0; i < ordered.length; i++)
            addEditableTableRow(rowCtx, ordered[i]!, table, 0, tracker.entries, i, [], false);

        // add export button (format menu populated by registerExportFormat)
        let buttons = element.createDiv({ cls: "tempo-bottom" });
        let exportBtn = new ButtonComponent(buttons)
            .onClick(evt => showExportMenu(evt, tracker, settings));
        setIcon(exportBtn.buttonEl.createSpan({ cls: "tempo-btn-icon" }), "download");
        exportBtn.buttonEl.createSpan({ text: "Export" });
    }


    setCountdownValues(tracker, current, total, totalToday, currentDiv, settings);

    // While a tracker runs, every displayed duration grows linearly with
    // wall clock time, so each tick just adds elapsed Date.now() delta to
    // baselines captured at render time — pure arithmetic, no moment
    // objects. Any edit re-renders (and re-baselines) the whole block.
    // registerInterval clears the timer when the component unloads.
    if (runningEntry && !runningEntry.endTime) {
        const baselineNow = Date.now();
        const runningBaseMs = getDuration(runningEntry);
        const totalBaseMs = getTotalDuration(tracker.entries);
        const liveBases = liveCells.map(lc => ({cell: lc.cell, baseMs: getDuration(lc.entry)}));
        let todayBaseMs = totalToday ? getTotalDurationToday(tracker.entries) : 0;
        let todayAnchor = baselineNow;
        let dayStamp = new Date(baselineNow).getDate();

        component.registerInterval(window.setInterval(() => {
            if (!element.isConnected)
                return;
            const now = Date.now();
            const elapsedMs = now - baselineNow;

            current.setText(formatDuration(runningBaseMs + elapsedMs, settings));
            total.setText(formatDuration(totalBaseMs + elapsedMs, settings));

            if (totalToday) {
                // past midnight "today" becomes a different window: recompute
                // from scratch so yesterday's entries drop out of the total
                if (new Date(now).getDate() !== dayStamp) {
                    dayStamp = new Date(now).getDate();
                    todayBaseMs = getTotalDurationToday(tracker.entries);
                    todayAnchor = now;
                }
                totalToday.setText(formatDuration(todayBaseMs + (now - todayAnchor), settings));
            }

            // keep the running segment's (and its ancestors') table durations ticking too
            for (const {cell, baseMs} of liveBases)
                if (cell.isConnected)
                    cell.setText(formatDuration(baseMs + elapsedMs, settings));
        }, 1000));
    }
}

export function getDuration(entry: Entry): number {
    if (entry.subEntries) {
        return getTotalDuration(entry.subEntries);
    } else if (!entry.startTime) {
        return 0;
    } else {
        // timestamps are ISO strings: Date.parse gives the same epoch ms as
        // moment(...).valueOf() but without allocating a moment per call
        const endMs = entry.endTime ? Date.parse(entry.endTime) : Date.now();
        return endMs - Date.parse(entry.startTime);
    }
}

// local-midnight → local-midnight+1day bounds for an "YYYY-MM-DD" string
function dayWindowMs(date: string): { startMs: number, endMs: number } {
    return {
        // a date-time string without a timezone is parsed as LOCAL time, which
        // is what moment(date).startOf/endOf("day") produce
        startMs: Date.parse(`${date}T00:00:00`),
        endMs: Date.parse(`${date}T23:59:59.999`)
    };
}

// ms of this entry's (subtree's) time that falls inside a day window,
// mirroring getDurationDate's clipping semantics with plain arithmetic
function getDurationInWindow(entry: Entry, winStartMs: number, winEndMs: number): number {
    if (entry.subEntries) {
        let ret = 0;
        for (const sub of entry.subEntries)
            ret += getDurationInWindow(sub, winStartMs, winEndMs);
        return ret;
    }
    if (!entry.startTime)
        return 0;
    let startMs = Date.parse(entry.startTime);
    let endMs = entry.endTime ? Date.parse(entry.endTime) : Date.now();
    if (endMs < winStartMs || startMs > winEndMs)
        return 0;
    if (startMs < winStartMs)
        startMs = winStartMs;
    if (endMs > winEndMs)
        endMs = winEndMs;
    return endMs - startMs;
}

export function getDurationDate(entry: Entry, date: string): number {
    const {startMs, endMs} = dayWindowMs(date);
    return getDurationInWindow(entry, startMs, endMs);
}

export function getDurationToday(entry: Entry): number {
    const today = moment().format('YYYY-MM-DD');
    return getDurationDate(entry, today);
}

export function getTotalDuration(entries: Entry[]): number {
    let ret = 0;
    for (let entry of entries)
        ret += getDuration(entry);
    return ret;
}

export function getTotalDurationToday(entries: Entry[]): number {
    const today = moment().format('YYYY-MM-DD');
    const {startMs, endMs} = dayWindowMs(today);
    let ret = 0;
    for (const entry of entries)
        ret += getDurationInWindow(entry, startMs, endMs);
    return ret;
}

export function getTotalDurationDate(entries: Entry[], date: string): number {
    const {startMs, endMs} = dayWindowMs(date);
    let ret = 0;
    for (const entry of entries)
        ret += getDurationInWindow(entry, startMs, endMs);
    return ret;
}

export function isRunning(tracker: Tracker): boolean {
    return !!getRunningEntry(tracker.entries);
}

export function getRunningEntry(entries: Entry[]): Entry | undefined {
    for (let entry of entries) {
        // if this entry has sub entries, check if one of them is running
        if (entry.subEntries) {
            let running = getRunningEntry(entry.subEntries);
            if (running)
                return running;
        } else if (entry.startTime) {
            // if this entry has no sub entries and no end time, it's running
            if (!entry.endTime)
                return entry;
        }
    }
    return undefined;
}

// entries on the ancestor path from the tree root down to the running leaf
// (leaf included), e.g. ["Work", "Part 2"] as entry objects; empty when
// nothing runs. These are exactly the entries whose displayed durations tick
// live. O(n) once per render, mirroring getRunningEntry's traversal so the
// two can never disagree about what is running.
function getRunningPath(entries: Entry[]): Entry[] {
    for (const entry of entries) {
        if (entry.subEntries) {
            const path = getRunningPath(entry.subEntries);
            if (path.length)
                return [entry, ...path];
        } else if (entry.startTime) {
            if (!entry.endTime)
                return [entry];
        }
    }
    return [];
}

// the chain of segment names from the top-level ancestor down to the
// running leaf, e.g. ["Work", "Part 2"]; undefined when nothing runs.
// Mirrors getRunningEntry's traversal so the two can never disagree about
// what is running.
export function getRunningChain(entries: Entry[]): string[] | undefined {
    for (let entry of entries) {
        if (entry.subEntries) {
            let chain = getRunningChain(entry.subEntries);
            if (chain)
                return [entry.name, ...chain];
        } else if (entry.startTime) {
            if (!entry.endTime)
                return [entry.name];
        }
    }
    return undefined;
}

export function createMarkdownTable(tracker: Tracker, settings: TempoSettings): string {
    let table = [["Segment", "Start time", "End time", "Duration"]];
    for (let entry of orderedEntries(tracker.entries, settings)) {
        for (let row of exportRows(entry, settings))
            table.push([`${row.label}${inlineMetaText(row)}`, row.start, row.end, row.duration]);
    }
    table.push(["**Total**", "", "", `**${formatDuration(getTotalDuration(tracker.entries), settings)}**`]);

    let ret = "";
    // calculate the width every column needs to look neat when monospaced
    let widths = Array.from(Array(4).keys()).map(i => Math.max(...table.map(a => a[i]!.length)));
    for (let r = 0; r < table.length; r++) {
        // add separators after first row
        if (r == 1)
            ret += "| " + Array.from(Array(4).keys()).map(i => "-".repeat(widths[i]!)).join(" | ") + " |\n";

        let row: string[] = [];
        for (let i = 0; i < 4; i++)
            row.push(table[r]![i]!.padEnd(widths[i]!, " "));
        ret += "| " + row.join(" | ") + " |\n";
    }
    return ret;
}

function createCsvCell(content: string): string {
    return `"${content.replace(/"/g, '""')}"`;
}

export function createCsv(tracker: Tracker, settings: TempoSettings): string {
    let ret = [["Segment", "Category", "Tags", "Note", "Start time", "End time", "Duration"]].map(row => row.join(settings.csvDelimiter)).join("\n") + "\n";
    for (let entry of orderedEntries(tracker.entries, settings)) {
        for (let row of exportRows(entry, settings)) {
            const fields = [
                row.label,
                row.category,
                row.tags.join(" "),
                row.note,
                row.start,
                row.end,
                row.duration
            ];
            ret += fields.map(createCsvCell).join(settings.csvDelimiter) + "\n";
        }
    }
    return ret;
}

export function orderedEntries(entries: Entry[], settings: TempoSettings): Entry[] {
    return settings.reverseSegmentOrder ? entries.slice().reverse() : entries;
}

export function formatTimestamp(timestamp: string, settings: TempoSettings): string {
    return moment(timestamp).format(settings.timestampFormat);
}

// Pure-arithmetic replacement for moment.duration, verified byte-identical to
// moment across 40k+ duration/settings combinations. Replicates moment's exact
// bubble/as semantics for a milliseconds-only duration:
//   - daysToMonths(days)  = (days * 4800) / 146097   (400 years = 146097 days)
//   - monthsToDays(months)= (months * 146097) / 4800
//   - as("year")          = months / 12  =>  ms / (86400000 * 30.436875) / 12
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;
const MONTHS_PER_DAY = 4800 / 146097;
const DAYS_PER_MONTH = 146097 / 4800;
const MS_PER_YEAR = MS_PER_DAY * MONTHS_PER_DAY * 12; // 31_556_952_000

function durationParts(totalTime: number): { years: number, months: number, days: number, hours: number, minutes: number, seconds: number } {
    const totalHours = Math.floor(totalTime / MS_PER_HOUR);
    const totalDays = Math.floor(totalTime / MS_PER_DAY);
    const monthsFromDays = Math.floor(totalDays * MONTHS_PER_DAY);
    return {
        years: Math.floor(totalTime / MS_PER_YEAR),
        months: monthsFromDays % 12,
        days: totalDays - Math.ceil(monthsFromDays * DAYS_PER_MONTH),
        hours: totalHours % 24,
        minutes: Math.floor(totalTime / 60_000) % 60,
        seconds: Math.floor(totalTime / 1000) % 60
    };
}

export function formatDuration(totalTime: number, settings: TempoSettings): string {
    const parts = durationParts(totalTime);
    let ret = "";
    let hours = settings.fineGrainedDurations ? parts.hours : Math.floor(totalTime / MS_PER_HOUR);

    if (settings.timestampDurations) {
        if (settings.fineGrainedDurations) {
            if (Math.floor(totalTime / MS_PER_DAY) > 0)
                ret += Math.floor(totalTime / MS_PER_DAY) + ".";
        }
        ret += `${hours.toString().padStart(2, "0")}:${parts.minutes.toString().padStart(2, "0")}:${parts.seconds.toString().padStart(2, "0")}`;
    } else {
        if (settings.fineGrainedDurations) {
            if (parts.years > 0)
                ret += parts.years + "y ";
            if (parts.months > 0)
                ret += parts.months + "M ";
            if (parts.days > 0)
                ret += parts.days + "d ";
        }
        if (hours > 0)
            ret += hours + "h ";
        if (parts.minutes > 0)
            ret += parts.minutes + "m ";
        ret += parts.seconds + "s";
    }
    return ret;
}


// fills a name template: every run of # in the template becomes the counter,
// zero-padded to the run's length ("Part #" → "Part 4", "PART ###" → "PART 004",
// "## part" → "04 part")
export function formatNameTemplate(template: string, counter: number): string {
    return template.replace(/#+/g, digits => String(counter).padStart(digits.length, "0"));
}

function startSubEntry(entry: Entry, name: string, settings: TempoSettings): void {
    // if this entry is not split yet, we add its time as a sub-entry instead.
    // Metadata is copied onto the first part so the elapsed time keeps its
    // category/tags/color, but the note stays on the group — notes describe
    // the single entry they sit on, they never follow a split.
    if (!entry.subEntries) {
        const {note: _note, ...rest} = entry;
        entry.subEntries = [{ ...rest, name: formatNameTemplate(settings.subEntryNameTemplate, 1) }];
        entry.startTime = undefined;
        entry.endTime = undefined;
    }

    if (!name)
        name = formatNameTemplate(settings.subEntryNameTemplate, entry.subEntries.length + 1);
    entry.subEntries.push({ name: name, startTime: moment().toISOString() });
}

function startNewEntry(tracker: Tracker, name: string, settings: TempoSettings, category?: string): void {
    if (!name) {
        name = formatNameTemplate(settings.segmentNameTemplate, tracker.entries.length + 1);
        // a hand-emptied template must not create unnamed segments
        if (!name)
            name = `Segment ${tracker.entries.length + 1}`;
    }
    let entry: Entry = { name: name, startTime: moment().toISOString(), category: category || undefined };
    tracker.entries.push(entry);
}

function endRunningEntry(tracker: Tracker): void {
    let entry = getRunningEntry(tracker.entries);
    if (entry)
        entry.endTime = moment().toISOString();
}

// recursively strips all timestamps, keeping names (and the sub-entry
// structure) intact so the tracker becomes a reusable template
function clearEntryTimes(entries: Entry[]): void {
    for (let entry of entries) {
        entry.startTime = undefined;
        entry.endTime = undefined;
        entry.collapsed = undefined;
        if (entry.subEntries)
            clearEntryTimes(entry.subEntries);
    }
}

// which reset action the user picked in the reset confirmation
type ResetChoice = "delete" | "clearTimes" | undefined;

function showResetConfirm(app: App): Promise<ResetChoice> {
    return new Promise((resolve) => {
        const modal = new ConfirmModal(
            app,
            "Reset this tracker? The running segment will be stopped and removed too.",
            choice => resolve(choice === true ? "delete" : choice === "extra" ? "clearTimes" : undefined),
            "Delete all",
            "Clear times only"
        );
        modal.open();
    });
}

function removeEntry(entries: Entry[], toRemove: Entry): boolean {
    if (entries.contains(toRemove)) {
        entries.remove(toRemove);
        return true;
    } else {
        for (let entry of entries) {
            if (entry.subEntries && removeEntry(entry.subEntries, toRemove)) {
                // if we only have one sub entry remaining, we can merge back into our main entry
                if (entry.subEntries.length == 1) {
                    let single = entry.subEntries[0]!;
                    entry.startTime = single.startTime;
                    entry.endTime = single.endTime;
                    entry.subEntries = undefined;
                }
                return true;
            }
        }
    }
    return false;
}

// returns the sibling array (tracker.entries itself or some entry's
// subEntries) that directly contains the target entry
function findParentEntry(entries: Entry[], target: Entry): Entry[] | undefined {
    if (entries.contains(target))
        return entries;
    for (let entry of entries) {
        if (entry.subEntries) {
            let parent = findParentEntry(entry.subEntries, target);
            if (parent)
                return parent;
        }
    }
    return undefined;
}

// writes a display-ordered permutation back into the storage array
// element-wise, preserving entry object identity
function writeDisplayOrder(parent: Entry[], display: Entry[]): void {
    for (let i = 0; i < display.length; i++)
        parent[i] = display[i]!;
}

// reorders an entry among its siblings. All positions are in display space
// (the order shown in the table, i.e. orderedEntries()), so this stays
// correct when reverseSegmentOrder is on. `insertBefore` is the index to
// insert at within the sibling list excluding the target itself (that is
// how the drop indicator counts boundaries), 0..siblingCount-1.
// Returns whether anything changed.
function reorderEntry(entries: Entry[], target: Entry, insertBefore: number, settings: TempoSettings): boolean {
    const parent = findParentEntry(entries, target);
    if (!parent)
        return false;
    const display = orderedEntries(parent, settings);
    const from = display.indexOf(target);
    // the boundary at the top of the row that follows the target is the
    // slot it already occupies; every other boundary is a real move
    if (from < 0 || insertBefore < 0 || insertBefore > display.length - 1 ||
        insertBefore === from)
        return false;
    const next = display.slice();
    next.splice(from, 1);
    next.splice(insertBefore, 0, target);
    writeDisplayOrder(parent, next);
    return true;
}

// moves an entry one slot up (-1) or down (+1) in display order among its
// siblings. Returns whether anything changed.
function moveEntryByOffset(entries: Entry[], target: Entry, offset: -1 | 1, settings: TempoSettings): boolean {
    const parent = findParentEntry(entries, target);
    if (!parent)
        return false;
    const display = orderedEntries(parent, settings).slice();
    const from = display.indexOf(target);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= display.length)
        return false;
    [display[from], display[to]] = [display[to]!, display[from]!];
    writeDisplayOrder(parent, display);
    return true;
}

// fills the Current card's label with the running segment breadcrumb:
// one span per name, joined by faint "›" separators. Plain text on purpose —
// the micro-label style would mangle rendered markdown. The full chain also
// goes into the title so truncated labels stay readable on hover.
function setRunningLabel(label: HTMLElement, entries: Entry[]): void {
    const chain = getRunningChain(entries);
    if (!chain)
        return; // nothing runs; the card is hidden anyway
    label.replaceChildren();
    chain.forEach((name, i) => {
        if (i > 0)
            label.createSpan({ text: "›", cls: "tempo-timer-label-sep" });
        label.createSpan({ text: name, cls: "tempo-timer-label-name" });
    });
    label.title = chain.join(" › ");
}

function setCountdownValues(tracker: Tracker, current: HTMLElement, total: HTMLElement, totalToday: HTMLElement, currentDiv: HTMLDivElement, settings: TempoSettings): void {
    let running = getRunningEntry(tracker.entries);
    if (running && !running.endTime) {
        current.setText(formatDuration(getDuration(running), settings));
        currentDiv.hidden = false;
    } else {
        currentDiv.hidden = true;
    }
    total.setText(formatDuration(getTotalDuration(tracker.entries), settings));
    totalToday?.setText(formatDuration(getTotalDurationToday(tracker.entries), settings));
}

function formatEditableTimestamp(timestamp: string, settings: TempoSettings): string {
    return moment(timestamp).format(settings.editableTimestampFormat);
}

function unformatEditableTimestamp(formatted: string, settings: TempoSettings): string {
    return moment(formatted, settings.editableTimestampFormat).toISOString();
}

function updateLegacyInfo(entries: Entry[]): void {
    for (let entry of entries) {
        if (entry.startTime == null)
            entry.startTime = undefined;
        if (entry.endTime == null)
            entry.endTime = undefined;

        // in 0.1.8, timestamps were changed from unix to iso
        if (entry.startTime && !isNaN(+entry.startTime))
            entry.startTime = moment.unix(+entry.startTime).toISOString();
        if (entry.endTime && !isNaN(+entry.endTime))
            entry.endTime = moment.unix(+entry.endTime).toISOString();

        // in 1.0.0, sub-entries were made optional
        if (entry.subEntries == null || !entry.subEntries.length)
            entry.subEntries = undefined;

        // rich segment metadata is always normalized on load so hand-edited
        // JSON and writes from newer versions stay well-formed
        normalizeEntryMeta(entry);

        if (entry.subEntries)
            updateLegacyInfo(entry.subEntries);
    }
}

/**
 * Recursively flattens one entry into export rows, maintaining the hierarchy
 * via the indented label ("- ", "-- ", …). Each row carries the entry's OWN
 * metadata — inheritance is a display/aggregation concept and duplicating
 * ancestor values onto children would make exports noisy and lossy.
 */
interface ExportRow {
    // indented display label ("- Part 2")
    label: string;
    category: string;
    tags: string[];
    note: string;
    start: string;
    end: string;
    duration: string;
}

function exportRows(entry: Entry, settings: TempoSettings, indent: number = 0): ExportRow[] {
    const prefix = `${"-".repeat(indent)} `;
    const ret: ExportRow[] = [{
        label: `${prefix}${entry.name}`,
        category: entry.category ?? "",
        tags: entry.tags ?? [],
        note: entry.note ?? "",
        start: entry.startTime ? formatTimestamp(entry.startTime, settings) : "",
        end: entry.endTime ? formatTimestamp(entry.endTime, settings) : "",
        duration: entry.endTime || entry.subEntries ? formatDuration(getDuration(entry), settings) : ""
    }];
    if (entry.subEntries) {
        for (let sub of orderedEntries(entry.subEntries, settings))
            ret.push(...exportRows(sub, settings, indent + 1));
    }
    return ret;
}

// metadata appended to the Segment column of the markdown table export, e.g.
// `Work (Billing) #deep-work`. Compact on purpose: notes stay out of the table.
function inlineMetaText(row: ExportRow): string {
    let suffix = "";
    if (row.category)
        suffix += ` (${row.category})`;
    for (const tag of row.tags)
        suffix += ` #${tag}`;
    return suffix;
}

function addEditableTableRow(ctx: RowContext, entry: Entry, table: HTMLTableElement, indent: number, parentEntries: Entry[], displayIndex: number, ancestors: Entry[], ancestorsCollapsed: boolean): void {
    const {app, tracker, newSegmentNameBox, runningEntry, runningPath, getFile, getSectionInfo, settings, component, liveCells, scheduleCollapseSave, visibility} = ctx;
    const entryRunning = entry === runningEntry;
    let row = table.createEl("tr");
    visibility.rowByEntry.set(entry, row);
    // this row hides only when an ancestor is collapsed — its own flag hides
    // its descendants, not itself
    row.hidden = ancestorsCollapsed;
    row.style.setProperty("--depth", String(indent));
    if (indent > 0)
        row.addClass("tempo-subrow");
    if (entryRunning)
        row.addClass("tempo-row-running");

    // effective metadata (category/tags/color resolve through inheritance; the
    // row accent and chips re-render whenever a save rebuilds the table)
    const colorToken = effectiveColorToken(entry, ancestors, settings.categories);
    if (colorToken) {
        row.style.setProperty("--tempo-row-color", colorVar(colorToken)!);
        row.addClass("tempo-row-colored");
    }

    // the depth indent lives on the wrap instead of the label so the drag
    // handle sits at the row start, clear of the tree-connector lines that
    // .tempo-subrow draws inside the indent space
    let nameField = new EditableField(row, 0, entry.name);
    let nameCell = nameField.cell;
    let nameWrap = nameCell.createDiv({ cls: "tempo-name-wrap" });
    nameWrap.style.marginLeft = indent ? `${indent * 1.4}em` : "0";
    let dragHandle = nameWrap.createSpan({ cls: "tempo-drag-handle", attr: {"aria-hidden": "true"} });
    setIcon(dragHandle, "grip-vertical");
    if (colorToken) {
        const colorDot = nameWrap.createSpan({ cls: "tempo-color-dot", attr: {"aria-hidden": "true"} });
        colorDot.style.background = colorVar(colorToken)!;
    }
    nameWrap.appendChild(nameField.label);
    const ownNote = resolveNote(entry);
    if (ownNote) {
        let noteIcon = nameWrap.createSpan({cls: "tempo-note-icon", attr: {"aria-label": "Note", "tabindex": "0"}});
        setIcon(noteIcon, "sticky-note");
        attachNotePopover(app, noteIcon, ownNote, getFile, component, () => void openDetailsModal());
    }
    let startField = new EditableTimestampField(row, entry.startTime!, settings);
    let endField = new EditableTimestampField(row, entry.endTime!, settings);

    let durationCell = row.createEl("td");
    if (runningPath.has(entry)) {
        // this row's duration grows in real time; displayTracker keeps it ticking
        durationCell.setText(formatDuration(getDuration(entry), settings));
        liveCells.push({entry, cell: durationCell});
    } else {
        durationCell.setText(entry.endTime || entry.subEntries ? formatDuration(getDuration(entry), settings) : "");
    }

    void renderName(app, nameField.label, entry.name, getFile, component);

    // second, quiet line under the name: category chip + up to N tag chips
    renderMetaLine(nameCell, entry, ancestors, settings, indent);

    // details modal: full metadata editing for one segment (name, category,
    // color, tags, note); the caller's save writes the note back
    async function openDetailsModal(): Promise<void> {
        if (nameField.editing())
            return;
        // tell the editor which category (if any) an unset segment inherits,
        // so it can show why the row displays a group
        const inheritedCategory = resolveCategory(entry, ancestors);
        const inherited = inheritedCategory && inheritedCategory.source !== entry
            ? {name: inheritedCategory.value, sourceName: inheritedCategory.source.name}
            : undefined;
        const modal = new EntryDetailsModal(app, entry, {
            categories: settings.categories,
            suggestedTags: settings.suggestedTags,
            treeTags: collectTreeTags(tracker.entries),
            sourcePath: getFile(),
            inherited,
            onSaved: () => saveTracker(app, tracker, getFile(), getSectionInfo(), settings)
        });
        modal.open();
    }

    // right-click context menu with quick category/color/tag actions; text
    // inputs keep their native paste menu
    row.addEventListener("contextmenu", (e: MouseEvent) => {
        const target = e.target as HTMLElement | null;
        if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA"))
            return;
        e.preventDefault();
        if (nameField.editing())
            return;
        showEntryMenu(app, e, entry, ancestors, settings, () => void openDetailsModal(),
            () => void saveTracker(app, tracker, getFile(), getSectionInfo(), settings));
    });

    let expandButton = new ButtonComponent(nameWrap)
        .setClass("clickable-icon")
        .setClass("tempo-expand-button")
        .setIcon(`chevron-${entry.collapsed ? "left" : "down"}`)
        .onClick(() => {
            entry.collapsed = entry.collapsed ? undefined : true;
            // flip the chevron and show/hide the sub-rows instantly; only the
            // persistence write is debounced in the background
            void expandButton.setIcon(`chevron-${entry.collapsed ? "left" : "down"}`);
            visibility.apply(entry, !!entry.collapsed);
            scheduleCollapseSave();
        });
    if (!entry.subEntries)
        expandButton.buttonEl.setCssProps({ visibility: "hidden" })

    makeRowDraggable({
        handle: dragHandle,
        row: row,
        wrap: table.parentElement as HTMLElement,
        isEditing: () => nameField.editing(),
        getSiblingRows: () => orderedEntries(parentEntries, settings)
            .map(sub => visibility.rowByEntry.get(sub))
            .filter((subRow): subRow is HTMLTableRowElement => subRow !== undefined),
        onDrop: insertBefore => {
            // hidden rows belong to collapsed branches, which the whole
            // sibling level shares: a visible row never has hidden siblings
            if (reorderEntry(tracker.entries, entry, insertBefore, settings))
                void saveTracker(app, tracker, getFile(), getSectionInfo(), settings);
        }
    });

    let entryButtons = row.createEl("td");
    entryButtons.addClass("tempo-table-buttons");
    void new ButtonComponent(entryButtons)
        .setClass("clickable-icon")
        .setClass("tempo-action-move")
        .setTooltip("Move up")
        .setIcon("chevron-up")
        .setDisabled(displayIndex <= 0)
        .onClick(async () => {
            if (moveEntryByOffset(tracker.entries, entry, -1, settings))
                await saveTracker(app, tracker, getFile(), getSectionInfo(), settings);
        });
    void new ButtonComponent(entryButtons)
        .setClass("clickable-icon")
        .setClass("tempo-action-move")
        .setTooltip("Move down")
        .setIcon("chevron-down")
        .setDisabled(displayIndex < 0 || displayIndex >= parentEntries.length - 1)
        .onClick(async () => {
            if (moveEntryByOffset(tracker.entries, entry, 1, settings))
                await saveTracker(app, tracker, getFile(), getSectionInfo(), settings);
        });
    let playButton = new ButtonComponent(entryButtons)
        .setClass("clickable-icon")
        .setClass("tempo-action-play")
        .setIcon(`lucide-${entryRunning ? "square" : "play"}`)
        .setTooltip(entryRunning ? "End" : "Continue")
        .setDisabled(!!runningEntry && !entryRunning)
        .onClick(async () => {
            if (entryRunning) {
                endRunningEntry(tracker);
            } else if (!entry.subEntries && !entry.startTime) {
                // if we're using a template version of a tracker without a start time, start now
                entry.startTime = moment().toISOString();
            } else {
                startSubEntry(entry, newSegmentNameBox.getValue(), settings);
            }
            await saveTracker(app, tracker, getFile(), getSectionInfo(), settings);
        });
    playButton.buttonEl.toggleClass("tempo-action-running", entryRunning);
    let editButton = new ButtonComponent(entryButtons)
        .setClass("clickable-icon")
        .setClass("tempo-action-edit")
        .setTooltip("Edit")
        .setIcon("lucide-pencil")
        .onClick(async () => {
            await handleEdit();
        });
    void new ButtonComponent(entryButtons)
        .setClass("clickable-icon")
        .setClass("tempo-action-details")
        .setTooltip("Details")
        .setIcon("lucide-tags")
        .onClick(async () => {
            if (!nameField.editing())
                await openDetailsModal();
        });

    // Add double-click to edit functionality
    nameField.label.addEventListener("dblclick", () => {
        if (!nameField.editing()) {
            void handleEdit();
        }
    });

    async function handleEdit() {
        if (nameField.editing()) {
            await saveChanges();
        } else {
            startEditing();
        }
    }

    async function saveChanges() {
        entry.name = nameField.endEdit();
        expandButton.buttonEl.style.display = null as unknown as string;
        startField.endEdit();
        entry.startTime = startField.getTimestamp();
        if (!entryRunning) {
            endField.endEdit();
            entry.endTime = endField.getTimestamp();
        }
        await saveTracker(app, tracker, getFile(), getSectionInfo(), settings);
        void editButton.setIcon("lucide-pencil");
        editButton.buttonEl.removeClass("tempo-action-editing");
        void renderName(app, nameField.label, entry.name, getFile, component);
    }

    function startEditing() {
        nameField.beginEdit(entry.name, true);
        expandButton.buttonEl.setCssProps({ display: "none" });
        // only allow editing start and end times if we don't have sub entries
        if (!entry.subEntries) {
            startField.beginEdit(entry.startTime!);
            if (!entryRunning)
                endField.beginEdit(entry.endTime!);
        }
        void editButton.setIcon("lucide-check");
        editButton.buttonEl.addClass("tempo-action-editing");

        // Set up save/cancel handlers for keyboard shortcuts
        nameField.onSave = startField.onSave = endField.onSave = async () => {
            await saveChanges();
        };

        nameField.onCancel = startField.onCancel = endField.onCancel = () => {
            nameField.endEdit();
            startField.endEdit();
            if (!entryRunning) {
                endField.endEdit();
            }
            expandButton.buttonEl.style.display = null as unknown as string;
            void editButton.setIcon("lucide-pencil");
            editButton.buttonEl.removeClass("tempo-action-editing");
        };
    }

    void new ButtonComponent(entryButtons)
        .setClass("clickable-icon")
        .setClass("tempo-action-delete")
        .setTooltip("Remove")
        .setIcon("lucide-trash")
        .setDisabled(entryRunning)
        .onClick(async () => {
            const confirmed = await showConfirm(app, "Are you sure you want to delete this entry?");
            if (!confirmed)
                return;
            removeEntry(tracker.entries, entry);
            await saveTracker(app, tracker, getFile(), getSectionInfo(), settings);
        });

    if (entry.subEntries) {
        // pass each child's sibling list and display position down so no row
        // ever searches the tree for its own context
        const ordered = orderedEntries(entry.subEntries, settings);
        for (let i = 0; i < ordered.length; i++)
            addEditableTableRow(ctx, ordered[i]!, table, indent + 1, entry.subEntries, i, [...ancestors, entry], ancestorsCollapsed || !!entry.collapsed);
    }
}

function showConfirm(app: App, message: string): Promise<boolean> {
    return new Promise((resolve) => {
        const modal = new ConfirmModal(app, message, choice => resolve(choice === true));
        modal.open();
    });
}

// ---------------------------------------------------------------------------
// Segment metadata: row chips, note popover, right-click menu
// ---------------------------------------------------------------------------

// Second, quiet line under a row's name: one category chip plus up to MAX_TAGS
// tag chips (own tags always come first since resolveTags orders them that
// way), collapsing the remainder into "+N". Rows without any metadata render
// nothing, so plain trackers stay exactly as tidy as before.
function renderMetaLine(cell: HTMLTableCellElement, entry: Entry, ancestors: Entry[], settings: TempoSettings, indent: number): void {
    const category = resolveCategory(entry, ancestors);
    const tags = resolveTags(entry, ancestors);
    if (!category && tags.length === 0)
        return;

    const meta = cell.createDiv({cls: "tempo-meta"});
    if (indent)
        meta.style.marginLeft = `${indent * 1.4}em`;

    if (category) {
        const chip = meta.createSpan({cls: "tempo-chip tempo-cat-chip"});
        const dot = chip.createSpan({cls: "tempo-chip-dot"});
        const catColor = resolveCategoryColor(category.value, settings.categories);
        if (catColor)
            dot.style.background = colorVar(catColor)!;
        chip.createSpan({cls: "tempo-chip-text", text: category.value});
        if (category.source !== entry)
            chip.setAttr("title", `Category inherited from “${category.source.name}”`);
    }

    const maxShown = 3;
    for (let i = 0; i < tags.length && i < maxShown; i++) {
        const owned = tags[i]!;
        const chip = meta.createSpan({cls: "tempo-chip tempo-tag-chip"});
        chip.createSpan({cls: "tempo-chip-text", text: `#${owned.tag}`});
        if (owned.source !== entry) {
            chip.addClass("is-inherited");
            chip.setAttr("title", `Tag from “${owned.source.name}”`);
        }
    }
    if (tags.length > maxShown) {
        const rest = tags.slice(maxShown);
        const more = meta.createSpan({cls: "tempo-chip tempo-more-chip", text: `+${rest.length}`});
        more.setAttr("title", rest.map(t => `#${t.tag}`).join("  "));
    }
}

// markdown node cache for notes, keyed by note text (mirrors nameRenderCache)
const noteRenderCache = new Map<string, Node[]>();

async function renderNoteNodes(app: App, note: string, getFile: GetFile, component: Component): Promise<Node[]> {
    let nodes = noteRenderCache.get(note);
    if (!nodes) {
        const temp = createSpan();
        await MarkdownRenderer.render(app, note, temp, getFile(), component);
        nodes = temp.hasChildNodes() ? Array.from(temp.childNodes) : [];
        noteRenderCache.set(note, nodes);
    }
    return nodes;
}

const NOTE_POPOVER_SHOW_DELAY = 250;
const NOTE_POPOVER_HIDE_DELAY = 200;

// Working hover tooltip for a segment's note: hidden until the pointer
// rests on the sticky-note icon, stays open while the pointer is inside
// it (so links and long notes are usable), and hides shortly after the
// pointer leaves both. Clicking the icon opens the details editor instead.
// The popover lives inside the table wrapper so it is torn down with the
// block on re-render, and is positioned absolutely against that wrapper.
function attachNotePopover(app: App, anchor: HTMLElement, note: string, getFile: GetFile, component: Component, onEdit: () => void): void {
    const wrap = anchor.closest<HTMLElement>(".tempo-table-wrap");
    if (!wrap) {
        // no table wrapper (unlikely): degrade to a plain-text title tooltip
        anchor.setAttr("title", note.length > 300 ? `${note.slice(0, 300)}…` : note);
        return;
    }
    const pop = wrap.createDiv({cls: "tempo-note-pop"});
    const body = pop.createDiv({cls: "tempo-note-pop-body"});
    let overAnchor = false;
    let overPop = false;
    let hideTimer: number | undefined;
    let showTimer: number | undefined;

    const place = (): void => {
        const iconR = anchor.getBoundingClientRect();
        const wrapR = wrap.getBoundingClientRect();
        const dims = pop.getBoundingClientRect();
        let top = iconR.bottom - wrapR.top + 5;
        let left = iconR.left - wrapR.left;
        if (top + dims.height > wrapR.height - 4)
            top = Math.max(0, iconR.top - wrapR.top - dims.height - 5);
        left = Math.max(0, Math.min(left, wrapR.width - dims.width - 8));
        pop.style.top = `${top}px`;
        pop.style.left = `${left}px`;
    };

    const sync = (): void => {
        const visible = overAnchor || overPop;
        if (visible) {
            pop.addClass("is-visible");
            void renderNoteNodes(app, note, getFile, component).then(nodes => {
                if (!(overAnchor || overPop))
                    return;
                body.empty();
                body.append(...nodes.map(n => n.cloneNode(true)));
                place();
            });
        } else {
            pop.removeClass("is-visible");
        }
    };

    // hide on a short delay so moving from the icon into the popover does
    // not close it; cancel pending hides/shows on every state change
    const scheduleHide = (): void => {
        window.clearTimeout(hideTimer);
        hideTimer = window.setTimeout(() => {
            hideTimer = undefined;
            if (!overAnchor && !overPop) {
                overAnchor = false;
                overPop = false;
                sync();
            }
        }, NOTE_POPOVER_HIDE_DELAY);
    };

    const scheduleShow = (): void => {
        window.clearTimeout(showTimer);
        showTimer = window.setTimeout(() => {
            showTimer = undefined;
            sync();
        }, NOTE_POPOVER_SHOW_DELAY);
    };

    anchor.addEventListener("mouseenter", () => {
        overAnchor = true;
        window.clearTimeout(hideTimer);
        scheduleShow();
    });
    anchor.addEventListener("mouseleave", () => {
        overAnchor = false;
        window.clearTimeout(showTimer);
        if (overPop) {
            scheduleHide();
            return;
        }
        sync();
    });
    pop.addEventListener("mouseenter", () => {
        overPop = true;
        window.clearTimeout(hideTimer);
    });
    pop.addEventListener("mouseleave", () => {
        overPop = false;
        window.clearTimeout(showTimer);
        scheduleHide();
    });
    anchor.addEventListener("focus", () => {
        overAnchor = true;
        sync();
    });
    anchor.addEventListener("blur", () => {
        overAnchor = false;
        sync();
    });
    // click keeps its editor role: the tooltip is for reading, the dialog
    // is for editing
    anchor.addEventListener("click", (e: MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        onEdit();
    });
}

// Right-click menu for one row: full details plus quick category/color actions
// that mutate the entry and let the caller persist. Color uses a swatch
// popover, category a nested menu re-shown at the same position.
function showEntryMenu(app: App, evt: MouseEvent, entry: Entry, ancestors: Entry[], settings: TempoSettings, openDetails: () => void, onSaved: () => void): void {
    const at = {x: evt.clientX, y: evt.clientY};
    const menu = new Menu();

    menu.addItem(item => {
        item.setTitle("Edit details").setIcon("tags");
        item.onClick(() => openDetails());
    });
    menu.addSeparator();
    menu.addItem(item => {
        item.setTitle("Set color…").setIcon("palette");
        item.onClick(() => {
            showColorPopover({clientX: at.x, clientY: at.y}, entry.color, token => {
                entry.color = token;
                onSaved();
            });
        });
    });
    if (entry.color) {
        menu.addItem(item => {
            item.setTitle("Clear color").setIcon("rotate-ccw");
            item.onClick(() => {
                entry.color = undefined;
                onSaved();
            });
        });
    }
    // what the row currently shows (own value, or an ancestor's when unset);
    // picking "No category" stores null so the removal also wins over an
    // inherited category
    const effective = resolveCategory(entry, ancestors);
    menu.addItem(item => {
        item.setTitle("Set category…").setIcon("folder");
        item.onClick(() => {
            const sub = new Menu();
            const apply = (name: string): void => {
                entry.category = name || null;
                onSaved();
            };
            sub.addItem(subItem => {
                subItem.setTitle("No category").setChecked(!effective);
                subItem.onClick(() => apply(""));
            });
            for (const category of settings.categories) {
                const isCurrent = effective?.value === category.name;
                sub.addItem(subItem => {
                    subItem.setTitle(category.name).setChecked(isCurrent);
                    subItem.onClick(() => apply(category.name));
                });
            }
            sub.showAtPosition(at);
        });
    });

    menu.showAtMouseEvent(evt);
}

// characters that can start a markdown/HTML construct in Obsidian. Names with
// none of these (plus no `www.` autolink and no leading list/quote/heading
// marker) render to themselves verbatim, so we can skip the renderer entirely
// for them and just keep the plain text the label already holds.
const MARKDOWN_OR_HTML = /[\\`*_~[\]!<>#|:$]/;
const MARKDOWN_LEADING = /^\s*(#{1,6}\s|>|[-+*]\s|\d+[.)]\s)/;

function hasMarkdownSyntax(name: string): boolean {
    return MARKDOWN_OR_HTML.test(name) || MARKDOWN_LEADING.test(name) || name.includes("www.");
}

// Rendered segment names, keyed by name, so a table rebuild after every
// interaction doesn't re-run MarkdownRenderer for names it already rendered
// this session. Entries are re-cloned on reuse so two rows sharing a name
// each get their own copy of the nodes.
const nameRenderCache = new Map<string, Node[]>();

async function renderName(app: App, label: HTMLSpanElement, name: string, getFile: GetFile, component: Component): Promise<void> {
    if (!hasMarkdownSyntax(name)) {
        // plain text: the label already holds the raw name (createSpan text),
        // and MarkdownRenderer would render it back to the same text
        return;
    }
    let nodes = nameRenderCache.get(name);
    if (!nodes) {
        // render into a detached container first: MarkdownRenderer resolves
        // asynchronously when content needs loading (linked images etc.), and
        // the old approach wrote into the label while unwrapping it
        // synchronously, racing the renderer. Passing the raw name (not
        // innerHTML) also keeps literal HTML in task names from being
        // interpreted as markup.
        const temp = createSpan();
        await MarkdownRenderer.render(app, name, temp, getFile(), component);
        if (!label.isConnected)
            return; // the table was rebuilt while we were rendering; discard
        // rendering wraps the content in a paragraph — unwrap it
        const p = temp.querySelector("p");
        nodes = p?.hasChildNodes() ? Array.from(p.childNodes) : [];
        nameRenderCache.set(name, nodes);
    }
    if (!label.isConnected)
        return;
    label.replaceChildren(...nodes.map(n => n.cloneNode(true)));
}


class EditableField {
    cell: HTMLTableCellElement;
    label: HTMLSpanElement;
    box: TextComponent;
    onSave?: () => Promise<void> | void;
    onCancel?: () => Promise<void> | void;

    constructor(row: HTMLTableRowElement, indent: number, value: string) {
        this.cell = row.createEl("td");
        this.label = this.cell.createSpan({ text: value });
        this.label.style.marginLeft = indent ? `${indent * 1.4}em` : "0";
        this.box = new TextComponent(this.cell).setValue(value);
        this.box.inputEl.addClass("tempo-input");
        this.box.inputEl.hide();
        this.box.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
            // Save with Ctrl/Cmd + Enter
            if (e.key === "Enter") {
                e.preventDefault();
                void this.onSave?.();
            }
            // Cancel with Escape
            if (e.key === "Escape") {
                e.preventDefault();
                void this.onCancel?.();
            }
        });
    }

    editing(): boolean {
        return this.label.hidden;
    }

    beginEdit(value: string, focus = false): void {
        this.label.hidden = true;
        void this.box.setValue(value);
        this.box.inputEl.show();
        if (focus)
            this.box.inputEl.focus();
    }

    endEdit(): string {
        const value = this.box.getValue();
        this.label.setText(value);
        this.box.inputEl.hide();
        this.label.hidden = false;
        return value;
    }
}

class EditableTimestampField extends EditableField {
    settings: TempoSettings;

    constructor(row: HTMLTableRowElement, value: string, settings: TempoSettings) {
        super(row, 0, value ? formatTimestamp(value, settings) : "");
        this.settings = settings;
    }

    beginEdit(value: string, focus = false): void {
        super.beginEdit(value ? formatEditableTimestamp(value, this.settings) : "", focus);
    }

    endEdit(): string {
        const value = this.box.getValue();
        let displayValue = value;
        if (value) {
            const timestamp = unformatEditableTimestamp(value, this.settings);
            displayValue = formatTimestamp(timestamp, this.settings);
        }
        this.label.setText(displayValue);
        this.box.inputEl.hide();
        this.label.hidden = false;
        return value;
    }

    getTimestamp(): string | undefined {
        if (this.box.getValue()) {
            return unformatEditableTimestamp(this.box.getValue(), this.settings);
        } else {
            return undefined;
        }
    }
}
