import {formatDuration} from "../tracker";
import {TempoSettings} from "../settings";
import {StatsResult} from "./types";

function csvCell(content: string, delimiter: string): string {
    return `"${content.replace(/"/g, '""')}"`;
}

export function buildStatsCsv(result: StatsResult, settings: TempoSettings): string {
    let ret = ["Name", "Duration"].map(c => csvCell(c, settings.csvDelimiter)).join(settings.csvDelimiter) + "\n";
    for (const row of result.leaderboard) {
        ret += [row.name, formatDuration(row.durationMs, settings)]
            .map(c => csvCell(c, settings.csvDelimiter))
            .join(settings.csvDelimiter) + "\n";
    }
    return ret;
}
