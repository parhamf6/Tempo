import {
    App,
    ButtonComponent,
    DropdownComponent,
    MarkdownRenderChild,
    MarkdownSectionInformation,
    TextComponent,
    ToggleComponent,
    moment,
    setIcon
} from "obsidian";
import {TempoSettings} from "../settings";
import {formatDuration} from "../tracker";
import {scanEntries} from "./scan";
import {computeStats, computeStatsForPeriod, resolveRange} from "./aggregate";
import {saveStatsState} from "./state";
import {buildStatsCsv} from "./export";
import {StatsBucket, StatsLeaderboardRow, StatsRange, StatsRangeType, StatsResult, StatsSource, StatsState} from "./types";

type GetFile = () => string;

function newSourceId(): string {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export function displayStats(
    app: App,
    state: StatsState,
    element: HTMLElement,
    getFile: GetFile,
    getSectionInfo: () => MarkdownSectionInformation,
    settings: TempoSettings,
    component: MarkdownRenderChild
): void {
    element.addClass("tempo-container");
    element.addClass("tempo-stats-container");

    const save = async (): Promise<void> => {
        await saveStatsState(app, state, getFile(), getSectionInfo(), settings);
    };

    const sourcesSection = element.createDiv({cls: "tempo-stats-sources"});
    const rangeSection = element.createDiv({cls: "tempo-stats-range"});
    const resultsSection = element.createDiv({cls: "tempo-stats-results"});
    const bottom = element.createDiv({cls: "tempo-bottom"});

    let refreshButton: ButtonComponent;
    let refreshing = false;

    // chart drill-down: which bucket is selected and whether the view is filtered to it
    let selectedKey: number | null = null;
    let filterActive = false;

    // session-only date-navigator position (days into the past); never persisted,
    // so tab titles keep their "ending today" meaning on reload
    let rangeOffset = 0;

    // leaderboard accordion: normalized name of the currently expanded task row
    let openTaskKey: string | null = null;

    const refresh = async (): Promise<void> => {
        if (refreshing)
            return;
        refreshing = true;
        refreshButton?.setDisabled(true);
        try {
            const scanned = await scanEntries(app, state.sources);
            const result = computeStats(scanned.entries, {...state.range, offset: rangeOffset || undefined}, scanned.fileCount);

            // drop the selection if it no longer matches a bucket (e.g. range changed)
            if (selectedKey !== null && !result.buckets.some(b => b.start === selectedKey)) {
                selectedKey = null;
                filterActive = false;
            }
            const selected = selectedKey !== null
                ? result.buckets.find(b => b.start === selectedKey) ?? null
                : null;
            const filteredResult = selected && filterActive
                ? computeStatsForPeriod(scanned.entries, selected.start, selected.end, scanned.fileCount)
                : null;

            // remember ephemeral view state so background refreshes don't disturb the reader
            const uiState = captureStatsUiState(resultsSection);
            renderResults(resultsSection, result, settings, component, {
                selected,
                filteredResult,
                openTaskKey,
                onSelect: (bucket) => {
                    if (bucket && bucket.start !== selectedKey) {
                        selectedKey = bucket.start;
                        filterActive = false;
                    } else {
                        selectedKey = null;
                        filterActive = false;
                    }
                    void refresh();
                },
                onToggleFilter: () => {
                    filterActive = !filterActive;
                    void refresh();
                },
                onToggleTask: (key) => {
                    openTaskKey = key;
                    void refresh();
                }
            });
            restoreStatsUiState(resultsSection, uiState);
        } finally {
            refreshing = false;
            refreshButton?.setDisabled(false);
        }
    };

    const onChange = async (): Promise<void> => {
        await save();
        await refresh();
    };

    renderSources(sourcesSection, state, onChange);
    renderRange(rangeSection, state, onChange, {
        getOffset: () => rangeOffset,
        setOffset: (offset) => {
            rangeOffset = offset;
        }
    });

    refreshButton = new ButtonComponent(bottom).onClick(async () => await refresh());
    setIcon(refreshButton.buttonEl.createSpan({cls: "tempo-btn-icon"}), "refresh-cw");
    refreshButton.buttonEl.createSpan({text: "Refresh"});

    const exportButton = new ButtonComponent(bottom).onClick(async () => {
        const scanned = await scanEntries(app, state.sources);
        const result = computeStats(scanned.entries, state.range, scanned.fileCount);
        await navigator.clipboard.writeText(buildStatsCsv(result, settings));
    });
    setIcon(exportButton.buttonEl.createSpan({cls: "tempo-btn-icon"}), "clipboard-copy");
    exportButton.buttonEl.createSpan({text: "Copy stats as CSV"});

    let debounceHandle: number | undefined;
    const scheduleRefresh = (): void => {
        if (debounceHandle)
            window.clearTimeout(debounceHandle);
        debounceHandle = window.setTimeout(() => void refresh(), 500);
    };
    component.registerEvent(app.vault.on("modify", () => scheduleRefresh()));
    component.registerEvent(app.vault.on("create", () => scheduleRefresh()));
    component.registerEvent(app.vault.on("delete", () => scheduleRefresh()));
    component.registerEvent(app.vault.on("rename", () => scheduleRefresh()));

    void refresh();
}

// ---------------------------------------------------------------------------
// Sources panel
// ---------------------------------------------------------------------------

function describeSource(source: StatsSource): string {
    if (source.type === "file")
        return "Single file";
    const scope = (source.recursive ?? true) ? "with subfolders" : "this folder only";
    if (source.matchMode === "regex" && source.pattern)
        return `Regex: ${source.pattern} (${scope})`;
    return `All files (${scope})`;
}

function renderSources(container: HTMLElement, state: StatsState, onChange: () => Promise<void>): void {
    container.empty();
    container.createDiv({text: "Sources", cls: "tempo-stats-heading"});

    const list = container.createDiv({cls: "tempo-stats-source-list"});
    const addButtonRow = container.createDiv({cls: "tempo-stats-add-row"});
    const formHost = container.createDiv({cls: "tempo-stats-form-host"});

    const rerenderList = (): void => {
        list.empty();
        if (state.sources.length === 0) {
            list.createDiv({
                cls: "tempo-empty",
                text: "No sources yet — add a folder or file below."
            });
            return;
        }
        for (const source of state.sources) {
            const row = list.createDiv({cls: "tempo-stats-source-row"});
            const iconEl = row.createSpan({cls: "tempo-stats-source-icon"});
            setIcon(iconEl, source.type === "folder" ? "folder" : "file");

            const info = row.createDiv({cls: "tempo-stats-source-info"});
            info.createDiv({
                text: source.type === "folder" ? (source.path || "/ (vault root)") : source.path,
                cls: "tempo-stats-source-path"
            });
            info.createDiv({text: describeSource(source), cls: "tempo-stats-source-desc"});

            const actions = row.createDiv({cls: "tempo-stats-source-actions"});
            new ButtonComponent(actions)
                .setClass("clickable-icon")
                .setClass("tempo-action-edit")
                .setIcon("lucide-pencil")
                .setTooltip("Edit")
                .onClick(() => openForm(source));
            new ButtonComponent(actions)
                .setClass("clickable-icon")
                .setClass("tempo-action-delete")
                .setIcon("lucide-trash")
                .setTooltip("Remove")
                .onClick(async () => {
                    state.sources = state.sources.filter(s => s.id !== source.id);
                    rerenderList();
                    await onChange();
                });
        }
    };

    const openForm = (existing: StatsSource | null): void => {
        formHost.empty();
        renderSourceForm(formHost, existing, {
            onSave: async (source) => {
                if (existing) {
                    const idx = state.sources.findIndex(s => s.id === existing.id);
                    if (idx >= 0)
                        state.sources[idx] = source;
                } else {
                    state.sources.push(source);
                }
                formHost.empty();
                rerenderList();
                await onChange();
            },
            onCancel: () => formHost.empty()
        });
    };

    rerenderList();
    new ButtonComponent(addButtonRow)
        .setButtonText("Add source")
        .onClick(() => openForm(null));
}

function renderSourceForm(
    host: HTMLElement,
    existing: StatsSource | null,
    handlers: { onSave: (s: StatsSource) => Promise<void>, onCancel: () => void }
): void {
    const form = host.createDiv({cls: "tempo-stats-form"});

    const typeRow = form.createDiv({cls: "tempo-stats-form-row"});
    typeRow.createSpan({text: "Type", cls: "tempo-stats-form-label"});
    const typeDropdown = new DropdownComponent(typeRow)
        .addOption("folder", "Folder")
        .addOption("file", "Single file")
        .setValue(existing?.type ?? "folder");

    const pathRow = form.createDiv({cls: "tempo-stats-form-row"});
    pathRow.createSpan({text: "Path", cls: "tempo-stats-form-label"});
    const pathInput = new TextComponent(pathRow).setValue(existing?.path ?? "");
    pathInput.inputEl.addClass("tempo-input");

    const recursiveRow = form.createDiv({cls: "tempo-stats-form-row"});
    recursiveRow.createSpan({text: "Include subfolders", cls: "tempo-stats-form-label"});
    const recursiveToggle = new ToggleComponent(recursiveRow).setValue(existing?.recursive ?? true);

    const matchRow = form.createDiv({cls: "tempo-stats-form-row"});
    matchRow.createSpan({text: "Match", cls: "tempo-stats-form-label"});
    const matchDropdown = new DropdownComponent(matchRow)
        .addOption("all", "All files")
        .addOption("regex", "Filename regex")
        .setValue(existing?.matchMode ?? "all");

    const patternRow = form.createDiv({cls: "tempo-stats-form-row"});
    patternRow.createSpan({text: "Pattern", cls: "tempo-stats-form-label"});
    const patternInput = new TextComponent(patternRow)
        .setValue(existing?.pattern ?? "^\\d{4}-\\d{2}-\\d{2}$");
    patternInput.inputEl.addClass("tempo-input");

    const caseRow = form.createDiv({cls: "tempo-stats-form-row"});
    caseRow.createSpan({text: "Case sensitive", cls: "tempo-stats-form-label"});
    const caseToggle = new ToggleComponent(caseRow).setValue(existing?.caseSensitive ?? false);

    const errorEl = form.createDiv({cls: "tempo-stats-form-error"});
    errorEl.hide();

    const updateVisibility = (): void => {
        const isFolder = typeDropdown.getValue() === "folder";
        const isRegex = matchDropdown.getValue() === "regex";
        recursiveRow.toggle(isFolder);
        matchRow.toggle(isFolder);
        patternRow.toggle(isFolder && isRegex);
        caseRow.toggle(isFolder && isRegex);
        pathInput.setPlaceholder(isFolder ? "Daily  (leave empty for vault root)" : "Daily/myjob.md");
    };
    typeDropdown.onChange(() => updateVisibility());
    matchDropdown.onChange(() => updateVisibility());
    updateVisibility();

    const buttonsRow = form.createDiv({cls: "tempo-stats-form-buttons"});
    new ButtonComponent(buttonsRow).setButtonText("Cancel").onClick(() => handlers.onCancel());
    new ButtonComponent(buttonsRow)
        .setButtonText(existing ? "Save" : "Add")
        .setCta()
        .onClick(async () => {
            const type = typeDropdown.getValue() as "folder" | "file";
            const path = pathInput.getValue().trim();
            errorEl.hide();

            if (type === "file" && !path) {
                errorEl.setText("Please enter a file path.");
                errorEl.show();
                return;
            }

            const isRegex = type === "folder" && matchDropdown.getValue() === "regex";
            let pattern: string | undefined;
            if (isRegex) {
                pattern = patternInput.getValue().trim();
                if (!pattern) {
                    errorEl.setText('Please enter a regex pattern, or switch to "all files".');
                    errorEl.show();
                    return;
                }
                try {
                    new RegExp(pattern);
                } catch {
                    errorEl.setText("That regex pattern isn't valid.");
                    errorEl.show();
                    return;
                }
            }

            const source: StatsSource = {
                id: existing?.id ?? newSourceId(),
                type,
                path,
                recursive: type === "folder" ? recursiveToggle.getValue() : undefined,
                matchMode: type === "folder" ? (matchDropdown.getValue() as "all" | "regex") : undefined,
                pattern: isRegex ? pattern : undefined,
                caseSensitive: isRegex ? caseToggle.getValue() : undefined
            };
            await handlers.onSave(source);
        });
}

// ---------------------------------------------------------------------------
// Range panel
// ---------------------------------------------------------------------------

interface RangeOption {
    type: StatsRangeType;
    label: string;
    days?: number;
}

const rangeOptions: RangeOption[] = [
    {type: "today", label: "Today"},
    {type: "days", label: "7 days", days: 7},
    {type: "days", label: "30 days", days: 30},
    {type: "custom", label: "Custom"}
];

function renderRange(
    container: HTMLElement,
    state: StatsState,
    onChange: () => Promise<void>,
    nav: { getOffset: () => number, setOffset: (offset: number) => void }
): void {
    container.empty();
    const barRow = container.createDiv({cls: "tempo-stats-range-bar"});
    const customRow = container.createDiv({cls: "tempo-stats-range-custom"});

    const isActive = (opt: RangeOption): boolean => {
        if (state.range.type !== opt.type)
            return false;
        if (opt.type === "days")
            return state.range.days === opt.days;
        return true;
    };

    const buttonEls: HTMLElement[] = [];
    const updateActiveStyles = (): void => {
        buttonEls.forEach((el, i) => el.toggleClass("is-active", isActive(rangeOptions[i]!)));
    };

    // preset tabs
    for (const opt of rangeOptions) {
        const btn = new ButtonComponent(barRow)
            .setButtonText(opt.label)
            .onClick(async () => {
                state.range = opt.type === "days" ? {type: "days", days: opt.days} : {type: opt.type};
                // switching tabs jumps back to the window ending today
                nav.setOffset(0);
                updateActiveStyles();
                updateNav();
                rerenderCustom();
                await onChange();
            });
        btn.buttonEl.addClass("tempo-stats-range-pill");
        buttonEls.push(btn.buttonEl);
    }

    // --- inline date navigator: ‹ window › ----------------------------------
    barRow.createDiv({cls: "tempo-range-divider"});

    const prevBtn = new ButtonComponent(barRow)
        .setClass("clickable-icon")
        .setClass("tempo-range-nav-btn")
        .setIcon("chevron-left")
        .setTooltip("Previous day");
    const labelEl = barRow.createEl("button", {cls: "tempo-stats-range-label", attr: {type: "button"}});
    const nextBtn = new ButtonComponent(barRow)
        .setClass("clickable-icon")
        .setClass("tempo-range-nav-btn")
        .setIcon("chevron-right")
        .setTooltip("Next day");

    const effectiveRange = (): StatsRange => ({
        ...state.range,
        offset: state.range.type === "custom" ? undefined : nav.getOffset()
    });

    const customReady = (): boolean =>
        state.range.type !== "custom" || (!!state.range.start && !!state.range.end);

    // true when the window's end reaches today
    const atPresent = (): boolean => {
        if (state.range.type === "custom")
            return !!state.range.end && moment(state.range.end).isSameOrAfter(moment(), "day");
        return nav.getOffset() <= 0;
    };

    const updateNav = (): void => {
        if (!customReady()) {
            labelEl.setText("Pick a date range");
            prevBtn.setDisabled(true);
            nextBtn.setDisabled(true);
            labelEl.removeClass("is-parked");
            labelEl.removeAttribute("title");
            return;
        }

        const {start, end} = resolveRange(effectiveRange());
        if (state.range.type === "today") {
            labelEl.setText(start.format("ddd, MMM D YYYY"));
        } else {
            const sameYear = start.year() === end.year();
            labelEl.setText(`${start.format(sameYear ? "MMM D" : "MMM D, YYYY")} – ${end.format("MMM D, YYYY")}`);
        }

        // ▶ is disabled once the window's end reaches today
        nextBtn.setDisabled(atPresent());
        // parked in the past → the label itself becomes a "back to today" button
        labelEl.toggleClass("is-parked", !atPresent());
        if (atPresent())
            labelEl.removeAttribute("title");
        else
            labelEl.setAttribute("title", "Back to today");
    };

    const stepBack = async (dir: 1 | -1): Promise<void> => {
        if (!customReady())
            return;
        // always step by a single day, regardless of range length
        if (state.range.type === "custom" && state.range.start && state.range.end) {
            state.range = {
                ...state.range,
                start: moment(state.range.start).add(dir, "days").format("YYYY-MM-DD"),
                end: moment(state.range.end).add(dir, "days").format("YYYY-MM-DD")
            };
            rerenderCustom();
        } else {
            nav.setOffset(Math.max(0, nav.getOffset() + dir));
        }
        updateNav();
        await onChange();
    };

    prevBtn.onClick(() => stepBack(1));
    nextBtn.onClick(() => stepBack(-1));

    // clicking the label jumps back to the present when parked in the past
    const jumpToPresent = async (): Promise<void> => {
        if (state.range.type === "custom" && state.range.start && state.range.end) {
            const span = moment(state.range.end).diff(moment(state.range.start), "days") + 1;
            state.range = {
                ...state.range,
                end: moment().format("YYYY-MM-DD"),
                start: moment().subtract(span - 1, "days").format("YYYY-MM-DD")
            };
            rerenderCustom();
        } else {
            nav.setOffset(0);
        }
        updateNav();
        await onChange();
    };

    labelEl.addEventListener("click", () => {
        if (customReady() && !atPresent())
            void jumpToPresent();
    });

    const rerenderCustom = (): void => {
        customRow.empty();
        customRow.toggle(state.range.type === "custom");
        if (state.range.type !== "custom")
            return;

        const startInput = customRow.createEl("input", {
            attr: {type: "date"},
            cls: "tempo-input"
        });
        startInput.value = state.range.start ?? moment().subtract(6, "days").format("YYYY-MM-DD");
        const endInput = customRow.createEl("input", {
            attr: {type: "date"},
            cls: "tempo-input"
        });
        endInput.value = state.range.end ?? moment().format("YYYY-MM-DD");

        new ButtonComponent(customRow)
            .setButtonText("Apply")
            .setCta()
            .onClick(async () => {
                state.range = {type: "custom", start: startInput.value, end: endInput.value};
                await onChange();
            });
    };

    updateActiveStyles();
    rerenderCustom();
    updateNav();
}

// ---------------------------------------------------------------------------
// Results: summary cards + chart + leaderboard
// ---------------------------------------------------------------------------

interface StatsDayView {
    selected: StatsBucket | null;
    filteredResult: StatsResult | null;
    // leaderboard accordion: which task's day-by-day list is expanded
    openTaskKey: string | null;
    onSelect: (bucket: StatsBucket | null) => void;
    onToggleFilter: () => void;
    onToggleTask: (key: string | null) => void;
}

// ephemeral view state that should survive a background re-render
interface StatsUiState {
    breakdownOpen: boolean;
    lbScrollTop: number;
    lbFilter: string;
}

function captureStatsUiState(root: HTMLElement): StatsUiState {
    return {
        breakdownOpen: root.querySelector<HTMLDetailsElement>("details.tempo-breakdown")?.open ?? false,
        lbScrollTop: root.querySelector<HTMLElement>(".tempo-stats-leaderboard")?.scrollTop ?? 0,
        lbFilter: root.querySelector<HTMLInputElement>(".tempo-lb-filter")?.value ?? ""
    };
}

function restoreStatsUiState(root: HTMLElement, state: StatsUiState): void {
    const breakdown = root.querySelector<HTMLDetailsElement>("details.tempo-breakdown");
    if (breakdown)
        breakdown.open = state.breakdownOpen;

    const board = root.querySelector<HTMLElement>(".tempo-stats-leaderboard");
    if (board)
        board.scrollTop = state.lbScrollTop;

    const filter = root.querySelector<HTMLInputElement>(".tempo-lb-filter");
    if (filter && state.lbFilter) {
        filter.value = state.lbFilter;
        // re-run the row filtering for the restored query
        filter.dispatchEvent(new Event("input"));
    }
}

function addSummaryCard(container: HTMLElement, icon: string, value: string, label: string): void {
    const card = container.createDiv({cls: "tempo-timer"});
    setIcon(card.createSpan({cls: "tempo-timer-icon"}), icon);
    card.createSpan({cls: "tempo-timer-time", text: value});
    card.createSpan({cls: "tempo-timer-label", text: label});
}

function renderResults(container: HTMLElement, result: StatsResult, settings: TempoSettings, component: MarkdownRenderChild, view: StatsDayView): void {
    container.empty();

    // when filtered to a bucket, summary cards and leaderboard show just that period
    const effective = view.filteredResult ?? result;

    const summary = container.createDiv({cls: "tempo-timers"});
    addSummaryCard(summary, "clock", formatDuration(effective.totalMs, settings), "Total time");
    addSummaryCard(summary, "files", String(result.fileCount), "Files scanned");
    addSummaryCard(summary, "list-checks", String(effective.leaderboard.length), "Tasks tracked");

    const chartWrap = container.createDiv({cls: "tempo-stats-chart-wrap"});
    if (result.buckets.length === 0 || result.buckets.every(b => b.durationMs === 0)) {
        chartWrap.createDiv({cls: "tempo-empty", text: "No tracked time in this range yet."});
    } else {
        renderBarChart(chartWrap, result.buckets, settings, component, view);
    }

    if (view.selected)
        renderDayPanel(container, view, settings);

    if (effective.leaderboard.length === 0) {
        const board = container.createDiv({cls: "tempo-stats-leaderboard"});
        board.createDiv({cls: "tempo-empty", text: "Nothing to rank yet."});
    } else {
        const max = Math.max(1, ...effective.leaderboard.map(r => r.durationMs));

        // client-side task name filter; toggles rows without re-rendering so focus survives
        const searchRow = container.createDiv({cls: "tempo-stats-lb-search"});
        const filterInput = searchRow.createEl("input", {
            cls: "tempo-input tempo-lb-filter",
            attr: {type: "search", placeholder: "Filter tasks…", spellcheck: false}
        });

        const board = container.createDiv({cls: "tempo-stats-leaderboard"});
        const noMatch = board.createDiv({cls: "tempo-empty", text: "No tasks match."});
        noMatch.hide();
        const items = effective.leaderboard.map(row => {
            const item = board.createDiv({cls: "tempo-stats-lb-item"});
            const rowEl = addLeaderboardRow(item, row, max, settings);
            rowEl.addClass("is-clickable");
            rowEl.setAttribute("title", "Show day-by-day times");

            // expandable per-day breakdown, fed by each bucket's own leaderboard
            const key = taskKeyOf(row.name);
            const isOpen = view.openTaskKey === key;
            const detail = item.createDiv({cls: "tempo-stats-lb-detail"});
            if (isOpen)
                fillTaskDetail(detail, row, result.buckets, settings);
            detail.toggle(isOpen);
            rowEl.addEventListener("click", () =>
                view.onToggleTask(isOpen ? null : key));

            return {el: item, name: row.name.toLowerCase()};
        });
        filterInput.addEventListener("input", () => {
            const query = filterInput.value.trim().toLowerCase();
            let visible = 0;
            for (const {el, name} of items) {
                const show = !query || name.includes(query);
                el.toggle(show);
                if (show)
                    visible++;
            }
            noMatch.toggle(visible === 0);
        });
    }

    renderTaskBreakdown(container, effective, settings);
}

function addLeaderboardRow(board: HTMLElement, row: StatsLeaderboardRow, max: number, settings: TempoSettings): HTMLDivElement {
    const rowEl = board.createDiv({cls: "tempo-stats-lb-row"});
    rowEl.createDiv({cls: "tempo-stats-lb-name", text: row.name});
    const track = rowEl.createDiv({cls: "tempo-stats-lb-track"});
    const bar = track.createDiv({cls: "tempo-stats-lb-bar"});
    bar.style.width = `${Math.max(4, (row.durationMs / max) * 100)}%`;
    rowEl.createDiv({cls: "tempo-stats-lb-value", text: formatDuration(row.durationMs, settings)});
    return rowEl;
}

// leaderboard grouping key (matches buildLeaderboard in aggregate.ts)
function taskKeyOf(name: string): string {
    return name.trim().toLowerCase();
}

// expands a task row into its per-bucket times across the visible window
function fillTaskDetail(container: HTMLElement, row: StatsLeaderboardRow, buckets: StatsBucket[], settings: TempoSettings): void {
    const key = taskKeyOf(row.name);
    const series = buckets.map(b => ({
        label: b.label,
        ms: b.leaderboard.find(r => taskKeyOf(r.name) === key)?.durationMs ?? 0
    }));
    const max = Math.max(1, ...series.map(s => s.ms));

    for (const point of series) {
        const line = container.createDiv({cls: "tempo-stats-lb-day" + (point.ms > 0 ? "" : " is-zero")});
        line.createDiv({cls: "tempo-stats-lb-day-date", text: point.label});
        const track = line.createDiv({cls: "tempo-stats-lb-day-track"});
        if (point.ms > 0) {
            const bar = track.createDiv({cls: "tempo-stats-lb-day-bar"});
            bar.style.width = `${Math.max(6, (point.ms / max) * 100)}%`;
        }
        line.createDiv({cls: "tempo-stats-lb-day-value", text: formatDuration(point.ms, settings)});
    }
}

function renderTaskBreakdown(container: HTMLElement, result: StatsResult, settings: TempoSettings): void {
    if (result.leaderboard.length === 0 || result.totalMs <= 0)
        return;

    const details = container.createEl("details", {cls: "tempo-breakdown"});
    const summary = details.createEl("summary", {cls: "tempo-breakdown-summary"});
    setIcon(summary.createSpan({cls: "tempo-breakdown-summary-icon"}), "chevron-right");
    summary.createSpan({text: "Task breakdown (%)", cls: "tempo-breakdown-summary-text"});

    // top slices + everything else merged into "Other"
    const maxSlices = 6;
    const palette = [
        "var(--color-blue)", "var(--color-green)", "var(--color-yellow)",
        "var(--color-orange)", "var(--color-red)", "var(--color-purple)",
        "var(--color-cyan)", "var(--color-pink)"
    ];
    const otherColor = "var(--text-faint)";
    const slices = result.leaderboard.slice(0, maxSlices)
        .map(r => ({name: r.name, durationMs: r.durationMs}));
    const rest = result.leaderboard.slice(maxSlices);
    const restMs = rest.reduce((sum, r) => sum + r.durationMs, 0);
    if (restMs > 0)
        slices.push({name: "Other", durationMs: restMs});

    const body = details.createDiv({cls: "tempo-breakdown-body"});
    const chartWrap = body.createDiv({cls: "tempo-breakdown-chart"});

    const size = 120;
    const center = size / 2;
    const radius = 44;
    const thickness = 16;
    const circumference = 2 * Math.PI * radius;

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${size} ${size}`);
    svg.setAttribute("class", "tempo-breakdown-donut");

    const tip = chartWrap.createDiv({cls: "tempo-chart-tip"});
    const tipLabel = tip.createDiv({cls: "tempo-chart-tip-label"});
    const tipValue = tip.createDiv({cls: "tempo-chart-tip-value"});

    let acc = 0;
    slices.forEach((slice, i) => {
        const frac = slice.durationMs / result.totalMs;
        const color = i < maxSlices ? palette[i % palette.length]! : otherColor;

        const circle = document.createElementNS(svgNS, "circle");
        circle.setAttribute("cx", String(center));
        circle.setAttribute("cy", String(center));
        circle.setAttribute("r", String(radius));
        circle.setAttribute("fill", "none");
        circle.setAttribute("stroke", color);
        circle.setAttribute("stroke-width", String(thickness));
        circle.setAttribute("stroke-dasharray", `${frac * circumference} ${circumference}`);
        circle.setAttribute("stroke-dashoffset", String(-acc * circumference));
        circle.setAttribute("transform", `rotate(-90 ${center} ${center})`);
        circle.setAttribute("class", "tempo-breakdown-slice");
        circle.setAttribute("aria-label", `${slice.name}: ${formatPct(slice.durationMs, result.totalMs)} · ${formatDuration(slice.durationMs, settings)}`);

        circle.addEventListener("mouseenter", () => {
            circle.addClass("is-hl");
            tipLabel.setText(slice.name);
            tipValue.setText(`${formatPct(slice.durationMs, result.totalMs)} · ${formatDuration(slice.durationMs, settings)}`);
            const svgBox = svg.getBoundingClientRect();
            const wrapBox = chartWrap.getBoundingClientRect();
            const scale = svgBox.width / size;
            const mid = (acc + frac / 2) * 2 * Math.PI - Math.PI / 2;
            const x = svgBox.left - wrapBox.left + (center + radius * Math.cos(mid)) * scale;
            const y = svgBox.top - wrapBox.top + (center + radius * Math.sin(mid)) * scale;
            tip.style.left = `${x}px`;
            tip.style.top = `${y}px`;
            tip.addClass("is-visible");
        });
        circle.addEventListener("mouseleave", () => {
            circle.removeClass("is-hl");
            tip.removeClass("is-visible");
        });
        svg.appendChild(circle);
        acc += frac;
    });

    const totalValue = document.createElementNS(svgNS, "text");
    totalValue.setAttribute("x", String(center));
    totalValue.setAttribute("y", String(center + 1));
    totalValue.setAttribute("text-anchor", "middle");
    totalValue.setAttribute("class", "tempo-breakdown-total");
    totalValue.textContent = formatDuration(result.totalMs, settings);
    svg.appendChild(totalValue);

    chartWrap.appendChild(svg);

    const legend = body.createDiv({cls: "tempo-breakdown-legend"});
    slices.forEach((slice, i) => {
        const row = legend.createDiv({cls: "tempo-breakdown-row"});
        const dot = row.createSpan({cls: "tempo-breakdown-dot"});
        dot.style.background = i < maxSlices ? palette[i % palette.length]! : otherColor;
        row.createSpan({cls: "tempo-breakdown-name", text: slice.name});
        row.createSpan({
            cls: "tempo-breakdown-pct",
            text: `${formatPct(slice.durationMs, result.totalMs)} · ${formatDuration(slice.durationMs, settings)}`
        });

        // list which tasks were merged into the "Other" slice
        if (i === maxSlices && rest.length > 0) {
            const joined = rest.map(r => r.name).join(" - ");
            legend.createDiv({
                cls: "tempo-breakdown-subitem",
                text: joined,
                attr: {title: joined}
            });
        }
    });
}

function formatPct(ms: number, total: number): string {
    const pct = (ms / total) * 100;
    return pct >= 9.95 ? `${Math.round(pct)}%` : `${Math.round(pct * 10) / 10}%`;
}

function renderDayPanel(container: HTMLElement, view: StatsDayView, settings: TempoSettings): void {
    const sel = view.selected!;
    const panel = container.createDiv({cls: "tempo-stats-day-panel"});

    const head = panel.createDiv({cls: "tempo-stats-day-head"});
    const titles = head.createDiv({cls: "tempo-stats-day-titles"});
    titles.createDiv({cls: "tempo-stats-day-title", text: sel.label});
    titles.createDiv({cls: "tempo-stats-day-total", text: `${formatDuration(sel.durationMs, settings)} tracked`});

    const actions = head.createDiv({cls: "tempo-stats-day-actions"});
    const filterBtn = new ButtonComponent(actions)
        .setButtonText(view.filteredResult ? "Showing this day" : "Filter view to this day")
        .onClick(() => view.onToggleFilter());
    filterBtn.buttonEl.addClass("tempo-stats-range-pill");
    filterBtn.buttonEl.toggleClass("is-active", !!view.filteredResult);
    new ButtonComponent(actions)
        .setClass("clickable-icon")
        .setIcon("lucide-x")
        .setTooltip("Close")
        .onClick(() => view.onSelect(null));

    const list = panel.createDiv({cls: "tempo-stats-day-list"});
    if (sel.leaderboard.length === 0) {
        list.createDiv({cls: "tempo-empty", text: "No tasks recorded in this period."});
        return;
    }
    const max = Math.max(1, ...sel.leaderboard.map(r => r.durationMs));
    for (const row of sel.leaderboard)
        addLeaderboardRow(list, row, max, settings);
}

function renderBarChart(container: HTMLElement, buckets: StatsBucket[], settings: TempoSettings, component: MarkdownRenderChild, view: StatsDayView): void {
    const width = 640;
    const height = 160;
    const paddingBottom = 22;
    const paddingTop = 8;
    const chartHeight = height - paddingBottom - paddingTop;
    const slot = width / buckets.length;
    const barWidth = Math.max(3, slot - 4);
    const max = Math.max(1, ...buckets.map(b => b.durationMs));
    const labelEvery = Math.max(1, Math.ceil(buckets.length / 12));

    const svgNS = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("class", view.selected ? "tempo-stats-chart has-selection" : "tempo-stats-chart");
    svg.setAttribute("preserveAspectRatio", "none");

    // tooltip shown on hover or click/tap of a bar
    const tip = container.createDiv({cls: "tempo-chart-tip"});
    const tipLabel = tip.createDiv({cls: "tempo-chart-tip-label"});
    const tipValue = tip.createDiv({cls: "tempo-chart-tip-value"});
    let activeBar: SVGRectElement | null = null;

    const hideTip = (): void => {
        tip.removeClass("is-visible");
        activeBar?.removeClass("is-active");
        activeBar = null;
    };

    const showTip = (bar: SVGRectElement, bucket: StatsBucket): void => {
        activeBar?.removeClass("is-active");
        activeBar = bar;
        bar.addClass("is-active");
        tipLabel.setText(bucket.label);
        tipValue.setText(formatDuration(bucket.durationMs, settings));

        const wrapBox = container.getBoundingClientRect();
        const barBox = bar.getBoundingClientRect();
        const half = tip.offsetWidth / 2 + 4;
        let left = barBox.left - wrapBox.left + barBox.width / 2;
        left = Math.min(Math.max(left, half), Math.max(half, wrapBox.width - half));
        tip.style.left = `${left}px`;
        tip.style.top = `${barBox.top - wrapBox.top}px`;
        tip.addClass("is-visible");
    };

    buckets.forEach((bucket, i) => {
        const x = i * slot + 2;
        const barH = Math.max(1, (bucket.durationMs / max) * chartHeight);
        const rect = document.createElementNS(svgNS, "rect");
        rect.setAttribute("x", String(x));
        rect.setAttribute("y", String(paddingTop + (chartHeight - barH)));
        rect.setAttribute("width", String(barWidth));
        rect.setAttribute("height", String(barH));
        rect.setAttribute("rx", "3");
        rect.setAttribute("class", "tempo-stats-bar");
        rect.setAttribute("aria-label", `${bucket.label}: ${formatDuration(bucket.durationMs, settings)}`);
        rect.toggleClass("is-selected", view.selected?.start === bucket.start);

        rect.addEventListener("mouseenter", () => showTip(rect, bucket));
        rect.addEventListener("mouseleave", hideTip);
        rect.addEventListener("click", () => {
            hideTip();
            view.onSelect(bucket);
        });
        svg.appendChild(rect);

        if (i % labelEvery === 0) {
            const text = document.createElementNS(svgNS, "text");
            text.setAttribute("x", String(x + barWidth / 2));
            text.setAttribute("y", String(height - 4));
            text.setAttribute("text-anchor", "middle");
            text.setAttribute("class", "tempo-stats-chart-label");
            text.textContent = bucket.label;
            svg.appendChild(text);
        }
    });

    // tap/click anywhere outside the chart dismisses a pinned tooltip
    component.registerDomEvent(document, "click", (e: MouseEvent) => {
        if (!e.target || !svg.contains(e.target as Node))
            hideTip();
    });

    container.appendChild(svg);
}
