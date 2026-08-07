import { app } from "../../../scripts/app.js";

// VRandomSelector: the backend declares a fixed pool of optional inputs
// (input_1..input_30) so every slot can be lazy. This extension hides the
// pool and instead shows connected slots + exactly one empty trailing slot,
// renamed sequentially. The first connection locks the shared type.

const DYN = /^input_(\d+)$/;
const MAX_INPUTS = 30;

function normalize(node) {
	if (node.__vrs_normalizing || !node.inputs) return;
	node.__vrs_normalizing = true;
	try {
		// Drop every empty dynamic slot.
		for (let i = node.inputs.length - 1; i >= 0; i--) {
			const inp = node.inputs[i];
			if (DYN.test(inp.name) && inp.link == null) node.removeInput(i);
		}

		// Shared type = type of the first connected dynamic slot.
		let type = "*";
		for (const inp of node.inputs) {
			if (!DYN.test(inp.name) || inp.link == null) continue;
			const link = node.graph?.links?.[inp.link];
			if (link?.type && link.type !== "*") {
				type = link.type;
				break;
			}
		}

		// Rename connected slots sequentially and enforce the shared type.
		let n = 0;
		for (const inp of node.inputs) {
			if (!DYN.test(inp.name)) continue;
			inp.name = `input_${++n}`;
			inp.type = type;
		}

		// One empty trailing slot (while below the declared pool size).
		if (n < MAX_INPUTS) node.addInput(`input_${n + 1}`, type);

		if (node.outputs?.[0]) node.outputs[0].type = type;
		node.setSize(node.computeSize());
	} finally {
		node.__vrs_normalizing = false;
	}
}

app.registerExtension({
	name: "Comfy.VRandomSelector",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData.name !== "VRandomSelector") return;

		const onNodeCreated = nodeType.prototype.onNodeCreated;
		nodeType.prototype.onNodeCreated = function () {
			onNodeCreated?.apply(this, arguments);
			// Collapse the declared pool to a single empty slot on fresh nodes.
			// (Loaded workflows overwrite inputs in configure() right after.)
			normalize(this);
		};

		const onConfigure = nodeType.prototype.onConfigure;
		nodeType.prototype.onConfigure = function () {
			this.__vrs_configuring = true;
			onConfigure?.apply(this, arguments);
			// Normalize only after the whole graph (incl. links) is restored.
			setTimeout(() => {
				this.__vrs_configuring = false;
				normalize(this);
			}, 0);
		};

		const onConnectionsChange = nodeType.prototype.onConnectionsChange;
		nodeType.prototype.onConnectionsChange = function (type, index, connected, linkInfo) {
			onConnectionsChange?.apply(this, arguments);
			if (type !== LiteGraph.INPUT || this.__vrs_configuring) return;
			normalize(this);
		};
	},
});
