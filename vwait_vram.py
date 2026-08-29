import time

import torch

import comfy.model_management as model_management
from server import PromptServer


class AnyType(str):
    """A type string that never mismatches - ComfyUI wildcard trick."""

    def __ne__(self, _other):
        return False


any_type = AnyType("*")

BYTES_PER_GB = 1024 ** 3


def _free_vram_gb(device_index: int, count_own_vram: bool = True) -> float | None:
    """
    Free VRAM in GB, or None when there is no CUDA device.

    The driver's free value drops to almost nothing once ComfyUI has a model
    resident, which would make this node block forever from the second render on.
    So by default the memory THIS process holds is counted as available - ComfyUI
    frees its own models when it needs room, and what we really want to wait for is
    memory held by OTHER processes.
    """
    if not torch.cuda.is_available():
        return None
    if device_index >= torch.cuda.device_count():
        raise ValueError(
            f"VWaitForVRAM: device_index {device_index} does not exist "
            f"({torch.cuda.device_count()} CUDA device(s) present)"
        )
    free_bytes, _total = torch.cuda.mem_get_info(device_index)
    if count_own_vram:
        free_bytes += torch.cuda.memory_reserved(device_index)
    return free_bytes / BYTES_PER_GB


class VWaitForVRAM:
    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "min_free_gb": ("FLOAT", {"default": 8.0, "min": 0.0, "max": 1024.0, "step": 0.1, "tooltip": "Hold execution until at least this much VRAM is free on the device."}),
                "device_index": ("INT", {"default": 0, "min": 0, "max": 15, "tooltip": "CUDA device to watch."}),
                "poll_seconds": ("FLOAT", {"default": 2.0, "min": 0.1, "max": 60.0, "step": 0.1, "tooltip": "How often the free memory is checked while waiting."}),
                "timeout_seconds": ("FLOAT", {"default": 0.0, "min": 0.0, "max": 86400.0, "step": 1.0, "tooltip": "Give up after this many seconds. 0 = wait forever (cancel with ComfyUI's stop button)."}),
                "on_timeout": (["continue", "error"], {"default": "continue", "tooltip": "What to do when the timeout is reached: run anyway, or fail the prompt."}),
                "count_own_vram": ("BOOLEAN", {"default": True, "tooltip": "Count VRAM held by THIS ComfyUI as available (it frees its own models when it needs room). Keep this on to wait only for other processes - turning it off makes the node block forever once a model is resident."}),
            },
            "optional": {
                "any_in": (any_type, {"tooltip": "Splice this node into a wire (e.g. the sampler's latent or model input) - it holds back everything DOWNSTREAM of it."}),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = (any_type, "FLOAT")
    RETURN_NAMES = ("any_out", "free_gb")
    FUNCTION = "main"
    CATEGORY = "ValiTools"
    DESCRIPTION = """
VWaitForVRAM - holds execution until the GPU has enough free VRAM.

Splice it into a wire ahead of the memory-hungry part of the graph (the
sampler's latent or model input is the usual spot): everything downstream of
this node waits, the value on 'any_in' is passed through untouched.

Free memory is read from the CUDA driver. VRAM held by this ComfyUI itself is
counted as available by default ('count_own_vram'), because ComfyUI frees its
own models when it needs room - otherwise the node would block forever once a
model is resident. So what you are really waiting for is OTHER processes to let
go. This node only waits: it never unloads or frees anything itself.

Waiting can be cancelled at any time with ComfyUI's stop button. Without a CUDA
device the node passes through immediately.
"""

    @classmethod
    def IS_CHANGED(cls, **kwargs):
        # Never let ComfyUI serve this node from cache: a cached run would skip the
        # wait entirely from the second queued prompt on.
        return float("nan")

    def _report(self, unique_id, free_gb, min_free_gb, waiting, waited):
        if unique_id is None:
            return
        try:
            PromptServer.instance.send_sync("valitools.vram_wait", {
                "node": str(unique_id),
                "free_gb": None if free_gb is None else round(free_gb, 2),
                "min_free_gb": round(min_free_gb, 2),
                "waiting": waiting,
                "waited": round(waited, 1),
            })
        except Exception:
            pass  # a failed status update must never break the run

    def main(self, min_free_gb, device_index, poll_seconds, timeout_seconds, on_timeout, count_own_vram=True, any_in=None, unique_id=None):
        device_index = int(device_index)
        free_gb = _free_vram_gb(device_index, count_own_vram)

        if free_gb is None:
            print("[VWaitForVRAM] No CUDA device - passing through.")
            self._report(unique_id, None, min_free_gb, False, 0.0)
            return (any_in, 0.0)

        started = time.monotonic()
        announced = False

        while free_gb < min_free_gb:
            # Lets ComfyUI's stop button end the wait instead of hanging forever
            model_management.throw_exception_if_processing_interrupted()

            waited = time.monotonic() - started
            if timeout_seconds > 0 and waited >= timeout_seconds:
                message = (f"VWaitForVRAM: only {free_gb:.2f} GB free on cuda:{device_index} "
                           f"after {waited:.0f}s, needed {min_free_gb:.2f} GB")
                if on_timeout == "error":
                    raise RuntimeError(message)
                print(f"[VWaitForVRAM] {message} - continuing anyway.")
                break

            if not announced:
                print(f"[VWaitForVRAM] Waiting for {min_free_gb:.2f} GB free on cuda:{device_index} "
                      f"(currently {free_gb:.2f} GB)...")
                announced = True

            self._report(unique_id, free_gb, min_free_gb, True, waited)
            time.sleep(poll_seconds)  # releases the GIL, the server stays responsive
            free_gb = _free_vram_gb(device_index, count_own_vram)

        waited = time.monotonic() - started
        if announced:
            print(f"[VWaitForVRAM] {free_gb:.2f} GB free after {waited:.1f}s - continuing.")
        self._report(unique_id, free_gb, min_free_gb, False, waited)

        return {
            "ui": {"vram": [f"{free_gb:.2f} / {min_free_gb:.2f} GB"]},
            "result": (any_in, float(free_gb)),
        }


NODE_CLASS_MAPPINGS = {
    "VWaitForVRAM": VWaitForVRAM,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "VWaitForVRAM": "VWaitForVRAM",
}
