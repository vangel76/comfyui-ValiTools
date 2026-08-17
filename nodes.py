import os
import re
import random
import hashlib
from pathlib import Path

from aiohttp import web
from server import PromptServer

import subprocess


WILDCARD_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'wildcards')
LEGACY_WILDCARD_DIR_SUFFIX = "/comfyui-richtext_basicdynamicprompts/wildcards"
LORA_PATTERN = re.compile(
    r'<(?:lora|lora_a|lora_b|lora_visual|lora_a_visual|lora_b_visual|lora_audio|lora_a_audio|lora_b_audio):[^>\n\r]+>',
    re.IGNORECASE,
)

# Variable syntax: '{a|b}==<name>' / '__file__==<name>' assigns, '<name>' references.
# '==!<name>' is the silent variant: it assigns but emits nothing at the definition site.
# Must stay in sync with the variable regexes in web/nodes/nodes.js.
VARIABLE_ASSIGN_PATTERN = re.compile(r'\s*==\s*(!)?<([A-Za-z0-9_]+)>')  # used with .match() right after a combination
VARIABLE_REF_PATTERN = re.compile(r'<([A-Za-z0-9_]+)>')
# 'word==<name>' on fully resolved text: captures the single word right before '=='
LITERAL_ASSIGN_PATTERN = re.compile(r'([^\s{}|<>=]+)\s*==\s*(!)?<([A-Za-z0-9_]+)>')
# Switcher guard: '<name>==value::' / '<name>!=value::' glued to a following '{...}'
# block or '__wildcard__' gates it on the variable's value (case-insensitive).
# Must stay in sync with nodes.js.
GUARD_BEFORE_PATTERN = re.compile(r'<([A-Za-z0-9_]+)>\s*(==|!=)\s*([^:{}|<>\n]*?)::\Z')  # lookback, anchored at construct start
GUARD_SCAN_PATTERN = re.compile(r'<([A-Za-z0-9_]+)>\s*(==|!=)\s*([^:{}|<>\n]*?)::(?=\{|__)')  # final sweep

DEFAULT_PROMPT = r"""### Instructions and Tips

## SYNTAX:

## COMBINATIONS

# They use '{' and '}' delimiters with '|' as separator.
# Distribution is even by default but you can specify custom choice distribution using 'N::' prefix where N is a number from 0 to 1.
# Examples:
   
    A {red|blue} car.  # 50% chance for both red and blue
    A {green|} bird.   # 50% chance for 'green' and 50% for empty string
    {0.1::green|0.2::yellow|{pink|red}} background. # 10% chance for green, 20% for yellow and 70% for {pink|red}
    {child|{jumping up|running} {cat|{large|small}dog}|boring human}. # nested posible with levels colored differently

## WILDCARDS

# These pull a random non-empty line from a TXT file directly stored in 'wildcard_directory'.
# They use double underscore delimiters and its content should be the filename without extension.
# Single '#' comments still go until the end of the line, but '#comment#' can now be used inline too.
# When 'wildcard_directory\filename.txt' does not exist -> the __filename__ string will remain in the prompt.
# Wildcards are highlighted as YELLOW when they point to a .txt file that exists - otherwise, RED. 
# This highlight feature only supports up to 4 nested subfolders - wildcards pointing to deeper files will still work but show up as red.
# You can add comments and combinations within wildcards but try to not create infinite loops when doing so - the node has safety against that though.

    __ThisIsAWildCard__ # pulls from 'wildcard_directory\ThisIsAWildCard.txt' but I don't have that file so this string will appear in the final prompt
    __Folder1\Folder2\ThisIsAWildCard__ # sub-directory support - will pull from 'wildcard_directory\Folder1\Folder2\ThisIsAWildCard.txt'

## You can nest combinations and wildcards at will (ex: combination within wildcard within combination ...)

## VARIABLES

# Append '==<name>' right after a combination or wildcard to remember its resolved value.
# The assignment still outputs its value where it stands - it just also saves it for reuse.
# Reuse the value anywhere AFTER the assignment - even inside later combinations or wildcards - by writing <name>.
# Names may contain letters, digits and underscores and are case-insensitive. Reassigning a name overwrites its value.
# A <name> that is never assigned anywhere stays as-is in the output (and shows up RED in the editor).
# Plain text works too: 'fore-head==<part>' stores the single word (no spaces) right before '=='.
# That also works inside combination branches - only the SELECTED branch's assignment happens: her {face==<part>|fore-head==<part>|head==<part>}
# For a fixed MULTI-WORD text use a single-choice combination: {crime scene}==<loc>
# SILENT assignment: '==!<name>' stores the value but outputs NOTHING where it stands - only the <name> references output it.
# NODE INPUTS: text connected to the in1..in4 input sockets is available here as <in1>..<in4> - chain VSmartPrompt nodes by wiring one's output into another's socket.
# TIP: typing '<' opens a dropdown with all assigned variables - type to filter, UP/DOWN + ENTER/TAB or click to insert, ESC to close.

    {blonde|ginger}==<haircolor> hair            # picks one AND remembers the pick
    her {light <haircolor>|dark <haircolor>} eyebrows match her <haircolor> hair
    __names__==<girlname> enters. Say hi to <girlname>!
    {sunny|rainy|foggy}==!<weather>              # rolls + remembers, outputs nothing here
    the <weather> morning turns into a <weather> afternoon

## SWITCHER (conditional blocks)

# Gate a combination or wildcard on a variable's value: glue '<name>==value::' DIRECTLY in front of it.
# Value matches (case-insensitive) -> it resolves normally. No match -> the whole thing outputs nothing.
# '<name>!=value::' is the NOT form: fires for every value EXCEPT the given one.
# Assign the tag BEFORE the switch. Silent branch tags are perfect for this:

    she is {cutting the wedding cake cake==!<act>|holding a champagne glas glass==!<act>|dancing dance==!<act>}.
    <act>==cake::{she serves the cake|she cuts another slice}
    <act>!=cake::{she is not near the cake}      # fires for glass AND dance
    <act>==cake::__cake_actions__               # wildcards can be gated too

## Word weightning
# This is already natively supported by ComfyUI - in case you didn't know, it reinforces the importance of the encased words.
    (car or something:1.2) # Just showcasing that these are also highlighted

    
## Hotkeys/Shortcuts/Misc:
#     - CTRL + Left Mouse Click on a Yellow wildcard -> opens the file with your default text editor (Notepad++ recommended)
#     - CTRL + Left Mouse Click on a Red wildcard -> creates and opens the file with your default text editor (Notepad++ recommended)
#     - Adjust Font Size with CTRL + Mouse Wheel Up/Down 
#     - CTRL + UP/DOWN (on selected text) mimics ComfyUI's fast text weighting

## TIPS:
#     - This node is (accidentally) fully compatible with subgraphs. This means you can actually add the 'prompt area' as a widget to the subgraph's widgets!
#          To do so: place the node inside a subgraph then outside the subgraph -> right click on it -> Edit subgraph widgets -> Search 'vsmart' and turn the visibility ON for 'richprompt_widget_-1'

"""


def normalize_wildcard_directory(wildcard_dir: str | None) -> str:
    if wildcard_dir is None:
        return WILDCARD_DIR

    normalized = str(wildcard_dir).strip()
    if not normalized:
        return normalized

    normalized_lower = normalized.replace("\\", "/").rstrip("/").lower()
    if normalized_lower.endswith(LEGACY_WILDCARD_DIR_SUFFIX):
        return WILDCARD_DIR

    return normalized


