import {MarkdownRenderChild, Plugin, TFile} from "obsidian";
import {defaultSettings, TempoSettings} from "./settings";
import {TempoSettingsTab} from "./settings-tab";
import {displayTracker, Entry, formatDuration, formatTimestamp, getDuration, getDurationToday, getRunningEntry, getTotalDuration, getTotalDurationToday, isRunning, loadAllTrackers, loadTracker, orderedEntries, getTotalDurationDate} from "./tracker";
import {displayStats} from "./stats/render";
import {loadStatsState} from "./stats/state";
import {defaultStatsState} from "./stats/types";

export default class TempoPlugin extends Plugin {

    // noinspection JSUnusedGlobalSymbols
    public api = {
        // verbatim versions of the functions found in tracker.ts with the same parameters
        loadTracker, getDuration, getTotalDuration, getDurationToday, getTotalDurationToday, getRunningEntry, isRunning, getTotalDurationDate,

        // modified versions of the functions found in tracker.ts, with the number of required arguments reduced
        loadAllTrackers: (fileName: string) => loadAllTrackers(this.app, fileName),
        formatTimestamp: (timestamp: string) => formatTimestamp(timestamp, this.settings),
        formatDuration: (totalTime: number) => formatDuration(totalTime, this.settings),
        orderedEntries: (entries: Entry[]) => orderedEntries(entries, this.settings)
    };
    public settings!: TempoSettings;

    async onload(): Promise<void> {
        await this.loadSettings();

        this.addSettingTab(new TempoSettingsTab(this.app, this));

        this.registerMarkdownCodeBlockProcessor("tempo", (s, e, i) => {
            e.empty();
            let component = new MarkdownRenderChild(e);
            let tracker = loadTracker(s);

            // Wrap file name in a function since it can change
            let filePath = i.sourcePath;
            const getFile = () => filePath;

            // Hook rename events to update the file path
            component.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
                if (file instanceof TFile && oldPath === filePath) {
                    filePath = file.path;
                }
            }));

            displayTracker(this.app, tracker, e, getFile, () => i.getSectionInfo(e), this.settings, component);
            i.addChild(component);
        });

        this.addCommand({
            id: `insert`,
            name: `Insert time tracker`,
            editorCallback: (e, _) => {
                e.replaceSelection("```tempo\n```\n");
            }
        });

        this.registerMarkdownCodeBlockProcessor("tempo-stats", (s, e, i) => {
            e.empty();
            let component = new MarkdownRenderChild(e);
            let state = loadStatsState(s);

            let filePath = i.sourcePath;
            const getFile = () => filePath;

            component.registerEvent(this.app.vault.on("rename", (file, oldPath) => {
                if (file instanceof TFile && oldPath === filePath) {
                    filePath = file.path;
                }
            }));

            displayStats(this.app, state, e, getFile, () => i.getSectionInfo(e), this.settings, component);
            i.addChild(component);
        });

        this.addCommand({
            id: `insert-stats`,
            name: `Insert time tracker stats`,
            editorCallback: (e, _) => {
                const initial = JSON.stringify(defaultStatsState, null, this.settings.prettyPrintJson ? 2 : undefined);
                e.replaceSelection(`\`\`\`tempo-stats\n${initial}\n\`\`\`\n`);
            }
        });
    }

    async loadSettings(): Promise<void> {
        this.settings = Object.assign({}, defaultSettings, await this.loadData() as Partial<TempoSettings>);
    }

    async saveSettings(): Promise<void> {
        await this.saveData(this.settings);
    }
}
