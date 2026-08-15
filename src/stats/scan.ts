import {App, TFile} from "obsidian";
import {Entry, loadAllTrackers} from "../tracker";
import {StatsSource} from "./types";

interface CacheItem {
    mtime: number;
    entries: Entry[];
}

// Module-level cache shared by every stats block in the current session. Keyed by file path.
// A file is only ever re-read and re-parsed if its modification time has changed since we last
// looked at it, or if it isn't in the cache yet.
const fileCache = new Map<string, CacheItem>();

export function invalidateStatsCache(filePath?: string): void {
    if (filePath) {
        fileCache.delete(filePath);
    } else {
        fileCache.clear();
    }
}

function normalizeMdPath(path: string): string {
    let p = path.trim().replace(/^\/+/, "");
    if (!p.toLowerCase().endsWith(".md"))
        p += ".md";
    return p;
}

function normalizeFolderPath(path: string): string {
    let p = path.trim().replace(/^\/+/, "").replace(/\/+$/, "");
    if (p === "/" )
        p = "";
    return p;
}

function isInFolder(file: TFile, folderPath: string, recursive: boolean): boolean {
    if (!folderPath) {
        // vault root
        if (recursive)
            return true;
        return !file.path.includes("/");
    }
    const prefix = folderPath + "/";
    if (!file.path.startsWith(prefix))
        return false;
    if (recursive)
        return true;
    const rest = file.path.slice(prefix.length);
    return !rest.includes("/");
}

export function resolveSourceFiles(app: App, sources: StatsSource[]): TFile[] {
    const result = new Map<string, TFile>();

    for (const source of sources) {
        if (source.type === "file") {
            if (!source.path)
                continue;
            const path = normalizeMdPath(source.path);
            const file = app.vault.getAbstractFileByPath(path);
            if (file instanceof TFile)
                result.set(file.path, file);
            continue;
        }

        const folderPath = normalizeFolderPath(source.path ?? "");
        const recursive = source.recursive ?? true;
        let regex: RegExp | null = null;
        if (source.matchMode === "regex" && source.pattern) {
            try {
                regex = new RegExp(source.pattern, source.caseSensitive ? "" : "i");
            } catch {
                // invalid regex: treat as no matches for this source rather than throwing
                regex = null;
                continue;
            }
        }

        for (const file of app.vault.getMarkdownFiles()) {
            if (!isInFolder(file, folderPath, recursive))
                continue;
            if (regex && !regex.test(file.basename))
                continue;
            result.set(file.path, file);
        }
    }

    return Array.from(result.values());
}

async function getFileEntries(app: App, file: TFile): Promise<Entry[]> {
    const cached = fileCache.get(file.path);
    if (cached && cached.mtime === file.stat.mtime)
        return cached.entries;

    const trackers = await loadAllTrackers(app, file.path);
    const entries: Entry[] = [];
    for (const {tracker} of trackers)
        entries.push(...tracker.entries);

    fileCache.set(file.path, {mtime: file.stat.mtime, entries});
    return entries;
}

export interface ScannedData {
    entries: Entry[];
    fileCount: number;
}

export async function scanEntries(app: App, sources: StatsSource[]): Promise<ScannedData> {
    const files = resolveSourceFiles(app, sources);
    const entries: Entry[] = [];
    for (const file of files)
        entries.push(...await getFileEntries(app, file));
    return {entries, fileCount: files.length};
}
