# Tempo

**A modern, minimal multi-purpose time tracker for your Obsidian notes.**

Tempo lets you track time directly inside your notes using a simple code
block. Press the **play** button when you begin a task and the **stop** button
when you finish — Tempo records the timestamps, saves them as plain JSON in your
note, and shows you a clean table with per-segment and total durations. Because
time is tracked purely by timestamps, a tracker keeps running even if you switch
notes, close Obsidian, or shut down your device.

This version also adds **Tempo Stats** — a companion code block that aggregates
the tracked time from the sources _you_ choose into a clear summary: total time,
number of tracked tasks, and number of files scanned.


https://github.com/user-attachments/assets/33966c3e-238d-4aa4-9967-61d2681e93fa


---

## ✨ Features

- **In-note time tracking** — a `tempo` code block turns any note into a live
  timer with named segments.
- **Icon-based controls** — start a segment with the **play** button (▶); while
  it's running the button becomes a **stop** button (⏹). No text buttons to
  hunt for.
- **Timestamp-based** — segments are stored as start/end timestamps, so a
  running timer survives note switches, app restarts, and reboots.
- **Multiple segments** — track as many named segments as you like; play,
  continue, rename, and delete them inline.
- **Rich segment metadata** — give any segment or child segment a **category**
  (single-select, from a global list you manage), any number of **tags**, a
  **color**, and a **note**. Colors follow your theme; children inherit their
  parent's category/color (and union its tags) unless they set their own —
  choosing **No category** on a segment always clears it for good, even when
  its parent is categorized.
- **Details editor & quick actions** — click a row's tags icon (or right-click
  the row) to edit a segment's metadata in a dialog; set category/color from a
  right-click menu without opening it.
- **Copy as CSV** — export the table to your clipboard for spreadsheets.
- **Totals & today** — see the total tracked time and (optionally) the time
  tracked today.
- **Tempo Stats** (`tempo-stats`) — aggregate the time tracked across the
  sources you pick:
  - You add **sources** yourself — a **folder** (optionally recursive, optionally
    filtered by a filename regex) or a **single file**. Tempo only scans what
    you tell it to; it does _not_ scan your whole vault automatically.
  - **Time range** — **Today**, **7 days**, **30 days**, or a **custom range**
    picked with a calendar date picker.
  - **Group by** — break the numbers down **by name**, **by category**, or **by
    tag** (persisted per stats block); **filter chips** narrow the view to the
    categories/tags you pick (session-only, so a reload always shows the full
    range).
  - The panel shows, for the selected period: the **total time** tracked, the
    **number of tasks (segments)** tracked, and the **number of files** scanned.
    It also draws a daily **bar chart** and a per-task **leaderboard** as a
    visual breakdown. Refresh on demand or automatically as your vault changes.
