// A single rule describing which files a stats block should pull `tempo`
// code blocks from.
export interface StatsSource {
    id: string;
    // "folder": scan a folder (optionally recursively), optionally filtered by a filename regex.
    // "file": a single, specific file.
    type: "folder" | "file";
    // For type "folder": vault-relative folder path, "" or "/" means the vault root.
    // For type "file": vault-relative file path (with or without the .md extension).
    path: string;
    // Only used when type === "folder".
    recursive?: boolean;
    matchMode?: "all" | "regex";
    // Regex tested against the file's basename (without extension), only when matchMode === "regex".
    pattern?: string;
    caseSensitive?: boolean;
}

export type StatsRangeType = "today" | "days" | "custom";

export interface StatsRange {
    type: StatsRangeType;
    // Only used when type === "days". Includes today, so 7 = last 7 days including today.
    days?: number;
    // Only used when type === "custom". ISO date strings (YYYY-MM-DD).
    start?: string;
    end?: string;
    // Days the window is shifted into the past via the date navigator.
    // Session-only: injected at render time, never persisted to the code block,
    // so the tab titles always keep their "ending today" meaning on reload.
    offset?: number;
}

export interface StatsState {
    sources: StatsSource[];
    range: StatsRange;
}

export const defaultStatsRange: StatsRange = { type: "days", days: 7 };

export const defaultStatsState: StatsState = {
    sources: [],
    range: defaultStatsRange
};

// One bucket in the daily/weekly/monthly bar chart.
export interface StatsBucket {
    label: string;
    // Start of the bucket, used for sorting and tooltips.
    start: number;
    // End of the bucket (inclusive), used when filtering the view down to this bucket.
    end: number;
    durationMs: number;
    // Per-task totals within this bucket, shown in the drill-down panel.
    leaderboard: StatsLeaderboardRow[];
}

// One row in the "by name" leaderboard.
export interface StatsLeaderboardRow {
    name: string;
    durationMs: number;
}

export interface StatsResult {
    totalMs: number;
    fileCount: number;
    buckets: StatsBucket[];
    leaderboard: StatsLeaderboardRow[];
}
