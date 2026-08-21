import { app } from "../../../scripts/app.js";

// VFileRandom: shows the no-repeat cycle progress ("45 / 235") on the node
// after each run, so the user can see when the deck is about to reshuffle.

app.registerExtension({
	name: "Comfy.VFileRandom",
	beforeRegisterNodeDef(nodeType, nodeData) {
		if (nodeData.name !== "VFileRandom") return;

		const onExecuted = nodeType.prototype.onExecuted;
		nodeType.prototype.onExecuted = function (message) {
			onExecuted?.apply(this, arguments);
			const text = message?.cycle?.[0];
			if (!text) return;

			let widget = this.widgets?.find((w) => w.name === "cycle");
			if (!widget) {
				widget = this.addWidget("text", "cycle", "", () => {}, { serialize: false });
				widget.disabled = true;
				this.setSize([this.size[0], this.computeSize()[1]]);
			}
			widget.value = text;
			this.setDirtyCanvas(true, true);
		};
	},
});
