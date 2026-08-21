import {moment} from "obsidian";
import {Entry} from "../tracker";
import {StatsBucket, StatsLeaderboardRow, StatsRange, StatsResult} from "./types";

type Moment = ReturnType<typeof moment>;

export function resolveRange(range: StatsRange): { start: Moment, end: Moment } {
    if (range.type === "today") {
        return {start: moment().startOf("day"), end: moment().endOf("day")};
    }
    if (range.type === "custom" && range.start && range.end) {
        let start = moment(range.start).startOf("day");
        let end = moment(range.end).endOf("day");
        if (end.isBefore(start)) {
            const tmp = start;
            start = end.clone().startOf("day");
            end = tmp.clone().endOf("day");
        }
        return {start, end};
    }
    // default / "days"
    const days = Math.max(1, range.days ?? 7);
    return {
        start: moment().subtract(days - 1, "days").startOf("day"),
        end: moment().endOf("day")
    };
}

// Duration of an entry (recursing into sub-entries) that overlaps with [rangeStart, rangeEnd].
// Entries that are still running (no endTime) are treated as running until "now".
export function durationInRange(entry: Entry, rangeStart: Moment, rangeEnd: Moment): number {
    if (entry.subEntries) {
        let sum = 0;
        for (const sub of entry.subEntries)
            sum += durationInRange(sub, rangeStart, rangeEnd);
        return sum;
    }
    if (!entry.startTime)
        return 0;

    let start = moment(entry.startTime);
    let end = entry.endTime ? moment(entry.endTime) : moment();

    if (end.isBefore(rangeStart) || start.isAfter(rangeEnd))
        return 0;
    if (start.isBefore(rangeStart))
        start = rangeStart;
    if (end.isAfter(rangeEnd))
        end = rangeEnd;

    return Math.max(0, end.diff(start));
}

function buildBuckets(entries: Entry[], start: Moment, end: Moment): StatsBucket[] {
    const spanDays = end.diff(start, "days") + 1;
    const buckets: StatsBucket[] = [];

    if (spanDays <= 31) {
        let cursor = start.clone().startOf("day");
        while (cursor.isSameOrBefore(end)) {
            const bucketStart = cursor.clone();
            const bucketEnd = cursor.clone().endOf("day");
            const clippedEnd = bucketEnd.isAfter(end) ? end : bucketEnd;
            let total = 0;
            for (const entry of entries)
                total += durationInRange(entry, bucketStart, clippedEnd);
            buckets.push({
                label: bucketStart.format("MMM D"),
                start: bucketStart.valueOf(),
                end: clippedEnd.valueOf(),
                durationMs: total,
                leaderboard: buildLeaderboard(entries, bucketStart, clippedEnd)
            });
            cursor.add(1, "day");
        }
    } else if (spanDays <= 180) {
        let cursor = start.clone().startOf("day");
        while (cursor.isSameOrBefore(end)) {
            const bucketStart = cursor.clone();
            const bucketEnd = cursor.clone().add(6, "days").endOf("day");
            const clippedEnd = bucketEnd.isAfter(end) ? end : bucketEnd;
            let total = 0;
            for (const entry of entries)
                total += durationInRange(entry, bucketStart, clippedEnd);
            buckets.push({
                label: bucketStart.format("MMM D"),
                start: bucketStart.valueOf(),
                end: clippedEnd.valueOf(),
                durationMs: total,
                leaderboard: buildLeaderboard(entries, bucketStart, clippedEnd)
            });
            cursor.add(7, "days");
        }
    } else {
        let cursor = start.clone().startOf("month");
        while (cursor.isSameOrBefore(end)) {
            const bucketStart = cursor.clone();
            const bucketEnd = cursor.clone().endOf("month");
            const clippedStart = bucketStart.isBefore(start) ? start : bucketStart;
            const clippedEnd = bucketEnd.isAfter(end) ? end : bucketEnd;
            let total = 0;
            for (const entry of entries)
                total += durationInRange(entry, clippedStart, clippedEnd);
            buckets.push({
                label: bucketStart.format("MMM YYYY"),
                start: bucketStart.valueOf(),
                end: clippedEnd.valueOf(),
                durationMs: total,
                leaderboard: buildLeaderboard(entries, clippedStart, clippedEnd)
            });
            cursor.add(1, "month");
        }
    }

    return buckets;
}

function buildLeaderboard(entries: Entry[], start: Moment, end: Moment): StatsLeaderboardRow[] {
    const totals = new Map<string, { name: string, durationMs: number }>();

    for (const entry of entries) {
        const key = entry.name.trim().toLowerCase();
        if (!key)
            continue;
        const ms = durationInRange(entry, start, end);
        if (ms <= 0)
            continue;
        const existing = totals.get(key);
        if (existing) {
            existing.durationMs += ms;
        } else {
            totals.set(key, {name: entry.name.trim(), durationMs: ms});
        }
    }

    return Array.from(totals.values())
        .sort((a, b) => b.durationMs - a.durationMs);
}

export function computeStats(entries: Entry[], range: StatsRange, fileCount: number): StatsResult {
    const {start, end} = resolveRange(range);

    let totalMs = 0;
    for (const entry of entries)
        totalMs += durationInRange(entry, start, end);

    return {
        totalMs,
        fileCount,
        buckets: buildBuckets(entries, start, end),
        leaderboard: buildLeaderboard(entries, start, end)
    };
}

// Aggregates stats for an explicit period, used when the view is filtered
// down to a single chart bucket via the drill-down panel.
export function computeStatsForPeriod(entries: Entry[], startMs: number, endMs: number, fileCount: number): StatsResult {
    const start = moment(startMs);
    const end = moment(endMs);

    let totalMs = 0;
    for (const entry of entries)
        totalMs += durationInRange(entry, start, end);

    return {
        totalMs,
        fileCount,
        buckets: [],
        leaderboard: buildLeaderboard(entries, start, end)
    };
}
