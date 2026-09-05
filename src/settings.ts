import {StatsSource} from "./stats/types";
import {Category} from "./meta";

export const defaultSettings: TempoSettings = {
    timestampFormat: "YY-MM-DD HH:mm:ss",
    editableTimestampFormat: "YYYY-MM-DD HH:mm:ss",
    csvDelimiter: ",",
    segmentNameTemplate: "Segment #",
    subEntryNameTemplate: "Part #",
    suggestedSegmentNames: "",
    categories: [],
    suggestedTags: "",
    statusBarEnabled: false,
    statusBarSources: [],
    fineGrainedDurations: true,
    reverseSegmentOrder: false,
    timestampDurations: false,
    showToday: false,
    useMonospacedFont: false,
    prettyPrintJson: false
};

export interface TempoSettings {
    timestampFormat: string;
    editableTimestampFormat: string;
    csvDelimiter: string;
    // templates for auto-generated names; every run of # becomes the
    // counter, zero-padded to the run's length ("PART ###" → "PART 004")
    segmentNameTemplate: string;
    subEntryNameTemplate: string;
    suggestedSegmentNames: string;
    // single-select categories (name + optional color) offered across every
    // tracker; referenced by entries via their plain name
    categories: Category[];
    // one tag per line, offered in tag autocomplete alongside tags already
    // used in the current tracker
    suggestedTags: string;
    // status bar running-timer indicators; empty sources = whole vault
    statusBarEnabled: boolean;
    statusBarSources: StatsSource[];
    fineGrainedDurations: boolean;
    reverseSegmentOrder: boolean;
    timestampDurations: boolean;
    showToday: boolean;
    useMonospacedFont: boolean;
    prettyPrintJson: boolean;
}
