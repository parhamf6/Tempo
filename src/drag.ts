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

    let pressed = false;
    let started = false;
    let startY = 0;
    let indicator: HTMLDivElement | undefined;
    let insertBefore: number | null = null;

    function cleanup(): void {
        pressed = false;
        started = false;
        insertBefore = null;
        row.removeClass("tempo-row-dragging");
        document.body.removeClass("tempo-dragging");
        indicator?.remove();
        indicator = undefined;
        window.removeEventListener("keydown", onKeyDown, true);
    }

    function onKeyDown(e: KeyboardEvent): void {
        if (e.key === "Escape") {
            e.preventDefault();
            e.stopPropagation();
            cleanup();
        }
    }

    // chooses the sibling boundary closest to the pointer and moves the
    // insertion line there; boundaries are every row's top edge plus the
    // last row's bottom edge (= append at the end)
    function positionIndicator(pointerY: number): void {
        const all = getSiblingRows().filter(sibling => !sibling.hidden);
        const from = all.indexOf(row);
        if (from < 0) {
            cleanup();
            return;
        }
        const others = all.filter(sibling => sibling !== row);
        const wrapRect = wrap.getBoundingClientRect();

        let best = others.length;
        let bestY = others.length
            ? others[others.length - 1]!.getBoundingClientRect().bottom
            : wrapRect.top;
        let bestDist = Math.abs(pointerY - bestY);
        for (let i = 0; i < others.length; i++) {
            const top = others[i]!.getBoundingClientRect().top;
            const dist = Math.abs(pointerY - top);
            if (dist < bestDist) {
                best = i;
                bestY = top;
                bestDist = dist;
            }
        }

        // the row's own slot reads as "no change": once the row is lifted,
        // the gap below it (top edge of the row that followed it) is the
        // boundary it already occupies. The gap above it has no boundary of
        // its own — the line above the row above it means "move up one".
        const noop = best === from;
        insertBefore = noop ? null : best;
        if (!indicator)
            return;
        indicator.hidden = noop;
        if (!noop)
            indicator.style.top = `${bestY - wrapRect.top}px`;
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
            document.body.addClass("tempo-dragging");
            indicator = createDiv({cls: "tempo-drop-indicator"});
            indicator.hidden = true;
            wrap.appendChild(indicator);
            window.addEventListener("keydown", onKeyDown, true);
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
