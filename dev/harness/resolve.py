#!/usr/bin/env python3
"""Run nodes.py's resolver outside ComfyUI.  usage: resolve.py PROMPT.txt [SEED] [--main]
Stubs aiohttp/server, imports ../../nodes.py, prints the resolved prompt.
--main goes through the node's main() (LoRA cleanup path, ui outputs)."""
import sys, types, importlib.util, os
aio = types.ModuleType("aiohttp"); aio.web = types.SimpleNamespace(json_response=lambda *a, **k: None, Response=lambda *a, **k: None)
sys.modules["aiohttp"] = aio
srv = types.ModuleType("server")
class _PS:
    class instance:
        routes = types.SimpleNamespace(get=lambda *a, **k: (lambda f: f), post=lambda *a, **k: (lambda f: f))
srv.PromptServer = _PS
sys.modules["server"] = srv
here = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location("nodes", os.path.join(here, "..", "..", "nodes.py"))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
args = [a for a in sys.argv[1:] if not a.startswith("--")]
text = open(args[0], encoding="utf-8").read()
seed = int(args[1]) if len(args) > 1 else 1
if "--main" in sys.argv:
    cls = next(v for k, v in vars(m).items() if isinstance(v, type) and getattr(v, "FUNCTION", "") == "main" and "VSmartPrompt" in k)
    print(cls().main("", seed, "", False, True, False, True, True, "/nonexistent", prompt=text)["result"][0])
else:
    print(m.dynamic_prompts(text, seed, single_line_output=False, remove_whitespaces=True, remove_empty_tags=False))
