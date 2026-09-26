import { JSDOM } from "jsdom";
import fs from "fs";
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const w = dom.window;
for (const k of ["window","document","Node","DOMParser","HTMLElement","Element","Range","getSelection","requestAnimationFrame","cancelAnimationFrame","MutationObserver","CustomEvent","Event","KeyboardEvent","navigator","getComputedStyle","ResizeObserver"]) {
  if (w[k] === undefined) continue; try { Object.defineProperty(globalThis, k, { value: (typeof w[k] === "function" && k[0] === k[0].toLowerCase()) ? w[k].bind(w) : w[k], configurable: true, writable: true }); } catch {}
}
if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe(){} disconnect(){} unobserve(){} };
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
globalThis.fetch = async () => ({ ok: true, json: async () => ({ files: [], results: {} }) });
// Fresh copy of the repo's web/ into hz/web on every run (a symlink would resolve to the real
// path and the "../../../scripts" imports would escape the harness); the absolute
// "/scripts/api.js" import in nodes.js is rewritten in the copy.
const repoWeb = new URL("../../web/", import.meta.url).pathname;
const hzWeb = new URL("./hz/web/", import.meta.url).pathname;
fs.rmSync(hzWeb, { recursive: true, force: true });
fs.cpSync(repoWeb, hzWeb, { recursive: true });
const nodesPath = hzWeb + "nodes/nodes.js";
fs.writeFileSync(nodesPath, fs.readFileSync(nodesPath, "utf8").replace('"/scripts/api.js"', '"../../../scripts/api.js"'));
const { app } = await import("./scripts/app.js");
const { api } = await import("./scripts/api.js");
const { FindReplaceBar } = await import("./hz/web/widgets/find_replace_bar.js");
for (const m of ["refresh","refreshVersions","refreshMode","refreshSlots","syncButtons","show"]) {
  const orig = FindReplaceBar.prototype[m];
  FindReplaceBar.prototype[m] = function(...a) { console.log("   -> "+m+" called from", (new Error().stack.split("\n")[2]||"").trim().slice(0,110)); try { const r = orig.apply(this, a); if (m==="refreshVersions") console.log("   refreshVersions ran; info=", JSON.stringify(this.api.versions.info()).slice(0,120)); return r; } catch (e) { console.log("   !! " + m + " threw:", e.stack.split("\n").slice(0,3).join(" | ")); throw e; } };
}
await import("./hz/web/nodes/nodes.js");
const ext = app.extensions.find(e => e.beforeRegisterNodeDef);
function NodeType() {}
await ext.beforeRegisterNodeDef(NodeType, { name: "VSmartPrompt" }, app);
const text = fs.readFileSync(process.argv[2], "utf8");
const WN = ["available_loras_stem","seed","control_after_generate","line_suffix","single_line_output","remove_whitespaces","remove_empty_tags","load_loras_from_prompt","remove_loras_pattern","wildcard_directory","prompt"];
const mk = (id, promptText, properties) => {
  const node = Object.create(NodeType.prototype);
  Object.assign(node, {
    id, title: "test"+id, size: [800, 600], properties, inputs: [], widgets_values: [],
    widgets: WN.map(n => ({ name: n, value: n === "prompt" ? promptText : (n === "seed" ? 1 : (n === "control_after_generate" ? "randomize" : "")), options: {} })),
    setDirtyCanvas() {}, setSize() {}, computeSize() { return [800, 600]; },
    addWidget(type, name, value, cb) { const wdg = { type, name, value, callback: cb, options: {} }; this.widgets.push(wdg); return wdg; },
    addDOMWidget(name, type, element, opts) { const wdg = { name, type, element, options: opts || {}, value: "" }; this.widgets.push(wdg); document.body.appendChild(element); return wdg; },
  });
  return node;
};
const poke = (node) => { const ed = node.widgets.find(w => w.element)?.element; if (ed) { ed.dispatchEvent(new w.Event("focus")); ed.dispatchEvent(new w.Event("mouseenter")); ed.dispatchEvent(new w.Event("focusin", { bubbles: true })); } };
const inspect = (label) => {
  const v = [...document.querySelectorAll("button")].filter(b => b.textContent === "V").pop();
  const sel = [...document.querySelectorAll("select")].pop();
  console.log(label, "| V title:", JSON.stringify((v?.title || "").slice(0, 40)), "| V bg:", v?.style.background, "| select options:", [...(sel?.options || [])].map(o => o.textContent), "hidden:", sel?.hidden);
};
try {
  const n1 = mk(7, text, {});
  NodeType.prototype.onNodeCreated.call(n1); n1._silverUpdateEditorContent();
  api.dispatch("executed", { node: "7", output: { selected_ranges: [], wildcard_resolutions: [], variable_values: [{}] } });
  poke(n1); inspect("after run on fresh node");
  // --- simulate tab switch: serialize + recreate + configure
  const info = JSON.parse(JSON.stringify({ id: 7, widgets_values: n1.widgets.filter(w => !w.element && w.type !== "button").map(w => w.value), properties: n1.properties }));
  console.log("serialized properties keys:", Object.keys(info.properties), "versions bytes:", (info.properties.valitools_versions || "").length);
  document.body.innerHTML = "";
  const n2 = mk(7, "", info.properties);            // litegraph sets properties before onConfigure
  NodeType.prototype.onNodeCreated.call(n2);
  n2.widgets_values = info.widgets_values;
  NodeType.prototype.onConfigure.call(n2, info);
  n2.onConfigure?.(info);
  poke(n2); inspect("after re-create + configure");
  api.dispatch("executed", { node: "7", output: { selected_ranges: [], wildcard_resolutions: [], variable_values: [{}] } });
  poke(n2); inspect("after second run");
  console.log("prompt restored:", JSON.stringify((n2.widgets.find(w=>w.name==="prompt").value||"").slice(0,30)));
} catch (e) { console.log("THROWS:", e.stack.split("\n").slice(0, 8).join("\n")); }
setTimeout(() => process.exit(0), 300);
