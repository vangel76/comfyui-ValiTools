// Floating editor toolbar for the rich-text prompt editor: undo/redo buttons and
// a plain-text find & replace bar (CTRL+F / CTRL+H).
//
// Matches are painted with the CSS Custom Highlight API, so the editor's own
// syntax-highlighting HTML is never touched (no nested-span hazards, and stepping
// through matches needs no re-render). Browsers without the API still get the
// active match selected - only the bulk tinting is missing.

const HIGHLIGHT_STYLE_ID = "vali-find-highlight-style";
const MATCH_HIGHLIGHT = "vali-find-match";
const ACTIVE_HIGHLIGHT = "vali-find-active";
const SCOPE_HIGHLIGHT = "vali-find-scope";

const supportsHighlights = () => typeof CSS !== "undefined" && !!CSS.highlights && typeof Highlight === "function";

const installHighlightStyles = () => {
	if (!supportsHighlights() || document.getElementById(HIGHLIGHT_STYLE_ID)) return;
	const style = document.createElement("style");
	style.id = HIGHLIGHT_STYLE_ID;
	style.textContent = `
		::highlight(${SCOPE_HIGHLIGHT}) { background-color: rgba(120, 170, 255, 0.14); }
		::highlight(${MATCH_HIGHLIGHT}) { background-color: rgba(255, 210, 0, 0.30); }
		::highlight(${ACTIVE_HIGHLIGHT}) { background-color: rgba(255, 170, 0, 0.85); color: #111111; }
	`;
	document.head.appendChild(style);
};

const BUTTON_CSS = `
	background: #333; color: #ddd; border: 1px solid #555; border-radius: 4px;
	padding: 2px 7px; font-size: 12px; font-family: monospace; cursor: pointer;
	line-height: 16px; min-width: 22px;
`;
const INPUT_CSS = `
	background: #1b1b1b; color: #eee; border: 1px solid #555; border-radius: 4px;
	padding: 2px 6px; font-size: 12px; font-family: monospace; outline: none;
`;

export class FindReplaceBar {
	/**
	 * @param {HTMLElement} editor the contentEditable prompt editor
	 * @param {object} api {getText, applyText, selectRange, createRange, undo, redo, canUndo, canRedo}
	 */
	constructor(editor, api) {
		this.editor = editor;
		this.api = api;
		this.query = "";
		this.caseSensitive = false;
		this.scope = null; // [start, end] - search & replace stay inside this range
		this.matches = [];
		this.activeIndex = -1;
		this.open = false;
		this.visible = false;
		this._frame = null;

		installHighlightStyles();
		this._build();
	}

	// --- DOM ---------------------------------------------------------------

	_button(label, title, onClick) {
		const button = document.createElement("button");
		button.textContent = label;
		button.title = title;
		button.style.cssText = BUTTON_CSS;
		button.addEventListener("mousedown", (e) => e.preventDefault()); // keep editor focus
		button.addEventListener("click", (e) => {
			e.preventDefault();
			e.stopPropagation();
			onClick();
		});
		return button;
	}

	_input(placeholder, width) {
		const input = document.createElement("input");
		input.type = "text";
		input.placeholder = placeholder;
		input.style.cssText = `${INPUT_CSS} width: ${width}px;`;
		// The editor's own handlers must never see these keys
		input.addEventListener("keydown", (e) => e.stopPropagation());
		input.addEventListener("keypress", (e) => e.stopPropagation());
		input.addEventListener("input", (e) => e.stopPropagation());
		return input;
	}

