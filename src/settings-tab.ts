import {App, ButtonComponent, PluginSettingTab, Setting, SettingGroup, type SettingDefinitionItem} from "obsidian";
import TempoPlugin from "./main";
import {defaultSettings, type TempoSettings} from "./settings";
import {renderSources} from "./stats/render";
import {Category, colorVar} from "./meta";
import {createColorPicker, showColorPopover} from "./color-picker";

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
                name: "Suggested segment names",
                desc: "One name per line. These are offered as suggestions in the segment name box when it is focused, filtered as you type.",
                control: {
                    key: "suggestedSegmentNames",
                    type: "textarea",
                    rows: 5,
                    placeholder: "Meeting\nCoding\nDeep work\nReview\nLunch"
                }
            },
            {
                name: "Categories",
                desc: "Single-select classifications with an optional color. Segments and stats can group by these. Entries reference a category by name, so deleting one never destroys data.",
                render: (setting: Setting) => {
                    setting.controlEl.empty();
                    const host = setting.controlEl.createDiv({cls: "tempo-category-manager"});
                    renderCategoryManager(host, this.plugin);
                }
            },
            {
                name: "Suggested tags",
                desc: "One tag per line (no #). Offered in tag autocomplete alongside tags already used in a tracker.",
                control: {
                    key: "suggestedTags",
                    type: "textarea",
                    rows: 4,
                    placeholder: "deep-work\nmeeting\nbilling"
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
                name: "Show running timers in the status bar",
                desc: "Displays every currently running timer in Obsidian's bottom status bar, where you can open the note or stop the timer.",
                control: {
                    key: "statusBarEnabled",
                    type: "toggle",
                    defaultValue: defaultSettings.statusBarEnabled
                }
            },
            {
                name: "Status bar scope",
                desc: "Which notes to watch for running timers. Leave empty to watch the whole vault, or add specific folders and files, like the stats block.",
                render: (setting: Setting) => {
                    setting.controlEl.empty();
                    const host = setting.controlEl.createDiv({cls: "tempo-status-sources"});
                    renderSources(host, {sources: this.plugin.settings.statusBarSources, range: {type: "today"}}, async () => {
                        await this.plugin.saveSettings();
                        this.plugin.onSettingsChanged();
                    });
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
        this.plugin.onSettingsChanged();
    }
}

// Global category manager rendered inside the Settings → Tempo tab. Categories
// are {name, color?}; entries reference them by plain name, so renaming or
// deleting here only ever changes how existing segments are styled/grouped —
// stored segment data is left untouched.
function renderCategoryManager(host: HTMLElement, plugin: TempoPlugin): void {
    const list = host.createDiv({cls: "tempo-category-list"});
    const empty = host.createDiv({cls: "tempo-category-empty", text: "No categories yet — add one below."});
    const addRow = host.createDiv({cls: "tempo-category-add-row"});
    const formHost = host.createDiv({cls: "tempo-category-form-host"});

    const persist = async (categories: Category[]): Promise<void> => {
        plugin.settings.categories = categories;
        await plugin.saveSettings();
        plugin.onSettingsChanged();
    };

    const dotColor = (category: Category): string | undefined => colorVar(category.color);

    const renderList = (): void => {
        list.empty();
        const categories = plugin.settings.categories;
        empty.toggle(categories.length === 0);
        for (const category of categories) {
            const row = list.createDiv({cls: "tempo-category-row"});
            const dot = row.createSpan({cls: "tempo-category-dot"});
            const color = dotColor(category);
            if (color)
                dot.style.background = color;
            row.createSpan({cls: "tempo-category-name", text: category.name});

            new ButtonComponent(row)
                .setClass("clickable-icon")
                .setClass("tempo-action-edit")
                .setTooltip("Color")
                .setIcon("palette")
                .onClick((evt: MouseEvent) => {
                    showColorPopover(evt, category.color, token => {
                        void persist(categories.map(c => c === category ? {...c, color: token} : c));
                    });
                });
            new ButtonComponent(row)
                .setClass("clickable-icon")
                .setClass("tempo-action-edit")
                .setTooltip("Rename")
                .setIcon("lucide-pencil")
                .onClick(() => beginRename(row, category, categories, renderList, persist));
            new ButtonComponent(row)
                .setClass("clickable-icon")
                .setClass("tempo-action-delete")
                .setTooltip("Delete")
                .setIcon("lucide-trash")
                .onClick(async () => {
                    await persist(categories.filter(c => c !== category));
                });
        }
    };

    const beginRename = (
        row: HTMLElement,
        category: Category,
        categories: Category[],
        rerender: () => void,
        persist: (next: Category[]) => Promise<void>
    ): void => {
        const nameEl = row.querySelector<HTMLElement>(".tempo-category-name");
        const label = nameEl?.textContent ?? category.name;
        if (nameEl)
            nameEl.hide();
        const input = row.createEl("input", {cls: "tempo-input tempo-category-name-input", attr: {type: "text"}});
        input.value = label;
        input.focus();
        input.select();
        const commit = async (): Promise<void> => {
            const value = input.value.trim();
            if (value && value !== category.name)
                await persist(categories.map(c => c === category ? {...c, name: value} : c));
            rerender();
        };
        input.addEventListener("keydown", (e: KeyboardEvent) => {
            if (e.key === "Enter") {
                e.preventDefault();
                void commit();
            } else if (e.key === "Escape") {
                rerender();
            }
        });
        input.addEventListener("blur", () => void commit());
    };

    const openForm = (): void => {
        formHost.empty();
        addRow.hide();

        const form = formHost.createDiv({cls: "tempo-stats-form"});
        const nameInput = form.createEl("input", {
            cls: "tempo-input",
            attr: {type: "text", placeholder: "Category name"}
        });
        const colors = form.createDiv({cls: "tempo-details-colors tempo-details-row"});
        let pickedColor: string | undefined;
        createColorPicker(colors, undefined, token => {
            pickedColor = token;
        });

        const buttons = form.createDiv({cls: "tempo-stats-form-buttons"});
        new ButtonComponent(buttons).setButtonText("Cancel").onClick(() => {
            formHost.empty();
            addRow.show();
        });
        new ButtonComponent(buttons).setButtonText("Add").setCta().onClick(async () => {
            const name = nameInput.value.trim();
            if (!name)
                return;
            await persist([...plugin.settings.categories, {name, color: pickedColor}]);
            formHost.empty();
            addRow.show();
            renderList();
        });
        nameInput.focus();
    };

    new ButtonComponent(addRow)
        .setButtonText("Add category")
        .onClick(() => openForm());

    renderList();
}