def resolve_wildcard_file_path(wildcard_dir: str, wildcard_name: str) -> str | None:
    wildcard_dir = normalize_wildcard_directory(wildcard_dir)
    if not wildcard_dir:
        return None

    wildcard_path = Path(wildcard_dir)
    valid_wildcard_path = wildcard_path.exists() and wildcard_path.is_dir() and (str(wildcard_path.resolve()) != str(wildcard_path.anchor))
    if not valid_wildcard_path:
        return None

    normalized_name = str(wildcard_name).strip()
    if normalized_name.lower().endswith(".txt"):
        normalized_name = normalized_name[:-4]

    normalized_name = re.sub(r"[\\/]+", "/", normalized_name)
    parts = [p for p in normalized_name.split("/") if p and p not in (".", "..")]
    if not parts:
        return None

    current_dir = wildcard_dir

    for part in parts[:-1]:
        try:
            entries = os.listdir(current_dir)
        except OSError:
            return None

        match = next(
            (entry for entry in entries if entry.lower() == part.lower() and os.path.isdir(os.path.join(current_dir, entry))),
            None,
        )
        if not match:
            return None
        current_dir = os.path.join(current_dir, match)

    target_file = parts[-1]
    try:
        entries = os.listdir(current_dir)
    except OSError:
        return None

    resolved_base = wildcard_path.resolve()
    for entry in entries:
        base_name, ext = os.path.splitext(entry)
        if ext.lower() == ".txt" and base_name.lower() == target_file.lower():
            candidate = os.path.join(current_dir, entry)
            try:
                if not Path(candidate).resolve().is_relative_to(resolved_base):
                    return None
            except (OSError, ValueError):
                return None
            return candidate

    return None


def remove_lora_patterns_from_prompt(prompt: str) -> str:
    return LORA_PATTERN.sub("", prompt)


