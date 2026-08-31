import {MarkdownSectionInformation, ButtonComponent, TextComponent, TFile, MarkdownRenderer, Component, MarkdownRenderChild, App, setIcon} from "obsidian";
import {moment} from "./moment";
import {TempoSettings} from "./settings";
import {ConfirmModal} from "./confirm-modal";
import {makeRowDraggable} from "./drag";

export interface Tracker {
    entries: Entry[];
}

export interface Entry {
    name: string;
    startTime?: string;
    endTime?: string;
    subEntries?: Entry[];
    collapsed?: boolean;
}

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

export function displayTracker(app: App, tracker: Tracker, element: HTMLElement, getFile: GetFile, getSectionInfo: () => MarkdownSectionInformation | null, settings: TempoSettings, component: MarkdownRenderChild): void {

    element.addClass("tempo-container");
    // add start/stop controls
    let running = isRunning(tracker);
    let controls = element.createDiv({ cls: "tempo-controls" });
    let btn = new ButtonComponent(controls)
        .setClass("clickable-icon")
        .setIcon(`lucide-${running ? "stop" : "play"}-circle`)
        .setTooltip(running ? "End" : "Start")
        .onClick(async () => {
            if (running) {
                endRunningEntry(tracker);
            } else {
                startNewEntry(tracker, newSegmentNameBox.getValue());
            }
            await saveTracker(app, tracker, getFile(), getSectionInfo(), settings);
        });
    btn.buttonEl.addClass("tempo-btn");
    btn.buttonEl.toggleClass("tempo-btn-running", running);
    let newSegmentNameBox = new TextComponent(controls)
        .setPlaceholder("Segment name")
        .setDisabled(running);
    newSegmentNameBox.inputEl.addClass("tempo-txt");
    newSegmentNameBox.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter" && !running) {
            e.preventDefault();
            startNewEntry(tracker, newSegmentNameBox.getValue());
            void saveTracker(app, tracker, getFile(), getSectionInfo(), settings);
        }
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
    currentDiv.createSpan({ text: "Current", cls: "tempo-timer-label" });
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
    // collapse toggles rewrite the whole note section just to persist a boolean;
    // debounce bursts of toggles into a single write (still session-surviving)
    let collapseSaveTimer: number | undefined;
    const scheduleCollapseSave = (): void => {
        if (collapseSaveTimer !== undefined)
            window.clearTimeout(collapseSaveTimer);
        collapseSaveTimer = window.setTimeout(() => {
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

        for (let entry of orderedEntries(tracker.entries, settings))
            addEditableTableRow(app, tracker, entry, table, newSegmentNameBox, running, getFile, getSectionInfo, settings, 0, component, liveCells, scheduleCollapseSave, visibility, false);

        // add copy buttons
        let buttons = element.createDiv({ cls: "tempo-bottom" });
        let copyTableBtn = new ButtonComponent(buttons)
            .onClick(() => navigator.clipboard.writeText(createMarkdownTable(tracker, settings)));
        setIcon(copyTableBtn.buttonEl.createSpan({ cls: "tempo-btn-icon" }), "table");
        copyTableBtn.buttonEl.createSpan({ text: "Copy as table" });
        let copyCsvBtn = new ButtonComponent(buttons)
            .onClick(() => navigator.clipboard.writeText(createCsv(tracker, settings)));
        setIcon(copyCsvBtn.buttonEl.createSpan({ cls: "tempo-btn-icon" }), "file-spreadsheet");
        copyCsvBtn.buttonEl.createSpan({ text: "Copy as CSV" });
    }


    setCountdownValues(tracker, current, total, totalToday, currentDiv, settings);

    // While the tracker runs, every displayed duration grows linearly with wall
    // clock time, so each tick just adds elapsed Date.now() delta to baselines
    // captured at render time — no moment objects in the hot path. Any edit
    // re-renders (and re-baselines) the whole block anyway. registerInterval
    // clears the timer when the component unloads.
    const runningEntry = getRunningEntry(tracker.entries);
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
        let endTime = entry.endTime ? moment(entry.endTime) : moment();
        return endTime.diff(moment(entry.startTime));
    }
}

export function getDurationDate(entry: Entry, date: string): number {
    if (entry.subEntries) return getTotalDurationDate(entry.subEntries, date);
    if (!entry.startTime) return 0;

    let endTime = entry.endTime ? moment(entry.endTime) : moment();
    let startTime = moment(entry.startTime);

    const endDayEnd = endTime.clone().endOf("day");
    const startDayStart = startTime.clone().startOf("day");

    const targetDayStart = moment(date).startOf("day");
    const targetDayEnd = moment(date).endOf("day");

    const timeFramesDoNotOverlap =
        endTime.isBefore(targetDayStart) || startDayStart.isAfter(targetDayEnd);
    if (timeFramesDoNotOverlap) return 0;

    if (startTime.isBefore(targetDayStart)) startTime = targetDayStart;
    if (endDayEnd.isAfter(targetDayEnd)) endTime = targetDayEnd;

    return endTime.diff(startTime);
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
    let ret = 0;
    for (let entry of entries)
        ret += getDurationToday(entry);
    return ret;
}

