export const defaultSettings: TempoSettings = {
    timestampFormat: "YY-MM-DD HH:mm:ss",
    editableTimestampFormat: "YYYY-MM-DD HH:mm:ss",
    csvDelimiter: ",",
    segmentNameTemplate: "Segment #",
    subEntryNameTemplate: "Part #",
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
    fineGrainedDurations: boolean;
    reverseSegmentOrder: boolean;
    timestampDurations: boolean;
    showToday: boolean;
    useMonospacedFont: boolean;
    prettyPrintJson: boolean;
}