def dynamic_prompts(
    prompt: str, 
    seed: int, 
    line_suffix: str = "", 
    single_line_output: bool = True,
    remove_whitespaces: bool = True,
    remove_empty_tags: bool = True,
    wildcard_dir: str = WILDCARD_DIR,
    return_trace: bool = False,
    preset_variables: dict[str, str] | None = None) -> str | tuple[str, list[list[int]], list[dict[str, str | int]]]:

    wildcard_dir = normalize_wildcard_directory(wildcard_dir)
    # ONE RNG stream for the whole run. Never reseed mid-run: reseeding per pass
    # replays the same draw sequence and locks picks of different passes together
    # (e.g. a nested wildcard's line pick was 100% correlated with its parent's).
    rng = random.Random(seed)
    source_map = list(range(len(prompt))) if return_trace else None
    selected_ranges: list[list[int]] = []
    selected_range_keys: set[tuple[int, int]] = set()
    wildcard_trace_entries: list[dict[str, str | int]] = []
    wildcard_trace_lookup: dict[int, dict[str, str | int]] = {}
    wildcard_origin_map: list[int | None] | None = [None] * len(prompt) if return_trace else None

    # Source indexes that count as "surviving" in the final filter pass even though
    # their chars never reach the output text: empty-branch marks and variable
    # references replaced by their value (the editor still shows those chars).
    forced_source_indexes: set[int] = set()

    def _append_selected_ranges(choice_source_map: list[int | None] | None, force: bool = False) -> None:
        if choice_source_map is None:
            return

        if force:
            forced_source_indexes.update(i for i in choice_source_map if i is not None)

        def _add(key: tuple[int, int]) -> None:
            if key not in selected_range_keys:
                selected_range_keys.add(key)
                selected_ranges.append([key[0], key[1]])

        current_start = None
        previous = None

        for source_index in choice_source_map:
            if source_index is None:
                if current_start is not None and previous is not None:
                    _add((current_start, previous + 1))
                current_start = None
                previous = None
                continue

            if current_start is None:
                current_start = source_index
                previous = source_index
                continue

            if previous is not None and source_index == previous + 1:
                previous = source_index
                continue

            _add((current_start, previous + 1))
            current_start = source_index
            previous = source_index

        if current_start is not None and previous is not None:
            _add((current_start, previous + 1))

    def _split_lines_with_map(text: str, text_map: list[int | None] | None) -> tuple[list[str], list[list[int | None] | None]]:
        lines: list[str] = []
        line_maps: list[list[int | None] | None] = []
        current_chars: list[str] = []
        current_map: list[int | None] = []
        index = 0

        while index < len(text):
            char = text[index]
            if char == "\r":
                lines.append("".join(current_chars))
                line_maps.append(current_map.copy() if text_map is not None else None)
                current_chars = []
                current_map = []
                if index + 1 < len(text) and text[index + 1] == "\n":
                    index += 1
            elif char == "\n":
                lines.append("".join(current_chars))
                line_maps.append(current_map.copy() if text_map is not None else None)
                current_chars = []
                current_map = []
            else:
                current_chars.append(char)
                if text_map is not None:
                    current_map.append(text_map[index])
            index += 1

        lines.append("".join(current_chars))
        line_maps.append(current_map.copy() if text_map is not None else None)
        return lines, line_maps

    def _strip_text_and_map(text: str, text_map: list[int | None] | None) -> tuple[str, list[int | None] | None]:
        start = 0
        end = len(text)

        while start < end and text[start].isspace():
            start += 1

        while end > start and text[end - 1].isspace():
            end -= 1

        stripped_map = text_map[start:end] if text_map is not None else None
        return text[start:end], stripped_map

    def _find_comment_end(text: str, start_index: int) -> int:
        marker_end = start_index + 1
        while marker_end < len(text) and text[marker_end] == "#":
            marker_end += 1

        # Keep the existing behavior for ##... and ###... comments:
        # they still run until the end of the line.
        if marker_end - start_index > 1:
            return len(text)

        search_index = marker_end
        while search_index < len(text):
            if text[search_index] != "#":
                search_index += 1
                continue

            previous_is_hash = search_index > 0 and text[search_index - 1] == "#"
            next_is_hash = search_index + 1 < len(text) and text[search_index + 1] == "#"
            if not previous_is_hash and not next_is_hash:
                return search_index + 1

            search_index += 1

        return len(text)

    def _remove_comments_and_map(
        text: str,
        text_map: list[int | None] | None,
    ) -> tuple[str, list[int | None] | None]:
        if "#" not in text:
            return text, text_map

        visible_chars: list[str] = []
        visible_map: list[int | None] | None = [] if text_map is not None else None
        index = 0

        while index < len(text):
            if text[index] != "#":
                visible_chars.append(text[index])
                if visible_map is not None:
                    visible_map.append(text_map[index])
                index += 1
                continue

            index = _find_comment_end(text, index)

        return "".join(visible_chars), visible_map

    def _join_text_segments(
        texts: list[str],
        maps: list[list[int | None] | None],
        separator: str,
    ) -> tuple[str, list[int | None] | None]:
        if not texts:
            return "", [] if maps and maps[0] is not None else None

        joined_text_parts: list[str] = []
        joined_map: list[int | None] | None = [] if maps and maps[0] is not None else None

        for index, text_part in enumerate(texts):
            if index > 0:
                joined_text_parts.append(separator)
                if joined_map is not None:
                    joined_map.extend([None] * len(separator))

            joined_text_parts.append(text_part)
            if joined_map is not None and maps[index] is not None:
                joined_map.extend(maps[index])

        return "".join(joined_text_parts), joined_map

    def _filter_selected_ranges_to_source_map(
        ranges: list[list[int]],
        prompt_source_map: list[int | None] | None,
    ) -> list[list[int]]:
        if prompt_source_map is None:
            return ranges

        used_source_indexes = {index for index in prompt_source_map if index is not None} | forced_source_indexes
        if not used_source_indexes:
            return []

        filtered_ranges: list[list[int]] = []
        seen_ranges: set[tuple[int, int]] = set()

        for start, end in sorted(ranges, key=lambda item: (item[0], item[1])):
            current_start = None
            previous = None

            for source_index in range(start, end):
                if source_index not in used_source_indexes:
                    if current_start is not None and previous is not None:
                        key = (current_start, previous + 1)
                        if key not in seen_ranges:
                            seen_ranges.add(key)
                            filtered_ranges.append([key[0], key[1]])
                    current_start = None
                    previous = None
                    continue

                if current_start is None:
                    current_start = source_index
                    previous = source_index
                    continue

                if previous is not None and source_index == previous + 1:
                    previous = source_index
                    continue

                key = (current_start, previous + 1)
                if key not in seen_ranges:
                    seen_ranges.add(key)
                    filtered_ranges.append([key[0], key[1]])
                current_start = source_index
                previous = source_index

            if current_start is not None and previous is not None:
                key = (current_start, previous + 1)
                if key not in seen_ranges:
                    seen_ranges.add(key)
                    filtered_ranges.append([key[0], key[1]])

        return filtered_ranges

    def _collect_wildcard_resolutions(
        prompt_text: str,
        prompt_wildcard_map: list[int | None] | None,
    ) -> list[dict[str, str | int]]:
        if prompt_wildcard_map is None:
            return []

        resolved_fragments: dict[int, list[str]] = {}
        for index, wildcard_id in enumerate(prompt_wildcard_map):
            if wildcard_id is None:
                continue
            resolved_fragments.setdefault(wildcard_id, []).append(prompt_text[index])

        wildcard_resolutions: list[dict[str, str | int]] = []
        for wildcard_id, resolved_chars in resolved_fragments.items():
            entry = wildcard_trace_lookup.get(wildcard_id)
            if not entry:
                continue

            resolved_text = "".join(resolved_chars)
            if not resolved_text:
                continue

            wildcard_resolutions.append({
                "start": entry["start"],
                "end": entry["end"],
                "resolved": resolved_text,
            })

        wildcard_resolutions.sort(key=lambda item: (int(item["start"]), int(item["end"])))
        return wildcard_resolutions

    # --- VARIABLES ({a|b}==<name> / __file__==<name> assigns, <name> references) ---
    # Pre-seeded with the node's string input sockets (in1..in4) so upstream node
    # outputs can be referenced in the text; inserted as-is, never re-resolved.
    # A prompt-internal assignment to the same name overwrites (last assignment wins).
    variables: dict[str, str] = {}
    if preset_variables:
        variables.update({
            str(name).lower(): str(value)
            for name, value in preset_variables.items()
            if value is not None
        })

    def _match_guard_before(text: str, construct_start: int) -> tuple[int, str, str, str] | None:
        """Returns (guard_start, var_name, operator, wanted_value) for a
        '<name>==value::' / '<name>!=value::' prefix glued to the construct at
        construct_start, or None."""
        slice_start = max(0, construct_start - 96)
        gm = GUARD_BEFORE_PATTERN.search(text[slice_start:construct_start])
        if not gm:
            return None
        return slice_start + gm.start(), gm.group(1).lower(), gm.group(2), gm.group(3).strip().lower()

    def _guard_is_true(var_name: str, operator: str, wanted_value: str) -> bool:
        equal = str(variables.get(var_name, "")).strip().lower() == wanted_value
        return equal if operator == "==" else not equal

    def _substitute_variables(
        text: str,
        text_source_map: list[int | None] | None = None,
        text_wildcard_map: list[int | None] | None = None,
    ) -> str | tuple[str, list[int | None] | None, list[int | None] | None]:
        """Replaces '<name>' references with their stored values (substituted text maps to no source)."""
        if not variables or "<" not in text:
            if text_source_map is None:
                return text
            return text, text_source_map, text_wildcard_map

        result_parts: list[str] = []
        result_source_map: list[int | None] | None = [] if text_source_map is not None else None
        result_wildcard_map: list[int | None] | None = [] if text_wildcard_map is not None else None
        last_index = 0

        for match in VARIABLE_REF_PATTERN.finditer(text):
            tail = text[max(0, match.start() - 32):match.start()].rstrip()
            if tail.endswith("!"):
                tail = tail[:-1].rstrip()
            if tail.endswith("=="):
                continue  # '<name>' belongs to a pending 'word==<name>' / 'word==!<name>' assignment

            value = variables.get(match.group(1).lower())
            if value is None:
                continue  # unknown name stays literal

            start, end = match.span()
            result_parts.append(text[last_index:start])
            result_parts.append(value)
            if result_source_map is not None:
                result_source_map.extend(text_source_map[last_index:start])
                result_source_map.extend([None] * len(value))
                # The '<name>' chars leave the output but stay visible in the editor:
                # keep any selection mark covering them (e.g. a '{<in1>|...}' branch).
                forced_source_indexes.update(i for i in text_source_map[start:end] if i is not None)
            if result_wildcard_map is not None:
                result_wildcard_map.extend(text_wildcard_map[last_index:start])
                result_wildcard_map.extend([None] * len(value))
            last_index = end

        result_parts.append(text[last_index:])
        if result_source_map is not None:
            result_source_map.extend(text_source_map[last_index:])
        if result_wildcard_map is not None:
            result_wildcard_map.extend(text_wildcard_map[last_index:])

        updated_text = "".join(result_parts)
        if text_source_map is None:
            return updated_text
        return updated_text, result_source_map, result_wildcard_map

    def _capture_literal_assignments(
        text: str,
        text_source_map: list[int | None] | None = None,
        text_wildcard_map: list[int | None] | None = None,
        only_unbraced: bool = False,
    ) -> str | tuple[str, list[int | None] | None, list[int | None] | None]:
        """
        Handles 'word==<name>' on fully resolved text: stores the single word right
        before '==' and strips the assignment suffix, keeping the word in place.
        Runs after wildcard/combination resolution, so an assignment inside a
        combination branch only happens when that branch was selected.
        With only_unbraced=True (used between resolution passes so switcher guards
        can see branch-inner tags early) assignments still inside any '{...}' are
        left alone - they belong to branches that may never be selected.
        """
        result_parts: list[str] = []
        result_source_map: list[int | None] | None = [] if text_source_map is not None else None
        result_wildcard_map: list[int | None] | None = [] if text_wildcard_map is not None else None
        last_index = 0

        for match in LITERAL_ASSIGN_PATTERN.finditer(text):
            word = match.group(1)
            if "__" in word:
                continue  # unresolved wildcard assignment stays fully literal
            if only_unbraced and (text.count("{", 0, match.start()) - text.count("}", 0, match.start())) > 0:
                continue  # inside an unresolved combination branch

            variables[match.group(3).lower()] = word
            if match.group(2) is None:
                keep_end = match.end(1)  # keep the word, drop the '==<name>' suffix
            else:
                keep_end = match.start()  # 'word==!<name>': silent - the whole assignment vanishes
            result_parts.append(text[last_index:keep_end])
            if result_source_map is not None:
                result_source_map.extend(text_source_map[last_index:keep_end])
            if result_wildcard_map is not None:
                result_wildcard_map.extend(text_wildcard_map[last_index:keep_end])
            last_index = match.end()

        result_parts.append(text[last_index:])
        if result_source_map is not None:
            result_source_map.extend(text_source_map[last_index:])
        if result_wildcard_map is not None:
            result_wildcard_map.extend(text_wildcard_map[last_index:])

        updated_text = "".join(result_parts)
        if text_source_map is None:
            return updated_text
        return updated_text, result_source_map, result_wildcard_map

    def _resolve_fragment(fragment: str) -> str:
        """
        Fully resolves a text fragment (variables, wildcards, combinations) so its
        final value can be stored in a variable. Bounded like the main loop.
        """
        for _ in range(10):
            fragment = _substitute_variables(fragment)
            has_wildcards = "__" in fragment
            has_combinations = "{" in fragment or "}" in fragment
            if not has_wildcards and not has_combinations:
                break
            if has_wildcards:
                fragment = _process_wildcards(fragment, wildcard_dir, seed)
            if has_combinations:
                fragment = _process_combinations(fragment, seed)
        fragment = _capture_literal_assignments(fragment)
        return _substitute_variables(fragment)

    # Updated _fix_prompt signature and logic
    def _fix_prompt(
        prompt: str, 
        line_suffix: str, 
        single_line_output: bool,
        remove_whitespaces: bool,
        remove_empty_tags: bool,
    ) -> str:
        """
        Processes the prompt by:
        1. Removing comments.
        2. Applying line suffix and optionally trimming (based on remove_whitespaces).
        3. Combining lines (based on single_line_output).
        4. Applying default prompt cleaning (e.g., ",," -> ",").
        5. Optionally removing empty tags (based on remove_empty_tags).
    
        Args:
            prompt (str): The initial string.
            line_suffix (str): String to append to each line.
            single_line_output (bool): If True, joins lines with a space; otherwise, joins with a newline.
            remove_whitespaces (bool): If True, strips lines and removes empty ones.
            remove_empty_tags (bool): If True, removes redundant separators like ' , ,' or ' , .'
    
        Returns:
            str: The modified string.
        """
        
        # --- Start of Modified Preprocessing Code ---
        cleaned_lines = []
        lines = prompt.splitlines()
    
        for line in lines:
            line_without_comment, _ = _remove_comments_and_map(line, None)

            # Apply trimming if remove_whitespaces is True
            trimmed_line = line_without_comment.strip() if remove_whitespaces else line_without_comment
            if remove_whitespaces:
                while ("  " in trimmed_line):
                    trimmed_line = trimmed_line.replace("  ", " ")
    
            # Apply the specified line_suffix
            if trimmed_line:
                # Only add suffix if the line is not empty after stripping
                final_line = trimmed_line + line_suffix
                
                # Only add non-empty lines to the cleaned list
                cleaned_lines.append(final_line)
    
        # Convert the cleaned lines back into a single/multi-line string
        # Join with " " for single line output, or "\n" for multi-line output
        joiner = " " if single_line_output else "\n"
        prompt = joiner.join(cleaned_lines)
        # --- End of Modified Preprocessing Code ---
        
        # Default cleaning replacements 
        replacements = {}
        replacements[" ,"] = ","
        replacements[",  "] = ", "
        replacements[" ."] = "."
        replacements[".  "] = ". "
        replacements[".,"] = "."
        replacements[",."] = ","
        replacements[",,"] = ","
        replacements[".."] = "."
        
        empty_tag_replacements = [".,", ",.", ",,", ".."]
        
        # Sort replacements by key length in descending order
        sorted_replacements = sorted(replacements.items(), key=lambda item: len(item[0]), reverse=True)
    
        # The replacement loop runs until no changes are made.
        while True:
            replacement_made_in_pass = False
            current_prompt_state = prompt
    
            for old_substring, new_substring in sorted_replacements:
            
                if not remove_empty_tags and old_substring in empty_tag_replacements:
                    continue
            
                temp_prompt = current_prompt_state
    
                pattern = re.compile(re.escape(old_substring), re.IGNORECASE)
    
                replacements_to_make_in_this_pass = []
                for match in pattern.finditer(temp_prompt):
                    start, end = match.span()
    
                    # Check if this match is inside any <...> tag
                    tag_start_index = temp_prompt.rfind('<', 0, start)
                    if tag_start_index != -1:
                        tag_end_index = temp_prompt.find('>', tag_start_index)
                        if tag_end_index != -1 and tag_end_index > start:
                            continue
    
                    replacements_to_make_in_this_pass.append((start, end, new_substring))
    
    
                # Apply replacements from right to left
                for start, end, new_sub in sorted(replacements_to_make_in_this_pass, key=lambda x: x[0], reverse=True):
                    current_prompt_state = current_prompt_state[:start] + new_sub + current_prompt_state[end:]
                    replacement_made_in_pass = True
    
            if not replacement_made_in_pass:
                break
    
            prompt = current_prompt_state
        
        # --- Logic for remove_empty_tags ---
        if remove_empty_tags:
            temp_prompt = prompt
            
            # Simple cleanup of spacing before running the final delimiter removal
            temp_prompt = temp_prompt.replace(", ", ",").replace(" ,", ",").replace(" .", ".").replace(". ", ".")
            temp_prompt = temp_prompt.replace(",", ", ")
            temp_prompt = re.sub(r'\.(?!\d)', '. ', temp_prompt) # replaces '.' -> '. ' Only if there is no immediate digit after the dot
            
            # Use a loop to remove sequences of a delimiter, optional space, and another delimiter.
            while True:
                initial_len = len(temp_prompt)
                # Replace pattern (separator, optional space, separator) with a single separator
                # e.g., ', , ' -> ', '
                temp_prompt = re.sub(r'([.,])\s*([.,])', r'\1 ', temp_prompt)
                
                if len(temp_prompt) == initial_len:
                    break
            
            # Final cleaning of delimiters (e.g. 'cat,, dog' -> 'cat, dog')
            temp_prompt = temp_prompt.replace(",,", ",").replace("..", ".")
            prompt = temp_prompt
            
            
        prompt = prompt.strip()
        # The existing loop to remove leading/trailing delimiters/spaces
        while prompt.startswith(",") or prompt.startswith(".") or prompt.startswith(" ") or prompt.endswith(",") or prompt.endswith(" "):
            try:
                if prompt.startswith(",") or prompt.startswith(".") or prompt.startswith(" "):
                    prompt = prompt[1:].strip() # Strip again after removing
                if prompt.endswith(",") or prompt.endswith(" "):
                    prompt = prompt[:-1].strip() # Strip again after removing
            except Exception:
                break
        
        return prompt
    
    
    def _process_wildcards(
        prompt: str,
        wildcard_dir: str,
        seed: int,
        prompt_source_map: list[int | None] | None = None,
        prompt_wildcard_map: list[int | None] | None = None,
    ) -> str | tuple[str, list[int | None], list[int | None] | None]:
        """
        Replaces substrings like '__something__' in the prompt with the content of
        the corresponding '.txt' file.
    
        If the file contains multiple lines:
        1. Empty lines and comment lines (#...) are ignored.
        2. One line is randomly selected and returned.
        
        This ensures that only one item (which may contain further dynamic syntax) is
        substituted, regardless of whether combination syntax is present in the file.
        
        Args:
            prompt (str): The input string potentially containing wildcard substrings.
            wildcard_dir (str): The directory to search for wildcard '.txt' files.
            seed (int): An integer seed for the random number generator.
    
        Returns:
            str: The prompt string with wildcards replaced by a single selected line.
        """
        if wildcard_dir is None or not wildcard_dir:
            if prompt_source_map is None:
                return prompt
            return prompt, prompt_source_map, prompt_wildcard_map
        
        wildcard_path = Path(wildcard_dir)
        valid_wildcard_path = wildcard_path.exists() and wildcard_path.is_dir() and (str(wildcard_path.resolve()) != str(wildcard_path.anchor))
        if not valid_wildcard_path:
            print(f"[VSmartPrompt] Invalid wildcard_directory: {wildcard_dir}")
            if prompt_source_map is None:
                return prompt
            return prompt, prompt_source_map, prompt_wildcard_map
        
        # Regex to find '__something__' or '__something.txt__', optionally with a
        # '==<name>' (or silent '==!<name>') variable assignment
        pattern = re.compile(r'__(.+?)__(?:\s*==\s*(!)?<([A-Za-z0-9_]+)>)?')

        def replace_match(match):
            wildcard_name = match.group(1).strip()
            silent_assign = match.group(2) is not None
            variable_name = match.group(3)
    
            if wildcard_name.lower().endswith('.txt'):
                wildcard_name = wildcard_name[:-4]
    
            # Normalize separators and split into parts
            normalized = re.sub(r'[\\/]+', '/', wildcard_name)
            parts = [p for p in normalized.split('/') if p]
    
            if not parts:
                return match.group(0), False
    
            # Resolve path case-insensitively
            filepath = resolve_wildcard_file_path(wildcard_dir, "/".join(parts))
            if not filepath or not os.path.isfile(filepath):
                return match.group(0), False
    
            try:
                with open(filepath, 'r', encoding='utf-8') as f:
                    file_content = f.read()
    
                # Filter lines (ignore empty and comment lines)
                lines = []
                for line in file_content.splitlines():
                    trimmed = line.strip()
                    if not trimmed:
                        continue

                    trimmed, _ = _remove_comments_and_map(trimmed, None)
                    trimmed = trimmed.strip()
                    if trimmed:
                        lines.append(trimmed)
    
                # Choose one random valid line
                chosen = rng.choice(lines) if lines else ""

                if variable_name:
                    chosen = _resolve_fragment(chosen)
                    variables[variable_name.lower()] = chosen
                    if silent_assign:
                        chosen = ""

                return chosen, True

            except Exception as e:
                print(f"Error reading file {filepath}: {e}")
                return match.group(0), False
    
        result_parts: list[str] = []
        result_source_map: list[int | None] | None = [] if prompt_source_map is not None else None
        result_wildcard_map: list[int | None] | None = [] if prompt_wildcard_map is not None else None
        last_index = 0

        for match in pattern.finditer(prompt):
            start, end = match.span()

            # Switcher guard '<name>==value::' glued in front of the wildcard
            emit_until = start
            guard = _match_guard_before(prompt, start)
            if guard is not None:
                guard_start, guard_var, guard_op, guard_value = guard
                if guard_var not in variables:
                    # Tag not assigned yet - keep guard + wildcard untouched for a later pass.
                    result_parts.append(prompt[last_index:end])
                    if result_source_map is not None:
                        result_source_map.extend(prompt_source_map[last_index:end])
                    if result_wildcard_map is not None:
                        result_wildcard_map.extend(prompt_wildcard_map[last_index:end])
                    last_index = end
                    continue
                emit_until = guard_start
                if not _guard_is_true(guard_var, guard_op, guard_value):
                    # Guard false: drop guard + wildcard (incl. its assignment suffix,
                    # which is part of the match) without reading the file.
                    result_parts.append(prompt[last_index:emit_until])
                    if result_source_map is not None:
                        result_source_map.extend(prompt_source_map[last_index:emit_until])
                    if result_wildcard_map is not None:
                        result_wildcard_map.extend(prompt_wildcard_map[last_index:emit_until])
                    last_index = end
                    continue

            replacement, was_resolved = replace_match(match)

            token_source_map = prompt_source_map[start:end] if prompt_source_map is not None else None
            token_wildcard_map = prompt_wildcard_map[start:end] if prompt_wildcard_map is not None else None

            wildcard_origin_id = None
            if was_resolved and token_source_map is not None:
                token_source_indexes = [source_index for source_index in token_source_map if source_index is not None]
                if token_source_indexes:
                    wildcard_origin_id = len(wildcard_trace_entries)
                    wildcard_entry = {
                        "id": wildcard_origin_id,
                        "start": token_source_indexes[0],
                        "end": token_source_indexes[-1] + 1,
                    }
                    wildcard_trace_entries.append(wildcard_entry)
                    wildcard_trace_lookup[wildcard_origin_id] = wildcard_entry

            if was_resolved and wildcard_origin_id is None and token_wildcard_map is not None:
                inherited_ids = [wildcard_id for wildcard_id in token_wildcard_map if wildcard_id is not None]
                unique_inherited_ids = set(inherited_ids)
                if len(unique_inherited_ids) == 1:
                    wildcard_origin_id = inherited_ids[0]

            result_parts.append(prompt[last_index:emit_until])
            result_parts.append(replacement)

            if result_source_map is not None:
                result_source_map.extend(prompt_source_map[last_index:emit_until])
                result_source_map.extend([None] * len(replacement))

            if result_wildcard_map is not None:
                result_wildcard_map.extend(prompt_wildcard_map[last_index:emit_until])
                result_wildcard_map.extend([wildcard_origin_id] * len(replacement))

            last_index = end

        result_parts.append(prompt[last_index:])
        if result_source_map is not None:
            result_source_map.extend(prompt_source_map[last_index:])
        if result_wildcard_map is not None:
            result_wildcard_map.extend(prompt_wildcard_map[last_index:])

        updated_prompt = "".join(result_parts)
        if prompt_source_map is None:
            return updated_prompt

        return updated_prompt, result_source_map, result_wildcard_map
    
    
    def _process_combinations(
        prompt: str,
        seed: int,
        prompt_source_map: list[int | None] | None = None,
        prompt_wildcard_map: list[int | None] | None = None,
    ) -> str | tuple[str, list[int | None], list[int | None] | None]:
        """
        Replaces substrings enclosed in '{...}' with a randomly selected choice
        from their pipe-separated contents.
        """
        pattern = re.compile(r'{([^}{]*)}')

        search_offset = 0
        while True:
            match = pattern.search(prompt, search_offset)
            if not match:
                break

            start, end = match.span()

            # Switcher guard '<name>==value::' glued in front of the block
            replace_start = start
            guard = _match_guard_before(prompt, start)
            if guard is not None:
                guard_start, guard_var, guard_op, guard_value = guard
                if guard_var not in variables:
                    # Tag not assigned yet (e.g. branch-inner 'word==!<name>' still
                    # pending) - defer this block to a later pass.
                    search_offset = match.end()
                    continue
                if not _guard_is_true(guard_var, guard_op, guard_value):
                    # Guard false: remove guard + block + trailing assignment suffix.
                    end_final = end
                    false_suffix = VARIABLE_ASSIGN_PATTERN.match(prompt, end_final)
                    if false_suffix:
                        end_final = false_suffix.end()
                    prompt = prompt[:guard_start] + prompt[end_final:]
                    if prompt_source_map is not None:
                        prompt_source_map = prompt_source_map[:guard_start] + prompt_source_map[end_final:]
                    if prompt_wildcard_map is not None:
                        prompt_wildcard_map = prompt_wildcard_map[:guard_start] + prompt_wildcard_map[end_final:]
                    search_offset = 0
                    continue
                # Guard true: consume the prefix, resolve the block normally.
                replace_start = guard_start

            choices_str = match.group(1)
            choices_source_map = prompt_source_map[start + 1:end - 1] if prompt_source_map is not None else None
            choices_wildcard_map = prompt_wildcard_map[start + 1:end - 1] if prompt_wildcard_map is not None else None
            
            # --- Parse choices and weights ---
            processed_lines = []
            processed_line_maps = []
            processed_wildcard_maps = []
            split_lines, split_line_maps = _split_lines_with_map(choices_str, choices_source_map)
            _, split_wildcard_maps = _split_lines_with_map(choices_str, choices_wildcard_map)

            for line, line_source_map, line_wildcard_map in zip(split_lines, split_line_maps, split_wildcard_maps): # Remove comments and empty lines inside combinations ---
                stripped, stripped_source_map = _strip_text_and_map(line, line_source_map)
                _, stripped_wildcard_map = _strip_text_and_map(line, line_wildcard_map)
                if not stripped:
                    continue

                stripped_without_comments, stripped_source_map = _remove_comments_and_map(stripped, stripped_source_map)
                _, stripped_wildcard_map = _remove_comments_and_map(stripped, stripped_wildcard_map)
                stripped, stripped_source_map = _strip_text_and_map(stripped_without_comments, stripped_source_map)
                _, stripped_wildcard_map = _strip_text_and_map(stripped_without_comments, stripped_wildcard_map)
                if not stripped:
                    continue
            
                processed_lines.append(stripped)
                processed_line_maps.append(stripped_source_map)
                processed_wildcard_maps.append(stripped_wildcard_map)
            
            recombined, recombined_source_map = _join_text_segments(processed_lines, processed_line_maps, "\n")
            _, recombined_wildcard_map = _join_text_segments(processed_lines, processed_wildcard_maps, "\n")
            raw_choices_list = []
            raw_choice_maps = []
            raw_choice_wildcard_maps = []
            # Pre-strip source map per branch: marking fallback for branches whose
            # stripped text is empty (whitespace-only), so the chosen-branch white
            # mark still lands on the branch's characters in the editor.
            raw_choice_mark_maps = []
            current_choice_chars = []
            current_choice_map = []
            current_choice_wildcard_map = []

            def _finish_choice(delimiter_source_index):
                raw_map_snapshot = current_choice_map.copy() if recombined_source_map is not None else None
                choice_text, choice_source_map = _strip_text_and_map(
                    "".join(current_choice_chars),
                    current_choice_map.copy() if recombined_source_map is not None else None,
                )
                _, choice_wildcard_map = _strip_text_and_map(
                    "".join(current_choice_chars),
                    current_choice_wildcard_map.copy() if recombined_wildcard_map is not None else None,
                )
                raw_choices_list.append(choice_text)
                raw_choice_maps.append(choice_source_map)
                raw_choice_wildcard_maps.append(choice_wildcard_map)
                mark_map = None
                if not choice_text:
                    if raw_map_snapshot and any(i is not None for i in raw_map_snapshot):
                        mark_map = raw_map_snapshot
                    elif delimiter_source_index is not None:
                        # Zero-length branch: mark its preceding '|' delimiter instead.
                        mark_map = [delimiter_source_index]
                raw_choice_mark_maps.append(mark_map)

            previous_delimiter_source = None
            for index, char in enumerate(recombined):
                if char == '|':
                    _finish_choice(previous_delimiter_source)
                    previous_delimiter_source = recombined_source_map[index] if recombined_source_map is not None else None
                    current_choice_chars = []
                    current_choice_map = []
                    current_choice_wildcard_map = []
                    continue

                current_choice_chars.append(char)
                if recombined_source_map is not None:
                    current_choice_map.append(recombined_source_map[index])
                if recombined_wildcard_map is not None:
                    current_choice_wildcard_map.append(recombined_wildcard_map[index])

            _finish_choice(previous_delimiter_source)
            
            
            weighted_choices = []
            unweighted_choices = []
            total_defined_weight = 0.0
            
            for item, item_source_map, item_wildcard_map, item_mark_map in zip(raw_choices_list, raw_choice_maps, raw_choice_wildcard_maps, raw_choice_mark_maps):
                if '::' in item:
                    try:
                        weight_str, choice_text = item.split('::', 1)
                        weight = float(weight_str)
                        if not (0 <= weight <= 1):
                            raise ValueError("Weight must be between 0 and 1.")

                        choice_source_map = item_source_map[len(weight_str) + 2:] if item_source_map is not None else None
                        weighted_choices.append({
                            "text": choice_text,
                            "weight": weight,
                            "source_map": choice_source_map,
                            "wildcard_map": item_wildcard_map[len(weight_str) + 2:] if item_wildcard_map is not None else None,
                            "mark_map": None,
                        })
                        total_defined_weight += weight
                    except ValueError:
                        unweighted_choices.append((item, item_source_map, item_wildcard_map, item_mark_map))
                else:
                    unweighted_choices.append((item, item_source_map, item_wildcard_map, item_mark_map))
            
            if total_defined_weight > 1.0:
                for i in range(len(weighted_choices)):
                    weighted_choices[i]["weight"] = weighted_choices[i]["weight"] / total_defined_weight
                total_defined_weight = 1.0
                
            remaining_weight = 1.0 - total_defined_weight
            
            if unweighted_choices:
                if remaining_weight < 0:
                    remaining_weight = 0
                    
                equal_share_for_unweighted = remaining_weight / len(unweighted_choices)
                for choice_text, choice_source_map, choice_wildcard_map, choice_mark_map in unweighted_choices:
                    weighted_choices.append({
                        "text": choice_text,
                        "weight": equal_share_for_unweighted,
                        "source_map": choice_source_map,
                        "wildcard_map": choice_wildcard_map,
                        "mark_map": choice_mark_map,
                    })
    
            # --- Perform selection ---
            selected_choice = ""
            selected_choice_source_map = None
            selected_choice_wildcard_map = None
            selected_choice_mark_map = None
            if not weighted_choices:
                selected_choice = ""
            else:
                choice_indexes = list(range(len(weighted_choices)))
                weights_list = [item["weight"] for item in weighted_choices]

                selected_index = rng.choices(choice_indexes, weights=weights_list, k=1)[0]
                selected_choice = weighted_choices[selected_index]["text"]
                selected_choice_source_map = weighted_choices[selected_index]["source_map"]
                selected_choice_wildcard_map = weighted_choices[selected_index]["wildcard_map"]
                selected_choice_mark_map = weighted_choices[selected_index].get("mark_map")

            if selected_choice_mark_map:
                # Whitespace-only branch: its output is empty, mark the branch's
                # original (pre-strip) characters so the pick is still visible.
                _append_selected_ranges(selected_choice_mark_map, force=True)
            elif selected_choice_source_map is not None:
                _append_selected_ranges(selected_choice_source_map)

            # '{...}==<name>': fully resolve the picked choice, store it, and consume the
            # suffix. '{...}==!<name>' additionally emits nothing at the definition site.
            assignment = VARIABLE_ASSIGN_PATTERN.match(prompt, end)
            if assignment:
                resolved_value = _resolve_fragment(selected_choice)
                variables[assignment.group(2).lower()] = resolved_value
                end = assignment.end()
                if assignment.group(1) is not None:
                    # Silent assignment: emits nothing, but keep the chosen branch
                    # white-marked in the editor (its chars never reach the output).
                    if prompt_source_map is not None:
                        forced_source_indexes.update(i for i in (selected_choice_source_map or []) if i is not None)
                        selected_choice_source_map = []
                    resolved_value = ""
                    if prompt_wildcard_map is not None:
                        selected_choice_wildcard_map = []
                elif resolved_value != selected_choice:
                    # Nested syntax resolved into generated text: the output maps to no
                    # source characters, but the branch's original chars stay visible in
                    # the editor - keep their selection mark alive through the filter.
                    if prompt_source_map is not None:
                        forced_source_indexes.update(i for i in (selected_choice_source_map or []) if i is not None)
                        selected_choice_source_map = [None] * len(resolved_value)
                    if prompt_wildcard_map is not None:
                        selected_choice_wildcard_map = [None] * len(resolved_value)
                # else: the value is byte-identical to the branch text - keep its source
                # maps so the post-run selection marking survives.
                selected_choice = resolved_value

            # Replace the matched inner block (and a consumed guard prefix) with the selected choice
            prompt = prompt[:replace_start] + selected_choice + prompt[end:]
            if prompt_source_map is not None:
                prompt_source_map = prompt_source_map[:replace_start] + (selected_choice_source_map or []) + prompt_source_map[end:]
            if prompt_wildcard_map is not None:
                prompt_wildcard_map = prompt_wildcard_map[:replace_start] + (selected_choice_wildcard_map or []) + prompt_wildcard_map[end:]
            search_offset = 0
    
        if prompt_source_map is None:
            return prompt

        return prompt, prompt_source_map, prompt_wildcard_map
    
    
    # --- Main function body: Fix applied here ---
    
    # NOTE: reference substitution deliberately happens only AFTER the resolution loop:
    # substituting during the loop would fill '<name>' inside not-yet-captured
    # 'word==<name>' assignments and freeze references to stale values.
    max_process_count = 30
    while max_process_count > 0:

        has_wildcards = "__" in prompt
        has_combinations = "{" in prompt or "}" in prompt

        if not has_wildcards and not has_combinations:
            break # Exit the loop if no more dynamic content is found

        iteration_snapshot = (prompt, len(variables))

        # Process wildcards recursively (NO _fix_prompt call here)
        if has_wildcards:
            max_subprocess_count = 10
            while max_subprocess_count > 0:
                if "__" in prompt:
                    if source_map is None:
                        prompt = _process_wildcards(prompt, wildcard_dir, seed)
                    else:
                        prompt, source_map, wildcard_origin_map = _process_wildcards(prompt, wildcard_dir, seed, source_map, wildcard_origin_map)
                else:
                    break
                max_subprocess_count -= 1

        # Process combinations recursively (NO _fix_prompt call here)
        if has_combinations:
            max_subprocess_count = 30
            while max_subprocess_count > 0:
                if "{" in prompt or "}" in prompt:
                    if source_map is None:
                        prompt = _process_combinations(prompt, seed)
                    else:
                        prompt, source_map, wildcard_origin_map = _process_combinations(prompt, seed, source_map, wildcard_origin_map)
                else:
                    break
                max_subprocess_count -= 1

        # Capture bare 'word==<name>' assignments (outside any braces) between passes
        # so switcher guards can see branch-inner tags on the next pass.
        if source_map is None:
            prompt = _capture_literal_assignments(prompt, only_unbraced=True)
        else:
            prompt, source_map, wildcard_origin_map = _capture_literal_assignments(prompt, source_map, wildcard_origin_map, only_unbraced=True)

        if (prompt, len(variables)) == iteration_snapshot:
            break  # only deferred guards (unassigned tags) remain - the sweep handles them

        max_process_count -= 1

    if max_process_count == 0 and ("__" in prompt or "{" in prompt or "}" in prompt):
        print("[VSmartPrompt] Warning: processing limit reached; possible infinite loop in prompt.")

    def _sweep_guards(
        text: str,
        text_source_map: list[int | None] | None = None,
        text_wildcard_map: list[int | None] | None = None,
    ) -> str | tuple[str, list[int | None] | None, list[int | None] | None]:
        """
        Removes leftover guarded constructs whose tag was never assigned or whose
        guard is false. A (rare) true guard surviving the loop just loses its prefix
        and leaves its construct as literal text.
        """
        block_after = re.compile(r'\{[^{}]*\}(?:\s*==\s*!?<[A-Za-z0-9_]+>)?')
        wildcard_after = re.compile(r'__.+?__(?:\s*==\s*!?<[A-Za-z0-9_]+>)?')

        result_parts: list[str] = []
        result_source_map: list[int | None] | None = [] if text_source_map is not None else None
        result_wildcard_map: list[int | None] | None = [] if text_wildcard_map is not None else None
        last_index = 0

        for gm in GUARD_SCAN_PATTERN.finditer(text):
            if gm.start() < last_index:
                continue
            construct = block_after.match(text, gm.end()) or wildcard_after.match(text, gm.end())
            construct_end = construct.end() if construct else gm.end()
            guard_true = gm.group(1).lower() in variables and _guard_is_true(gm.group(1).lower(), gm.group(2), gm.group(3).strip().lower())

            result_parts.append(text[last_index:gm.start()])
            if result_source_map is not None:
                result_source_map.extend(text_source_map[last_index:gm.start()])
            if result_wildcard_map is not None:
                result_wildcard_map.extend(text_wildcard_map[last_index:gm.start()])
            last_index = gm.end() if guard_true else construct_end

        result_parts.append(text[last_index:])
        if result_source_map is not None:
            result_source_map.extend(text_source_map[last_index:])
        if result_wildcard_map is not None:
            result_wildcard_map.extend(text_wildcard_map[last_index:])

        updated_text = "".join(result_parts)
        if text_source_map is None:
            return updated_text
        return updated_text, result_source_map, result_wildcard_map

    # Plain-word assignments on the fully resolved text, then the guard sweep, then a
    # final substitution pass for all references (including ones that appeared before
    # their assignment).
    if source_map is None:
        prompt = _capture_literal_assignments(prompt)
        prompt = _sweep_guards(prompt)
        prompt = _substitute_variables(prompt)
    else:
        prompt, source_map, wildcard_origin_map = _capture_literal_assignments(prompt, source_map, wildcard_origin_map)
        prompt, source_map, wildcard_origin_map = _sweep_guards(prompt, source_map, wildcard_origin_map)
        prompt, source_map, wildcard_origin_map = _substitute_variables(prompt, source_map, wildcard_origin_map)

    wildcard_resolutions: list[dict[str, str | int]] = []
    if return_trace:
        wildcard_resolutions = _collect_wildcard_resolutions(prompt, wildcard_origin_map)

    # 1. FINAL CLEANING: Run _fix_prompt ONCE on the fully resolved string
    prompt = _fix_prompt(
        prompt=prompt, 
        line_suffix=line_suffix, 
        single_line_output=single_line_output, 
        remove_whitespaces=remove_whitespaces, 
        remove_empty_tags=remove_empty_tags
    )
    
    if return_trace:
        selected_ranges = _filter_selected_ranges_to_source_map(selected_ranges, source_map)
        selected_ranges.sort(key=lambda item: (item[0], item[1]))
        return prompt, selected_ranges, wildcard_resolutions

    return prompt


