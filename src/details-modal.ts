import {App, ButtonComponent, Component, DropdownComponent, MarkdownRenderer, Modal, setIcon} from "obsidian";
import {Category, colorVar, isColorToken, MetaNode} from "./meta";
import {createColorPicker} from "./color-picker";

// The category this segment currently shows via an ancestor (its own field is
// unset). Lets the editor reflect reality and explain that "No category" will
// stop the inheritance.
export interface InheritedCategory {
    name: string;
    sourceName: string;
}

// Context the tracker supplies so the modal can mutate the entry and tell the
// caller to persist. The modal writes straight onto the entry object and then
// invokes onSaved; the caller owns the note write.
export interface EntryDetailsContext {
    categories: Category[];
    // newline-separated list from settings
    suggestedTags: string;
    // tags already used anywhere in this tracker, offered in autocomplete
    treeTags: string[];
    // active note path for markdown previews
    sourcePath: string;
    // category resolved through an ancestor (own field unset), if any
    inherited?: InheritedCategory;
    // called once the modal has applied edits and the caller should save
    onSaved: () => void | Promise<void>;
}

interface Draft {
    name: string;
    // selected category in the dropdown: "" = no category
    category: string;
    // false until the user actually changes the dropdown, so a no-op save
    // never rewrites an inherited (unset) category into an explicit value
    categoryTouched: boolean;
    color?: string;
    tags: string[];
    note: string;
}

export class EntryDetailsModal extends Modal {
    private draft: Draft;
    private categoryDropdown!: DropdownComponent;
    private colorHint!: HTMLElement;

    constructor(app: App, private entry: MetaNode, private ctx: EntryDetailsContext) {
        super(app);
        // show the effective category (own value, or the inherited one) so the
        // dropdown never lies about why the row displays a group
        const initialCategory = typeof entry.category === "string"
            ? entry.category
            : entry.category === null
                ? ""
                : ctx.inherited?.name ?? "";
        this.draft = {
            name: entry.name,
            category: initialCategory,
            categoryTouched: false,
            color: entry.color,
            tags: [...(entry.tags ?? [])],
            note: entry.note ?? ""
        };
    }

    onOpen(): void {
        const {contentEl} = this;
        contentEl.addClass("tempo-details-modal");

        contentEl.createEl("h2", {text: "Segment details", cls: "tempo-details-title"});

        this.renderNameField(contentEl);
        this.renderCategoryField(contentEl);
        this.renderColorField(contentEl);
        this.renderTagsField(contentEl);
        this.renderNoteField(contentEl);

        const actions = contentEl.createDiv({cls: "tempo-details-actions"});
        const cancel = new ButtonComponent(actions).setButtonText("Cancel");
        cancel.onClick(() => this.close());
        const save = new ButtonComponent(actions).setButtonText("Save").setCta();
        save.onClick(async () => {
            await this.apply();
        });

        this.scope.register([], "Escape", () => this.close());
        this.scope.register(["Mod"], "Enter", async () => {
            await this.apply();
        });
    }

    private renderNameField(host: HTMLElement): void {
        const row = host.createDiv({cls: "tempo-details-row"});
        row.createEl("label", {text: "Name", cls: "tempo-details-label"});
        const input = row.createEl("input", {cls: "tempo-input", attr: {type: "text", placeholder: "Segment name"}});
        input.value = this.draft.name;
        input.addEventListener("input", () => {
            this.draft.name = input.value;
        });
        input.addEventListener("keydown", (e: KeyboardEvent) => {
            if (e.key === "Enter") {
                e.preventDefault();
                void this.apply();
            }
        });
    }

    private renderCategoryField(host: HTMLElement): void {
        const row = host.createDiv({cls: "tempo-details-row"});
        const labelRow = row.createDiv({cls: "tempo-details-label-row"});
        labelRow.createEl("label", {text: "Category", cls: "tempo-details-label"});

        this.categoryDropdown = new DropdownComponent(row)
            .addOption("", "No category");
        const known = new Set(this.ctx.categories.map(c => c.name));
        for (const category of this.ctx.categories)
            this.categoryDropdown.addOption(category.name, category.name);
        // a category no longer present in settings (own value, or one that is
        // inherited from an ancestor) still needs an option so the dropdown can
        // display what the row shows
        if (this.draft.category && !known.has(this.draft.category)) {
            const isInherited = this.ctx.inherited?.name === this.draft.category;
            this.categoryDropdown.addOption(this.draft.category, isInherited ? `${this.draft.category} (inherited)` : this.draft.category);
        }
        this.categoryDropdown.setValue(this.draft.category);
        this.categoryDropdown.selectEl.addClass("tempo-category-dropdown");
        this.categoryDropdown.onChange(value => {
            this.draft.category = value;
            this.draft.categoryTouched = true;
            this.refreshCategoryHint();
            this.refreshColorHint();
        });

        this.categoryHint = host.createDiv({cls: "tempo-details-hint"});
        this.refreshCategoryHint();
    }

    private categoryHint!: HTMLElement;

