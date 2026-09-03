import { app } from "../../../scripts/app.js";
import { api } from "/scripts/api.js";
import { AutocompleteDropdown } from "../widgets/autocomplete_dropdown.js";
import { FindReplaceBar } from "../widgets/find_replace_bar.js";
import { WildcardEditor } from "../widgets/wildcard_editor.js";


// Note: trying to block/bypass ComfyUI's native node CTRL+UP/DOWN/LEFT/RIGHT shortcuts does not work from within editor. Doing a global window listener and blocking it this way works
if (!window.comfy_silver_weight_listener_added) {
    window.addEventListener("keydown", (e) => {
        const el = document.activeElement;
        if (el && typeof el.silverTextWeighting === "function") {
            if ((e.key === "ArrowUp" || e.key === "ArrowDown" || e.key === "ArrowLeft" || e.key === "ArrowRight") && (e.ctrlKey || e.metaKey)) {
                e.stopImmediatePropagation();
                if (e.key === "ArrowUp" || e.key === "ArrowDown") {
                    e.preventDefault();
                    el.silverTextWeighting(e);
                }
                // Left/Right: keep ComfyUI's node shortcuts blocked but let the
                // browser's native CTRL+arrow word jump / selection happen.
            }
        }
    }, true); 
    window.comfy_silver_weight_listener_added = true;
}


