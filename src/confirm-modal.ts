import {App, Modal} from "obsidian";

export class ConfirmModal extends Modal {
    // Message to show in the modal
    message: string;

    // Callback to run on user choice
    callback: (choice: boolean) => void;

    // Whether an option was picked
    picked: boolean = false;

    constructor(app: App, message: string, callback: (choice: boolean) => void) {
        super(app);
        this.message = message;
        this.callback = callback;
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

        const okButton = actions.createEl("button", {
            text: "Delete",
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