- **Configurable formatting** — moment.js timestamp format, CSV delimiter,
  fine-grained vs. compact durations, timestamp-style durations, segment order,
  and more (see [Settings](#%EF%b8%8f-settings)).
- **Public JavaScript API** — query and aggregate your trackers from
  [DataviewJS](https://blacksmithgu.github.io/obsidian-dataview/api/intro/)
  (see [JavaScript API](#-javascript-api)).

---

## 📦 Installation

### Option A — From the Obsidian Community Plugins store (recommended, once published)

1. Open **Settings → Community plugins**.
2. Make sure **Restricted mode** is **off**.
3. Click **Browse**, search for **Tempo**, and click **Install**.
4. Toggle **Tempo** on in your community plugins list.

### Option B — Manual install (build from source)

Requirements: [Node.js](https://nodejs.org/) 18+ and npm.

```bash
# 1. Clone this repository
git clone <your-repo-url> Tempo
cd Tempo

# 2. Install dependencies
npm install

# 3. Build the plugin (produces main.js, manifest.json, styles.css at the root)
npm run build
```

Then copy the three built files into your vault:

1. In your vault, open the folder `<vault>/.obsidian/plugins/`.
2. **Create a folder named exactly `tempo`** (this must match the plugin id in
   `manifest.json`).
3. Copy `main.js`, `manifest.json`, and `styles.css` into that `tempo` folder.
4. Restart Obsidian (or toggle the plugin off/on), then enable **Tempo** under
   **Settings → Community plugins**.

> ⚠️ **Folder name matters.** Obsidian matches the plugin folder name to the
> `id` field in `manifest.json`. If the folder is named anything other than
> `tempo`, the plugin will not load.

> 📌 **Requires Obsidian 1.13.0 or later.** This version uses Obsidian's
> declarative settings API, so the `minAppVersion` in `manifest.json` is set to
> `1.13.0`. On older Obsidian versions the plugin will not enable.

---

## 🤔 Usage

### Tracking time

1. Open the note where you want to track time.
2. From the command palette, run **`Tempo: Insert Time Tracker`** (or type a
   ```` ```tempo ```` code block manually).
3. Switch to **Live Preview** or **Reading** mode — the tracker renders as a
   table.
4. Name the first segment (or leave it blank) and press the **play** button (▶).
5. When you're done, press the **stop** button (⏹). The elapsed time is saved
   and shown in the table.
6. Add more segments as needed; use the inline **continue** (▶), **edit** (✏️),
   and **delete** (🗑️) controls to manage them. Use **Copy as CSV** to export
   the table.

### Categorizing, tagging & notes

- **Categories** are single-select groups (optionally colored) you manage in
  **Settings → Tempo → Categories**. Pick one next to the segment name box
  before pressing play, or after the segment exists.
- Every row that has metadata shows it quietly beneath the name: a colored
  category chip and up to three `#tag` chips (dashed chips are inherited from
  an ancestor). The row itself gets a colored left rail and a dot before its
  name; the running timer and status bar reuse the same color.
- Pick **No category** from a row's right-click menu (or the details dialog)
  to remove a group for good — that segment keeps showing no category even if
  its parent has one. In the details dialog, an inherited category is shown
  with a note saying where it comes from.
- Click a row's **tags icon** (or right-click the row → **Edit details**) to
  open the segment dialog: rename it, choose a category, add tags (with
  autocomplete from your suggested tags and the tags already used in the
  tracker), pick a color override, and write a markdown note with a live
  preview. Hovering the note icon in the row shows a rendered tooltip;
  clicking the icon opens this dialog.
- Right-click a row for quick actions: **Set color**, **Set category**, and
  **Clear color**.
- Exports carry the metadata: the markdown table shows `name (category)
  #tags` inline, CSV gains Category/Tags/Note columns, and JSON/TOML/YAML
  include all fields.

The tracker data lives as JSON inside the code block, so it stays in your note
and syncs with the rest of your vault.

### Viewing statistics

1. In a note, run **`Tempo: Insert Time Tracker Stats`** from the command
   palette (or add a ```` ```tempo-stats ```` code block).
2. In the stats panel:
   - **Add sources** — choose the folders/files you want included: a **folder**
     (optionally recursive, optionally filtered by a filename regex) or a
     **single file**. Only the sources you add are scanned.
   - **Pick a time range** — **Today**, **7 days**, **30 days**, or a
     **custom range** with a calendar date picker.
   - **Group by name / category / tag** to change how the leaderboard and
     breakdown are aggregated, and click the **category/tag filter chips** to
     narrow the view.
   - The panel reports, for that period: the **total time** tracked, the
     **number of tasks (segments)** tracked, and the **number of files** scanned.
     It also draws a daily **bar chart** and a per-task **leaderboard**.
3. Click **Refresh** to recompute, or let it refresh automatically as files in
   your vault change.

---

## ⚙️ Settings

Open **Settings → Tempo** (or search "Tempo" in Obsidian's settings search).

| Setting | Description |
| --- | --- |
| **Timestamp display format** | moment.js format for timestamps in tracker tables (e.g. `YY-MM-DD HH:mm:ss`). |
| **CSV delimiter** | Character used when copying a table as CSV. Useful for locales that use `;` instead of `,`. |
| **Fine-grained durations** | Include days, months, and years in durations. When off, larger units roll into the hours display. |
| **Timestamp durations** | Show durations as `12:15:01` instead of `12h 15m 1s`. |
| **Display segments in reverse order** | Show older segments at the bottom instead of the top. |
| **Show total today** | Display the total time spent today in the tracker table. |
| **Use monospaced font for times** | Use your monospaced font for the title timer so digits don't shift while counting. |
| **Categories** | Manage the global single-select categories (name + optional color) that segments and stats can group by. |
| **Suggested tags** | One tag per line (no `#`), offered in tag autocomplete along with tags already used in a tracker. |
| **Pretty-print tracker data** | Pretty-print the code block JSON (larger files, easier sync merges). |

---

## 🔍 JavaScript API

Tempo exposes a public API for use with plugins like
[Dataview](https://blacksmithgu.github.io/obsidian-dataview/). Access it via the
Obsidian `app` object:

```js
app.plugins.plugins["tempo"].api;
```

Example — using [DataviewJS](https://blacksmithgu.github.io/obsidian-dataview/api/intro/)
to load every tracker in the vault and print the total duration of each:

```js
// get the Tempo plugin api instance
let api = dv.app.plugins.plugins["tempo"].api;

for (let page of dv.pages()) {
    // load trackers in the file at the given path
    let trackers = await api.loadAllTrackers(page.file.path);

    if (trackers.length)
        dv.el("strong", "Trackers in " + page.file.name);

    for (let { section, tracker } of trackers) {
        // print the total duration of the tracker
        let duration = api.getTotalDuration(tracker.entries);
        dv.el("p", api.formatDuration(duration));
    }
}
```

Available functions:

- `loadTracker(json)` — parse a single tracker's JSON.
- `loadAllTrackers(fileName)` — load all trackers in a file.
- `getDuration(entry)` / `getTotalDuration(entries)` — durations in ms.
- `getDurationToday(entry)` / `getTotalDurationToday(entries)` — today's totals.
- `getDurationDate(entry, date)` / `getTotalDurationDate(entries, date)`.
- `getRunningEntry(entries)` / `isRunning(tracker)`.
- `formatTimestamp(timestamp)` / `formatDuration(totalTime)` — using your settings.
- `orderedEntries(entries)` — entries ordered per your segment-order setting.

---

## 👀 What it does (under the hood)

A time tracker is just a special code block that stores the timestamps of when
you pressed the **play** and **stop** buttons. Because only timestamps are
stored, you can switch notes, close Obsidian, or shut down your machine while a
tracker is running — when you return, it's still running. The segment names,
start times, end times, and any metadata (category/tags/color/note) are saved as
JSON in the code block and rendered as a table in preview/reading mode. All
metadata fields are optional, so trackers written by older Tempo versions load
unchanged. One caveat: if an *older* Tempo version on another device edits and
re-saves a tracker, it only keeps the fields it knows about and will drop the
metadata — keep every device on the same version to be safe.

---

## 🛠️ Development

```bash
npm install        # install dependencies
npm run dev        # watch mode; rebuilds on change into main.js + test-vault
npm run build      # production build (tsc typecheck + minified esbuild bundle)
npm run lint       # eslint (includes Obsidian-specific rules)
```

The dev build also copies `main.js`, `manifest.json`, and `styles.css` into
`test-vault/.obsidian/plugins/simple-time-tracker/` so you can test against the
bundled sample vault.

---

## 🙏 Credits

Tempo is built on top of [ObsidianSimpleTimeTracker](https://github.com/Ellpeck/ObsidianSimpleTimeTracker)
by [Ellpeck](https://github.com/Ellpeck) (MIT licensed) — thanks for such a solid foundation
to build on, and for kindly approving this fork.

## 📄 License

MIT — see the original project for license details.