app.registerExtension({
    name: "Comfy.VSmartPrompt",
    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        if (nodeData.name !== "VSmartPrompt") return;

		const SILVER_SERIALIZED_WIDGET_COUNT = 11;

			let current_wildcard_directory = "";
			let stored_wildcard_directory = "";
			let hovered_wildcard_content = "";
			let wildcard_files = [];
			let wildcardValidationTimeout = null;
			let wildcardValidationRequestId = 0;
			let lastWildcardValidationSignature = "";
			const SILVER_SELECTED_RANGE_START = "\uE000";
			const SILVER_SELECTED_RANGE_END = "\uE001";
			const normalizeSelectedRanges = (ranges, textLength) => {
				if (!Array.isArray(ranges) || textLength <= 0) return [];

			const sanitizedRanges = ranges
				.filter((range) => Array.isArray(range) && range.length >= 2)
				.map(([start, end]) => {
					const normalizedStart = Math.max(0, Math.min(textLength, Number(start)));
					const normalizedEnd = Math.max(normalizedStart, Math.min(textLength, Number(end)));
					return [normalizedStart, normalizedEnd];
				})
				.filter(([start, end]) => Number.isFinite(start) && Number.isFinite(end) && end > start)
				.sort((a, b) => a[0] - b[0] || a[1] - b[1]);

			if (sanitizedRanges.length === 0) return [];

			const mergedRanges = [sanitizedRanges[0]];
			for (let i = 1; i < sanitizedRanges.length; i++) {
				const [start, end] = sanitizedRanges[i];
				const lastRange = mergedRanges[mergedRanges.length - 1];
				if (start <= lastRange[1]) {
					lastRange[1] = Math.max(lastRange[1], end);
				} else {
					mergedRanges.push([start, end]);
				}
			}

				return mergedRanges;
			};

			const normalizeWildcardResolutions = (entries, textLength) => {
				if (!Array.isArray(entries) || textLength <= 0) return [];

				return entries
					.filter((entry) => entry && typeof entry === "object")
					.map((entry) => {
						const start = Math.max(0, Math.min(textLength, Number(entry.start)));
						const end = Math.max(start, Math.min(textLength, Number(entry.end)));
						const resolved = typeof entry.resolved === "string" ? entry.resolved : "";
						return { start, end, resolved };
					})
					.filter((entry) => Number.isFinite(entry.start) && Number.isFinite(entry.end) && entry.end > entry.start && entry.resolved.length > 0)
					.sort((a, b) => a.start - b.start || a.end - b.end);
			};

		const applySelectedRangeMarkers = (text, ranges) => {
			const normalizedRanges = normalizeSelectedRanges(ranges, text.length);
			if (normalizedRanges.length === 0) return text;

			let result = "";
			let rangeIndex = 0;

			for (let i = 0; i < text.length; i++) {
				if (rangeIndex < normalizedRanges.length && normalizedRanges[rangeIndex][0] === i) {
					result += SILVER_SELECTED_RANGE_START;
				}

				result += text[i];

				if (rangeIndex < normalizedRanges.length && normalizedRanges[rangeIndex][1] === i + 1) {
					result += SILVER_SELECTED_RANGE_END;
					rangeIndex++;
				}
			}

			return result;
		};
		
		const WILDCARD_PATTERN = /__.*?__/g;
		const SILVER_TOKEN_NONCE = Math.random().toString(36).slice(2, 10);

		// Variable syntax: '{a|b}==<name>' / '__file__==<name>' assigns, '<name>' references.
		// '==!<name>' is the silent variant: assigns but emits nothing at the definition site.
		// Must stay in sync with the variable regexes in nodes.py.
		const VARIABLE_ASSIGN_SCAN_REGEX = /\S\s*==\s*!?<([A-Za-z0-9_]+)>/g;
		const VARIABLE_ASSIGN_REGEX = /==\s*(!?)<([A-Za-z0-9_]+)>/g;
		const VARIABLE_REF_REGEX = /<([A-Za-z0-9_]+)>/g;
		// Autocomplete: assignment with its source (for the dropdown preview), and the
		// partial reference being typed directly before the cursor ('<', '<ha', ...).
		const VARIABLE_ASSIGN_PREVIEW_REGEX = /(\{(?:[^{}]|\{[^{}]*\})*\}|__.+?__|[^\s{}|<>=]+)\s*==\s*!?<([A-Za-z0-9_]+)>/g;
		const VARIABLE_PARTIAL_REGEX = /<([A-Za-z0-9_]*)$/;
		// Characters a wildcard name being typed may contain. The opening '__' itself
		// is located with lastIndexOf - a regex would match the leftmost '__' on the
		// line and swallow everything after it.
		const WILDCARD_PARTIAL_REGEX = /^[^\n|{}<>]*$/;
		// Switcher guard '<name>==value::' / '<name>!=value::' glued to a '{...}'
		// block or '__wildcard__'. Must stay in sync with GUARD_*_PATTERN in nodes.py.
		const GUARD_REGEX = /<([A-Za-z0-9_]+)>\s*(?:==|!=)\s*([^:{}|<>\n]*?)::(?=\{|__)/g;
		const variableStyle = "color:#DA70D6; font-weight:bold;";
		// String input sockets usable as variables in the text (<in1>..<in4>)
		const INPUT_VAR_NAMES = ["in1", "in2", "in3", "in4"];
		const getConnectedInputVars = (node) =>
			INPUT_VAR_NAMES.filter((name) => node?.inputs?.some((i) => i.name === name && i.link != null));

        // Advanced syntax highlighting with fixed comment typing behavior
		const highlight = (text, selectedRanges = [], wildcardExecutions = [], externalVariables = [], variableValues = null) => {
			// Post-run tooltip for variables: 'name' -> resolved value (lowercased keys)
			const variableTitle = (name) => {
				const value = variableValues?.[name.toLowerCase()];
				if (value === undefined || value === null) return "";
				const safe = String(value)
					.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
					.replace(/"/g, "&quot;").replace(/\r?\n/g, "&#10;");
				return ` title="&lt;${name}&gt; = ${safe}"`;
			};
			const variableValueStyle = (name) =>
				variableValues?.[name.toLowerCase()] !== undefined
					? " background:rgba(218, 112, 214, 0.18); box-shadow:inset 0 -1px 0 rgba(218, 112, 214, 0.85); border-radius:3px; padding:0 1px;"
					: "";
			let work = applySelectedRangeMarkers(text, selectedRanges);

			// Variable names assigned anywhere in the text (references to them highlight as valid),
			// plus externally provided ones (connected in1..in4 sockets) and everything the
			// last run knew - that is how variables handed over through 'vars_in' become
			// valid here, since their names cannot be known before the first execution.
			const definedVariables = new Set(externalVariables);
			for (const name of Object.keys(variableValues || {})) definedVariables.add(name.toLowerCase());
			VARIABLE_ASSIGN_SCAN_REGEX.lastIndex = 0;
			let variableAssignMatch;
			while ((variableAssignMatch = VARIABLE_ASSIGN_SCAN_REGEX.exec(text)) !== null) {
				definedVariables.add(variableAssignMatch[1].toLowerCase());
			}
			const wildcardExecutionMap = new Map();
			for (const entry of normalizeWildcardResolutions(wildcardExecutions, text.length)) {
				wildcardExecutionMap.set(`${entry.start}:${entry.end}`, entry);
			}
			const wildcardOccurrences = [];
			WILDCARD_PATTERN.lastIndex = 0;
			let wildcardMatch;
			while ((wildcardMatch = WILDCARD_PATTERN.exec(text)) !== null) {
				wildcardOccurrences.push({
					start: wildcardMatch.index,
					end: wildcardMatch.index + wildcardMatch[0].length,
				});
			}
			let wildcardOccurrenceIndex = 0;
		
			const tokens = [];
			const protect = (frag) => {
				const tok = `@@@${SILVER_TOKEN_NONCE}_TOKEN${tokens.length}@@@`;
				tokens.push(frag);
				return tok;
			};
		
			const escapeHTML = (s) => s
				.replace(/&/g, "&amp;")
				.replace(/</g, "&lt;")
				.replace(/>/g, "&gt;")
				.replace(/"/g, "&quot;")
				.replace(/'/g, "&#39;");

			const getCommentStyle = (markerLength) => {
				if (markerLength >= 3) {
					return "color:#FFA500; font-style:italic; font-size:2em;";
				}
				if (markerLength === 2) {
					return "color:#A020F0; font-style:italic; font-size:1.5em;";
				}
				return "color:#6A9955; font-style:italic;";
			};

			const findClosingSingleHash = (line, startIndex) => {
				for (let i = startIndex; i < line.length; i++) {
					if (line[i] !== "#") continue;

					const previousIsHash = i > 0 && line[i - 1] === "#";
					const nextIsHash = i + 1 < line.length && line[i + 1] === "#";
					// A '#' that belongs to a '/#' or '#/' block marker must not close an
					// inline comment - both comment styles stay independent (mirrors nodes.py).
					const isBlockMarker = (i > 0 && line[i - 1] === "/") || (i + 1 < line.length && line[i + 1] === "/");
					if (!previousIsHash && !nextIsHash && !isBlockMarker) {
						return i;
					}
				}

				return -1;
			};

			const highlightComments = (text) => {
				let result = "";
				let cursor = 0;

				while (cursor < text.length) {
					const blockIndex = text.indexOf("/#", cursor);
					const hashIndex = text.indexOf("#", cursor);
					const nextIndex = blockIndex === -1 ? hashIndex : hashIndex === -1 ? blockIndex : Math.min(blockIndex, hashIndex);
					if (nextIndex === -1) return result + text.slice(cursor);

					result += text.slice(cursor, nextIndex);
					if (nextIndex === blockIndex) {
						const closingIndex = text.indexOf("#/", blockIndex + 2);
						const endIndex = closingIndex === -1 ? text.length : closingIndex + 2;
						result += protect(`<span style="${getCommentStyle(1)}">${escapeHTML(text.slice(blockIndex, endIndex))}</span>`);
						cursor = endIndex;
						continue;
					}

					const remainingLine = text.slice(hashIndex).split(/\r?\n/, 1)[0];
					let markerEnd = 1;
					while (markerEnd < remainingLine.length && remainingLine[markerEnd] === "#") markerEnd++;
					const markerLength = markerEnd;
					const style = getCommentStyle(markerLength);
					if (markerLength > 1) {
						result += protect(`<span style="${style}">${escapeHTML(remainingLine)}</span>`);
						cursor = hashIndex + remainingLine.length;
						continue;
					}

					const closingIndex = findClosingSingleHash(remainingLine, markerEnd);
					const commentText = closingIndex === -1 ? remainingLine : remainingLine.slice(0, closingIndex + 1);
					result += protect(`<span style="${style}">${escapeHTML(commentText)}</span>`);
					cursor = hashIndex + commentText.length;
				}

				return result;
			};
		
			// ------------------------
			// 1) Structural highlighting (comments, wildcards, tags)
			// ------------------------
			work = highlightComments(work);

			// Switcher guards: '<name>==value::' glued to a following block or wildcard.
			// Must run before wildcard/variable rules (they'd eat the '<name>' part).
			work = work.replace(GUARD_REGEX, (match, name) => {
				const valid = definedVariables.has(name.toLowerCase());
				const style = valid
					? "color:#FF8C00; font-weight:bold;"
					: "color:#FF4444; font-weight:bold;";
				return protect(`<span style="${style}${variableValueStyle(name)}"${variableTitle(name)}>${escapeHTML(match)}</span>`);
			});

			// Wildcards
			work = work.replace(/__.*?__/g, (match) => {
				const occurrence = wildcardOccurrences[wildcardOccurrenceIndex++] || null;
				const resolution = occurrence ? wildcardExecutionMap.get(`${occurrence.start}:${occurrence.end}`) : null;
				const content = match.slice(2, -2);
				const color = wildcard_files.includes(content.replace(/[\\/]+/g, "\\").toLowerCase()) ? "#FFD700" : "#FF4444";
				const safe = escapeHTML(match);
				const safeResolved = resolution ? escapeHTML(resolution.resolved).replace(/\r?\n/g, "&#10;") : "";
				const resolvedStyle = resolution
					? " background:rgba(56, 189, 248, 0.20); box-shadow:inset 0 -1px 0 rgba(125, 211, 252, 0.95); border-radius:3px; padding:0 1px;"
					: "";
				const titleAttr = safeResolved ? ` title="${safeResolved}"` : "";
				return protect(`<span style="color:${color}; font-weight:bold;${resolvedStyle}"${titleAttr}>${safe}</span>`);
			});

			// Variable assignments: ==<name> — valid after a combination, wildcard or plain
			// word; only an '==<name>' with nothing before it is inert and shows red.
			// Silent '==!<name>' assignments render dimmed + italic.
			work = work.replace(VARIABLE_ASSIGN_REGEX, (match, bang, name, offset, whole) => {
				const valid = /\S\s*$/.test(whole.substring(0, offset));
				let style = valid ? variableStyle : "color:#FF4444; font-weight:bold;";
				if (valid && bang) style += " opacity:0.6; font-style:italic;";
				if (valid) style += variableValueStyle(name);
				return protect(`<span style="${style}"${valid ? variableTitle(name) : ""}>${escapeHTML(match)}</span>`);
			});

			// Variable references: <name> - violet when assigned somewhere, red otherwise
			work = work.replace(VARIABLE_REF_REGEX, (match, name) => {
				const assigned = definedVariables.has(name.toLowerCase());
				const color = assigned ? "#DA70D6" : "#FF4444";
				const extra = assigned ? variableValueStyle(name) : "";
				return protect(`<span style="color:${color}; font-weight:bold;${extra}"${assigned ? variableTitle(name) : ""}>${escapeHTML(match)}</span>`);
			});

			// Escape remaining text
			work = work.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
		
			// Weight numbers
			work = work.replace(/:([0-9]+(?:\.[0-9]+)?)(?=[^)]*?\))/g, (m) =>
				`<span style="color:#4aa3ff; font-weight:bold;">${m}</span>`
			);
		
			// Parentheses
			const parenStyle = "color:#00FFFF; font-weight:bold;";
			work = work.replace(/\(([^)]*?)\)/g, (_, inner) =>
				`<span style="${parenStyle}">(</span>${inner}<span style="${parenStyle}">)</span>`
			);
		
			// Dynamic prompt weights
			work = work.replace(/([0-9]+(?:\.[0-9]+)?::)/g, (m) =>
				`<span style="color:#4aa3ff; font-weight:bold;">${m}</span>`
			);
		
			// Combination options: uniform per-level colors, first option bold
			const comboLevelColors = ["#7CFC00", "#9ce1ff", "#C084FC", "#F4A261"];
			const comboFrameColors = ["#ff6644", "#00CED1", "#DA70D6", "#FFD166"];
			const getDepthColor = (colors, depth) => colors[Math.min(depth, colors.length - 1)];
			const getComboFrameStyle = (depth) => `color:${getDepthColor(comboFrameColors, depth)}; font-weight:bold;`;
			const getUniformFirstOptionStyle = (depth) => `color:${getDepthColor(comboLevelColors, depth)}; font-weight:bold;`;
			const getUniformOtherOptionStyle = (depth) => `color:${getDepthColor(comboLevelColors, depth)}; font-weight:normal;`;

			const splitCombinationOptions = (text) => {
				const options = [];
				let current = "";
				let depth = 0;

				for (const char of text) {
					if (char === "{" ) {
						depth++;
						current += char;
						continue;
					}

					if (char === "}") {
						depth = Math.max(0, depth - 1);
						current += char;
						continue;
					}

					if (char === "|" && depth === 0) {
						options.push(current);
						current = "";
						continue;
					}

					current += char;
				}

				options.push(current);
				return options;
			};

			const findMatchingBrace = (text, startIndex) => {
				let depth = 0;

				for (let i = startIndex; i < text.length; i++) {
					if (text[i] === "{") depth++;
					else if (text[i] === "}") {
						depth--;
						if (depth === 0) return i;
					}
				}

				return -1;
			};

			const formatCombinationBlocks = (text, depth = 0) => {
				let result = "";

				for (let i = 0; i < text.length; i++) {
					if (text[i] !== "{") {
						result += text[i];
						continue;
					}

					const closingIndex = findMatchingBrace(text, i);
					if (closingIndex === -1) {
						result += text[i];
						continue;
					}

					const inner = text.slice(i + 1, closingIndex);
					const options = splitCombinationOptions(inner);
					const comboFrameStyle = getComboFrameStyle(depth);

					// A zero-length chosen branch is marked on its '|' delimiter; the
					// sentinels then straddle the option split (START at the end of one
					// option, END at the start of the next) and would misnest. Strip
					// them and white-mark the pipe itself instead.
					const markedPipes = [];
					for (let k = 0; k < options.length - 1; k++) {
						if (options[k].endsWith(SILVER_SELECTED_RANGE_START) && options[k + 1].startsWith(SILVER_SELECTED_RANGE_END)) {
							options[k] = options[k].slice(0, -1);
							options[k + 1] = options[k + 1].slice(1);
							markedPipes[k] = true;
						} else {
							markedPipes[k] = false;
						}
					}

					const formattedOptions = options.map((option, index) => {
						const optionStyle = index === 0 ? getUniformFirstOptionStyle(depth) : getUniformOtherOptionStyle(depth);
						return `<span style="${optionStyle}">${formatCombinationBlocks(option, depth + 1)}</span>`;
					});

					let joined = "";
					formattedOptions.forEach((formattedOption, index) => {
						joined += formattedOption;
						if (index < formattedOptions.length - 1) {
							const pipeStyle = markedPipes[index]
								? `${comboFrameStyle} background:#f2f2f2; border-radius:2px; padding:0 1px;`
								: comboFrameStyle;
							joined += `<span style="${pipeStyle}">|</span>`;
						}
					});

					result += protect(
						`<span><span style="${comboFrameStyle}">{</span>${joined}<span style="${comboFrameStyle}">}</span></span>`
					);
					i = closingIndex;
				}

				return result;
			};

			work = formatCombinationBlocks(work);

			// Combo separators
			const comboStyle = getComboFrameStyle(0);
			work = work.replace(/\{/g, `<span style="${comboStyle}">{</span>`)
					.replace(/\}/g, `<span style="${comboStyle}">}</span>`)
					.replace(/\|/g, `<span style="${comboStyle}">|</span>`);
		
			// Punctuation
			const punctuationStyle = "color:#FFFF00; font-weight:bold;";
			work = work.replace(/,/g, `<span style="${punctuationStyle}">,</span>`)
					.replace(/\.(?![0-9]|\.)/g, `<span style="${punctuationStyle}">.</span>`);
		
			// Restore tokens
			for (let i = tokens.length - 1; i >= 0; i--) {
				work = work.split(`@@@${SILVER_TOKEN_NONCE}_TOKEN${i}@@@`).join(tokens[i]);
			}

			const selectedChoiceStyle = "background:#f2f2f2; color:#111111; border-radius:2px; padding:0 1px;";
			work = work.split(SILVER_SELECTED_RANGE_START).join(`<span style="${selectedChoiceStyle}">`)
					.split(SILVER_SELECTED_RANGE_END).join(`</span>`);
		
			return work;
		};

		
		// --- Helper: find matching bracket pair indices ---
        const getPlainCursorPosition = (editor, selection) => {
            const range = selection.getRangeAt(0);
            const preRange = range.cloneRange();
            preRange.selectNodeContents(editor);
            preRange.setEnd(range.startContainer, range.startOffset);
            return preRange.cloneContents().textContent.length;
        };

		const getPlainRangeOffsets = (editor, selection) => {
			const range = selection.getRangeAt(0);
			const startRange = range.cloneRange();
			startRange.selectNodeContents(editor);
			startRange.setEnd(range.startContainer, range.startOffset);

			const endRange = range.cloneRange();
			endRange.selectNodeContents(editor);
			endRange.setEnd(range.endContainer, range.endOffset);

			return {
				start: startRange.cloneContents().textContent.length,
				end: endRange.cloneContents().textContent.length,
			};
		};

		const getEditorSelectionState = (editor) => {
			const selection = window.getSelection();
			if (!selection || selection.rangeCount === 0) return null;

			const range = selection.getRangeAt(0);
			if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) {
				return null;
			}

			const { start, end } = getPlainRangeOffsets(editor, selection);
			return {
				start,
				end,
				isCollapsed: selection.isCollapsed,
			};
		};

		const getEditorPlainText = (editor) => editor.textContent || "";

        const setPlainCursorPosition = (editor, offset) => {
            let currentOffset = 0;
            const walker = document.createTreeWalker(
                editor,
                NodeFilter.SHOW_TEXT,
                null,
                false
            );
            let node;

            while (currentOffset <= offset && (node = walker.nextNode())) {
                const nodeLength = node.textContent.length;
                
                if (currentOffset + nodeLength >= offset) {
                    const range = document.createRange();
                    range.setStart(node, offset - currentOffset);
                    range.collapse(true);

                    const sel = window.getSelection();
                    sel.removeAllRanges();
                    sel.addRange(range);
                    return;
                }
                currentOffset += nodeLength;
            }
            
            if (offset >= currentOffset) {
                const range = document.createRange();
                range.selectNodeContents(editor);
                range.collapse(false);

                const sel = window.getSelection();
                sel.removeAllRanges();
                sel.addRange(range);
            }
        };
        
		// Used for text selection + CTRL+UP/DOWN
		// Maps plain-text offsets to a DOM range inside the highlighted markup.
		// Returns null when the offsets are out of range.
		const createPlainRange = (editor, startOffset, endOffset) => {
			let currentOffset = 0;
			let startNode, startNodeOffset, endNode, endNodeOffset;

			const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT, null, false);
			let node;

			while ((node = walker.nextNode())) {
				const nodeLength = node.textContent.length;

				// Find Start
				if (!startNode && currentOffset + nodeLength >= startOffset) {
					startNode = node;
					startNodeOffset = startOffset - currentOffset;
				}
				// Find End
				if (!endNode && currentOffset + nodeLength >= endOffset) {
					endNode = node;
					endNodeOffset = endOffset - currentOffset;
				}

				currentOffset += nodeLength;
				if (startNode && endNode) break;
			}

			if (!startNode || !endNode) return null;

			const range = document.createRange();
			range.setStart(startNode, startNodeOffset);
			range.setEnd(endNode, endNodeOffset);
			return range;
		};

		const setPlainSelectionRange = (editor, startOffset, endOffset) => {
			const sel = window.getSelection();
			const range = createPlainRange(editor, startOffset, endOffset);

			if (range) {
				sel.removeAllRanges();
				sel.addRange(range);
				return;
			}

			if (endOffset <= 0) {
				setPlainCursorPosition(editor, 0);
				return;
			}

			setPlainCursorPosition(editor, endOffset);
		};
		
		// EX: 'aaa ### bbb ###### ccc' -> 'aaa ### bbb # ccc'
		const fixCommentBody = (text) => {
			// Split the input text into individual lines
			const lines = text.split('\n');
			const fixedLines = [];
		
			for (const line of lines) {
				// 1. Find the index of the very first '#'
				const firstHashIndex = line.indexOf('#');
		
				if (firstHashIndex === -1) {
					// If no comment is found on this line, keep the line as is
					fixedLines.push(line);
					continue;
				}
		
				// 2. Determine the end index of the initial consecutive '#' sequence (the comment marker).
				// This ensures the full starting sequence (e.g., '#', '##', or '###') is preserved.
				let initialMarkerEndIndex = firstHashIndex + 1;
				while (initialMarkerEndIndex < line.length && line[initialMarkerEndIndex] === '#') {
					initialMarkerEndIndex++;
				}
		
				// 3. Separate the line into the preserved prefix (code + initial marker)
				// and the mutable comment body.
				const prefixPart = line.substring(0, initialMarkerEndIndex);
		
				// The body is the rest of the line, where the cleaning will occur.
				const commentBodyPart = line.substring(initialMarkerEndIndex);
		
				// 4. Apply replacement to the comment body:
				// The regex /##+/g matches two or more consecutive '#' characters and replaces
				// the entire match with a single '#' character.
				const fixedCommentBody = commentBodyPart.replace(/##+/g, '#');
		
				// 5. Reassemble the line and add it to the results
				const fixedLine = prefixPart + fixedCommentBody;
				fixedLines.push(fixedLine);
			}
		
			// Join the lines back together with newline characters
			return fixedLines.join('\n');
		};

		const normalizePastedText = (text) => {
			return text
				.replace(/\r\n?/g, "\n")
				.replace(/\u00A0/g, " ")
				.replace(/\n{3,}/g, "\n\n");
		};

		const getClipboardPlainText = (e) => {
			const html = e.clipboardData?.getData("text/html");
			if (html) {
				const parser = new DOMParser();
				const doc = parser.parseFromString(html, "text/html");
				const blockElements = new Set([
					"ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DIV", "DL", "FIELDSET",
					"FIGCAPTION", "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4",
					"H5", "H6", "HEADER", "HR", "LI", "MAIN", "NAV", "OL", "P", "PRE",
					"SECTION", "TABLE", "TD", "TH", "TR", "UL"
				]);
				let result = "";

				const walk = (node) => {
					if (node.nodeType === Node.TEXT_NODE) {
						result += node.textContent || "";
						return;
					}

					if (node.nodeType !== Node.ELEMENT_NODE) return;

					const tagName = node.tagName;
					if (tagName === "BR") {
						result += "\n";
						return;
					}

					const isBlock = blockElements.has(tagName);
					if (isBlock && result && !result.endsWith("\n")) {
						result += "\n";
					}

					for (const child of node.childNodes) {
						walk(child);
					}

					if (isBlock && result && !result.endsWith("\n\n")) {
						result += "\n\n";
					}
				};

				for (const child of doc.body.childNodes) {
					walk(child);
				}

				const normalizedHtmlText = normalizePastedText(result.trimEnd());
				if (normalizedHtmlText.includes("\n\n")) {
					return normalizedHtmlText;
				}
			}

			return normalizePastedText(e.clipboardData?.getData("text/plain") || "");
		};
		
		
		async function get_wildcard_files() {
			try {
				const resp = await fetch("/valitools/get_wildcard_files", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({current_wildcard_dir: current_wildcard_directory})
				});
				if (!resp.ok) {
					console.warn("[VSmartPrompt] get_wildcard_files request failed:", resp.status);
					return { wildcard_files: wildcard_files, wildcard_directory: current_wildcard_directory };
				}
				const data = await resp.json();
				wildcard_files = data.wildcard_files || [];
				return data;
			} catch (e) {
				console.warn("[VSmartPrompt] get_wildcard_files error:", e);
				return { wildcard_files: wildcard_files, wildcard_directory: current_wildcard_directory };
			}
		};
		// --- [End of helper functions] ---

		const restoreSavedWidgetValues = (node, values) => {
			if (!Array.isArray(values) || values.length === 0 || !node?.widgets?.length) return;

			const getWidget = (name) => node.widgets.find(w => w?.name === name);
			const assign = (name, index, fallback = undefined) => {
				if (index >= values.length) return;
				const widget = getWidget(name);
				if (!widget) return;
				const value = values[index];
				if (value === undefined) return;
				widget.value = value ?? fallback ?? widget.value;
			};

			assign("available_loras_stem", 0, "");
			assign("seed", 1, 0);
			assign("line_suffix", 3, "");
			assign("single_line_output", 4, true);
			assign("remove_whitespaces", 5, true);
			assign("remove_empty_tags", 6, true);
			assign("load_loras_from_prompt", 7, true);
			assign("remove_loras_pattern", 8, true);
			assign("wildcard_directory", 9, "");
			assign("prompt", 10, "");

			for (const widgetName of ["single_line_output", "remove_whitespaces", "remove_empty_tags"]) {
				const widget = getWidget(widgetName);
				if (widget) widget.value = true;
			}
		};

		const origOnConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function(info) {
			origOnConfigure?.apply(this, arguments);
			const values = Array.isArray(info?.widgets_values) ? info.widgets_values.slice() : null;
			if (!values?.length) return;
			this._silverSavedWidgetValues = values;
			restoreSavedWidgetValues(this, values);
			if (typeof this._silverUpdateEditorContent === "function") {
				this._silverUpdateEditorContent();
			}
			if (Array.isArray(this.widgets_values) && this.widgets_values.length > SILVER_SERIALIZED_WIDGET_COUNT) {
				this.widgets_values = this.widgets_values.slice(0, SILVER_SERIALIZED_WIDGET_COUNT);
			}
		};

		const origOnSerialize = nodeType.prototype.onSerialize;
		nodeType.prototype.onSerialize = function(info) {
			origOnSerialize?.apply(this, arguments);
			if (Array.isArray(info?.widgets_values) && info.widgets_values.length > SILVER_SERIALIZED_WIDGET_COUNT) {
				info.widgets_values = info.widgets_values.slice(0, SILVER_SERIALIZED_WIDGET_COUNT);
			}
		};
		

        const origOnNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function() {
            origOnNodeCreated?.apply(this, arguments);
            console.log("[VSmartPrompt] JS initialized for:", this.title);
			let editor = null;
			this._silverSelectedCombinationRanges = [];
			this._silverResolvedWildcardExecutions = [];
			
			const toggleSpellCheckButton = this.addWidget("button", "Toggle SpellCheck", null, () => {
				if (editor) {
					editor.spellcheck = !editor.spellcheck;
					updateEditorContent();
				}
			});
			toggleSpellCheckButton.serialize = false;
			toggleSpellCheckButton.serializeValue = () => undefined;

			// --- 1. SETUP PROMPT WIDGET AND CUSTOM EDITOR ---
				for (const hiddenWidgetName of ["available_loras_stem", "line_suffix", "single_line_output", "remove_whitespaces", "remove_empty_tags", "load_loras_from_prompt", "remove_loras_pattern"]) {
					const hiddenWidget = this.widgets?.find((w) => w.name === hiddenWidgetName);
					if (!hiddenWidget) continue;
					if (hiddenWidgetName === "single_line_output" || hiddenWidgetName === "remove_whitespaces" || hiddenWidgetName === "remove_empty_tags") {
						hiddenWidget.value = true;
				}
				hiddenWidget.computeSize = () => [0, 0];
				hiddenWidget.y = -600;
				hiddenWidget.hidden = true;
			}

            const prompt_widget = this.widgets?.find(w => w.name === "prompt");
			if (!prompt_widget) {
				console.warn("[VSmartPrompt] Missing hidden prompt widget during node creation.", this);
				return;
			}
			prompt_widget.computeSize = () => [0, 0]; // Force the widget to take 0 height and 0 width
			prompt_widget.y = -600; // Keep this just in case, to push it off-screen visually
            prompt_widget.hidden = true; 

            editor = document.createElement("div");
            editor.contentEditable = "true";
			editor.spellcheck = false;
			
            // ... (CSS styles for editor)
			editor.style.cssText = `
                border: 1px solid var(--border-color);
                border-radius: 6px;
                padding: 6px;
                min-height: 50px;
                white-space: pre-wrap;
                overflow-y: auto;
                font-family: monospace;
                color: #ffffff;
                background: #222222;
                outline: none;
                width: 100%;
                box-sizing: border-box;
            `;
			
			let editorFontSize = 14;          // default font size in px
			const minFontSize = 4;            // minimum safe font size
			const maxFontSize = 256;           // maximum safe font size
            editor.style.fontSize = `${editorFontSize}px`;
			const clearSelectedCombinationRanges = () => {
				this._silverSelectedCombinationRanges = [];
			};
			const clearResolvedWildcardExecutions = () => {
				this._silverResolvedWildcardExecutions = [];
			};
			const clearExecutionHighlights = () => {
				clearSelectedCombinationRanges();
				clearResolvedWildcardExecutions();
				this._silverVariableValues = null;
			};
			const invalidateWildcardValidation = () => {
				lastWildcardValidationSignature = "";
			};
			const scheduleWildcardCacheValidation = (text) => {
				if (!current_wildcard_directory || !Array.isArray(wildcard_files) || wildcard_files.length === 0) return;

				const wildcardMatches = Array.from(text.matchAll(/__([^_]+?)__/g));
				const candidates = [...new Set(
					wildcardMatches
						.map((match) => match[1].trim().replace(/[\\/]+/g, "\\"))
						.map((name) => name.toLowerCase().endsWith(".txt") ? name.slice(0, -4) : name)
						.filter((name) => name && (wildcard_files.includes(name) || wildcard_files.includes(`${name}.txt`)))
				)].sort();

				if (candidates.length === 0) {
					lastWildcardValidationSignature = "";
					if (wildcardValidationTimeout) {
						clearTimeout(wildcardValidationTimeout);
						wildcardValidationTimeout = null;
					}
					return;
				}

				const signature = `${current_wildcard_directory}::${candidates.join("|")}`;
				if (signature === lastWildcardValidationSignature) return;
				lastWildcardValidationSignature = signature;

				if (wildcardValidationTimeout) {
					clearTimeout(wildcardValidationTimeout);
				}

				const requestId = ++wildcardValidationRequestId;
				wildcardValidationTimeout = setTimeout(async () => {
					try {
						const response = await fetch("/valitools/validate_wildcards", {
							method: "POST",
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({
								current_wildcard_dir: current_wildcard_directory,
								wildcard_names: candidates,
							}),
						});
						if (!response.ok || requestId !== wildcardValidationRequestId) return;

						const data = await response.json();
						const existingWildcards = new Set((data.existing_wildcards || []).map((name) => String(name).toLowerCase()));
						const staleCandidates = candidates.filter((name) => !existingWildcards.has(name));
						if (staleCandidates.length === 0) return;

						const staleSet = new Set(staleCandidates);
						const previousLength = wildcard_files.length;
						wildcard_files = wildcard_files.filter((entry) => {
							const normalizedEntry = String(entry).toLowerCase().endsWith(".txt")
								? String(entry).toLowerCase().slice(0, -4)
								: String(entry).toLowerCase();
							return !staleSet.has(normalizedEntry);
						});

						if (wildcard_files.length !== previousLength) {
							updateEditorContent();
						}
					} catch {
						lastWildcardValidationSignature = "";
					} finally {
						if (requestId === wildcardValidationRequestId) {
							wildcardValidationTimeout = null;
						}
					}
				}, 250);
			};

			let findBar = null;

            // Function to synchronize the custom editor from the ComfyUI widget value
            const updateEditorContent = () => {
                const text = prompt_widget.value || "";
				const nextHTML = highlight(text, this._silverSelectedCombinationRanges || [], this._silverResolvedWildcardExecutions || [], getConnectedInputVars(this), this._silverVariableValues || null);
				const shouldRestoreSelection = document.activeElement === editor;
				const savedSelection = shouldRestoreSelection ? getEditorSelectionState(editor) : null;
				const scrollTop = editor.scrollTop;
				const scrollLeft = editor.scrollLeft;

				if (editor.innerHTML !== nextHTML) {
					editor.innerHTML = nextHTML;
				}

				editor.scrollTop = scrollTop;
				editor.scrollLeft = scrollLeft;

				if (shouldRestoreSelection && savedSelection) {
					if (savedSelection.isCollapsed) {
						setPlainCursorPosition(editor, savedSelection.end);
					} else {
						setPlainSelectionRange(editor, savedSelection.start, savedSelection.end);
					}
				}

				scheduleWildcardCacheValidation(text);
				findBar?.refresh(); // match ranges live in the rebuilt markup
                this.setDirtyCanvas(true, true); // Ensure the canvas updates its size if content changes on load
            };
			this._silverUpdateEditorContent = updateEditorContent;

			// --- UNDO / REDO HISTORY -------------------------------------------
			// The browser's native undo is useless here: every keystroke rewrites
			// innerHTML for the syntax highlighting, which wipes its history. This
			// keeps plain-text snapshots instead (typing bursts are coalesced).
			const textHistory = {
				entries: [],
				index: -1,
				lastTime: 0,
				lastWasTyping: false,
				applying: false,
				knownText: null,   // last text WE wrote - lets the widget callback tell own vs external changes
				baselinePending: true, // the first external value (workflow load) replaces the baseline
				MAX: 500,
				COALESCE_MS: 600,
			};

			// ComfyUI's widget setter runs `callback(value)` on every assignment, so all our
			// own writes go through here: knownText marks them, otherwise the callback would
			// mistake each keystroke for an external change and reset the undo history.
			const setWidgetText = (text) => {
				textHistory.knownText = text;
				prompt_widget.value = text;
			};

			const historyReset = (text) => {
				const baseline = text ?? (prompt_widget.value || "");
				textHistory.entries = [{ text: baseline, cursor: 0 }];
				textHistory.index = 0;
				textHistory.lastWasTyping = false;
				textHistory.knownText = baseline;
				findBar?.syncButtons();
			};

			const historyRecord = (text, cursor, isTyping = false) => {
				if (textHistory.applying) return;
				const current = textHistory.entries[textHistory.index];
				if (current && current.text === text) return;

				textHistory.baselinePending = false; // the node is being edited now
				textHistory.knownText = text;
				const now = Date.now();
				const coalesce = isTyping && textHistory.lastWasTyping
					&& now - textHistory.lastTime < textHistory.COALESCE_MS
					&& textHistory.index >= 1; // never fold into the baseline entry

				textHistory.entries.length = textHistory.index + 1; // drop the redo tail
				if (coalesce) {
					textHistory.entries[textHistory.index] = { text, cursor };
				} else {
					textHistory.entries.push({ text, cursor });
					textHistory.index = textHistory.entries.length - 1;
					if (textHistory.entries.length > textHistory.MAX) {
						textHistory.entries.shift();
						textHistory.index--;
					}
				}
				textHistory.lastTime = now;
				textHistory.lastWasTyping = isTyping;
				findBar?.syncButtons();
			};

			const historyApply = (entry) => {
				textHistory.applying = true;
				try {
					setWidgetText(entry.text);
					clearExecutionHighlights();
					invalidateWildcardValidation();
					updateEditorContent();
					editor.focus();
					setPlainCursorPosition(editor, Math.min(entry.cursor ?? 0, entry.text.length));
				} finally {
					textHistory.applying = false;
				}
				textHistory.lastWasTyping = false;
				findBar?.syncButtons();
			};

			const canUndo = () => textHistory.index > 0;
			const canRedo = () => textHistory.index < textHistory.entries.length - 1;
			const historyUndo = () => {
				if (!canUndo()) return;
				textHistory.index--;
				historyApply(textHistory.entries[textHistory.index]);
			};
			const historyRedo = () => {
				if (!canRedo()) return;
				textHistory.index++;
				historyApply(textHistory.entries[textHistory.index]);
			};

			// Single choke point for programmatic text changes (find & replace, ...)
			const applyTextChange = (newText, cursor) => {
				setWidgetText(fixCommentBody(newText));
				clearExecutionHighlights();
				invalidateWildcardValidation();
				updateEditorContent();
				historyRecord(prompt_widget.value, cursor, false);
			};

			historyReset();

			// Re-highlight when in1..in4 sockets connect/disconnect so <in1> validity updates
			const origOnConnectionsChange = this.onConnectionsChange;
			this.onConnectionsChange = (...args) => {
				origOnConnectionsChange?.apply(this, args);
				updateEditorContent();
			};

			if (Array.isArray(this._silverSavedWidgetValues)) {
				restoreSavedWidgetValues(this, this._silverSavedWidgetValues);
			}
            
            // --- FIX FOR REFRESH: INITIAL VALUE LOADING ---
            // 1. Redefine onCreated to use the actual loaded value
			const originalPromptOnCreated = prompt_widget.onCreated;
            prompt_widget.onCreated = (...args) => {
				originalPromptOnCreated?.apply(prompt_widget, args);
                // This ensures the custom editor is populated with the saved value
                // AFTER ComfyUI has loaded it from the backend.
                updateEditorContent(); 
            };
			
			// 2. Add an event listener to the ComfyUI widget to force a visual update
            // if the value is ever changed externally (e.g., via a Load function)
			const originalPromptCallback = prompt_widget.callback;
            prompt_widget.callback = (...args) => {
				const value = prompt_widget.value || "";
				// ComfyUI fires this on EVERY value assignment, ours included - own writes
				// carry knownText and must not touch the history.
				if (value !== textHistory.knownText) {
					clearExecutionHighlights();
					invalidateWildcardValidation();
					updateEditorContent();
					if (textHistory.baselinePending) {
						historyReset(value); // text injected while loading a workflow = new baseline
					} else {
						historyRecord(value, 0, false); // later external change stays undoable
					}
					textHistory.knownText = value;
				}
				originalPromptCallback?.apply(prompt_widget, args);
			};
			
			// Explicitly call the update function at the end of onNodeCreated.
            // This forces the initial visual update using the value already confirmed to be
            // in prompt_widget.value for a newly created node.
            updateEditorContent();
			
			// --- VARIABLE AUTOCOMPLETE (dropdown opens while typing '<') ---
			let autocompleteCtx = null;
			const autocomplete = new AutocompleteDropdown((item) => {
				if (!autocompleteCtx) return;
				const { partialStart, cursorOffset, plainText, kind } = autocompleteCtx;
				autocomplete.hide();
				autocompleteCtx = null;
				const inserted = kind === "wildcard" ? `__${item.name}__` : `<${item.name}>`;
				const updatedText = plainText.substring(0, partialStart) + inserted + plainText.substring(cursorOffset);
				setWidgetText(fixCommentBody(updatedText));
				clearExecutionHighlights();
				invalidateWildcardValidation();
				updateEditorContent();
				const caret = partialStart + inserted.length;
				setPlainCursorPosition(editor, caret);
				historyRecord(prompt_widget.value, caret, false);
			});
			const hideAutocomplete = () => {
				autocomplete.hide();
				autocompleteCtx = null;
			};

			// --- FIND & REPLACE + UNDO/REDO TOOLBAR (CTRL+F / CTRL+H) ---------
			findBar = new FindReplaceBar(editor, {
				getText: () => getEditorPlainText(editor),
				getCaret: () => getEditorSelectionState(editor)?.start ?? 0,
				getSelectedText: () => {
					const state = getEditorSelectionState(editor);
					if (!state || state.isCollapsed) return "";
					return getEditorPlainText(editor).substring(state.start, state.end);
				},
				getSelectionRange: () => {
					// The last selection made in the editor, even after focus moved to the bar
					const state = getEditorSelectionState(editor);
					if (state && !state.isCollapsed) return [state.start, state.end];
					const remembered = editor._silverLastSelection;
					return remembered && remembered[1] > remembered[0] ? remembered : null;
				},
				createRange: (start, end) => createPlainRange(editor, start, end),
				selectRange: (start, end) => setPlainSelectionRange(editor, start, end),
				applyText: (text, cursor) => applyTextChange(text, cursor),
				undo: historyUndo,
				redo: historyRedo,
				canUndo,
				canRedo,
			});
			this._silverFindBar = findBar;

			// CTRL+Click on a wildcard opens its .txt in this overlay editor
			const wildcardEditor = new WildcardEditor();
			this._silverWildcardEditor = wildcardEditor;

			// The compact toolbar follows editor focus / hover; the open find panel stays put.
			// Hover is also tracked on the DOM widget container so it appears anywhere over
			// the node's editor area, and hiding is delayed so the cursor can reach the bar.
			const trackHover = (element) => {
				if (!element) return;
				element.addEventListener("mouseenter", () => findBar.show());
				element.addEventListener("mouseleave", () => {
					if (document.activeElement !== editor) findBar.hideSoon();
				});
			};
			editor.addEventListener("focus", () => findBar.show());
			editor.addEventListener("blur", () => findBar.hideSoon(600));
			trackHover(editor);
			// The widget wrapper only exists once addDOMWidget ran - pick it up afterwards
			setTimeout(() => trackHover(editor.parentElement), 0);

			const updateAutocomplete = () => {
				const sel = window.getSelection();
				if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return hideAutocomplete();

				const cursorOffset = getPlainCursorPosition(editor, sel);
				const plainText = getEditorPlainText(editor);
				const before = plainText.substring(0, cursorOffset);

				// --- wildcards: an ODD number of '__' on the line means one is still open ---
				const lineStart = before.lastIndexOf("\n") + 1;
				const line = before.substring(lineStart);
				const openWildcard = ((line.match(/__/g) || []).length % 2) === 1;
				if (openWildcard) {
					const openIndex = line.lastIndexOf("__");
					const typed = line.substring(openIndex + 2);
					if (WILDCARD_PARTIAL_REGEX.test(typed)) {
						const wildcardPartial = typed.toLowerCase();
						const seen = new Set();
						const wildcardItems = [];
						for (const entry of wildcard_files || []) {
							const name = String(entry);
							if (name.toLowerCase().endsWith(".txt")) continue; // every file is listed twice
							if (seen.has(name)) continue;
							seen.add(name);
							if (!name.toLowerCase().includes(wildcardPartial)) continue;
							wildcardItems.push({ name, display: `__${name}__`, color: "#FFD700" });
						}
						if (wildcardItems.length === 0) return hideAutocomplete();
						// exact prefix matches first, then the rest
						wildcardItems.sort((a, b) => {
							const ap = a.name.toLowerCase().startsWith(wildcardPartial) ? 0 : 1;
							const bp = b.name.toLowerCase().startsWith(wildcardPartial) ? 0 : 1;
							return ap - bp || a.name.localeCompare(b.name);
						});

						const wcRect = sel.getRangeAt(0).getBoundingClientRect();
						const wcEditorRect = editor.getBoundingClientRect();
						autocompleteCtx = {
							kind: "wildcard",
							partialStart: cursorOffset - wildcardPartial.length - 2, // include the '__'
							cursorOffset,
							plainText,
						};
						autocomplete.show(
							wildcardItems.slice(0, 50),
							wcRect.left || wcEditorRect.left,
							(wcRect.bottom || wcEditorRect.top) + 2,
						);
						return;
					}
				}

				const partialMatch = before.match(VARIABLE_PARTIAL_REGEX);
				if (!partialMatch) return hideAutocomplete();
				const partial = partialMatch[1].toLowerCase();

				// Collect assigned variables with their assignment source as preview (last assignment wins)
				const vars = new Map();
				for (const name of getConnectedInputVars(this)) {
					vars.set(name, { name, preview: "input socket" });
				}
				// Variables handed over through 'vars_in' (known after the first run)
				for (const [name, value] of Object.entries(this._silverVariableValues || {})) {
					if (vars.has(name)) continue;
					const preview = String(value).length > 32 ? `${String(value).substring(0, 31)}…` : String(value);
					vars.set(name, { name, preview });
				}
				// Names come from the SAME scan the highlighting uses, so the dropdown can
				// never disagree with it (the preview regex below cannot see an assignment
				// on a nested block like '{a {x|y} b}==<v>' and used to drop those).
				VARIABLE_ASSIGN_SCAN_REGEX.lastIndex = 0;
				let scanMatch;
				while ((scanMatch = VARIABLE_ASSIGN_SCAN_REGEX.exec(plainText)) !== null) {
					const name = scanMatch[1];
					if (!vars.has(name.toLowerCase())) vars.set(name.toLowerCase(), { name, preview: "assigned" });
				}
				// ...then enrich with the assigned source text wherever it can be extracted
				VARIABLE_ASSIGN_PREVIEW_REGEX.lastIndex = 0;
				let m;
				while ((m = VARIABLE_ASSIGN_PREVIEW_REGEX.exec(plainText)) !== null) {
					const preview = m[1].length > 32 ? m[1].substring(0, 31) + "…" : m[1];
					vars.set(m[2].toLowerCase(), { name: m[2], preview });
				}

				const items = [...vars.values()].filter(v => v.name.toLowerCase().startsWith(partial));
				if (items.length === 0) return hideAutocomplete();

				const caretRect = sel.getRangeAt(0).getBoundingClientRect();
				const editorRect = editor.getBoundingClientRect();
				const x = caretRect.left || editorRect.left;
				const y = (caretRect.bottom || editorRect.top) + 2;
				autocompleteCtx = { kind: "variable", partialStart: cursorOffset - partial.length - 1, cursorOffset, plainText };
				autocomplete.show(items, x, y);
			};

			// Re-evaluate the autocomplete context when the cursor is placed by mouse
			editor.addEventListener("click", () => updateAutocomplete());

            // Stop ComfyUI shortcuts
            editor.addEventListener("keydown", (e) => {
				if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) return; // Support for native Ctrl+Enter command

                e.stopPropagation();

				// Own undo/redo: the native one is dead because every edit rewrites innerHTML
				if ((e.ctrlKey || e.metaKey) && !e.altKey) {
					const key = e.key.toLowerCase();
					if (key === 'z') {
						e.preventDefault();
						e.shiftKey ? historyRedo() : historyUndo();
						return;
					}
					if (key === 'y') {
						e.preventDefault();
						historyRedo();
						return;
					}
					if (key === 'f' || key === 'h') {
						e.preventDefault();
						hideAutocomplete();
						findBar.openFind(key === 'h');
						return;
					}
				}

				if (e.key === 'Escape' && findBar.open) {
					e.preventDefault();
					findBar.close();
					return;
				}

				// While the autocomplete dropdown is open, it owns navigation/confirm keys
				if (autocomplete.isOpen) {
					if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
						e.preventDefault();
						autocomplete.move(e.key === 'ArrowDown' ? 1 : -1);
						return;
					}
					if (e.key === 'Enter' || e.key === 'Tab') {
						e.preventDefault(); // also suppresses the keypress Enter handler
						autocomplete.selectCurrent();
						return;
					}
					if (e.key === 'Escape') {
						hideAutocomplete();
						return;
					}
				}
				
				// add text editor behavior with the TAB key but use 4 spaces instead of '\t'
				if (e.key === 'Tab') {
					e.preventDefault(); // CRITICAL: Stop the browser from blurring the element/changing focus
			
					const sel = window.getSelection();
					if (!sel || sel.rangeCount === 0) return;
			
					const plainOffset = getPlainCursorPosition(editor, sel);
					let plainText = getEditorPlainText(editor);
					
					const indentation = '    '; // Using 4 spaces
					
							plainText = plainText.substring(0, plainOffset) + indentation + plainText.substring(plainOffset);
							
							const fixed_text = fixCommentBody(plainText);
							setWidgetText(fixed_text);  // Update ComfyUI widget
							clearExecutionHighlights();
							invalidateWildcardValidation();
							
							updateEditorContent(); // Re-highlight (this calls editor.innerHTML = highlight(text);)
					
					// Set cursor to the position after the inserted characters
					setPlainCursorPosition(editor, plainOffset + indentation.length);
					historyRecord(prompt_widget.value, plainOffset + indentation.length, false);
				}
				
            });
			
            // Intercept 'Enter' to control newlines and cursor movement
            editor.addEventListener("keypress", (e) => {
                if (e.key === 'Enter') {
					
					if (e.ctrlKey || e.metaKey) return; // Support for native Ctrl+Enter command
					
                    e.preventDefault(); 
                    const sel = window.getSelection();
                    if (!sel || sel.rangeCount === 0) return;

                    const plainOffset = getPlainCursorPosition(editor, sel);
                    let plainText = getEditorPlainText(editor);
                    plainText = plainText.substring(0, plainOffset) + "\n" + plainText.substring(plainOffset);
					
						const fixed_text = fixCommentBody(plainText);
						setWidgetText(fixed_text);  // Update ComfyUI widget
						clearExecutionHighlights();
						invalidateWildcardValidation();
						
	                    updateEditorContent(); // Re-highlight

                    setPlainCursorPosition(editor, plainOffset + 1);
                    historyRecord(prompt_widget.value, plainOffset + 1, false);
                }
            });

            // Refactored input handler for cursor stability
            editor.addEventListener("input", () => {
                const sel = window.getSelection();
                if (!sel || sel.rangeCount === 0) return;
                
                const plainOffset = getPlainCursorPosition(editor, sel);
				const plainText = getEditorPlainText(editor);
				
					const fixed_text = fixCommentBody(plainText);
					setWidgetText(fixed_text);  // Update ComfyUI widget
					clearExecutionHighlights();
					invalidateWildcardValidation();
	                
	                updateEditorContent(); // Re-highlight

                setPlainCursorPosition(editor, plainOffset);
                // Group a typed word into one undo step; whitespace/punctuation ends the group
                const typedChar = (prompt_widget.value || "").charAt(plainOffset - 1);
                historyRecord(prompt_widget.value, plainOffset, /[^\s.,;:!?()[\]{}|<>#=]/.test(typedChar));
                updateAutocomplete();
            });

			editor.addEventListener("paste", (e) => {
				e.stopPropagation();
				e.preventDefault();

				const clipboardText = getClipboardPlainText(e);
				if (typeof clipboardText !== "string") return;

				const sel = window.getSelection();
				if (!sel || sel.rangeCount === 0) return;

				const { start, end } = getPlainRangeOffsets(editor, sel);
				const plainText = getEditorPlainText(editor);
					const updatedText = plainText.substring(0, start) + clipboardText + plainText.substring(end);
					const fixed_text = fixCommentBody(updatedText);
					setWidgetText(fixed_text);
					clearExecutionHighlights();
					invalidateWildcardValidation();

				updateEditorContent();
				setPlainCursorPosition(editor, start + clipboardText.length);
				historyRecord(prompt_widget.value, start + clipboardText.length, false);
			});
			
			// Remember the last real selection: focusing the find bar clears the DOM
			// selection, but "search inside the selection" still needs that range.
			const rememberSelection = () => {
				const state = getEditorSelectionState(editor);
				if (state && !state.isCollapsed) editor._silverLastSelection = [state.start, state.end];
			};
			editor.addEventListener("mouseup", rememberSelection);
			editor.addEventListener("keyup", rememberSelection);

			// --- Ensure the element is truly deselected on leaving focus ---
			editor.addEventListener('blur', () => {
				hideAutocomplete();
				rememberSelection();
				const sel = window.getSelection();
				// Crucial: remove any active selection ranges from the contentEditable element
				if (sel.rangeCount > 0) {
					sel.removeAllRanges();
				}
				// Explicitly call blur
				editor.blur();
			});
			
			// --- Allow ComfyUI default zoom behavior with mouse wheel ---
			editor.addEventListener("wheel", (e) => {
				if (e.ctrlKey || e.metaKey) {
					e.preventDefault(); // prevent zooming the whole page
					const delta = Math.sign(e.deltaY);
					editorFontSize -= delta; // scroll up => smaller deltaY => zoom in
					editorFontSize = Math.max(minFontSize, Math.min(maxFontSize, editorFontSize));
					editor.style.fontSize = `${editorFontSize}px`;
					return; // do not forward this event to ComfyUI canvas
				}
				
				e.stopPropagation();
				e.preventDefault();
				// Re-dispatch to ComfyUI canvas manually
				const canvas = document.querySelector("#graph-canvas");
				if (canvas) {
					const newEvent = new WheelEvent(e.type, e);
					canvas.dispatchEvent(newEvent);
				}
			}, { passive: false });
			
			// --- Quick Wildcard Edit ---
			editor.addEventListener("mousedown", (e) => {
				if (e.button === 0 && (e.ctrlKey || e.metaKey)) {
					if (hovered_wildcard_content !== "") {
						e.preventDefault();
						e.stopPropagation();
						
						const wildcardFileName = hovered_wildcard_content.toLowerCase().endsWith(".txt") ? hovered_wildcard_content : `${hovered_wildcard_content}.txt`;
						const baseDir = (current_wildcard_directory || "").replace(/[\\/]+$/, "");
						const wildcard_file_path = baseDir ? `${baseDir}/${wildcardFileName}` : wildcardFileName;
						// Edit the .txt in ComfyUI itself - handing the path to the OS file
						// handler would be a system call (and never works on remote installs)
						wildcardEditor.open(wildcard_file_path, current_wildcard_directory, hovered_wildcard_content, async () => {
							await get_wildcard_files();
							invalidateWildcardValidation();
							updateEditorContent();
						});
					}
				}
			});
			
			
			// ----------------------------------------------------
            // 2. MOUSE/HOVER EVENT LISTENERS FOR WILDCARD QUICK EDIT
            // ----------------------------------------------------
			
            // 2a. Handle mouse movement/hover
			editor.addEventListener("mousemove", (e) => {
				if (editor.style.cursor !== "default") editor.style.cursor = "default"; // Fix cursor changing bug
			
				// Clear early if no mouse coords
				const x = e.clientX;
				const y = e.clientY;
				if (typeof x !== 'number' || typeof y !== 'number') return;
			
				// Helper: get caret range from point (cross-browser)
				const getRangeFromPoint = (x, y) => {
					if (document.caretRangeFromPoint) {
						return document.caretRangeFromPoint(x, y);
					}
					// Firefox
					if (document.caretPositionFromPoint) {
						const pos = document.caretPositionFromPoint(x, y);
						if (!pos) return null;
						const r = document.createRange();
						r.setStart(pos.offsetNode, pos.offset);
						r.setEnd(pos.offsetNode, pos.offset);
						return r;
					}
					return null;
				};
			
				// Helper: gather all text nodes under an element in document order
				const collectTextNodes = (root) => {
					const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null, false);
					const nodes = [];
					let n;
					while ((n = walker.nextNode())) nodes.push(n);
					return nodes;
				};
			
				// Helper: given a container element and a Range, compute the caret index within
				// the container's concatenated text (or return null).
				const caretIndexInElement = (elem, range) => {
					if (!elem || !range) return null;
					// get text nodes under elem
					const textNodes = collectTextNodes(elem);
					if (textNodes.length === 0) return null;
			
					// Determine which text node the range.startContainer is
					let offsetNode = range.startContainer;
					let offset = range.startOffset;
			
					// If the startContainer is an element, try to find nearest text child at offset
					if (offsetNode.nodeType !== Node.TEXT_NODE) {
						// If it's an element, try to get the text node at/after the child index
						const child = offsetNode.childNodes[offset] || offsetNode.childNodes[Math.max(0, offset - 1)];
						// find nearest text node descendant
						offsetNode = (child && (child.nodeType === Node.TEXT_NODE)) ? child :
									(child ? collectTextNodes(child)[0] : null) || null;
						if (!offsetNode) {
							// fallback: try the first text node of elem
							offsetNode = textNodes[0];
							offset = 0;
						} else {
							// if we found a text node inside the child, set offset to 0 (approx)
							offset = 0;
						}
					}
			
					// find index of offsetNode in textNodes
					let idx = -1;
					for (let i = 0; i < textNodes.length; i++) {
						if (textNodes[i] === offsetNode) {
							idx = i;
							break;
						}
					}
					if (idx === -1) {
						// The offsetNode might be outside elem; fallback to first text node
						offsetNode = textNodes[0];
						idx = 0;
						offset = 0;
					}
			
					// sum lengths of previous nodes
					let caretIndex = offset;
					for (let i = 0; i < idx; i++) caretIndex += textNodes[i].textContent.length;
			
					return { caretIndex, textNodes };
				};
			
				// Get the range under the mouse pointer
				const range = getRangeFromPoint(x, y);
				if (!range) {
					hovered_wildcard_content = "";
					return;
				}
			
				// We will try to find the smallest relevant element to compute the local text.
				// Prefer the nearest ancestor element of the range.startContainer that is inside editor.
				let startNode = range.startContainer;
				let elementForSearch = (startNode.nodeType === Node.TEXT_NODE) ? startNode.parentElement : startNode;
			
				// Sanity: ensure elementForSearch is within the editor; otherwise fallback to the event target
				if (!elementForSearch || !editor.contains(elementForSearch)) {
					elementForSearch = e.target && editor.contains(e.target) ? e.target : editor;
				}
			
				// Compute caret index and concatenated text for this element
				const ci = caretIndexInElement(elementForSearch, range);
				if (!ci) {
					hovered_wildcard_content = "";
					return;
				}
				const { caretIndex, textNodes } = ci;
			
				// Build the concatenated text for the element (only once)
				let fullText = "";
				for (const tn of textNodes) fullText += tn.textContent;
				
				
				// Wildcard Quick Edit with CTRL + Left Click
				const wildcardRegex = /__.*?__/g;
				let wm;
				while ((wm = wildcardRegex.exec(fullText)) !== null) {
					const start = wm.index;
					const end = start + wm[0].length;
					if (caretIndex >= start && caretIndex <= end) {
						const content = wm[0].slice(2, -2).replace(/[\\/]+/g, "\\");
						if (content) {
							hovered_wildcard_content = content;
							return;
						}
						break;
					}
				}
				hovered_wildcard_content = "";
			});
            
			
			// 2b. Handle mouse leave
			editor.addEventListener("mouseleave", () => {
				hovered_wildcard_content = "";
			});
			
			
			
			// Support for wildcard pattern re-color based on file existance
            const wildcard_directory_widget = this.widgets?.find(w => w.name === "wildcard_directory");
            if (wildcard_directory_widget) {
				const syncWildcardDirectory = (value) => {
					if (typeof value !== "string") return;
					current_wildcard_directory = value;
					stored_wildcard_directory = value;
					if (wildcard_directory_widget.value !== value) {
						wildcard_directory_widget.value = value;
					}
				};

                // update immediately if value exists
                current_wildcard_directory = wildcard_directory_widget.value || "";

                // --- 1️⃣ Watch for user changes in UI ---
                const original_callback = wildcard_directory_widget.callback;
			                wildcard_directory_widget.callback = async function(value) {
			                    current_wildcard_directory = value || "";
						if (current_wildcard_directory !== stored_wildcard_directory) {
							const data = await get_wildcard_files();
							syncWildcardDirectory(data.wildcard_directory || current_wildcard_directory);
							clearExecutionHighlights();
							invalidateWildcardValidation();
							updateEditorContent();
						}
			                    if (original_callback) original_callback(value);
			                };

                // --- 2️⃣ Catch async load after workflow restore ---
			                setTimeout(async () => {
			                    current_wildcard_directory = wildcard_directory_widget.value || "";
						const data = await get_wildcard_files();
						syncWildcardDirectory(data.wildcard_directory || current_wildcard_directory);
						clearExecutionHighlights();
						invalidateWildcardValidation();
						updateEditorContent();
			                }, 2000);
            }
			
			
            
            // --- Use ComfyUI's DOM widget system ---
            const widget = this.addDOMWidget(`richprompt_widget_${this.id}`, "dom", editor, {
                //computeSize: (w, h) => [w, Math.max(50, Math.max(50, editor.scrollHeight + 10))]
				//computeSize: (w, h) => [w, h]
            });

			// Guard against layout glitches that collapse the DOM widget: keep the
			// node at a sane minimum width and re-assert the editor's full width.
			const MIN_NODE_WIDTH = 360;
			const enforceEditorWidth = () => {
				if (this.size && this.size[0] < MIN_NODE_WIDTH) {
					this.setSize([MIN_NODE_WIDTH, this.size[1]]);
				}
				if (editor.style.width !== "100%") editor.style.width = "100%";
				editor.style.boxSizing = "border-box";
			};
			enforceEditorWidth();
			const origEditorOnResize = this.onResize;
			this.onResize = (...args) => {
				origEditorOnResize?.apply(this, args);
				enforceEditorWidth();
			};
			const origEditorOnConfigure2 = this.onConfigure;
			this.onConfigure = (...args) => {
				origEditorOnConfigure2?.apply(this, args);
				setTimeout(enforceEditorWidth, 0);
			};

			widget.serialize = false;
			widget.serializeValue = () => undefined;
			if (widget.options) {
				widget.options.serialize = false;
			}
			
			const stopPropagation = (e) => {
				// Prevent the event from bubbling up to the ComfyUI canvas listeners
				e.stopPropagation();
				
				// Optional: Stop the default action, though the browser should handle it for contentEditable elements correctly if propagation is stopped.
				// e.preventDefault(); 
			};
			
			// FIX issue caused by: https://github.com/Comfy-Org/ComfyUI_frontend/pull/6087/files
			// Copy/cut PLAIN TEXT only: the default copies the highlighting HTML, and
			// markdown-aware paste targets turn the bold spans into '**...**'.
			const handleCopy = (e) => {
				e.stopPropagation();
				if (!e.clipboardData) return;
				const state = getEditorSelectionState(editor);
				// Offset mapping can fail on odd selections (triple click, selection anchored
				// on an element node). Falling through would let the browser copy the
				// highlighting HTML, so use the raw selection string as a fallback.
				const plain = (state && !state.isCollapsed)
					? getEditorPlainText(editor).substring(state.start, state.end)
					: (window.getSelection()?.toString() ?? "");
				if (!plain) return;
				e.clipboardData.setData("text/plain", plain);
				e.clipboardData.setData("text/html", "");  // never offer a rich flavour
				e.preventDefault();
			};
			editor.addEventListener("copy", handleCopy);
			editor.addEventListener("cut", (e) => {
				const state = getEditorSelectionState(editor);
				handleCopy(e);
				if (!state || state.isCollapsed) return;
				const text = getEditorPlainText(editor);
				setWidgetText(fixCommentBody(text.substring(0, state.start) + text.substring(state.end)));
				clearExecutionHighlights();
				invalidateWildcardValidation();
				updateEditorContent();
				setPlainCursorPosition(editor, state.start);
				historyRecord(prompt_widget.value, state.start, false);
			});
			
			
			
			
			// Attach the locals to the element so the global listener can see them - for CTRL+UP/DOWN Text Weighting feature with native shortcut block support
			editor.prompt_widget = prompt_widget;
			editor.updateEditorContent = updateEditorContent;
			editor.clearSelectedCombinationRanges = clearSelectedCombinationRanges;
			editor.clearResolvedWildcardExecutions = clearResolvedWildcardExecutions;
			editor.clearExecutionHighlights = clearExecutionHighlights;
			editor.invalidateWildcardValidation = invalidateWildcardValidation;
			editor.setPlainSelectionRange = setPlainSelectionRange; // Make sure this helper is available here
			editor.getOffsetFromPoint = (container, offset) => {
				const preRange = document.createRange();
				preRange.selectNodeContents(editor);
				preRange.setEnd(container, offset);
				return preRange.cloneContents().textContent.length;
			};
			editor.silverTextWeighting = function(e) {
				const sel = window.getSelection();
				if (!sel.rangeCount) return;
			
				const range = sel.getRangeAt(0);
				const start = this.getOffsetFromPoint(range.startContainer, range.startOffset);
				const end = this.getOffsetFromPoint(range.endContainer, range.endOffset);
			
				let text = this.textContent || "";
				let selectedText = text.substring(start, end);
				if (!selectedText) return;
			
				const delta = e.key === "ArrowUp" ? 0.05 : -0.05;
				const weightRegex = /^\((.*):([-]?\d+(?:\.\d+)?)\)$/;
				const match = selectedText.match(weightRegex);
			
				let newText;
				if (match) {
					const content = match[1];
					let weight = parseFloat((parseFloat(match[2]) + delta).toFixed(2));
					newText = weight === 1 ? content : `(${content}:${weight})`;
				} else {
					newText = `(${selectedText}:${(1 + delta).toFixed(2)})`;
				}
			
				// Use the attached references
				this.silverSetWidgetText(text.substring(0, start) + newText + text.substring(end));
				if (typeof this.clearExecutionHighlights === "function") {
					this.clearExecutionHighlights();
				}
				if (typeof this.invalidateWildcardValidation === "function") {
					this.invalidateWildcardValidation();
				}
				this.updateEditorContent();
				this.setPlainSelectionRange(this, start, start + newText.length);
				this.silverRecordHistory?.(this.prompt_widget.value, start + newText.length, true);
			};
			editor.silverRecordHistory = historyRecord;
			editor.silverSetWidgetText = setWidgetText;

			const executedListener = (event) => {
				const detail = event?.detail;
				if (!detail || String(detail.node) !== String(this.id)) return;

				const selectedRanges = Array.isArray(detail.output?.selected_ranges) ? detail.output.selected_ranges : [];
				const wildcardResolutions = Array.isArray(detail.output?.wildcard_resolutions) ? detail.output.wildcard_resolutions : [];
				const text = prompt_widget.value || "";
				this._silverSelectedCombinationRanges = normalizeSelectedRanges(selectedRanges, text.length);
				this._silverResolvedWildcardExecutions = normalizeWildcardResolutions(wildcardResolutions, text.length);
				const variableValues = detail.output?.variable_values?.[0];
				this._silverVariableValues = (variableValues && typeof variableValues === "object") ? variableValues : null;
				updateEditorContent();
			};
			api.addEventListener("executed", executedListener);
			this._silverExecutedListener = executedListener;

			// Clear stale white marks on runs where this node was skipped entirely
			// (lazy in1-in4: unused upstream branches never execute). Cached nodes
			// keep their marks - their previous roll is still the live output.
			const executionStartListener = () => { this._silverAwaitingResult = true; };
			const executionCachedListener = (event) => {
				const nodes = event?.detail?.nodes;
				if (Array.isArray(nodes) && nodes.map(String).includes(String(this.id))) {
					this._silverAwaitingResult = false;
				}
			};
			const executedFlagListener = (event) => {
				if (String(event?.detail?.node) === String(this.id)) this._silverAwaitingResult = false;
			};
			const executionDoneListener = () => {
				if (!this._silverAwaitingResult) return;
				this._silverAwaitingResult = false;
				clearExecutionHighlights();
				updateEditorContent();
			};
			api.addEventListener("execution_start", executionStartListener);
			api.addEventListener("execution_cached", executionCachedListener);
			api.addEventListener("executed", executedFlagListener);
			api.addEventListener("execution_success", executionDoneListener);
			this._silverExecutionFlowListeners = [
				["execution_start", executionStartListener],
				["execution_cached", executionCachedListener],
				["executed", executedFlagListener],
				["execution_success", executionDoneListener],
			];
			
			
			
			
			
            this.setDirtyCanvas(true, true);
			
            // cleanup
			const origOnRemoved = this.onRemoved;
            this.onRemoved = function() {
				origOnRemoved?.apply(this, arguments);
                editor.remove();
                autocomplete.cleanup();
				this._silverFindBar?.cleanup();
				this._silverFindBar = null;
				this._silverWildcardEditor?.cleanup();
				this._silverWildcardEditor = null;
				if (this._silverExecutedListener) {
					api.removeEventListener("executed", this._silverExecutedListener);
					this._silverExecutedListener = null;
				}
				if (Array.isArray(this._silverExecutionFlowListeners)) {
					for (const [name, listener] of this._silverExecutionFlowListeners) {
						api.removeEventListener(name, listener);
					}
					this._silverExecutionFlowListeners = null;
				}
				if (wildcardValidationTimeout) {
					clearTimeout(wildcardValidationTimeout);
					wildcardValidationTimeout = null;
				}
            };
        };
		
	
	},
});
