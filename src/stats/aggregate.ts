import {Entry} from "../tracker";
import {Moment, moment} from "../moment";
import {StatsBucket, StatsLeaderboardRow, StatsRange, StatsResult} from "./types";

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

// A top-level segment with its timestamps parsed to epoch ms once per
// computation, so aggregating across buckets is pure numeric clipping instead
// of constructing moment objects for every entry × bucket combination.
// Grouping happens at the TOP level on purpose: a segment with sub-entries
// reports its whole subtree under its own name — leaves like "Part 2" must
// never surface as separate leaderboard rows.
interface PreparedSegment {
    name: string;
    key: string;
    intervals: {startMs: number, endMs: number}[]; // flattened leaves; endMs = "now" while running
}

function prepareSegments(entries: Entry[]): PreparedSegment[] {
    const out: PreparedSegment[] = [];
    const now = Date.now();

    const collectIntervals = (entry: Entry, intervals: {startMs: number, endMs: number}[]): void => {
        if (entry.subEntries) {
            for (const sub of entry.subEntries)
                collectIntervals(sub, intervals);
            return;
        }
        if (!entry.startTime)
            return;
        intervals.push({
            startMs: moment(entry.startTime).valueOf(),
            // snapshot "now" once per computation so every bucket sees
            // a consistent picture of running entries
            endMs: entry.endTime ? moment(entry.endTime).valueOf() : now
        });
    };

    for (const entry of entries) {
        const intervals: {startMs: number, endMs: number}[] = [];
        collectIntervals(entry, intervals);
        if (intervals.length === 0)
            continue;
        out.push({
            name: entry.name,
            key: entry.name.trim().toLowerCase(),
            intervals
        });
    }
    return out;
}

function overlapMs(intervals: {startMs: number, endMs: number}[], rangeStartMs: number, rangeEndMs: number): number {
    let sum = 0;
    for (const iv of intervals) {
        if (iv.endMs <= rangeStartMs || iv.startMs >= rangeEndMs)
            continue;
        sum += Math.max(0, Math.min(iv.endMs, rangeEndMs) - Math.max(iv.startMs, rangeStartMs));
    }
    return sum;
}

// One pass over the prepared segments: sums overlapping durations into `total`
// and per-task totals simultaneously (bucket totals and their leaderboards
// therefore always agree by construction).
type TotalMap = Map<string, StatsLeaderboardRow>;

function accumulate(totals: TotalMap, prepared: PreparedSegment[], startMs: number, endMs: number): number {
    let total = 0;
    for (const seg of prepared) {
        const ms = overlapMs(seg.intervals, startMs, endMs);
        if (ms <= 0)
            continue;
        total += ms;
        if (!seg.key)
            continue;
        const existing = totals.get(seg.key);
        if (existing)
            existing.durationMs += ms;
        else
            totals.set(seg.key, {name: seg.name.trim(), durationMs: ms});
    }
    return total;
}

function leaderboardFrom(totals: TotalMap): StatsLeaderboardRow[] {
    return Array.from(totals.values())
        .sort((a, b) => b.durationMs - a.durationMs);
}

function buildBuckets(prepared: PreparedSegment[], start: Moment, end: Moment): StatsBucket[] {
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
    const prepared = prepareSegments(entries);

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
    const prepared = prepareSegments(entries);

    const totals: TotalMap = new Map();
    const totalMs = accumulate(totals, prepared, startMs, endMs);

    return {
        totalMs,
        fileCount,
        buckets: [],
        leaderboard: leaderboardFrom(totals)
    };
}
