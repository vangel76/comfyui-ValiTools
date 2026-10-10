"""Path containment for every file a ValiTools node or route touches.

Widget values and request bodies are untrusted: a workflow can come from anyone
and the /valitools/ routes have no access control. A path is accepted only when
its realpath lies inside one of a fixed set of roots:

- wildcards: the package's own wildcards/ folder
- images:    ComfyUI's input, output and temp folders

plus folders the server admin lists in allowed_folders.json next to this file
(edited on disk only - nothing the browser sends can add a root):

    {"wildcard_dirs": ["/srv/wildcards"], "image_dirs": ["/home/me/pictures"]}
"""
import json
import os
import re

try:
    import folder_paths
except ImportError:  # outside ComfyUI (dev harness)
    folder_paths = None


CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "allowed_folders.json")
DRIVE_PATTERN = re.compile(r"^[A-Za-z]:")


def _configured(key: str) -> list[str]:
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            entries = json.load(f).get(key, [])
    except (OSError, ValueError, AttributeError):
        return []
    return [os.path.expanduser(e) for e in entries if isinstance(e, str) and os.path.isabs(os.path.expanduser(e))]


def contained(path: str, roots: list[str]) -> str | None:
    """realpath of 'path' if it lies inside one of 'roots' (or is one), else None."""
    real = os.path.realpath(path)
    for root in roots:
        real_root = os.path.realpath(root)
        try:
            if os.path.normcase(os.path.commonpath([real, real_root])) == os.path.normcase(real_root):
                return real
        except ValueError:  # different drives on Windows
            continue
    return None


def safe_join(base: str, relative: str) -> str | None:
    """'base/relative' (realpath) for a plain relative path - no absolute path,
    no drive letter, no '..' - that stays inside 'base' after symlinks; else None."""
    if not isinstance(relative, str):
        return None
    relative = relative.strip().replace("\\", "/")
    if not relative or relative.startswith("/") or DRIVE_PATTERN.match(relative):
        return None
    parts = [p for p in relative.split("/") if p not in ("", ".")]
    if not parts or ".." in parts:
        return None
    return contained(os.path.join(base, *parts), [base])


def wildcard_roots(default_dir: str) -> list[str]:
    return [default_dir] + _configured("wildcard_dirs")


def image_base() -> str | None:
    """Folder that relative image paths start in (ComfyUI's input folder)."""
    return folder_paths.get_input_directory() if folder_paths is not None else None


def image_roots() -> list[str]:
    roots = []
    if folder_paths is not None:
        roots += [folder_paths.get_input_directory(), folder_paths.get_output_directory(), folder_paths.get_temp_directory()]
    return roots + _configured("image_dirs")
