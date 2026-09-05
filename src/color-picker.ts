import {colorVar, COLOR_OPTIONS, ColorToken, isColorToken} from "./meta";

// Shared color-swatch affordances used by the details modal, the settings
// category manager and the tracker row context menu. Colors are always the
// theme palette tokens, so they adapt to light/dark themes.

// A small transparent overlay that owns its own lifetime and resolves with the
// chosen token (undefined = cleared). Clicking outside or pressing Escape
// closes without picking.
export function showColorPopover(
    anchor: {clientX: number, clientY: number},
    value: string | undefined,
    onPick: (token: string | undefined) => void
): void {
    const doc = activeDocument ?? document;
    const overlay = doc.body.createDiv({cls: "tempo-color-overlay"});
    const pop = overlay.createDiv({cls: "tempo-color-pop"});

    const close = (): void => {
        overlay.detach();
        doc.removeEventListener("mousedown", onDocDown);
        doc.removeEventListener("keydown", onKeyDown);
    };
    const onDocDown = (e: MouseEvent): void => {
        // clicking a swatch fires its own handler; only outside clicks close
        if (!pop.contains(e.target as Node))
            close();
    };
    const onKeyDown = (e: KeyboardEvent): void => {
        if (e.key === "Escape") {
            e.preventDefault();
            close();
        }
    };

    for (const option of COLOR_OPTIONS) {
        const swatch = pop.createEl("button", {cls: "tempo-color-swatch", attr: {type: "button", title: option.label, "aria-label": option.label}});
        swatch.style.background = colorVar(option.token)!;
        swatch.toggleClass("is-active", value === option.token);
        swatch.addEventListener("click", () => {
            onPick(option.token);
            close();
        });
    }
    const clear = pop.createEl("button", {cls: "tempo-color-swatch tempo-color-swatch-clear", attr: {type: "button", title: "No color", "aria-label": "No color"}});
    clear.toggleClass("is-active", !value || !isColorToken(value));
    clear.addEventListener("click", () => {
        onPick(undefined);
        close();
    });

    // clamp to the viewport so a click near the bottom/right edge never opens
    // a popover that overflows the window
    pop.show();
    const rect = pop.getBoundingClientRect();
    const left = Math.max(4, Math.min(anchor.clientX, doc.body.clientWidth - rect.width - 8));
    const top = Math.max(4, Math.min(anchor.clientY, doc.body.clientHeight - rect.height - 8));
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;

    doc.addEventListener("mousedown", onDocDown);
    doc.addEventListener("keydown", onKeyDown, {capture: true});
}

// Inline swatch grid used inside forms (details modal, settings): same
// palette, but stays put and never closes itself.
export function createColorPicker(
    container: HTMLElement,
    value: string | undefined,
    onPick: (token: ColorToken | undefined) => void
): void {
    const grid = container.createDiv({cls: "tempo-color-grid"});
    for (const option of COLOR_OPTIONS) {
        const swatch = grid.createEl("button", {
            cls: "tempo-color-swatch tempo-color-swatch-inline",
            attr: {type: "button", title: option.label, "aria-label": option.label}
        });
        swatch.style.background = colorVar(option.token)!;
        swatch.toggleClass("is-active", value === option.token);
        swatch.addEventListener("click", () => {
            onPick(option.token);
            for (const s of Array.from(grid.querySelectorAll<HTMLElement>(".tempo-color-swatch-inline")))
                s.toggleClass("is-active", s === swatch);
        });
    }
}
