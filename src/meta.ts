// Segment metadata model: tags, category, color override and note live on
// every Entry (top-level segments and sub-entries alike). This module owns
// the definitions of those fields, the color palette, and the inheritance
// rules used to resolve what an entry "effectively" has. The tracker, stats
// and export layers all resolve metadata through here so they can never
// disagree about what an entry shows.

// The 8 Obsidian theme color tokens every other color in the app derives
// from. Entries and categories store the bare custom-property name
// (e.g. "--color-purple"); resolution wraps it in var(...) at render time so
// light/dark themes keep working.
export const COLOR_TOKENS = [
    "--color-red",
    "--color-orange",
    "--color-yellow",
    "--color-green",
    "--color-cyan",
    "--color-blue",
    "--color-purple",
    "--color-pink"
] as const;

export type ColorToken = typeof COLOR_TOKENS[number];

export interface ColorOption {
    token: ColorToken;
    label: string;
}

export const COLOR_OPTIONS: ColorOption[] = [
    {token: "--color-red", label: "Red"},
    {token: "--color-orange", label: "Orange"},
    {token: "--color-yellow", label: "Yellow"},
    {token: "--color-green", label: "Green"},
    {token: "--color-cyan", label: "Cyan"},
    {token: "--color-blue", label: "Blue"},
    {token: "--color-purple", label: "Purple"},
    {token: "--color-pink", label: "Pink"}
];

// A user-defined single-select classification. Entries reference categories by
// plain name, so renaming/deleting a category never orphans stored data — it
// only loses its color until reassigned. Defined globally in plugin settings.
export interface Category {
    name: string;
    color?: string;
}

// A category that exists in settings, so its color is known.
export interface ResolvedCategory extends Category {
    color: string;
}

// The subset of an Entry's fields that metadata logic reads. Tracking the
// full Entry interface here would create an import cycle with tracker.ts, and
// Entry structurally satisfies this shape anyway.
export interface MetaNode {
    name: string;
    tags?: string[];
    // undefined = unset (inherits an ancestor's category),
    // string = this segment's own category, null = explicitly NO category
    // (blocks inheritance — the user removed the group from this segment)
    category?: string | null;
    color?: string;
    note?: string;
    subEntries?: MetaNode[];
}

export function colorVar(token: string | undefined): string | undefined {
    return token ? `var(${token})` : undefined;
}

