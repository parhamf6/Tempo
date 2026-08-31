import {App, PluginSettingTab, Setting, SettingGroup, type SettingDefinitionItem} from "obsidian";
import TempoPlugin from "./main";
import {defaultSettings, type TempoSettings} from "./settings";

type TempoSettingKey = keyof TempoSettings;

export class TempoSettingsTab extends PluginSettingTab {

    plugin: TempoPlugin;

    constructor(app: App, plugin: TempoPlugin) {
        super(app, plugin);
        this.plugin = plugin;
        this.icon = "timer";
    }

    getSettingDefinitions(): SettingDefinitionItem<TempoSettingKey>[] {
        return [
            {
                name: "Timestamp display format",
                desc: createFragment(f => {
                    f.createSpan({text: "The way that timestamps in time tracker tables should be displayed. Uses "});
                    f.createEl("a", {text: "moment.js", href: "https://momentjs.com/docs/#/parsing/string-format/"});
                    f.createSpan({text: " syntax."});
                }),
                control: {
                    key: "timestampFormat",
                    type: "text",
                    defaultValue: defaultSettings.timestampFormat
                }
            },
            {
                name: "CSV delimiter",
                desc: "The delimiter character that should be used when copying a tracker table as CSV. For example, some languages use a semicolon instead of a comma.",
                control: {
                    key: "csvDelimiter",
                    type: "text",
                    defaultValue: defaultSettings.csvDelimiter
                }
            },
            {
                name: "Default segment name",
                desc: createFragment(f => {
                    f.createSpan({text: "Name for new top-level segments when none is typed. Every run of # becomes the segment number, padded to the number of # characters: "});
                    f.createEl("code", {text: "Segment #"});
                    f.createSpan({text: ", "});
                    f.createEl("code", {text: "Part ###"});
                    f.createSpan({text: ", "});
                    f.createEl("code", {text: "## Part"});
                    f.createSpan({text: "."});
                }),
                control: {
                    key: "segmentNameTemplate",
                    type: "text",
                    defaultValue: defaultSettings.segmentNameTemplate
                }
            },
            {
                name: "Default sub-entry name",
                desc: createFragment(f => {
                    f.createSpan({text: "Name for new sub-entries created with Continue when none is typed. Same # syntax: "});
                    f.createEl("code", {text: "Part #"});
                    f.createSpan({text: ", "});
                    f.createEl("code", {text: "Part ###"});
                    f.createSpan({text: "."});
                }),
                control: {
                    key: "subEntryNameTemplate",
                    type: "text",
                    defaultValue: defaultSettings.subEntryNameTemplate
                }
            },
            {
                name: "Fine-grained durations",
                desc: "Whether durations should include days, months and years. If this is disabled, additional time units will be displayed as part of the hours.",
                control: {
                    key: "fineGrainedDurations",
                    type: "toggle",
                    defaultValue: defaultSettings.fineGrainedDurations
                }
            },
            {
                name: "Timestamp durations",
                desc: "Whether durations should be displayed in a timestamp format (12:15:01) rather than the default duration format (12h 15m 1s).",
                control: {
                    key: "timestampDurations",
                    type: "toggle",
                    defaultValue: defaultSettings.timestampDurations
                }
            },
            {
                name: "Display segments in reverse order",
                desc: "Whether older tracker segments should be displayed towards the bottom of the tracker, rather than the top.",
                control: {
                    key: "reverseSegmentOrder",
                    type: "toggle",
                    defaultValue: defaultSettings.reverseSegmentOrder
                }
            },
            {
                name: "Show total today",
                desc: "Whether the total time spent today should be displayed in the tracker table.",
                control: {
                    key: "showToday",
                    type: "toggle",
                    defaultValue: defaultSettings.showToday
                }
            },
            {
                name: "Use monospaced font for times",
                desc: "Whether your configured monospaced font should be used for the times in the title, causing them to jump around less while counting up.",
                control: {
                    key: "useMonospacedFont",
                    type: "toggle",
                    defaultValue: defaultSettings.useMonospacedFont
                }
            },
            {
                name: "Pretty-print tracker data",
                desc: "Whether tracker code block content should be pretty-printed, which increases note file size but makes merging sync changes easier.",
                control: {
                    key: "prettyPrintJson",
                    type: "toggle",
                    defaultValue: defaultSettings.prettyPrintJson
                }
            },
            {
                name: "Support the plugin",
                desc: "Report issues or contribute on GitHub.",
                render: (setting: Setting, _group: SettingGroup) => {
                    setting.infoEl.empty();
                    setting.controlEl.empty();
                    setting.infoEl.createEl("p", {text: "Found a bug or have an idea? Open an issue on GitHub:"});
                    setting.infoEl.createEl("a", {
                        text: "Open the repository",
                        href: "https://github.com/parhamf6/Tempo/issues"
                    });
                }
            }
        ];
    }

    getControlValue(key: TempoSettingKey): unknown {
        return this.plugin.settings[key];
    }

    async setControlValue(key: TempoSettingKey, value: unknown): Promise<void> {
        const settings = this.plugin.settings as Record<TempoSettingKey, unknown>;
        // Mirror the previous behavior: empty text-like values fall back to the default.
        if ((key === "timestampFormat" || key === "csvDelimiter" || key === "segmentNameTemplate" || key === "subEntryNameTemplate") && typeof value === "string" && value.length === 0) {
            settings[key] = defaultSettings[key];
        } else {
            settings[key] = value;
        }
        await this.plugin.saveSettings();
    }
}
