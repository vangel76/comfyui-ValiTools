export const api = {
  listeners: {},
  addEventListener(t, f) { (this.listeners[t] ||= []).push(f); },
  removeEventListener() {},
  dispatch(t, detail) { for (const f of this.listeners[t] || []) f({ detail }); },
  fetchApi: async () => ({ ok: true, json: async () => ({ files: [], results: {} }) }),
  apiURL: (p) => p,
};