export function isColorToken(value: string): value is ColorToken {
    return (COLOR_TOKENS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

// Parses an unknown stored value into a clean list of tags. Hand-edited JSON
// may hold "#work"-style spellings, stray whitespace or duplicates; tags are
// always stored without the "#" prefix, trimmed, non-empty and unique
// (case-insensitively, first spelling wins).
export function normalizeTags(raw: unknown): string[] | undefined {
    if (!Array.isArray(raw))
        return undefined;
    const out: string[] = [];
    const seen = new Set<string>();
    for (const item of raw) {
        if (typeof item !== "string")
            continue;
        const tag = item.trim().replace(/^#+/, "");
        if (!tag)
            continue;
        const key = tag.toLocaleLowerCase();
        if (!seen.has(key)) {
            seen.add(key);
            out.push(tag);
        }
    }
    return out.length > 0 ? out : undefined;
}

// Coerces a stored field back to `string | undefined` so hand-edited nulls
// never leak into rendering or comparisons.
function normalizeOptionalString(raw: unknown): string | undefined {
    if (typeof raw !== "string")
        return undefined;
    const value = raw.trim();
    return value || undefined;
}

// Applies the above to every entry in a tree. Called from updateLegacyInfo so
// freshly-loaded trackers always carry well-formed metadata fields.
export function normalizeEntryMeta(entry: MetaNode): void {
    if (entry.tags != null)
        entry.tags = normalizeTags(entry.tags);
    // only string categories are normalized; null (explicit no-category) and
    // undefined (inherit) pass through untouched
    if (typeof entry.category === "string")
        entry.category = normalizeOptionalString(entry.category);
    if (entry.color != null)
        entry.color = isColorToken(entry.color) ? entry.color : undefined;
    if (entry.note != null)
        entry.note = normalizeOptionalString(entry.note);
    for (const sub of entry.subEntries ?? [])
        normalizeEntryMeta(sub);
}

// ---------------------------------------------------------------------------
// Inheritance
// ---------------------------------------------------------------------------

// Resolves the single-select category an entry displays/aggregates under.
// Own value wins; otherwise the nearest ancestor that has one provides it.
// An explicit `category: null` (the user removed the group) stops the search
// immediately — that segment is genuinely uncategorized and does NOT fall back
// to an ancestor.
export function resolveCategory(node: MetaNode, ancestors: MetaNode[] = []): { value: string, source: MetaNode } | undefined {
    for (const candidate of [node, ...ancestors]) {
        if (candidate.category === null)
            return undefined;
        const category = typeof candidate.category === "string" ? candidate.category.trim() : "";
        if (category)
            return {value: category, source: candidate};
    }
    return undefined;
}

// Resolves the color override an entry displays. Own override wins, else the
// nearest ancestor's; only when no override exists anywhere on the chain does
// the effective category's color (from settings) apply. Returns a bare color
// token or undefined.
export function resolveColorOverride(node: MetaNode, ancestors: MetaNode[] = []): { token: string, source: MetaNode } | undefined {
    for (const candidate of [node, ...ancestors]) {
        const color = candidate.color;
        if (color && isColorToken(color))
            return {token: color, source: candidate};
    }
    return undefined;
}

export function resolveCategoryColor(category: string, categories: Category[]): string | undefined {
    const def = categories.find(c => c.name === category);
    return def?.color && isColorToken(def.color) ? def.color : undefined;
}

// The final color shown for an entry: its own/nearest override, falling back
// to the color of the resolved category. Returns a bare token or undefined.
export function effectiveColorToken(node: MetaNode, ancestors: MetaNode[], categories: Category[]): string | undefined {
    const override = resolveColorOverride(node, ancestors);
    if (override)
        return override.token;
    const category = resolveCategory(node, ancestors);
    if (category)
        return resolveCategoryColor(category.value, categories);
    return undefined;
}

// The tags that apply to an entry: its own followed by every ancestor's, with
// the usual case-insensitive dedupe (first spelling wins). Each tag records
// which entry it came from so the UI can explain "inherited from X".
export interface OwnedTag {
    tag: string;
    source: MetaNode;
}

export function resolveTags(node: MetaNode, ancestors: MetaNode[] = []): OwnedTag[] {
    const out: OwnedTag[] = [];
    const seen = new Set<string>();
    const add = (candidate: MetaNode): void => {
        for (const raw of candidate.tags ?? []) {
            const tag = raw.trim().replace(/^#+/, "");
            if (!tag)
                continue;
            const key = tag.toLocaleLowerCase();
            if (!seen.has(key)) {
                seen.add(key);
                out.push({tag, source: candidate});
            }
        }
    };
    // own tags first (nearest reads most specific), then ancestors root-ward
    add(node);
    for (let i = 0; i < ancestors.length; i++)
        add(ancestors[i]!);
    return out;
}

// Notes never inherit: they describe the single entry they sit on.
export function resolveNote(node: MetaNode): string | undefined {
    return node.note?.trim() || undefined;
}

// All distinct tags anywhere in a tree, for tag autocomplete. First spelling
// wins, case-insensitively.
export function collectTreeTags(entries: MetaNode[]): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const walk = (node: MetaNode): void => {
        for (const raw of node.tags ?? []) {
            const tag = raw.trim().replace(/^#+/, "");
            const key = tag.toLocaleLowerCase();
            if (tag && !seen.has(key)) {
                seen.add(key);
                out.push(tag);
            }
        }
        for (const sub of node.subEntries ?? [])
            walk(sub);
    };
    for (const entry of entries)
        walk(entry);
    return out;
}

// Looks a category definition up in settings.
export function findCategory(categories: Category[], name: string): Category | undefined {
    return categories.find(c => c.name === name);
}
