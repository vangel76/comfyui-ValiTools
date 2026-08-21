import os
import json
import random
import threading
from pathlib import Path

import numpy as np
import torch
from PIL import Image, ImageOps

IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".tif", ".tiff"}

# Shuffle-bag state lives next to the package so a ComfyUI restart does not
# restart the no-repeat cycle. One entry per (folder, include_subfolders) key.
STATE_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vfile_random_state.json")
_state_lock = threading.Lock()


def _load_state():
    try:
        with open(STATE_FILE, "r", encoding="utf-8") as f:
            state = json.load(f)
        if isinstance(state, dict):
            return state
    except (OSError, ValueError):
        pass
    return {}


def _save_state(state):
    try:
        with open(STATE_FILE, "w", encoding="utf-8") as f:
            json.dump(state, f, indent=1)
    except OSError as e:
        print(f"[VFileRandom] Could not persist state file: {e}")


def _scan_images(folder, include_subfolders):
    files = []
    if include_subfolders:
        for root, _dirs, names in os.walk(folder):
            for name in names:
                if os.path.splitext(name)[1].lower() in IMAGE_EXTENSIONS:
                    files.append(str(Path(root, name).relative_to(folder)))
    else:
        for name in os.listdir(folder):
            if os.path.splitext(name)[1].lower() in IMAGE_EXTENSIONS and os.path.isfile(os.path.join(folder, name)):
                files.append(name)
    files.sort()
    return files


def _draw_from_bag(folder, include_subfolders, seed, reset_cycle):
    """Pick the next image of the no-repeat cycle.

    Returns (relative_name, remaining_after, cycle_total)."""
    files = _scan_images(folder, include_subfolders)
    if not files:
        raise ValueError(f"VFileRandom: no image files found in '{folder}'")

    key = f"{folder}|subfolders={bool(include_subfolders)}"
    rng = random.Random(seed)

    with _state_lock:
        state = _load_state()
        entry = state.get(key) if not reset_cycle else None
        if not isinstance(entry, dict):
            entry = {"remaining": [], "drawn": []}

        fileset = set(files)
        # Drop files deleted from disk; keep bag order for the survivors.
        remaining = [f for f in entry.get("remaining", []) if f in fileset]
        drawn = [f for f in entry.get("drawn", []) if f in fileset]

        # Files added mid-cycle join the current bag at random positions —
        # they have not been shown yet, so they are due before the reshuffle.
        known = set(remaining) | set(drawn)
        for f in files:
            if f not in known:
                remaining.insert(rng.randint(0, len(remaining)), f)

        if not remaining:
            remaining = list(files)
            rng.shuffle(remaining)
            drawn = []

        pick = remaining.pop(rng.randrange(len(remaining)))
        drawn.append(pick)

        state[key] = {"remaining": remaining, "drawn": drawn}
        _save_state(state)

    return pick, len(remaining), len(remaining) + len(drawn)


def _load_image_tensor(path):
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)

    image = np.array(img.convert("RGB")).astype(np.float32) / 255.0
    image = torch.from_numpy(image)[None,]

    if "A" in img.getbands():
        mask = np.array(img.getchannel("A")).astype(np.float32) / 255.0
        mask = 1.0 - torch.from_numpy(mask)
    else:
        mask = torch.zeros((image.shape[1], image.shape[2]), dtype=torch.float32)
    return image, mask.unsqueeze(0)


class VFileRandom:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "folder": ("STRING", {"multiline": False, "default": "", "tooltip": "Absolute path to the folder to draw images from."}),
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "tooltip": "Only triggers a new draw (keep it on 'randomize'); the no-repeat cycle itself is stateful."}),
                "include_subfolders": ("BOOLEAN", {"default": False}),
                "reset_cycle": ("BOOLEAN", {"default": False, "tooltip": "Forget which images were already drawn and start a fresh shuffled cycle on this run."}),
            },
        }

    RETURN_TYPES = ("IMAGE", "MASK", "STRING", "INT", "STRING")
    RETURN_NAMES = ("image", "mask", "filename", "remaining_in_cycle", "filename_noext")
    FUNCTION = "main"
    CATEGORY = "ValiTools"
    DESCRIPTION = """
VFileRandom - load a random image from a folder without repeats.

Draws like a shuffled deck: every image in the folder is shown exactly once
before any image repeats. The cycle is remembered per folder in a state file,
so it survives ComfyUI restarts. Images added to the folder mid-cycle join the
current cycle; deleted ones are dropped.

Outputs the image, its alpha mask, the filename (relative to the folder, also
as a variant without the file extension) and how many images are left before
the deck reshuffles.
"""

    def main(self, folder, seed, include_subfolders, reset_cycle):
        folder = os.path.normpath(os.path.expanduser(folder.strip()))
        if not folder or not os.path.isdir(folder):
            raise ValueError(f"VFileRandom: '{folder}' is not a directory")

        name, remaining, cycle_total = _draw_from_bag(folder, include_subfolders, seed, reset_cycle)
        path = os.path.join(folder, name)
        try:
            image, mask = _load_image_tensor(path)
        except Exception as e:
            raise ValueError(f"VFileRandom: could not load '{path}': {e}")

        drawn = cycle_total - remaining
        print(f"[VFileRandom] {name} ({drawn}/{cycle_total}, {remaining} left in cycle)")
        return {
            "ui": {"cycle": [f"{drawn} / {cycle_total}"]},
            "result": (image, mask, name, remaining, os.path.splitext(name)[0]),
        }


NODE_CLASS_MAPPINGS = {
    "VFileRandom": VFileRandom,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VFileRandom": "VFileRandom",
}
