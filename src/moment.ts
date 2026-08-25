// Typed facade over the moment instance re-exported by Obsidian.
//
// obsidian.d.ts derives its `moment` type from the separate `moment`
// package (`export const moment: typeof Moment`). When a lint/type
// environment fails to resolve that package, every raw `moment(...)` call
// degrades to `any` and each call site turns into an "unsafe assignment".
// This module gives the codebase a self-contained structural type so no
// call site depends on that resolution.

import {moment as obsidianMoment} from "obsidian";

type MomentUnit = "day" | "days" | "week" | "weeks" | "month" | "months" | "year" | "years";

export interface Moment {
    valueOf(): number;
    year(): number;
    clone(): Moment;
    toISOString(): string;
    format(template?: string): string;
    startOf(unit: MomentUnit): Moment;
    endOf(unit: MomentUnit): Moment;
    add(amount: number, unit?: MomentUnit): Moment;
    subtract(amount: number, unit?: MomentUnit): Moment;
    diff(other: Moment, unit?: MomentUnit): number;
    isBefore(other: Moment): boolean;
    isAfter(other: Moment, granularity?: string): boolean;
    isSameOrBefore(other: Moment, granularity?: string): boolean;
    isSameOrAfter(other: Moment, granularity?: string): boolean;
}

export interface Duration {
    hours(): number;
    minutes(): number;
    seconds(): number;
    days(): number;
    months(): number;
    asHours(): number;
    asDays(): number;
    asYears(): number;
}

export type MomentInput = string | number | Date | Moment;

interface RawMomentApi {
    (inp?: unknown, format?: string): unknown;
    unix(seconds: number): unknown;
    duration(ms: number): unknown;
}

const raw = obsidianMoment as unknown as RawMomentApi;

function wrap(value: unknown): Moment {
    return value as Moment;
}

export function moment(inp?: MomentInput, format?: string): Moment {
    return wrap(raw(inp, format));
}

moment.unix = (seconds: number): Moment => wrap(raw.unix(seconds));

moment.duration = (ms: number): Duration => raw.duration(ms) as Duration;