class VSmartPrompt:    
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                # Kept to preserve the widget order expected by older saved workflows.
                "available_loras_stem": ("STRING", {"default": "", "dynamicPrompts": False, "tooltip": "Compatibility placeholder for older workflows. This field is kept only to preserve widget ordering."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "tooltip": "Same seed + same prompt + same connected in1-in4 texts always returns the same output prompt. Changed input text re-rolls the picks even with a fixed seed."}),
                "line_suffix": ("STRING", {"multiline": False, "default": "", "dynamicPrompts": False, "tooltip": "Appends this string to the end of every line. Useful to automate suffixing of tags and descriptive text with either commas or single dots."}),
                "single_line_output": ("BOOLEAN", {"default": True, "tooltip": "This must be True for multi-line combinations to work."}),
                "remove_whitespaces": ("BOOLEAN", {"default": True, "tooltip": "Trims every line and converts multiple spaces to single space, ex: '   ' -> ' '. Also removes empty lines."}),
                "remove_empty_tags": ("BOOLEAN", {"default": True, "tooltip": "'tags' here is anything between dots or commas. Fixes cases like this: 'cat,,  , dog' -> 'cat, dog'."}),
                "load_loras_from_prompt": ("BOOLEAN", {"default": True, "tooltip": "Compatibility placeholder for older workflows. LoRA loading is no longer handled by this node."}),
                "remove_loras_pattern": ("BOOLEAN", {"default": True, "tooltip": "Compatibility placeholder for older workflows. When enabled, LoRA tags are stripped from the final prompt text."}),
                "wildcard_directory": ("STRING", {"multiline": False, "default": WILDCARD_DIR, "dynamicPrompts": False, "tooltip": "The directory where TXT wildcard files are stored."}),
            },
            "optional": {
                "prompt": ("STRING", {"multiline": True, "default": DEFAULT_PROMPT, "dynamicPrompts": False}),
                "in1": ("STRING", {"forceInput": True, "lazy": True, "tooltip": "External text, reference it in the prompt as <in1>. Inserted as-is (not re-resolved). The upstream branch only executes if <in1> appears in the prompt."}),
                "in2": ("STRING", {"forceInput": True, "lazy": True, "tooltip": "External text, reference it in the prompt as <in2>. Inserted as-is (not re-resolved). The upstream branch only executes if <in2> appears in the prompt."}),
                "in3": ("STRING", {"forceInput": True, "lazy": True, "tooltip": "External text, reference it in the prompt as <in3>. Inserted as-is (not re-resolved). The upstream branch only executes if <in3> appears in the prompt."}),
                "in4": ("STRING", {"forceInput": True, "lazy": True, "tooltip": "External text, reference it in the prompt as <in4>. Inserted as-is (not re-resolved). The upstream branch only executes if <in4> appears in the prompt."}),
            },
        }

    RETURN_TYPES = ("STRING","STRING",)
    RETURN_NAMES = ("prompt", "original_prompt",)
    FUNCTION = "main"
    CATEGORY = "ValiTools"
    DESCRIPTION = """
VSmartPrompt - Dynamic Prompts with a rich-text editor, variables and post-run highlighting.

Place a new instance of this node to get the full instructions.

INPUTS:

line_suffix: Appends this string to the end of every line. Useful to automate suffixing of tags and descriptive text with either commas or single dots.

single_line_output: This must be True for multi-line combinations to work.

remove_whitespaces: Trims every line and converts multiple spaces to single space, ex: '   ' -> ' '. Also removes empty lines.

remove_empty_tags: 'tags' here is anything between dots or commas. Fixes cases like this: 'cat,,  , dog' -> 'cat, dog'.

load_loras_from_prompt: Legacy compatibility toggle kept only to preserve widget ordering in older workflows.

remove_loras_pattern: Legacy compatibility toggle that strips LoRA tags from the output prompt text.

wildcard_directory: The directory where TXT wildcard files are stored.
"""

    INPUT_SOCKET_NAMES = ("in1", "in2", "in3", "in4")

    def check_lazy_status(self, prompt=DEFAULT_PROMPT, **kwargs):
        # Request a connected input only when '<inN>' actually appears in the prompt
        # text - otherwise the whole upstream branch is never executed.
        needed = []
        for name in self.INPUT_SOCKET_NAMES:
            if name in kwargs and kwargs[name] is None and re.search(rf'<{name}>', prompt or "", re.IGNORECASE):
                needed.append(name)
        return needed

    def main(self, available_loras_stem, seed, line_suffix, single_line_output, remove_whitespaces, remove_empty_tags, load_loras_from_prompt, remove_loras_pattern, wildcard_directory, prompt=DEFAULT_PROMPT, **kwargs):
        _ = available_loras_stem, load_loras_from_prompt
        # Skipped (unused) lazy inputs arrive as None - treated like unconnected ones.
        in1, in2, in3, in4 = (kwargs.get(name) for name in self.INPUT_SOCKET_NAMES)
        single_line_output = True
        remove_whitespaces = True
        remove_empty_tags = True
        wildcard_directory = normalize_wildcard_directory(wildcard_directory)

        # Mix connected input texts into the effective seed: when an upstream node's
        # output changes, this node's combination/wildcard picks re-roll too - even
        # with a fixed seed widget. Same seed + same inputs stays fully reproducible.
        connected_inputs = "\x1f".join(f"{name}={value}" for name, value in (("in1", in1), ("in2", in2), ("in3", in3), ("in4", in4)) if value is not None)
        if connected_inputs:
            input_digest = int.from_bytes(hashlib.sha256(connected_inputs.encode("utf-8")).digest()[:8], "big")
            seed = (seed ^ input_digest) & 0xffffffffffffffff

        dp, selected_ranges, wildcard_resolutions = dynamic_prompts(
            prompt=prompt,
            seed=seed,
            line_suffix=line_suffix,
            single_line_output=single_line_output,
            remove_whitespaces=remove_whitespaces,
            remove_empty_tags=remove_empty_tags,
            wildcard_dir=wildcard_directory,
            return_trace=True,
            preset_variables={"in1": in1, "in2": in2, "in3": in3, "in4": in4},
        )

        if remove_loras_pattern:
            cleaned_dp = remove_lora_patterns_from_prompt(dp)
            if cleaned_dp != dp:
                dp = cleaned_dp
            if remove_whitespaces or remove_empty_tags:
                dp = dynamic_prompts(prompt=dp, seed=seed, line_suffix=line_suffix, single_line_output=single_line_output, remove_whitespaces=remove_whitespaces, remove_empty_tags=remove_empty_tags, wildcard_dir=wildcard_directory)
        
        return {
            "ui": {
                "selected_ranges": selected_ranges,
                "wildcard_resolutions": wildcard_resolutions,
            },
            "result": (dp, prompt),
        }
