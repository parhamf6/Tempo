import {TextComponent} from "obsidian";

interface NameSuggestionOptions {
    getSuggestions: () => string[];
    limit?: number;
}

// Attaches a filtered suggestion dropdown to a segment-name text input. The
// dropdown appears on focus (with every suggestion) and narrows as the user
// types. Mouse click commits the name into the input; ArrowUp/ArrowDown move
// the highlight and Enter commits it, letting the caller's own Enter handler
// (which reads the input value) proceed normally afterwards.
export function attachNameSuggestions(input: TextComponent, options: NameSuggestionOptions): void {
    const limit = options.limit ?? 8;
    const inputEl = input.inputEl;

    const list = inputEl.createDiv({cls: "tempo-suggest"});
    list.setAttribute("role", "listbox");
    inputEl.after(list);

    let matches: string[] = [];
    let selectedIndex = -1;

    const setVisible = (visible: boolean): void => {
        list.toggleClass("is-visible", visible);
    };

    const hide = (): void => {
        list.empty();
        setVisible(false);
        matches = [];
        selectedIndex = -1;
    };

    const clearHighlight = (): void => {
        for (const el of Array.from(list.children))
            el.removeClass("is-selected");
        selectedIndex = -1;
    };

    const highlight = (index: number): void => {
        const items = Array.from(list.children) as HTMLElement[];
        for (const el of items)
            el.removeClass("is-selected");
        selectedIndex = index;
        const el = items[index];
        if (el) {
            el.addClass("is-selected");
            el.scrollIntoView({block: "nearest"});
        }
    };

    const commit = (name: string): void => {
        input.setValue(name);
        hide();
    };

    const render = (): void => {
        const query = input.getValue().trim().toLocaleLowerCase();
        const source = options.getSuggestions()
            .map(s => s.trim())
            .filter((s, i, arr) => s.length > 0 && arr.indexOf(s) === i);
        const filtered = query.length === 0 ? source : source.filter(s => s.toLocaleLowerCase().includes(query));
        matches = filtered.slice(0, limit);

        if (matches.length === 0) {
            hide();
            return;
        }

        list.empty();
        for (const name of matches) {
            const item = list.createDiv({cls: "tempo-suggest-item", text: name});
            item.setAttribute("role", "option");
            item.addEventListener("mousedown", (e: MouseEvent) => {
                e.preventDefault();
                commit(name);
            });
        }
        clearHighlight();
        setVisible(true);
    };

    inputEl.addEventListener("focus", render);
    inputEl.addEventListener("input", render);
    inputEl.addEventListener("blur", () => {
        window.setTimeout(hide, 120);
    });
    inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
        if (!list.hasClass("is-visible") || matches.length === 0)
            return;
        if (e.key === "ArrowDown") {
            e.preventDefault();
            highlight(Math.min(selectedIndex + 1, matches.length - 1));
        } else if (e.key === "ArrowUp") {
            e.preventDefault();
            highlight(Math.max(selectedIndex - 1, -1));
        } else if (e.key === "Escape") {
            e.preventDefault();
            hide();
        } else if (e.key === "Enter" && selectedIndex >= 0) {
            e.preventDefault();
            commit(matches[selectedIndex]!);
        }
    });
}
