import {Entry} from "../tracker";
import {Moment, moment} from "../moment";
import {Category, COLOR_TOKENS} from "../meta";
import {StatsBucket, StatsGroupBy, StatsLeaderboardRow, StatsRange, StatsResult} from "./types";

// How stats aggregate entries, and which facets/filters apply. All optional:
// the defaults reproduce the classic "by top-level name" behavior exactly.
export interface StatsViewConfig {
    groupBy?: StatsGroupBy;
    // settings category definitions, for category colors in rows/charts
    categories?: Category[];
    // active chip filters; within a dimension chips are OR'd, across
    // dimensions AND'd. Empty/undefined = no restriction.
    filters?: {categories?: string[], tags?: string[]};
}

const NO_CATEGORY = "Uncategorized";
const NO_TAG = "Untagged";

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

// One flattened leaf interval with the metadata that applies to it resolved
// through inheritance (category = own ?? nearest ancestor; tags = union of the
// whole ancestor path). Each top-level segment contributes as many intervals
// as it has leaves, so a tag or category set on a single part is aggregated
// even though the classic name grouping only ever reports the top segment.
interface LeafInterval {
    startMs: number;
    endMs: number;
    tags: string[];
    category?: string;
}

// A top-level segment with its timestamps parsed to epoch ms once per
// computation, so aggregating across buckets is pure numeric clipping instead
// of constructing moment objects for every entry × bucket combination.
interface PreparedSegment {
    name: string;
    key: string;
    intervals: LeafInterval[]; // endMs = "now" while running
}

function dedupeTags(tags: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of tags) {
        const tag = raw.trim().replace(/^#+/, "");
        const key = tag.toLocaleLowerCase();
        if (tag && !seen.has(key)) {
            seen.add(key);
            out.push(tag);
        }
    }
    return out;
}

