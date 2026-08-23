import {moment} from "obsidian";
import {Entry} from "../tracker";
import {StatsBucket, StatsLeaderboardRow, StatsRange, StatsResult} from "./types";

type Moment = ReturnType<typeof moment>;

export function resolveRange(range: StatsRange): { start: Moment, end: Moment } {
    // how many days the window is parked in the past via the date navigator
    const shift = range.offset ?? 0;

    if (range.type === "today") {
        const day = moment().subtract(shift, "days");
        return {start: moment(day).startOf("day"), end: moment(day).endOf("day")};
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
        start: moment().subtract(days - 1 + shift, "days").startOf("day"),
        end: moment().subtract(shift, "days").endOf("day")
    };
}

// A leaf entry with its timestamps parsed to epoch ms once per computation, so
// aggregating across buckets is pure numeric clipping instead of constructing
// moment objects for every entry × bucket combination.
interface PreparedEntry {
    name: string;
    key: string;
    startMs: number;
    endMs: number; // "now" for entries that are still running
}

function prepareEntries(entries: Entry[]): PreparedEntry[] {
    const out: PreparedEntry[] = [];
    const walk = (list: Entry[]): void => {
        for (const entry of list) {
            if (entry.subEntries) {
                walk(entry.subEntries);
            } else if (entry.startTime) {
                out.push({
                    name: entry.name,
                    key: entry.name.trim().toLowerCase(),
                    startMs: moment(entry.startTime).valueOf(),
                    // snapshot "now" once per computation so every bucket sees
                    // a consistent picture of running entries
                    endMs: entry.endTime ? moment(entry.endTime).valueOf() : Date.now()
                });
            }
        }
    };
    walk(entries);
    return out;
}

function overlapMs(e: PreparedEntry, rangeStartMs: number, rangeEndMs: number): number {
    if (e.endMs <= rangeStartMs || e.startMs >= rangeEndMs)
        return 0;
    return Math.max(0, Math.min(e.endMs, rangeEndMs) - Math.max(e.startMs, rangeStartMs));
}

// One pass over the prepared entries: sums overlapping durations into `total`
// and per-task totals simultaneously (bucket totals and their leaderboards
// therefore always agree by construction).
type TotalMap = Map<string, StatsLeaderboardRow>;

function accumulate(totals: TotalMap, prepared: PreparedEntry[], startMs: number, endMs: number): number {
    let total = 0;
    for (const e of prepared) {
        const ms = overlapMs(e, startMs, endMs);
        if (ms <= 0)
            continue;
        total += ms;
        if (!e.key)
            continue;
        const existing = totals.get(e.key);
        if (existing)
            existing.durationMs += ms;
        else
            totals.set(e.key, {name: e.name.trim(), durationMs: ms});
    }
    return total;
}

function leaderboardFrom(totals: TotalMap): StatsLeaderboardRow[] {
    return Array.from(totals.values())
        .sort((a, b) => b.durationMs - a.durationMs);
}

function buildBuckets(prepared: PreparedEntry[], start: Moment, end: Moment): StatsBucket[] {
    const spanDays = end.diff(start, "days") + 1;
    const buckets: StatsBucket[] = [];

    const addBucket = (labelled: Moment, clippedStart: Moment, clippedEnd: Moment, label: string): void => {
        const totals: TotalMap = new Map();
        const total = accumulate(totals, prepared, clippedStart.valueOf(), clippedEnd.valueOf());
        buckets.push({
            label,
            start: labelled.valueOf(),
            end: clippedEnd.valueOf(),
            durationMs: total,
            leaderboard: leaderboardFrom(totals)
        });
    };

    if (spanDays <= 31) {
        let cursor = start.clone().startOf("day");
        while (cursor.isSameOrBefore(end)) {
            const dayEnd = cursor.clone().endOf("day");
            addBucket(cursor, cursor.clone(), dayEnd.isAfter(end) ? end : dayEnd, cursor.format("MMM D"));
            cursor.add(1, "day");
        }
    } else if (spanDays <= 180) {
        let cursor = start.clone().startOf("day");
        while (cursor.isSameOrBefore(end)) {
            const weekEnd = cursor.clone().add(6, "days").endOf("day");
            addBucket(cursor, cursor.clone(), weekEnd.isAfter(end) ? end : weekEnd, cursor.format("MMM D"));
            cursor.add(7, "days");
        }
    } else {
        let cursor = start.clone().startOf("month");
        while (cursor.isSameOrBefore(end)) {
            const monthEnd = cursor.clone().endOf("month");
            const monthStart = cursor.clone();
            addBucket(
                monthStart,
                monthStart.isBefore(start) ? start.clone() : monthStart,
                monthEnd.isAfter(end) ? end.clone() : monthEnd,
                monthStart.format("MMM YYYY"));
            cursor.add(1, "month");
        }
    }

    return buckets;
}

export function computeStats(entries: Entry[], range: StatsRange, fileCount: number): StatsResult {
    const {start, end} = resolveRange(range);
    const prepared = prepareEntries(entries);

    const totals: TotalMap = new Map();
    const totalMs = accumulate(totals, prepared, start.valueOf(), end.valueOf());

    return {
        totalMs,
        fileCount,
        buckets: buildBuckets(prepared, start, end),
        leaderboard: leaderboardFrom(totals)
    };
}

// Aggregates stats for an explicit period, used when the view is filtered
// down to a single chart bucket via the drill-down panel.
export function computeStatsForPeriod(entries: Entry[], startMs: number, endMs: number, fileCount: number): StatsResult {
    const prepared = prepareEntries(entries);

    const totals: TotalMap = new Map();
    const totalMs = accumulate(totals, prepared, startMs, endMs);

    return {
        totalMs,
        fileCount,
        buckets: [],
        leaderboard: leaderboardFrom(totals)
    };
}
