import {App, MarkdownSectionInformation} from "obsidian";
import {TempoSettings} from "../settings";
import {saveSection} from "../tracker";
import {defaultStatsState, StatsState} from "./types";

export function loadStatsState(json: string): StatsState {
    if (json) {
        try {
            const parsed = JSON.parse(json) as Partial<StatsState>;
            return {
                sources: Array.isArray(parsed.sources) ? parsed.sources : [],
                range: parsed.range ?? defaultStatsState.range
            };
        } catch (e) {
            console.error(`Failed to parse stats state from ${json}: ${(e as Error).message}`);
        }
    }
    return {sources: [], range: {...defaultStatsState.range}};
}

export async function saveStatsState(app: App, state: StatsState, fileName: string, section: MarkdownSectionInformation | null, settings: TempoSettings): Promise<void> {
    await saveSection(app, fileName, section, JSON.stringify(state, null, settings.prettyPrintJson ? 2 : undefined));
}
