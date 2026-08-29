import { app } from "../../../scripts/app.js";
import { api } from "/scripts/api.js";

// VWaitForVRAM: shows the live free-VRAM reading while the node holds execution,
// so a long wait is visible instead of looking like a hang.

const setStatus = (node, text, waiting) => {
	if (!node) return;
	let widget = node.widgets?.find((w) => w.name === "vram");
	if (!widget) {
		widget = node.addWidget("text", "vram", "", () => {}, { serialize: false });
		widget.disabled = true;
		node.setSize([node.size[0], node.computeSize()[1]]);
	}
	widget.value = text;
	node.color = waiting ? "#6a4a12" : undefined;
	node.setDirtyCanvas(true, true);
};

app.registerExtension({
	name: "Comfy.VWaitForVRAM",
	setup() {
		api.addEventListener("valitools.vram_wait", (event) => {
			const d = event?.detail;
			if (!d) return;
			const node = app.graph?.getNodeById?.(Number(d.node));
			if (!node) return;
			const free = d.free_gb === null ? "-" : `${d.free_gb.toFixed(2)}`;
			setStatus(
				node,
				d.waiting ? `waiting ${free} / ${d.min_free_gb} GB (${d.waited}s)` : `${free} / ${d.min_free_gb} GB free`,
				!!d.waiting,
			);
		});
	},
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData.name !== "VWaitForVRAM") return;
		const onExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			onExecuted?.apply(this, arguments);
			const text = message?.vram?.[0];
			if (text) setStatus(this, `${text} free`, false);
		};
	},
});