function prepareSegments(entries: Entry[]): PreparedSegment[] {
    const out: PreparedSegment[] = [];
    const now = Date.now();

    const unionTags = (entry: Entry, ancestors: Entry[]): string[] =>
        dedupeTags([...(entry.tags ?? []), ...ancestors.flatMap(a => a.tags ?? [])]);

    // mirrors meta.resolveCategory: an explicit `category: null` on a segment
    // means the user removed the group — it never falls back to an ancestor
    const effectiveCategory = (entry: Entry, ancestors: Entry[]): string | undefined => {
        for (const node of [entry, ...ancestors]) {
            if (node.category === null)
                return undefined;
            const category = typeof node.category === "string" ? node.category.trim() : "";
            if (category)
                return category;
        }
        return undefined;
    };

    const collectIntervals = (entry: Entry, ancestors: Entry[], intervals: LeafInterval[]): void => {
        if (entry.subEntries) {
            for (const sub of entry.subEntries)
                collectIntervals(sub, [...ancestors, entry], intervals);
            return;
        }
        if (!entry.startTime)
            return;
        intervals.push({
            startMs: moment(entry.startTime).valueOf(),
            // snapshot "now" once per computation so every bucket sees
            // a consistent picture of running entries
            endMs: entry.endTime ? moment(entry.endTime).valueOf() : now,
            tags: unionTags(entry, ancestors),
            category: effectiveCategory(entry, ancestors)
        });
    };

    for (const entry of entries) {
        const intervals: LeafInterval[] = [];
        collectIntervals(entry, [], intervals);
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

function overlapMs(iv: LeafInterval, rangeStartMs: number, rangeEndMs: number): number {
    if (iv.endMs <= rangeStartMs || iv.startMs >= rangeEndMs)
        return 0;
    return Math.max(0, Math.min(iv.endMs, rangeEndMs) - Math.max(iv.startMs, rangeStartMs));
}

type GroupKey = string;

interface GroupRow {
    name: string;
    durationMs: number;
}

type TotalMap = Map<GroupKey, GroupRow>;

// The canonical display name for a facet value: prefer the settings definition
// (stable casing/color lookup), else the value as encountered.
function canonicalName(value: string, categories: Category[]): string {
    const def = categories.find(c => c.name === value);
    return def ? def.name : value;
}

function facetKey(value: string): string {
    return value.toLocaleLowerCase();
}

// The (key, label) group rows one interval belongs to under the active
// grouping. Tag grouping fans an interval out to every tag (plus "Untagged"
// when it has none) so tag row totals overlap — a lens, not a partition.
// Category and name grouping produce exactly one row each, so those totals
// always reconcile with the grand total.
function groupKeysFor(seg: PreparedSegment, iv: LeafInterval, view: Required<StatsViewConfig>): {key: GroupKey, label: string}[] {
    const {groupBy, categories} = view;
    if (groupBy === "category") {
        const value = iv.category ?? NO_CATEGORY;
        return [{key: `cat:${facetKey(value)}`, label: canonicalName(value, categories)}];
    }
    if (groupBy === "tag") {
        const values = iv.tags.length > 0 ? iv.tags : [NO_TAG];
        return values.map(value => ({key: `tag:${facetKey(value)}`, label: value}));
    }
    // name: exactly the top-level segment's name (subtree reported once)
    return seg.key ? [{key: `name:${seg.key}`, label: seg.name.trim()}] : [];
}

function matchesFilters(iv: LeafInterval, filters: {categories?: string[], tags?: string[]}): boolean {
    const cats = filters.categories;
    if (cats && cats.length > 0) {
        if (!iv.category || !cats.some(c => facetKey(c) === facetKey(iv.category!)))
            return false;
    }
    const tags = filters.tags;
    if (tags && tags.length > 0) {
        const wanted = new Set(tags.map(t => facetKey(t)));
        if (!iv.tags.some(t => wanted.has(facetKey(t))))
            return false;
    }
    return true;
}

// One pass over the prepared segments: adds each overlapping interval's ms to
// `total` exactly once (filtered), fans it out to its group rows, and records
// the categories/tags present in the window (facets, gathered regardless of
// filters so chips always reflect the full range).
function accumulate(
    totals: TotalMap,
    prepared: PreparedSegment[],
    startMs: number,
    endMs: number,
    view: Required<StatsViewConfig>,
    facets?: {categories: Set<string>, tags: Set<string>}
): number {
    let total = 0;
    for (const seg of prepared) {
        for (const iv of seg.intervals) {
            const ms = overlapMs(iv, startMs, endMs);
            if (ms <= 0)
                continue;
            if (facets) {
                if (iv.category)
                    facets.categories.add(iv.category);
                for (const tag of iv.tags)
                    facets.tags.add(tag);
            }
            if (!matchesFilters(iv, view.filters))
                continue;
            total += ms;
            for (const {key, label} of groupKeysFor(seg, iv, view)) {
                let row = totals.get(key);
                if (!row) {
                    row = {name: label, durationMs: 0};
                    totals.set(key, row);
                }
                row.durationMs += ms;
            }
        }
    }
    return total;
}

function leaderboardFrom(totals: TotalMap, view: Required<StatsViewConfig>): StatsLeaderboardRow[] {
    const rows = Array.from(totals.values())
        .sort((a, b) => b.durationMs - a.durationMs);
    // color resolve: category rows take the category color; tag rows cycle the
    // palette by rank; name rows stay uncolored (the renderer already applies
    // its rank palette to the donut)
    return rows.map((row, i) => {
        let color: string | undefined;
        if (view.groupBy === "category")
            color = view.categories.find(c => c.name === row.name)?.color;
        else if (view.groupBy === "tag")
            color = COLOR_TOKENS[i % COLOR_TOKENS.length]!;
        return {name: row.name, durationMs: row.durationMs, color};
    });
}

function buildBuckets(prepared: PreparedSegment[], start: Moment, end: Moment, view: Required<StatsViewConfig>): StatsBucket[] {
    const spanDays = end.diff(start, "days") + 1;
    const buckets: StatsBucket[] = [];

    const addBucket = (labelled: Moment, clippedStart: Moment, clippedEnd: Moment, label: string): void => {
        const totals: TotalMap = new Map();
        const total = accumulate(totals, prepared, clippedStart.valueOf(), clippedEnd.valueOf(), view);
        buckets.push({
            label,
            start: labelled.valueOf(),
            end: clippedEnd.valueOf(),
            durationMs: total,
            leaderboard: leaderboardFrom(totals, view)
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

function viewConfigOf(config: StatsViewConfig | undefined): Required<StatsViewConfig> {
    return {
        groupBy: config?.groupBy ?? "name",
        categories: config?.categories ?? [],
        filters: config?.filters ?? {}
    };
}

export function computeStats(entries: Entry[], range: StatsRange, fileCount: number, config?: StatsViewConfig): StatsResult {
    const view = viewConfigOf(config);
    const {start, end} = resolveRange(range);
    const prepared = prepareSegments(entries);

    const totals: TotalMap = new Map();
    const facets = {categories: new Set<string>(), tags: new Set<string>()};
    const totalMs = accumulate(totals, prepared, start.valueOf(), end.valueOf(), view, facets);

    return {
        totalMs,
        fileCount,
        facets: {
            categories: Array.from(facets.categories).sort((a, b) => a.toLocaleLowerCase().localeCompare(b.toLocaleLowerCase())),
            tags: Array.from(facets.tags).sort((a, b) => a.toLocaleLowerCase().localeCompare(b.toLocaleLowerCase()))
        },
        buckets: buildBuckets(prepared, start, end, view),
        leaderboard: leaderboardFrom(totals, view)
    };
}

// Aggregates stats for an explicit period, used when the view is filtered
// down to a single chart bucket via the drill-down panel.
export function computeStatsForPeriod(entries: Entry[], startMs: number, endMs: number, fileCount: number, config?: StatsViewConfig): StatsResult {
    const view = viewConfigOf(config);
    const prepared = prepareSegments(entries);

    const totals: TotalMap = new Map();
    const totalMs = accumulate(totals, prepared, startMs, endMs, view);

    return {
        totalMs,
        fileCount,
        facets: {categories: [], tags: []},
        buckets: [],
        leaderboard: leaderboardFrom(totals, view)
    };
}
