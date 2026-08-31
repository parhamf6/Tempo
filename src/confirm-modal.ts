import {App, Modal} from "obsidian";

// what the user picked: true/false map to the primary/confirm and cancel
// actions, "extra" to the optional secondary action (e.g. a softer
// alternative to deletion)
export type ConfirmChoice = boolean | "extra";

export class ConfirmModal extends Modal {
    // Message to show in the modal
    message: string;

    // Label of the primary (destructive) button
    confirmText: string;

    // When set, an additional neutral button is shown between cancel and
    // the primary action, for a second way to proceed
    extraText?: string;

    // Callback to run on user choice
    callback: (choice: ConfirmChoice) => void;

    // Whether an option was picked
    picked: boolean = false;

    constructor(app: App, message: string, callback: (choice: ConfirmChoice) => void, confirmText: string = "Delete", extraText?: string) {
        super(app);
        this.message = message;
        this.callback = callback;
        this.confirmText = confirmText;
        this.extraText = extraText;
    }

    onOpen(): void {
        const { contentEl } = this;
        contentEl.addClass("tempo-confirm-modal");

        contentEl.createEl("h2", { text: "Confirm", cls: "tempo-confirm-title" });
        contentEl.createEl("p", { text: this.message, cls: "tempo-confirm-message" });

        const actions = contentEl.createDiv({ cls: "tempo-confirm-actions" });

        const cancelButton = actions.createEl("button", {
            text: "Cancel",
            cls: "tempo-confirm-cancel",
        });
        cancelButton.addEventListener("click", () => {
            this.picked = true;
            this.close();
            this.callback(false);
        });

        if (this.extraText) {
            const extraButton = actions.createEl("button", {
                text: this.extraText,
                cls: "tempo-confirm-extra",
            });
            extraButton.addEventListener("click", () => {
                this.picked = true;
                this.close();
                this.callback("extra");
            });
        }

        const okButton = actions.createEl("button", {
            text: this.confirmText,
            cls: "tempo-confirm-ok",
        });
        okButton.addEventListener("click", () => {
            this.picked = true;
            this.close();
            this.callback(true);
        });

        // Set up keyboard handlers
        this.scope.register([], "Escape", () => {
            if (!this.picked) {
                this.picked = true;
                this.close();
                this.callback(false);
            }
        });
        this.scope.register([], "Enter", () => {
            if (!this.picked) {
                this.picked = true;
                this.close();
                this.callback(true);
            }
        });

        // Focus the cancel button by default to prevent accidental destructive action
        cancelButton.focus();
    }

    onClose(): void {
        if (!this.picked) {
            this.callback(false);
        }
    }
}
