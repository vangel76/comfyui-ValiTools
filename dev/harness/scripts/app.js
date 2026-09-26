export const app = {
  extensions: [],
  registerExtension(ext) { this.extensions.push(ext); },
  graph: { setDirtyCanvas() {} , _nodes: [] },
  canvas: { setDirty() {} },
  extensionManager: { workflow: { activeWorkflow: { changeTracker: { captureCanvasState() { globalThis.__captured = (globalThis.__captured||0)+1; } } } } },
  ui: { settings: { getSettingValue() { return null; } } },
};
