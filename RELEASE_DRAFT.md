# Tempo 1.1.1

<!-- Replace this placeholder with the recorded video (drag and drop into the GitHub release form). -->
*Demo video placeholder*

Patch release with two fixes found shortly after 1.1.0.

## Fixed

- **Leaderboard no longer splits segments into sub-entry rows.** Stats leaderboards — and the donut and day-by-day breakdowns fed by them — listed every sub-segment (each "Part 2", "Part 3", …) as its own row, merging unrelated parts across different segments into one bogus entry while the real segment disappeared. Sub-segment time now rolls up under its top-level segment name, matching the pre-1.1.0 grouping.
- **Tracker expand/collapse is instant.** Toggling a segment previously waited for a note write and a full block re-render before its sub-entries appeared. Rows now show and hide immediately; the state is still persisted quietly in the background.

## Install

### BRAT

Install [BRAT](https://github.com/TfTHacker/obsidian42-brat), open the command palette and run "BRAT: Add a beta plugin for testing", then enter:

```
https://github.com/parhamf6/Tempo
```

### Manual

Download `main.js`, `manifest.json`, and `styles.css` from the latest release and place them in:

```
<vault>/.obsidian/plugins/tempo/
```

Then enable "Tempo" in Settings → Community plugins.

---

Tempo builds on [Ellpeck's Simple Time Tracker](https://github.com/Ellpeck/ObsidianSimpleTimeTracker) (MIT). Thanks, Ellpeck.
