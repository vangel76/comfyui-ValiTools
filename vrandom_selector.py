import re
import random

MAX_DECLARED_INPUTS = 30
INPUT_NAME_PATTERN = re.compile(r"input_(\d+)")


class AnyType(str):
    """A type string that never mismatches — ComfyUI wildcard trick."""

    def __ne__(self, _other):
        return False


any_type = AnyType("*")


class VRandomSelector:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "seed": ("INT", {"default": 0, "min": 0, "max": 0xffffffffffffffff, "tooltip": "Same seed with the same connected inputs always picks the same one. Keep it on 'randomize' for a new pick each queue."}),
                "from_input": ("INT", {"default": 0, "min": 0, "max": MAX_DECLARED_INPUTS, "tooltip": "Restrict the pick to inputs numbered from this one on. 0 = no lower limit."}),
                "to_input": ("INT", {"default": 0, "min": 0, "max": MAX_DECLARED_INPUTS, "tooltip": "Restrict the pick to inputs numbered up to this one. 0 = no upper limit."}),
            },
            # The frontend (web/nodes/vrandom_selector.js) shows one empty slot and
            # grows the list as the user connects. Declaring the whole pool here is
            # what lets every slot be lazy: only the selected input's upstream
            # branch is executed.
            "optional": {
                f"input_{i}": (any_type, {"lazy": True}) for i in range(1, MAX_DECLARED_INPUTS + 1)
            },
        }

    RETURN_TYPES = (any_type, "INT")
    RETURN_NAMES = ("selected", "selected_index")
    FUNCTION = "main"
    CATEGORY = "ValiTools"
    DESCRIPTION = """
VRandomSelector - passes one of its connected inputs through at random.

Connect as many inputs as you like (a new empty slot appears as you connect);
all inputs must share one type, and the first connection locks that type.
Only the selected input's upstream branch is executed (lazy evaluation) - the
other branches stay cold.

from_input / to_input restrict the pick to a slot range (0 = no limit).
Outputs the selected value and its 1-based input index.
"""

    @classmethod
    def VALIDATE_INPUTS(cls, input_types):
        return True

    @staticmethod
    def _pick(seed, from_input, to_input, connected_names):
        pool = sorted(
            int(m.group(1))
            for name in connected_names
            if (m := INPUT_NAME_PATTERN.fullmatch(name))
        )
        lo = from_input if from_input > 0 else 1
        hi = to_input if to_input > 0 else (pool[-1] if pool else 0)
        pool = [i for i in pool if lo <= i <= hi]
        if not pool:
            return None
        return f"input_{random.Random(seed).choice(pool)}"

    def check_lazy_status(self, seed, from_input, to_input, **kwargs):
        pick = self._pick(seed, from_input, to_input, list(kwargs.keys()))
        if pick is not None and kwargs.get(pick) is None:
            return [pick]
        return []

    def main(self, seed, from_input, to_input, **kwargs):
        pick = self._pick(seed, from_input, to_input, list(kwargs.keys()))
        if pick is None:
            connected = [k for k in kwargs if INPUT_NAME_PATTERN.fullmatch(k)]
            raise ValueError(
                f"VRandomSelector: no connected input in range "
                f"[{from_input or 1}..{to_input or 'last'}] (connected: {len(connected)})"
            )
        index = int(INPUT_NAME_PATTERN.fullmatch(pick).group(1))
        return (kwargs[pick], index)


NODE_CLASS_MAPPINGS = {
    "VRandomSelector": VRandomSelector,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VRandomSelector": "VRandomSelector",
}