@PromptServer.instance.routes.post("/valitools/get_wildcard_files")
async def get_wildcard_files(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"wildcard_files": [], "wildcard_directory": ""}, status=400)
    current_wildcard_dir = normalize_wildcard_directory(data.get("current_wildcard_dir", ""))
    if not current_wildcard_dir:
        return web.json_response({"wildcard_files": [], "wildcard_directory": current_wildcard_dir})
    
    wildcard_files = []
    wildcard_path = Path(current_wildcard_dir)
    if current_wildcard_dir and wildcard_path.exists() and wildcard_path.is_dir() and (str(wildcard_path.resolve()) != str(wildcard_path.anchor)): # ignore cases like 'C:\'
        for root, dirs, files in os.walk(current_wildcard_dir):
            
            relative_path = Path(root).relative_to(wildcard_path)
            
            depth = len(relative_path.parts)
            if depth > 4:
                dirs.clear() # Clear the 'dirs' list to prevent os.walk from descending into subdirectories of the current 'root' folder.
                continue # Skip processing files in this folder
            
            for file in files:
                if file.endswith(".txt"):
                    full_file_path = Path(root) / file
                    relative_file_path = full_file_path.relative_to(wildcard_path) # Determine the relative path of the file inside current_wildcard_dir. The Path.relative_to() method is perfect for this.
                    relative_path_no_ext = relative_file_path.parent / relative_file_path.stem
                    wildcard_files.append(str(relative_path_no_ext).lower())
                    wildcard_files.append(str(relative_path_no_ext).lower() + ".txt") # fast way to add support for: __filename.txt__
    
    return web.json_response({"wildcard_files": wildcard_files, "wildcard_directory": current_wildcard_dir})