    private refreshCategoryHint(): void {
        if (!this.categoryHint)
            return;
        const hint = this.categoryHint;
        hint.empty();
        const ownIsSet = typeof this.entry.category === "string";
        const inherited = this.ctx.inherited;
        if (this.draft.category === "") {
            if (!this.draft.categoryTouched && !ownIsSet && !inherited)
                hint.createSpan({text: "No category."});
            else
                hint.createSpan({text: "No category — this segment will not inherit a parent's group."});
        } else if (!this.draft.categoryTouched && !ownIsSet && inherited) {
            hint.createSpan({text: `Currently using “${inherited.name}” inherited from “${inherited.sourceName}”. Pick another category, or No category to clear it here.`});
        } else if (this.draft.categoryTouched) {
            hint.createSpan({text: `Set to “${this.draft.category}”.`});
        }
    }

    private renderColorField(host: HTMLElement): void {
        const row = host.createDiv({cls: "tempo-details-row"});
        const labelRow = row.createDiv({cls: "tempo-details-label-row"});
        labelRow.createEl("label", {text: "Color", cls: "tempo-details-label"});

        const swatches = row.createDiv({cls: "tempo-details-colors"});
        createColorPicker(swatches, this.draft.color, token => {
            this.draft.color = token;
            this.refreshColorHint();
        });

        const clearBtn = new ButtonComponent(row)
            .setClass("clickable-icon")
            .setClass("tempo-details-clear-color")
            .setIcon("rotate-ccw")
            .setTooltip("Use the category's color");
        clearBtn.onClick(() => {
            this.draft.color = undefined;
            this.refreshColorSwatches(swatches);
            this.refreshColorHint();
        });

        this.colorHint = host.createDiv({cls: "tempo-details-hint"});
        this.refreshColorHint();
    }

    private refreshColorSwatches(host: HTMLElement): void {
        host.empty();
        createColorPicker(host, this.draft.color, token => {
            this.draft.color = token;
            this.refreshColorHint();
        });
    }

    private refreshColorHint(): void {
        if (!this.colorHint)
            return;
        const hint = this.colorHint;
        hint.empty();
        // show the color the entry will effectively display
        const override = this.draft.color;
        const categoryColor = this.categoryColor();
        const effective = override ?? categoryColor;
        const dot = hint.createSpan({cls: "tempo-color-hint-dot"});
        if (effective) {
            dot.style.background = colorVar(effective)!;
        } else {
            dot.addClass("is-empty");
        }
        if (override) {
            hint.createSpan({text: "Custom color override."});
        } else if (categoryColor) {
            hint.createSpan({text: `Uses the “${this.draft.category}” category color.`});
        } else {
            hint.createSpan({text: "No color — the segment has no category or override."});
        }
    }

    private categoryColor(): string | undefined {
        if (!this.draft.category)
            return undefined;
        const category = this.ctx.categories.find(c => c.name === this.draft.category);
        const color = category?.color;
        return color && isColorToken(color) ? color : undefined;
    }

    private renderTagsField(host: HTMLElement): void {
        const row = host.createDiv({cls: "tempo-details-row"});
        row.createEl("label", {text: "Tags", cls: "tempo-details-label"});

        const suggestions = this.tagSuggestions();
        const editor = row.createDiv({cls: "tempo-tags-editor"});

        const rebuildChips = (): void => {
            editor.querySelectorAll(".tempo-tags-chip").forEach(el => el.detach());
            // chips go before the input wrapper (which we keep last)
            const inputWrap = editor.querySelector<HTMLElement>(".tempo-tags-input-wrap");
            this.draft.tags.forEach((tag, i) => {
                const chip = editor.createDiv({cls: "tempo-tags-chip"});
                chip.createSpan({text: tag, cls: "tempo-tags-chip-label"});
                const remove = chip.createSpan({cls: "tempo-tags-chip-remove", attr: {role: "button", "aria-label": `Remove ${tag}`, tabindex: "0"}});
                setIcon(remove, "lucide-x");
                remove.addEventListener("click", () => {
                    this.draft.tags.splice(i, 1);
                    rebuildChips();
                    updateSuggestions("");
                });
                remove.addEventListener("keydown", (e: KeyboardEvent) => {
                    if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        this.draft.tags.splice(i, 1);
                        rebuildChips();
                        updateSuggestions("");
                    }
                });
                if (inputWrap)
                    editor.insertBefore(chip, inputWrap);
            });
        };

        const inputWrap = editor.createDiv({cls: "tempo-tags-input-wrap"});
        const input = inputWrap.createEl("input", {
            cls: "tempo-input tempo-tags-input",
            attr: {type: "text", placeholder: "Type a tag and press enter…", spellcheck: "false"}
        });

        const suggest = inputWrap.createDiv({cls: "tempo-suggest tempo-tags-suggest"});
        let matches: string[] = [];
        let selectedIndex = -1;

