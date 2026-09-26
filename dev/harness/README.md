# Headless harnesses

- `python3 resolve.py PROMPT.txt [SEED] [--main]` — resolver only, no ComfyUI needed.
- `npm install` once, then `node editor.mjs PROMPT.txt` — editor + toolbar in jsdom:
  onNodeCreated → executed event → serialize → re-create → onConfigure (tab switch), prints toolbar state.
  `hz/web` is re-copied from the repo's `web/` on every run (the absolute `/scripts/api.js` import is rewritten in the copy).
  runner rewrites on the fly, so no copy of the sources is needed.
