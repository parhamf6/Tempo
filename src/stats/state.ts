import {App, MarkdownSectionInformation, TFile} from "obsidian";
import {TempoSettings} from "../settings";
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

export async function saveStatsState(app: App, state: StatsState, fileName: string, section: MarkdownSectionInformation, settings: TempoSettings): Promise<void> {
    const file = app.vault.getAbstractFileByPath(fileName);
    if (!(file instanceof TFile))
        return;
    let content = await app.vault.read(file);

    const lines = content.split("\n");
    const prev = lines.filter((_, i) => i <= section.lineStart).join("\n");
    const next = lines.filter((_, i) => i >= section.lineEnd).join("\n");
    content = `${prev}\n${JSON.stringify(state, null, settings.prettyPrintJson ? 2 : undefined)}\n${next}`;

    await app.vault.modify(file, content);
}
