import {Menu} from "obsidian";
import type {Entry, Tracker} from "./tracker";
import {TempoSettings} from "./settings";

// A serializable clipboard format offered by a tracker's Export button.
// tracker.ts registers "table" and "csv" (which need its internal helpers);
// this module provides the JSON/TOML/YAML builders and the menu UI.
export interface ExportFormat {
    id: string;
    label: string;
    icon: string;
    build: (tracker: Tracker, settings: TempoSettings) => string;
}

const formats = new Map<string, ExportFormat>();

export function registerExportFormat(format: ExportFormat): void {
    formats.set(format.id, format);
}

export function getExportFormats(): ExportFormat[] {
    return [...formats.values()];
}

// JSON/TOML/YAML carry the raw tracker data, so drop the UI-only `collapsed`
// flag before serializing: the metadata fields (tags/category/color/note) are
// data and round-trip back into a tracker unchanged.
function strippedEntry(entry: Entry): object {
    const ret: Record<string, unknown> = {name: entry.name};
    if (entry.startTime !== undefined)
        ret.startTime = entry.startTime;
    if (entry.endTime !== undefined)
        ret.endTime = entry.endTime;
    if (entry.tags !== undefined)
        ret.tags = entry.tags;
    if (entry.category !== undefined)
        ret.category = entry.category;
    if (entry.color !== undefined)
        ret.color = entry.color;
    if (entry.note !== undefined)
        ret.note = entry.note;
    if (entry.subEntries !== undefined)
        ret.subEntries = entry.subEntries.map(strippedEntry);
    return ret;
}

export function buildJson(tracker: Tracker, settings: TempoSettings): string {
    const data = {entries: tracker.entries.map(strippedEntry)};
    return JSON.stringify(data, null, settings.prettyPrintJson ? 2 : undefined);
}

function tomlString(value: string): string {
    let ret = '"';
    for (const ch of value) {
        const code = ch.charCodeAt(0);
        switch (ch) {
            case "\\": ret += "\\\\"; break;
            case '"': ret += '\\"'; break;
            case "\n": ret += "\\n"; break;
            case "\t": ret += "\\t"; break;
            case "\r": ret += "\\r"; break;
            case "\b": ret += "\\b"; break;
            case "\f": ret += "\\f"; break;
            default:
                if (code < 0x20 || code === 0x7f)
                    ret += "\\u" + code.toString(16).padStart(4, "0");
                else
                    ret += ch;
        }
    }
    return ret + '"';
}

// Recursively emits `[[entries.subEntries...]]` array-of-table headers plus the
// scalar keys of one entry. The dotted path appends each header to the table
// most recently opened at its parent depth, which is exactly the nesting.
function tomlEntryLines(entry: Entry, path: string): string[] {
    const lines = [`[[${path}]]`];
    lines.push(`name = ${tomlString(entry.name)}`);
    if (entry.startTime !== undefined)
        lines.push(`startTime = ${tomlString(entry.startTime)}`);
    if (entry.endTime !== undefined)
        lines.push(`endTime = ${tomlString(entry.endTime)}`);
    if (entry.tags !== undefined)
        lines.push(`tags = [${entry.tags.map(t => tomlString(t)).join(", ")}]`);
    if (entry.category !== undefined)
        lines.push(`category = ${tomlString(entry.category)}`);
    if (entry.color !== undefined)
        lines.push(`color = ${tomlString(entry.color)}`);
    if (entry.note !== undefined)
        lines.push(`note = ${tomlString(entry.note)}`);
    for (const sub of entry.subEntries ?? [])
        lines.push("", ...tomlEntryLines(sub, `${path}.subEntries`));
    return lines;
}

export function buildToml(tracker: Tracker): string {
    const sections = tracker.entries.map(entry => tomlEntryLines(entry, "entries").join("\n"));
    return sections.join("\n\n") + (sections.length > 0 ? "\n" : "");
}

const SAFE_YAML = /^[A-Za-z_][A-Za-z0-9_ ./+\-()]*$/;

function yamlString(value: string): string {
    if (value && SAFE_YAML.test(value) && !/\s$/.test(value))
        return value;
    return '"' + value
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\t/g, "\\t") + '"';
}

function yamlEntryLines(entries: Entry[], indent: string): string[] {
    const lines: string[] = [];
    for (const entry of entries) {
        lines.push(`${indent}- name: ${yamlString(entry.name)}`);
        if (entry.startTime !== undefined)
            lines.push(`${indent}  startTime: ${yamlString(entry.startTime)}`);
        if (entry.endTime !== undefined)
            lines.push(`${indent}  endTime: ${yamlString(entry.endTime)}`);
        if (entry.category !== undefined)
            lines.push(`${indent}  category: ${yamlString(entry.category)}`);
        if (entry.color !== undefined)
            lines.push(`${indent}  color: ${yamlString(entry.color)}`);
        if (entry.note !== undefined)
            lines.push(`${indent}  note: ${yamlString(entry.note)}`);
        if (entry.tags !== undefined && entry.tags.length > 0) {
            lines.push(`${indent}  tags:`);
            for (const tag of entry.tags)
                lines.push(`${indent}    - ${yamlString(tag)}`);
        }
        if (entry.subEntries !== undefined && entry.subEntries.length > 0) {
            lines.push(`${indent}  subEntries:`);
            lines.push(...yamlEntryLines(entry.subEntries, indent + "    "));
        }
    }
    return lines;
}

export function buildYaml(tracker: Tracker): string {
    const lines = ["entries:", ...yamlEntryLines(tracker.entries, "  ")];
    return lines.join("\n") + "\n";
}

// Opens the format picker under the click and copies the chosen serialization
// to the clipboard.
export function showExportMenu(evt: MouseEvent, tracker: Tracker, settings: TempoSettings): void {
    const menu = new Menu();
    for (const format of getExportFormats()) {
        menu.addItem(item => {
            item.setTitle(format.label);
            item.setIcon(format.icon);
            item.onClick(() => navigator.clipboard.writeText(format.build(tracker, settings)));
        });
    }
    menu.showAtMouseEvent(evt);
}
