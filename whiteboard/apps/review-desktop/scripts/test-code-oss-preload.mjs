const unavailableIpc = new Proxy(
  {},
  {
    get(_target, method) {
      if (method === Symbol.toStringTag) return "Unavailable ipcRenderer";
      throw new Error(
        `Electron ipcRenderer.${String(method)} is unavailable in Code OSS Node tests; provide a test mock.`,
      );
    },
  },
);

if (!("vscode" in globalThis)) {
  globalThis.vscode = { ipcRenderer: unavailableIpc };
}
