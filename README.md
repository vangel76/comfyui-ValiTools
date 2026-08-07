# ValiTools

A collection of ComfyUI custom nodes. More tools will be added over time.

## Nodes

### VSmartPrompt

A Dynamic Prompts node with a rich-text (syntax-highlighted) prompt editor.

- **Combinations**: `{a|b}` with optional `N::` weights, nested at will, per-level coloring
- **Wildcards**: `__file__` pulls a random line from a `.txt` in `wildcard_directory` (subfolders supported); CTRL+Click opens or creates the file
- **Variables**: `{a|b}==<name>`, `__file__==<name>` or `word==<name>` store the resolved value - rolled ONCE, constant everywhere you reuse `<name>`; assignments inside combination branches only fire for the selected branch; typing `<` opens an autocomplete dropdown of all assigned variables
- **Comments**: `#` to end of line, inline `#comment#`, `##`/`###` headline styles
- **Post-run feedback**: the branches actually selected during execution are marked in the editor; resolved wildcards show their pulled line on hover
- Outputs: `prompt` (resolved), `original_prompt`

Based on [ComfyUI-RichText_BasicDynamicPrompts](https://github.com/GreenLandisaLie/ComfyUI-RichText_BasicDynamicPrompts) (heavily modified fork).

### VFileRandom

Loads a random image from a folder — like a shuffled deck: no image repeats until every image in the folder has been drawn once, then the deck reshuffles.

- The cycle is remembered per folder in `vfile_random_state.json` (survives ComfyUI restarts)
- Images added mid-cycle join the current cycle; deleted ones are dropped
- `include_subfolders` scans recursively; `reset_cycle` starts a fresh shuffled cycle
- Keep `seed` on *randomize* — it only triggers a new draw each queue; fix it to pause drawing
- Outputs: `image`, `mask` (from alpha), `filename` (relative to folder), `remaining_in_cycle`, `filename_noext`

### VRandomSelector

Passes one of its connected inputs through at random. Accepts any input type — all inputs must share one type; the first connection locks it.

- Variable input count: a new empty slot appears as you connect (up to 30)
- **Lazy evaluation**: only the selected input's upstream branch executes — unselected branches stay cold
- `from_input` / `to_input` restrict the pick to a slot range (0 = no limit)
- Keep `seed` on *randomize* — same seed + same connections = same pick
- Outputs: `selected` (typed like the inputs), `selected_index` (1-based)

# Changelog
- v1.2.1
  - VFileRandom: new `filename_noext` output (filename without extension)
- v1.2.0
  - New node: VRandomSelector — random passthrough of one of N connected same-type inputs, lazy-evaluated, with optional slot-range restriction
- v1.1.0
  - New node: VFileRandom — random image loader with no-repeat shuffle-bag cycling
- v1.0.0
  - Initial release: VSmartPrompt (renamed from the SILVER_BasicDynamicPrompts fork v4.1.0, new node identifier and `/valitools/` API routes so it can coexist with the original)