export function getTotalDurationDate(entries: Entry[], date: string): number {
    let ret = 0;
    for (let entry of entries)
        ret += getDurationDate(entry, date);
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

// true when this entry's subtree contains the running leaf, i.e. its displayed
// duration grows in real time until the tracker is stopped
function hasRunningLeaf(entry: Entry): boolean {
    if (entry.subEntries)
        return entry.subEntries.some(hasRunningLeaf);
    return !!entry.startTime && !entry.endTime;
}

export function createMarkdownTable(tracker: Tracker, settings: TempoSettings): string {
    let table = [["Segment", "Start time", "End time", "Duration"]];
    for (let entry of orderedEntries(tracker.entries, settings))
        table.push(...createTableSection(entry, settings));
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
    let ret = "";
    for (let entry of orderedEntries(tracker.entries, settings)) {
        for (let row of createTableSection(entry, settings))
            ret += row.map(createCsvCell).join(settings.csvDelimiter) + "\n";
    }
    return ret;
}

export function orderedEntries(entries: Entry[], settings: TempoSettings): Entry[] {
    return settings.reverseSegmentOrder ? entries.slice().reverse() : entries;
}

export function formatTimestamp(timestamp: string, settings: TempoSettings): string {
    return moment(timestamp).format(settings.timestampFormat);
}

export function formatDuration(totalTime: number, settings: TempoSettings): string {
    let ret = "";
    let duration = moment.duration(totalTime);
    let hours = settings.fineGrainedDurations ? duration.hours() : Math.floor(duration.asHours());

    if (settings.timestampDurations) {
        if (settings.fineGrainedDurations) {
            let days = Math.floor(duration.asDays());
            if (days > 0)
                ret += days + ".";
        }
        ret += `${hours.toString().padStart(2, "0")}:${duration.minutes().toString().padStart(2, "0")}:${duration.seconds().toString().padStart(2, "0")}`;
    } else {
        if (settings.fineGrainedDurations) {
            let years = Math.floor(duration.asYears());
            if (years > 0)
                ret += years + "y ";
            if (duration.months() > 0)
                ret += duration.months() + "M ";
            if (duration.days() > 0)
                ret += duration.days() + "d ";
        }
        if (hours > 0)
            ret += hours + "h ";
        if (duration.minutes() > 0)
            ret += duration.minutes() + "m ";
        ret += duration.seconds() + "s";
    }
    return ret;
}


function startSubEntry(entry: Entry, name: string): void {
    // if this entry is not split yet, we add its time as a sub-entry instead
    if (!entry.subEntries) {
        entry.subEntries = [{ ...entry, name: `Part 1` }];
        entry.startTime = undefined;
        entry.endTime = undefined;
    }

    if (!name)
        name = `Part ${entry.subEntries.length + 1}`;
    entry.subEntries.push({ name: name, startTime: moment().toISOString() });
}

function startNewEntry(tracker: Tracker, name: string): void {
    if (!name)
        name = `Segment ${tracker.entries.length + 1}`;
    let entry: Entry = { name: name, startTime: moment().toISOString() };
    tracker.entries.push(entry);
}

function endRunningEntry(tracker: Tracker): void {
    let entry = getRunningEntry(tracker.entries);
    if (entry)
        entry.endTime = moment().toISOString();
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

        if (entry.subEntries)
            updateLegacyInfo(entry.subEntries);
    }
}

/**
 * Recursively generates a table section for the time tracker entries, maintaining the hierarchy
 * and indenting sub-entries with a dynamic prefix.
 *
 * @param entry - The current time tracker entry to process. It may contain nested sub-entries.
 * @param settings - The settings object for the Tempo, containing format options.
 * @param indent - The current indentation level, starting at 0 for top-level entries and increasing for sub-entries.
 *                 This value determines the prefix (e.g., "-", "--") added to sub-entry names.
 */
function createTableSection(entry: Entry, settings: TempoSettings, indent: number = 0): string[][] {
    // Create dynamic prefix for sub-entries.
    const prefix = `${"-".repeat(indent)} `;

    // Generate the table data.
    let ret = [[
        `${prefix}${entry.name}`, // Add prefix based on the indent level.
        entry.startTime ? formatTimestamp(entry.startTime, settings) : "",
        entry.endTime ? formatTimestamp(entry.endTime, settings) : "",
        entry.endTime || entry.subEntries ? formatDuration(getDuration(entry), settings) : ""
    ]];

    // If sub-entries exist, add them recursively.
    if (entry.subEntries) {
        for (let sub of orderedEntries(entry.subEntries, settings))
            ret.push(...createTableSection(sub, settings, indent + 1));
    }

    return ret;
}

