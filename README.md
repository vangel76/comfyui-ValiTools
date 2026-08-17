# ValiTools

A collection of ComfyUI custom nodes. More tools will be added over time.

## Nodes

### VSmartPrompt

A Dynamic Prompts node with a rich-text (syntax-highlighted) prompt editor.

- **Combinations**: `{a|b}` with optional `N::` weights, nested at will, per-level coloring
- **Wildcards**: `__file__` pulls a random line from a `.txt` in `wildcard_directory` (subfolders supported); CTRL+Click opens or creates the file
- **Variables**: `{a|b}==<name>`, `__file__==<name>` or `word==<name>` store the resolved value - rolled ONCE, constant everywhere you reuse `<name>`; assignments inside combination branches only fire for the selected branch; typing `<` opens an autocomplete dropdown of all assigned variables. Silent variant `==!<name>` stores the value but outputs nothing at the definition site - only the `<name>` references emit it (references work even before the assignment)
- **Comments**: `#` to end of line, inline `#comment#`, `##`/`###` headline styles
- **Post-run feedback**: the branches actually selected during execution are marked in the editor; resolved wildcards show their pulled line on hover
- **String inputs**: four optional input sockets `in1`-`in4`; connected text is available in the prompt as `<in1>`-`<in4>` (inserted as-is, not re-resolved) - chain VSmartPrompt nodes by wiring one's output into another's socket
- **Switcher**: glue `<name>==value::` directly in front of a `{...}` block or `__wildcard__` to gate it on a variable's value (case-insensitive) - match resolves normally, mismatch outputs nothing. `<name>!=value::` is the NOT form (fires for every other value). Tag the state with silent branch assignments (`{... cake==!<act>|... glass==!<act>}`), then later `<act>==cake::{...}` / `<act>!=cake::{...}`. Works with `in1`-`in4` too; assign the tag before the switch
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
- v1.7.0
  - VSmartPrompt: switcher NOT guards - `<name>!=value::` fires for every value except the given one; never-assigned variables remove the construct like with `==`
- v1.6.4
  - VSmartPrompt: the white mark for a chosen zero-length branch (`{text|}`) now actually renders - it marks the `|` delimiter (the mark's HTML previously misnested across the branch split and was dropped by the browser)
- v1.6.3
  - VSmartPrompt: guard against the prompt editor collapsing to a narrow strip - editor asserts full node width (100% + border-box), node keeps a 360px minimum width, re-checked on resize and workflow load
- v1.6.2
  - VSmartPrompt: selection marks survive on branches whose stored value differs from the branch text (e.g. `{large chest chest==!<part>|stomach}==<part>`); silent `==!<name>` blocks now also white-mark their chosen branch
- v1.6.1
  - VSmartPrompt: `in1`-`in4` are lazy - an upstream node chain only executes when its `<inN>` actually appears in the prompt text; nodes skipped this way get their stale white selection marks cleared after the run (cached nodes keep theirs)
- v1.6.0
  - VSmartPrompt: switcher guards - `<name>==value::` glued before a `{...}` block or `__wildcard__` gates it on a variable's value; false or never-assigned guards remove the construct (and skip its assignments); guards render orange in the editor (red when the variable is unassigned)
- v1.5.1
  - VSmartPrompt: fixed a serious RNG bias - the resolver reseeded the random generator with the same seed on every resolution pass, replaying the identical draw stream and locking picks of different passes together (worst case: a nested wildcard's line pick was 100% correlated with its parent's - half of the combinations could never occur). One RNG stream per run now; note: the same seed produces a different (unbiased) result than in older versions
- v1.5.0
  - VSmartPrompt: connected `in1`-`in4` texts are mixed into the effective seed - when an upstream node re-rolls, this node's combination/wildcard picks re-roll too, even with a fixed seed. Same seed + same prompt + same input texts stays fully reproducible
- v1.4.3
  - VSmartPrompt: post-run selection marking now survives variable substitution - a chosen branch consisting of references (e.g. `{0.4::<in1>|<in2>}`) marks the `<name>` chars in the editor
- v1.4.2
  - VSmartPrompt: post-run selection marking now also shows picks of empty / whitespace-only branches - the branch's spaces are marked, or for zero-length branches the preceding `|` delimiter
- v1.4.1
  - VSmartPrompt: fixed CTRL+Left/Right word jump (and CTRL+SHIFT word selection) inside the editor - was swallowed by the global CTRL+arrow listener
- v1.4.0
  - VSmartPrompt: four optional string input sockets `in1`-`in4`, referenced in the prompt as `<in1>`-`<in4>` for chaining VSmartPrompt nodes; connected sockets show in the autocomplete dropdown and validate the references violet
- v1.3.0
  - VSmartPrompt: silent variable assignment `==!<name>` - assigns without emitting the value at the definition site; works on all three forms (`{a|b}==!<name>`, `__file__==!<name>`, `word==!<name>`); silent assignments render dimmed/italic in the editor
- v1.2.1
  - VFileRandom: new `filename_noext` output (filename without extension)
- v1.2.0
  - New node: VRandomSelector — random passthrough of one of N connected same-type inputs, lazy-evaluated, with optional slot-range restriction
- v1.1.0
  - New node: VFileRandom — random image loader with no-repeat shuffle-bag cycling
- v1.0.0
  - Initial release: VSmartPrompt (renamed from the SILVER_BasicDynamicPrompts fork v4.1.0, new node identifier and `/valitools/` API routes so it can coexist with the original)
