// Built-in wildcard file editor: CTRL+Click on a __wildcard__ opens the .txt right
// inside ComfyUI instead of handing the path to the operating system's file handler.
// Works on remote/headless installs too, and keeps the node free of system calls.

const OVERLAY_CSS = `
	position: fixed; inset: 0; z-index: 10001; display: flex;
	align-items: center; justify-content: center; background: rgba(0, 0, 0, 0.55);
`;
const PANEL_CSS = `
	display: flex; flex-direction: column; gap: 8px; width: min(720px, 90vw);
	max-height: 80vh; padding: 12px; border-radius: 8px; border: 1px solid #555;
	background: #1e1e1e; box-shadow: 0 8px 30px rgba(0, 0, 0, 0.6); font-family: monospace;
`;
const AREA_CSS = `
	flex: 1; min-height: 260px; resize: vertical; padding: 8px; border-radius: 6px;
	border: 1px solid #555; background: #141414; color: #eee; font-family: monospace;
	font-size: 13px; line-height: 1.45; outline: none; white-space: pre; overflow: auto;
`;
const BUTTON_CSS = `
	background: #333; color: #ddd; border: 1px solid #555; border-radius: 4px;
	padding: 4px 12px; font-size: 12px; font-family: monospace; cursor: pointer;
`;

export class WildcardEditor {
	constructor() {
		this.filePath = null;
		this.wildcardDir = null;
		this.onSaved = null;
		this._build();
	}

	_build() {
		this.element = document.createElement("div");
		this.element.style.cssText = OVERLAY_CSS;
		this.element.style.display = "none";
		// Clicking the backdrop closes, clicks inside the panel must not
		this.element.addEventListener("mousedown", (e) => {
			e.stopPropagation();
			if (e.target === this.element) this.close();
		});
		this.element.addEventListener("wheel", (e) => e.stopPropagation());
		this.element.addEventListener("keydown", (e) => {
			e.stopPropagation();
			if (e.key === "Escape") {
				e.preventDefault();
				this.close();
			} else if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
				e.preventDefault();
				this.save();
			}
		});

		const panel = document.createElement("div");
		panel.style.cssText = PANEL_CSS;

		this.title = document.createElement("div");
		this.title.style.cssText = "color:#FFD700; font-weight:bold; font-size:13px; word-break:break-all;";

		const hint = document.createElement("div");
		hint.style.cssText = "color:#888; font-size:11px;";
		hint.textContent = "One option per line. Empty lines and # comments are ignored when the wildcard is pulled.";

		this.area = document.createElement("textarea");
		this.area.spellcheck = false;
		this.area.style.cssText = AREA_CSS;

		this.status = document.createElement("span");
		this.status.style.cssText = "color:#888; font-size:11px; flex:1;";

		const row = document.createElement("div");
		row.style.cssText = "display:flex; align-items:center; gap:8px;";
		const saveButton = document.createElement("button");
		saveButton.textContent = "Save (CTRL+ENTER)";
		saveButton.style.cssText = BUTTON_CSS;
		saveButton.addEventListener("click", () => this.save());
		const cancelButton = document.createElement("button");
		cancelButton.textContent = "Close (ESC)";
		cancelButton.style.cssText = BUTTON_CSS;
		cancelButton.addEventListener("click", () => this.close());
		row.append(this.status, saveButton, cancelButton);

		panel.append(this.title, hint, this.area, row);
		this.element.appendChild(panel);
		document.body.appendChild(this.element);
	}

	/**
	 * Loads a wildcard file and shows the editor.
	 * @param {string} filePath absolute path of the .txt
	 * @param {string} wildcardDir the node's wildcard directory (server-side guard)
	 * @param {string} label short name shown in the title
	 * @param {() => void} onSaved called after a successful save
	 */
	async open(filePath, wildcardDir, label, onSaved) {
		this.filePath = filePath;
		this.wildcardDir = wildcardDir;
		this.onSaved = onSaved;
		this.title.textContent = `__${label}__`;
		this.status.textContent = "Loading…";
		this.area.value = "";
		this.element.style.display = "flex";

		try {
			const response = await fetch("/valitools/read_wildcard", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ file_path: filePath, wildcard_dir: wildcardDir }),
			});
			const data = await response.json();
			if (!data.success) {
				this.status.textContent = `Error: ${data.error || "could not read file"}`;
				return;
			}
			this.area.value = data.content || "";
			this.status.textContent = data.created ? "New file created" : "";
			this.area.focus();
			this.area.setSelectionRange(this.area.value.length, this.area.value.length);
		} catch (e) {
			this.status.textContent = `Error: ${e}`;
		}
	}

	async save() {
		if (!this.filePath) return;
		this.status.textContent = "Saving…";
		try {
			const response = await fetch("/valitools/save_wildcard", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					file_path: this.filePath,
					wildcard_dir: this.wildcardDir,
					content: this.area.value,
				}),
			});
			const data = await response.json();
			if (!data.success) {
				this.status.textContent = `Error: ${data.error || "could not save file"}`;
				return;
			}
			this.onSaved?.();
			this.close();
		} catch (e) {
			this.status.textContent = `Error: ${e}`;
		}
	}

	close() {
		this.element.style.display = "none";
		this.filePath = null;
		this.onSaved = null;
	}

	cleanup() {
		this.element.remove();
	}
}