function addEditableTableRow(app: App, tracker: Tracker, entry: Entry, table: HTMLTableElement, newSegmentNameBox: TextComponent, trackerRunning: boolean, getFile: GetFile, getSectionInfo: () => MarkdownSectionInformation | null, settings: TempoSettings, indent: number, component: MarkdownRenderChild, liveCells: LiveDurationCell[], scheduleCollapseSave: () => void, visibility: RowVisibility, ancestorsCollapsed: boolean): void {
    let entryRunning = getRunningEntry(tracker.entries) == entry;
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

    // the depth indent lives on the wrap instead of the label so the drag
    // handle sits at the row start, clear of the tree-connector lines that
    // .tempo-subrow draws inside the indent space
    let nameField = new EditableField(row, 0, entry.name);
    let nameWrap = nameField.cell.createDiv({ cls: "tempo-name-wrap" });
    nameWrap.style.marginLeft = indent ? `${indent * 1.4}em` : "0";
    let dragHandle = nameWrap.createSpan({ cls: "tempo-drag-handle", attr: {"aria-hidden": "true"} });
    setIcon(dragHandle, "grip-vertical");
    nameWrap.appendChild(nameField.label);
    let startField = new EditableTimestampField(row, entry.startTime!, settings);
    let endField = new EditableTimestampField(row, entry.endTime!, settings);

    let durationCell = row.createEl("td");
    if (hasRunningLeaf(entry)) {
        // this row's duration grows in real time; displayTracker keeps it ticking
        durationCell.setText(formatDuration(getDuration(entry), settings));
        liveCells.push({entry, cell: durationCell});
    } else {
        durationCell.setText(entry.endTime || entry.subEntries ? formatDuration(getDuration(entry), settings) : "");
    }

    void renderNameAsMarkdown(app, nameField.label, entry.name, getFile, component);

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
        getSiblingRows: () => {
            const parent = findParentEntry(tracker.entries, entry);
            if (!parent)
                return [];
            return orderedEntries(parent, settings)
                .map(sub => visibility.rowByEntry.get(sub))
                .filter((subRow): subRow is HTMLTableRowElement => subRow !== undefined);
        },
        onDrop: insertBefore => {
            // hidden rows belong to collapsed branches, which the whole
            // sibling level shares: a visible row never has hidden siblings
            if (reorderEntry(tracker.entries, entry, insertBefore, settings))
                void saveTracker(app, tracker, getFile(), getSectionInfo(), settings);
        }
    });

    let entryButtons = row.createEl("td");
    entryButtons.addClass("tempo-table-buttons");
    const parentList = findParentEntry(tracker.entries, entry);
    const displayIndex = parentList ? orderedEntries(parentList, settings).indexOf(entry) : 0;
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
        .setDisabled(displayIndex < 0 || displayIndex >= (parentList ? parentList.length : 1) - 1)
        .onClick(async () => {
            if (moveEntryByOffset(tracker.entries, entry, 1, settings))
                await saveTracker(app, tracker, getFile(), getSectionInfo(), settings);
        });
    let playButton = new ButtonComponent(entryButtons)
        .setClass("clickable-icon")
        .setClass("tempo-action-play")
        .setIcon(`lucide-${entryRunning ? "square" : "play"}`)
        .setTooltip(entryRunning ? "End" : "Continue")
        .setDisabled(trackerRunning && !entryRunning)
        .onClick(async () => {
            if (entryRunning) {
                endRunningEntry(tracker);
            } else if (!entry.subEntries && !entry.startTime) {
                // if we're using a template version of a tracker without a start time, start now
                entry.startTime = moment().toISOString();
            } else {
                startSubEntry(entry, newSegmentNameBox.getValue());
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
        void renderNameAsMarkdown(app, nameField.label, entry.name, getFile, component);
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
        for (let sub of orderedEntries(entry.subEntries, settings))
            addEditableTableRow(app, tracker, sub, table, newSegmentNameBox, trackerRunning, getFile, getSectionInfo, settings, indent + 1, component, liveCells, scheduleCollapseSave, visibility, ancestorsCollapsed || !!entry.collapsed);
    }
}

function showConfirm(app: App, message: string): Promise<boolean> {
    return new Promise((resolve) => {
        const modal = new ConfirmModal(app, message, resolve);
        modal.open();
    });
}

async function renderNameAsMarkdown(app: App, label: HTMLSpanElement, name: string, getFile: GetFile, component: Component): Promise<void> {
    // render into a detached container first: MarkdownRenderer resolves
    // asynchronously when content needs loading (linked images etc.), and the
    // old approach wrote into the label while unwrapping it synchronously,
    // racing the renderer. Passing the raw name (not innerHTML) also keeps
    // literal HTML in task names from being interpreted as markup.
    const temp = createSpan();
    await MarkdownRenderer.render(app, name, temp, getFile(), component);
    if (!label.isConnected)
        return; // the table was rebuilt while we were rendering; discard
    // rendering wraps the content in a paragraph — unwrap it
    const p = temp.querySelector("p");
    label.replaceChildren(...(p?.hasChildNodes() ? Array.from(p.childNodes) : []));
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
