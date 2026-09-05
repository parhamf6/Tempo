import {App, Component, MarkdownSectionInformation, Menu, Platform, setIcon, TFile} from "obsidian";
import {Entry, formatDuration, getDuration, loadAllTrackers, saveTracker, Tracker} from "./tracker";
import {TempoSettings} from "./settings";
import {resolveSourceFiles} from "./stats/scan";
import {colorVar, effectiveColorToken} from "./meta";

// One currently running timer found somewhere in the scanned scope, with
// enough context to act on it: stop it in its note, or open the note.
interface RunningTimer {
    file: TFile;
    section: MarkdownSectionInformation;
    tracker: Tracker;
    entry: Entry;
    // ancestor path down to the running leaf (leaf excluded), for metadata
    ancestors: Entry[];
}

// Per-file cache of the running timers found in a note, keyed by mtime so a
// file is only re-read when it actually changed (mirrors stats/scan.ts).
interface TimersCacheItem {
    mtime: number;
    running: RunningTimer[];
}

const timerCache = new Map<string, TimersCacheItem>();

const SCAN_BATCH_SIZE = 8;

function collectRunningTimers(file: TFile, section: MarkdownSectionInformation, tracker: Tracker, out: RunningTimer[]): void {
    const walk = (entry: Entry, ancestors: Entry[]): void => {
        if (entry.subEntries) {
            for (const sub of entry.subEntries)
                walk(sub, [...ancestors, entry]);
        } else if (entry.startTime && !entry.endTime) {
            out.push({file, section, tracker, entry, ancestors});
        }
    };
    for (const entry of tracker.entries)
        walk(entry, []);
}

// Status-bar indicators for running timers across the notes the user chose
// to watch (whole vault when no sources are configured). Extends Component so
// the 1s duration ticker and vault-change listeners are cleaned up on unload.
export class RunningTimersStatusBar extends Component {
    private timers: RunningTimer[] = [];
    private durSpans: {entry: Entry, el: HTMLElement}[] = [];
    private needRescan = true;
    private scanning = false;

    constructor(
        private app: App,
        private el: HTMLElement,
        private getSettings: () => TempoSettings
    ) {
        super();
    }

    onload(): void {
        this.registerInterval(window.setInterval(() => this.tick(), 1000));
        this.registerEvent(this.app.vault.on("modify", (file) => {
            if (file instanceof TFile) {
                timerCache.delete(file.path);
                this.scheduleRescan();
            }
        }));
        this.registerEvent(this.app.vault.on("create", (file) => {
            if (file instanceof TFile) {
                timerCache.delete(file.path);
                this.scheduleRescan();
            }
        }));
        this.registerEvent(this.app.vault.on("delete", (file) => {
            timerCache.delete(file.path);
            this.scheduleRescan();
        }));
        this.registerEvent(this.app.vault.on("rename", (_file, oldPath) => {
            timerCache.delete(oldPath);
            this.scheduleRescan();
        }));
        this.tick();
    }

    // Called by the plugin whenever settings change (toggle, sources, ...).
    settingsChanged(): void {
        this.needRescan = true;
        if (this.enabled()) {
            this.kickScan();
        } else {
            this.timers = [];
            this.render();
        }
    }

    private enabled(): boolean {
        return this.getSettings().statusBarEnabled;
    }

    private scheduleRescan(): void {
        this.needRescan = true;
        this.kickScan();
    }

    private kickScan(): void {
        if (this.enabled() && this.needRescan && !this.scanning) {
            this.needRescan = false;
            void this.scan();
        }
    }

    private async scan(): Promise<void> {
        this.scanning = true;
        try {
            const settings = this.getSettings();
            const files = settings.statusBarSources.length === 0
                ? this.app.vault.getMarkdownFiles()
                : resolveSourceFiles(this.app, settings.statusBarSources);
            const found: RunningTimer[] = [];
            for (let i = 0; i < files.length; i += SCAN_BATCH_SIZE) {
                const batch = await Promise.all(files.slice(i, i + SCAN_BATCH_SIZE).map(f => this.getFileTimers(f)));
                for (const b of batch)
                    found.push(...b);
            }
            this.timers = found;
        } finally {
            this.scanning = false;
            this.render();
        }
    }