	_build() {
		this.element = document.createElement("div");
		Object.assign(this.element.style, {
			position: "fixed",
			zIndex: 9999,
			display: "none",
			alignItems: "center",
			gap: "4px",
			padding: "3px 5px",
			background: "rgba(24, 24, 24, 0.97)",
			border: "1px solid #555",
			borderRadius: "6px",
			boxShadow: "0 3px 10px rgba(0, 0, 0, 0.45)",
			fontFamily: "monospace",
		});
		this.element.addEventListener("mousedown", (e) => e.stopPropagation());
		this.element.addEventListener("wheel", (e) => e.stopPropagation());
		// Hovering the bar itself must never let it disappear under the cursor
		this.element.addEventListener("mouseenter", () => {
			this.hovered = true;
			this.cancelHide();
			this.element.style.opacity = "1";
		});
		this.element.addEventListener("mouseleave", () => {
			this.hovered = false;
			if (!this.open) this.element.style.opacity = "0.55";
		});

		this.undoButton = this._button("↶", "Undo (CTRL+Z)", () => this.api.undo());
		this.redoButton = this._button("↷", "Redo (CTRL+SHIFT+Z)", () => this.api.redo());
		this.findButton = this._button("⌕", "Find & replace (CTRL+F)", () => this.openFind(false));
		this.copyButton = this._button("⎘", "Copy the whole prompt as plain text", () => this.copyAll());

		this.panel = document.createElement("div");
		Object.assign(this.panel.style, { display: "none", alignItems: "center", gap: "4px" });

		this.findInput = this._input("find", 130);
		this.findInput.addEventListener("input", () => {
			this.query = this.findInput.value;
			this._search({ keepActive: false });
		});
		this.findInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				this.step(e.shiftKey ? -1 : 1);
			} else if (e.key === "Escape") {
				e.preventDefault();
				this.close();
			}
		});

		this.counter = document.createElement("span");
		this.counter.style.cssText = "color:#999; font-size:11px; min-width:44px; text-align:center;";

		this.caseButton = this._button("Aa", "Match case", () => {
			this.caseSensitive = !this.caseSensitive;
			this.caseButton.style.background = this.caseSensitive ? "#5a4b1f" : "#333";
			this.caseButton.style.color = this.caseSensitive ? "#ffd166" : "#ddd";
			this._search({ keepActive: false });
		});

		this.scopeButton = this._button("⧉", "Find & replace only inside the selection", () => {
			this.setScope(this.scope ? null : this.api.getSelectionRange?.());
		});

		this.replaceInput = this._input("replace", 130);
		this.replaceInput.addEventListener("keydown", (e) => {
			if (e.key === "Enter") {
				e.preventDefault();
				e.shiftKey ? this.replaceAll() : this.replaceCurrent();
			} else if (e.key === "Escape") {
				e.preventDefault();
				this.close();
			}
		});

		const separator = () => {
			const s = document.createElement("span");
			s.style.cssText = "width:1px; height:16px; background:#555; margin:0 2px;";
			return s;
		};

		this.panel.append(
			separator(),
			this.findInput,
			this.counter,
			this._button("◀", "Previous match (SHIFT+ENTER)", () => this.step(-1)),
			this._button("▶", "Next match (ENTER)", () => this.step(1)),
			this.caseButton,
			this.scopeButton,
			separator(),
			this.replaceInput,
			this._button("Replace", "Replace the current match (ENTER)", () => this.replaceCurrent()),
			this._button("All", "Replace all matches (SHIFT+ENTER)", () => this.replaceAll()),
			this._button("✕", "Close (ESC)", () => this.close()),
		);

		this.element.append(this.undoButton, this.redoButton, this.copyButton, this.findButton, this.panel);
		document.body.appendChild(this.element);
	}

	// --- visibility & placement -------------------------------------------

	show() {
		this.cancelHide();
		this.element.style.opacity = this.open || this.hovered ? "1" : "0.55";
		if (this.visible) return;
		this.visible = true;
		this.element.style.display = "flex";
		this._reposition();
		this._startTracking();
		this.syncButtons();
	}

	cancelHide() {
		if (this._hideTimer) {
			clearTimeout(this._hideTimer);
			this._hideTimer = null;
		}
	}

	/** Delayed so the cursor can travel from the editor to the bar. */
	hideSoon(delay = 400) {
		this.cancelHide();
		this._hideTimer = setTimeout(() => {
			this._hideTimer = null;
			this.hide();
		}, delay);
	}

	hide() {
		if (this.open || this.hovered) return; // the find panel / cursor keeps the bar alive
		this.cancelHide();
		this.visible = false;
		this.element.style.display = "none";
		this._stopTracking();
	}

	_startTracking() {
		if (this._frame !== null) return;
		const tick = () => {
			this._frame = requestAnimationFrame(tick);
			this._reposition();
		};
		this._frame = requestAnimationFrame(tick);
	}

	_stopTracking() {
		if (this._frame === null) return;
		cancelAnimationFrame(this._frame);
		this._frame = null;
	}

	_reposition() {
		const rect = this.editor.getBoundingClientRect();
		if (rect.width === 0 && rect.height === 0) {
			this.element.style.visibility = "hidden";
			return;
		}
		this.element.style.visibility = "visible";
		const width = this.element.offsetWidth;
		const left = Math.max(4, Math.min(rect.right - width - 6, window.innerWidth - width - 4));
		this.element.style.left = `${left}px`;
		this.element.style.top = `${Math.max(4, rect.top + 4)}px`;
	}

	syncButtons() {
		for (const [button, enabled] of [[this.undoButton, this.api.canUndo()], [this.redoButton, this.api.canRedo()]]) {
			button.disabled = !enabled;
			button.style.opacity = enabled ? "1" : "0.35";
			button.style.cursor = enabled ? "pointer" : "default";
		}
	}

	// --- find panel --------------------------------------------------------

	/** Restricts find & replace to a text range; pass nothing to search the whole prompt. */
	setScope(range) {
		const bounds = Array.isArray(range) ? range : (range ? [range.start, range.end] : null);
		this.scope = bounds && bounds[1] > bounds[0] ? [bounds[0], bounds[1]] : null;
		this.scopeButton.style.background = this.scope ? "#1f3f5a" : "#333";
		this.scopeButton.style.color = this.scope ? "#8ec1ff" : "#ddd";
		this.scopeButton.title = this.scope
			? "Searching inside the selection only - click to search the whole prompt"
			: "Find & replace only inside the selection";
		this._search({ keepActive: false });
	}

	openFind(replaceMode) {
		this.open = true;
		this.show();
		this.element.style.opacity = "1";
		this.panel.style.display = "flex";
		const selected = this.api.getSelectedText?.();
		if (selected && !selected.includes("\n")) {
			// A short, single-line selection is what the user wants to search FOR...
			this.query = selected;
			this.findInput.value = selected;
			this.setScope(null);
		} else if (selected) {
			// ...a multi-line selection is a region to work INSIDE (like VSCode)
			this.setScope(this.api.getSelectionRange?.());
		}
		this._search({ keepActive: false });
		(replaceMode ? this.replaceInput : this.findInput).focus();
		this.findInput.select?.();
	}

	close() {
		this.open = false;
		this.panel.style.display = "none";
		this.scope = null;
		this.scopeButton.style.background = "#333";
		this.scopeButton.style.color = "#ddd";
		this._clearHighlights();
		this.matches = [];
		this.activeIndex = -1;
		this.editor.focus();
		this.hide();
	}

	/** Recomputes matches against the current text (call after external edits). */
	refresh() {
		if (!this.open) return;
		this._search({ keepActive: true, silent: true });
	}

	_search({ keepActive, silent } = {}) {
		const previousStart = keepActive && this.activeIndex >= 0 ? this.matches[this.activeIndex]?.[0] : null;
		const text = this.api.getText();
		const query = this.query;
		this.matches = [];

		if (this.scope) {
			// Keep the scope valid if the text shrank underneath it
			this.scope = [Math.min(this.scope[0], text.length), Math.min(this.scope[1], text.length)];
			if (this.scope[1] <= this.scope[0]) this.scope = null;
		}

		if (query) {
			const haystack = this.caseSensitive ? text : text.toLowerCase();
			const needle = this.caseSensitive ? query : query.toLowerCase();
			const limit = this.scope ? this.scope[1] : text.length;
			let from = this.scope ? this.scope[0] : 0;
			for (;;) {
				const index = haystack.indexOf(needle, from);
				if (index === -1 || index + needle.length > limit) break;
				this.matches.push([index, index + needle.length]);
				from = index + Math.max(1, needle.length);
			}
		}

		if (this.matches.length === 0) {
			this.activeIndex = -1;
		} else if (previousStart !== null) {
			const same = this.matches.findIndex(([start]) => start === previousStart);
			this.activeIndex = same >= 0 ? same : 0;
		} else {
			// Start from the caret so CTRL+F continues where the user is working
			const caret = this.api.getCaret?.() ?? 0;
			const after = this.matches.findIndex(([start]) => start >= caret);
			this.activeIndex = after >= 0 ? after : 0;
		}

		this._paint(!silent);
	}

	step(direction) {
		if (this.matches.length === 0) return;
		this.activeIndex = (this.activeIndex + direction + this.matches.length) % this.matches.length;
		this._paint(true);
	}

	_paint(selectActive) {
		this.counter.textContent = this.matches.length === 0
			? (this.query ? "0/0" : "")
			: `${this.activeIndex + 1}/${this.matches.length}`;

		this._clearHighlights();
		if (supportsHighlights() && this.scope) {
			const scopeRange = this.api.createRange(this.scope[0], this.scope[1]);
			if (scopeRange) CSS.highlights.set(SCOPE_HIGHLIGHT, new Highlight(scopeRange));
		}
		if (supportsHighlights() && this.matches.length) {
			const others = [];
			let active = null;
			this.matches.forEach(([start, end], index) => {
				const range = this.api.createRange(start, end);
				if (!range) return;
				if (index === this.activeIndex) active = range;
				else others.push(range);
			});
			if (others.length) CSS.highlights.set(MATCH_HIGHLIGHT, new Highlight(...others));
			if (active) CSS.highlights.set(ACTIVE_HIGHLIGHT, new Highlight(active));
		}

		if (selectActive && this.activeIndex >= 0) {
			const [start, end] = this.matches[this.activeIndex];
			this.api.selectRange(start, end);
			this.findInput.focus();
		}
	}

	_clearHighlights() {
		if (!supportsHighlights()) return;
		CSS.highlights.delete(SCOPE_HIGHLIGHT);
		CSS.highlights.delete(MATCH_HIGHLIGHT);
		CSS.highlights.delete(ACTIVE_HIGHLIGHT);
	}

	// --- replacing ---------------------------------------------------------

	replaceCurrent() {
		if (this.activeIndex < 0 || !this.matches.length) return;
		const [start, end] = this.matches[this.activeIndex];
		const replacement = this.replaceInput.value;
		const text = this.api.getText();
		if (this.scope) this.scope = [this.scope[0], this.scope[1] + replacement.length - (end - start)];
		this.api.applyText(text.substring(0, start) + replacement + text.substring(end), start + replacement.length);
		// Offsets shifted: re-scan and keep going from the replacement position
		this._search({ keepActive: false });
		if (this.matches.length) {
			const next = this.matches.findIndex(([matchStart]) => matchStart >= start + replacement.length);
			this.activeIndex = next >= 0 ? next : 0;
			this._paint(true);
		}
	}

	replaceAll() {
		if (!this.matches.length) return;
		const replacement = this.replaceInput.value;
		const text = this.api.getText();
		let result = "";
		let last = 0;
		for (const [start, end] of this.matches) {
			result += text.substring(last, start) + replacement;
			last = end;
		}
		result += text.substring(last);

		const count = this.matches.length;
		if (this.scope) {
			const delta = this.matches.reduce((sum, [start, end]) => sum + replacement.length - (end - start), 0);
			this.scope = [this.scope[0], this.scope[1] + delta];
		}
		this.api.applyText(result, Math.min(result.length, this.matches[0][0] + replacement.length));
		this._search({ keepActive: false });
		this.counter.textContent = `${count} replaced`;
	}

	/** Puts the entire prompt on the clipboard as plain text, no markup of any kind. */
	async copyAll() {
		const text = this.api.getText();
		try {
			await navigator.clipboard.writeText(text);
		} catch {
			// Clipboard API needs a secure context; fall back to a scratch textarea
			const scratch = document.createElement("textarea");
			scratch.value = text;
			scratch.style.cssText = "position:fixed; opacity:0; pointer-events:none;";
			document.body.appendChild(scratch);
			scratch.select();
			try { document.execCommand("copy"); } catch { /* nothing else we can do */ }
			scratch.remove();
		}
		const previous = this.copyButton.textContent;
		this.copyButton.textContent = "✓";
		setTimeout(() => { this.copyButton.textContent = previous; }, 900);
	}

	cleanup() {
		this.cancelHide();
		this._stopTracking();
		this._clearHighlights();
		this.element.remove();
	}
}
