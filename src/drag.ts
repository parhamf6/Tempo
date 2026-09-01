// Pointer-based drag & drop for reordering rows within one sibling group of
// the tracker table. Native HTML5 drag & drop is avoided on purpose: its drag
// images are unreliable inside Obsidian and it does not work with touch.
//
// The dragged row stays in place (just dimmed) while an accent insertion line
// snaps to the boundaries between its sibling rows. On release, the final
// position is reported as a display-order index to insert before (== sibling
// count means append at the end). Dropping onto the current slot reports
// nothing, so the caller can skip the save entirely.

export interface RowDragOptions {
    handle: HTMLElement;
    row: HTMLTableRowElement;
    // positioned ancestor (the table wrapper) the insertion line lives in
    wrap: HTMLElement;
    // drag must not start while the row's inline editor is open
    isEditing: () => boolean;
    // the dragged row's sibling rows in display order, including itself
    getSiblingRows: () => HTMLTableRowElement[];
    onDrop: (insertBefore: number) => void;
}

// pointer travel required before a press becomes a drag, so tiny jitters
// while grabbing the handle don't reorder anything
const DRAG_THRESHOLD = 4;

export function makeRowDraggable(options: RowDragOptions): void {
    const {handle, row, wrap, isEditing, getSiblingRows, onDrop} = options;

    // popout-safe: never use the global document/window, which point at the
    // main window when the tracker is rendered in a popped-out pane
    const doc = row.ownerDocument;
    const win = doc.defaultView!;

    let pressed = false;
    let started = false;
    let startY = 0;
    let indicator: HTMLDivElement | undefined;
    let insertBefore: number | null = null;
    // rects of every visible sibling (drag row excluded), plus the wrap's
    // rect, captured once when the drag starts. positionIndicator reuses these
    // instead of asking the browser for forced layout on every pointer move.
    let siblingTops: number[] = [];
    let wrapTop = 0;
    // the drag row's index among its visible siblings, resolved once at start
    let rowSlot = 0;

    function cleanup(): void {
        pressed = false;
        started = false;
        insertBefore = null;
        row.removeClass("tempo-row-dragging");
        doc.body.removeClass("tempo-dragging");
        indicator?.remove();
        indicator = undefined;
        win.removeEventListener("keydown", onKeyDown, true);
        win.removeEventListener("scroll", onScrollResize, true);
        win.removeEventListener("resize", onScrollResize);
    }

    function onKeyDown(e: KeyboardEvent): void {
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            cleanup();
        }
    }

    // rows may move under the pointer if the page scrolls or the window
    // resizes mid-drag; re-snapshot the cached rects instead of letting them
    // go stale (the old code re-measured on every pointer move)
    function onScrollResize(): void {
        if (started)
            snapshotRects();
    }

    // snapshots the visible sibling row rects once; called when a drag starts.
    // siblingTops holds the top edge of every sibling EXCEPT the dragged row,
    // plus the bottom edge of the last row (= the append boundary), so the
    // candidate index i maps directly to "insert before sibling i"
    function snapshotRects(): void {
        const all = getSiblingRows().filter(sibling => !sibling.hidden);
        rowSlot = all.indexOf(row);
        const others = all.filter(sibling => sibling !== row);
        const wrapRect = wrap.getBoundingClientRect();
        wrapTop = wrapRect.top;
        siblingTops = others.map(sibling => sibling.getBoundingClientRect().top);
        siblingTops.push(others.length
            ? others[others.length - 1]!.getBoundingClientRect().bottom
            : wrapRect.top);
    }

    // chooses the sibling boundary closest to the pointer and moves the
    // insertion line there; boundaries are every row's top edge plus the
    // last row's bottom edge (= append at the end)
    function positionIndicator(pointerY: number): void {
        if (rowSlot < 0) {
            cleanup();
            return;
        }
        const bestY = siblingTops[siblingTops.length - 1]!;
        let best = siblingTops.length - 1;
        let bestDist = Math.abs(pointerY - bestY);
        let bestPos = bestY;
        // the row's own slot is excluded: siblingTops holds one entry per
        // OTHER row, so index maps to boundary candidates directly
        for (let i = 0; i < siblingTops.length - 1; i++) {
            const dist = Math.abs(pointerY - siblingTops[i]!);
            if (dist < bestDist) {
                best = i;
                bestPos = siblingTops[i]!;
                bestDist = dist;
            }
        }

        // the row's own slot reads as "no change": once the row is lifted,
        // the gap below it (top edge of the row that followed it) is the
        // boundary it already occupies. The gap above it has no boundary of
        // its own — the line above the row above it means "move up one".
        const noop = best === rowSlot;
        insertBefore = noop ? null : best;
        if (!indicator)
            return;
        indicator.hidden = noop;
        if (!noop)
            indicator.style.top = `${bestPos - wrapTop}px`;
    }

    handle.addEventListener("pointerdown", (e: PointerEvent) => {
        if (e.button !== 0 || isEditing() || pressed)
            return;
        e.preventDefault();
        handle.setPointerCapture(e.pointerId);
        pressed = true;
        started = false;
        startY = e.clientY;
    });

    handle.addEventListener("pointermove", (e: PointerEvent) => {
        if (!pressed)
            return;
        if (!started) {
            if (Math.abs(e.clientY - startY) < DRAG_THRESHOLD)
                return;
            if (!row.isConnected) {
                cleanup();
                return;
            }
            started = true;
            row.addClass("tempo-row-dragging");
            doc.body.addClass("tempo-dragging");
            indicator = createDiv({cls: "tempo-drop-indicator"});
            indicator.hidden = true;
            wrap.appendChild(indicator);
            win.addEventListener("keydown", onKeyDown, true);
            win.addEventListener("scroll", onScrollResize, true);
            win.addEventListener("resize", onScrollResize);
            snapshotRects();
        }
        if (!row.isConnected) {
            cleanup();
            return;
        }
        positionIndicator(e.clientY);
    });

    handle.addEventListener("pointerup", (e: PointerEvent) => {
        if (!pressed)
            return;
        const target = insertBefore;
        const wasStarted = started;
        cleanup();
        if (wasStarted && target !== null && row.isConnected)
            void onDrop(target);
    });

    handle.addEventListener("pointercancel", () => {
        if (pressed)
            cleanup();
    });
}