        const addTag = (raw: string): void => {
            const tag = raw.trim().replace(/^#+/, "");
            if (!tag)
                return;
            const key = tag.toLocaleLowerCase();
            if (!this.draft.tags.some(t => t.toLocaleLowerCase() === key)) {
                this.draft.tags.push(tag);
                rebuildChips();
            }
            input.value = "";
            updateSuggestions("");
            input.focus();
        };

        const updateSuggestions = (query: string): void => {
            suggest.empty();
            const q = query.toLocaleLowerCase();
            const existing = new Set(this.draft.tags.map(t => t.toLocaleLowerCase()));
            matches = suggestions
                .filter(s => s.toLocaleLowerCase().includes(q))
                .filter(s => !existing.has(s.toLocaleLowerCase()))
                .slice(0, 6);
            selectedIndex = -1;
            if (matches.length === 0) {
                suggest.removeClass("is-visible");
                return;
            }
            for (const tag of matches) {
                const item = suggest.createDiv({cls: "tempo-suggest-item", text: `#${tag}`});
                item.addEventListener("mousedown", (e: MouseEvent) => {
                    e.preventDefault();
                    addTag(tag);
                });
            }
            suggest.addClass("is-visible");
        };

        input.addEventListener("input", () => updateSuggestions(input.value));
        input.addEventListener("focus", () => updateSuggestions(input.value));
        input.addEventListener("blur", () => window.setTimeout(() => suggest.removeClass("is-visible"), 120));
        input.addEventListener("keydown", (e: KeyboardEvent) => {
            const visible = suggest.hasClass("is-visible") && matches.length > 0;
            if (visible && e.key === "ArrowDown") {
                e.preventDefault();
                selectedIndex = Math.min(selectedIndex + 1, matches.length - 1);
                highlightSuggestion(suggest, selectedIndex);
            } else if (visible && e.key === "ArrowUp") {
                e.preventDefault();
                selectedIndex = Math.max(selectedIndex - 1, -1);
                highlightSuggestion(suggest, selectedIndex);
            } else if (e.key === "Escape") {
                suggest.removeClass("is-visible");
            } else if (e.key === "Enter") {
                e.preventDefault();
                if (selectedIndex >= 0 && matches[selectedIndex])
                    addTag(matches[selectedIndex]!);
                else
                    addTag(input.value);
            } else if (e.key === "," || e.key === "Tab") {
                e.preventDefault();
                if (input.value.trim())
                    addTag(input.value);
            } else if (e.key === "Backspace" && !input.value && this.draft.tags.length > 0) {
                this.draft.tags.pop();
                rebuildChips();
                updateSuggestions("");
            }
        });

        rebuildChips();
    }

    private tagSuggestions(): string[] {
        const out: string[] = [];
        const seen = new Set<string>();
        const add = (tag: string): void => {
            const clean = tag.trim().replace(/^#+/, "");
            const key = clean.toLocaleLowerCase();
            if (clean && !seen.has(key)) {
                seen.add(key);
                out.push(clean);
            }
        };
        for (const tag of this.ctx.treeTags)
            add(tag);
        for (const line of this.ctx.suggestedTags.split("\n"))
            add(line);
        return out;
    }

    private renderNoteField(host: HTMLElement): void {
        const row = host.createDiv({cls: "tempo-details-row tempo-details-note-row"});
        row.createEl("label", {text: "Note", cls: "tempo-details-label"});
        const note = row.createEl("textarea", {
            cls: "tempo-input tempo-details-note",
            attr: {placeholder: "Optional Markdown note about this segment…", rows: "3"}
        });
        note.value = this.draft.note;
        let renderTimer: number | undefined;
        const preview = row.createDiv({cls: "tempo-details-preview"});
        preview.hide();

        const renderPreview = (): void => {
            if (this.draft.note.trim()) {
                preview.empty();
                preview.show();
                const markdown = this.draft.note;
                // render into the same note context so wikilinks resolve;
                // Modal is not a Component, so the preview owns a throwaway one
                const renderHost = new Component();
                void MarkdownRenderer.render(this.app, markdown, preview, this.ctx.sourcePath, renderHost);
            } else {
                preview.hide();
            }
        };

        note.addEventListener("input", () => {
            this.draft.note = note.value;
            if (renderTimer)
                window.clearTimeout(renderTimer);
            renderTimer = window.setTimeout(renderPreview, 200);
        });
        renderPreview();
    }

    private async apply(): Promise<void> {
        const {entry, draft} = this;
        entry.name = draft.name.trim() || entry.name;
        // only write a category when the user actually changed the dropdown;
        // picking "No category" stores null (explicit none, blocks inheritance)
        if (draft.categoryTouched)
            entry.category = draft.category || null;
        entry.color = draft.color;
        entry.tags = draft.tags.length > 0 ? draft.tags : undefined;
        entry.note = draft.note.trim() || undefined;
        await this.ctx.onSaved();
        this.close();
    }

    onClose(): void {
        this.contentEl.empty();
    }
}

function highlightSuggestion(suggest: HTMLElement, index: number): void {
    const items = Array.from(suggest.querySelectorAll<HTMLElement>(".tempo-suggest-item"));
    for (const el of items)
        el.removeClass("is-selected");
    const target = items[index];
    if (target) {
        target.addClass("is-selected");
        target.scrollIntoView({block: "nearest"});
    }
}
