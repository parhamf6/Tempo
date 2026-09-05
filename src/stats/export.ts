import {formatDuration} from "../tracker";
import {TempoSettings} from "../settings";
import {StatsGroupBy, StatsResult} from "./types";

function csvCell(content: string): string {
    return `"${content.replace(/"/g, '""')}"`;
}

export function buildStatsCsv(result: StatsResult, settings: TempoSettings, groupBy: StatsGroupBy = "name"): string {
    const dimension = groupBy === "category" ? "Category" : groupBy === "tag" ? "Tag" : "Name";
    let ret = [dimension, "Duration"].map(csvCell).join(settings.csvDelimiter) + "\n";
    for (const row of result.leaderboard) {
        ret += [row.name, formatDuration(row.durationMs, settings)]
            .map(csvCell)
            .join(settings.csvDelimiter) + "\n";
    }
    return ret;
}