    private async getFileTimers(file: TFile): Promise<RunningTimer[]> {
        const cached = timerCache.get(file.path);
        if (cached && cached.mtime === file.stat.mtime)
            return cached.running;
        const trackers = await loadAllTrackers(this.app, file.path);
        const running: RunningTimer[] = [];
        for (const {section, tracker} of trackers)
            collectRunningTimers(file, section, tracker, running);
        timerCache.set(file.path, {mtime: file.stat.mtime, running});
        return running;
    }

    private tick(): void {
        this.kickScan();
        if (!this.enabled() || this.scanning || this.timers.length === 0)
            return;
        for (const {entry, el} of this.durSpans)
            el.setText(formatDuration(getDuration(entry), this.getSettings()));
    }

    private render(): void {
        this.el.empty();
        this.durSpans = [];
        if (!this.enabled() || this.timers.length === 0)
            return;
        if (Platform.isMobile)
            this.renderMobile();
        else
            for (const timer of this.timers)
                this.renderDesktopItem(timer);
    }

    private renderDesktopItem(timer: RunningTimer): void {
        const item = this.el.createDiv({cls: "tempo-status-item"});
        item.createDiv({cls: "tempo-status-tooltip", text: `${timer.entry.name} — ${timer.file.path}`});

        const icon = item.createSpan({cls: "tempo-status-icon"});
        setIcon(icon, "square");
        icon.addEventListener("click", (e: MouseEvent) => {
            e.stopPropagation();
            void this.stopTimer(timer);
        });

        const body = item.createDiv({cls: "tempo-status-body"});
        body.addEventListener("click", () => void this.openFile(timer));
        const settings = this.getSettings();
        const color = effectiveColorToken(timer.entry, timer.ancestors, settings.categories);
        if (color) {
            const dot = body.createSpan({cls: "tempo-status-dot"});
            dot.style.background = colorVar(color)!;
        }
        body.createSpan({cls: "tempo-status-name", text: timer.entry.name});

        const dur = body.createSpan({cls: "tempo-status-dur"});
        this.durSpans.push({entry: timer.entry, el: dur});
    }

    private renderMobile(): void {
        const item = this.el.createDiv({cls: "tempo-status-item tempo-status-mobile"});
        const icon = item.createSpan({cls: "tempo-status-icon"});
        setIcon(icon, "timer");
        item.createSpan({cls: "tempo-status-count", text: String(this.timers.length)});
        item.addEventListener("click", (e: MouseEvent) => this.showMobileMenu(e));
    }

    private showMobileMenu(evt: MouseEvent): void {
        const menu = new Menu();
        for (const timer of this.timers) {
            const dur = formatDuration(getDuration(timer.entry), this.getSettings());
            menu.addItem(item => {
                item.setTitle(`${timer.entry.name} — ${dur}`);
                item.setIcon("file-text");
                item.onClick(() => void this.openFile(timer));
            });
        }
        menu.addSeparator();
        for (const timer of this.timers) {
            menu.addItem(item => {
                item.setTitle(`Stop "${timer.entry.name}"`);
                item.setIcon("square");
                item.setWarning(true);
                item.onClick(() => void this.stopTimer(timer));
            });
        }
        menu.showAtMouseEvent(evt);
    }

    private async stopTimer(timer: RunningTimer): Promise<void> {
        timer.entry.endTime = new Date().toISOString();
        await saveTracker(this.app, timer.tracker, timer.file.path, timer.section, this.getSettings());
        timerCache.delete(timer.file.path);
        this.timers = this.timers.filter(t => t !== timer);
        this.render();
    }

    private async openFile(timer: RunningTimer): Promise<void> {
        const leaf = this.app.workspace.getLeaf(false);
        await leaf.openFile(timer.file);
    }
}