@PromptServer.instance.routes.post("/valitools/validate_wildcards")
async def validate_wildcards(request):
    try:
        data = await request.json()
    except Exception:
        return web.json_response({"existing_wildcards": []}, status=400)
    current_wildcard_dir = normalize_wildcard_directory(data.get("current_wildcard_dir", ""))
    wildcard_names = data.get("wildcard_names", [])

    existing_wildcards = []
    if current_wildcard_dir and isinstance(wildcard_names, list):
        seen = set()
        for wildcard_name in wildcard_names:
            if not isinstance(wildcard_name, str):
                continue

            normalized_name = wildcard_name.strip().replace("/", "\\").replace("\\\\", "\\")
            normalized_name = normalized_name[:-4] if normalized_name.lower().endswith(".txt") else normalized_name
            normalized_lower = normalized_name.lower()
            if not normalized_lower or normalized_lower in seen:
                continue

            seen.add(normalized_lower)
            if resolve_wildcard_file_path(current_wildcard_dir, normalized_name):
                existing_wildcards.append(normalized_lower)

    return web.json_response({"existing_wildcards": existing_wildcards})


@PromptServer.instance.routes.post("/valitools/quick_open_wildcard")
async def quick_open_wildcard(request):
    try:
        try:
            data = await request.json()
        except Exception:
            return web.json_response({"success": False, "error": "Invalid JSON"}, status=400)

        file_path = data.get("file_path")
        if isinstance(file_path, str):
            file_path = os.path.normpath(file_path.replace("\\", os.sep).replace("/", os.sep))

        if not file_path:
            return web.json_response({"success": False, "error": "No wildcard file path provided"})

        if not file_path.lower().endswith(".txt"):
            return web.json_response({"success": False, "error": "Only .txt files can be opened"})

        wildcard_dir = normalize_wildcard_directory(data.get("wildcard_dir") or "")
        if wildcard_dir:
            try:
                resolved_file = Path(file_path).resolve()
                resolved_dir = Path(wildcard_dir).resolve()
                if not resolved_file.is_relative_to(resolved_dir):
                    return web.json_response({"success": False, "error": "Access denied: path outside wildcard directory"})
            except (OSError, ValueError):
                return web.json_response({"success": False, "error": "Invalid file path"})

        parent_dir = os.path.dirname(file_path)
        if parent_dir and not os.path.exists(parent_dir):
            os.makedirs(parent_dir, exist_ok=True)

        if not os.path.exists(file_path):
            with open(file_path, "a", encoding="utf-8"):
                pass

        if os.name == 'nt': # Windows
            os.startfile(file_path)
        elif os.uname().sysname == 'Darwin': # macOS
            subprocess.call(('open', file_path))
        else: # Linux and others
            subprocess.call(('xdg-open', file_path))

        return web.json_response({"success": True})

    except Exception as e:
        print(f"Error in quick_open_wildcard: {e}")
        return web.json_response({"success": False, "error": str(e)}, status=500)

NODE_CLASS_MAPPINGS = {
    "VSmartPrompt": VSmartPrompt,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VSmartPrompt": "VSmartPrompt",
}

