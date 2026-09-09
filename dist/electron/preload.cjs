// src/main/preload.ts
var import_electron = require("electron");
var apiManager = {
  call: (method, params) => import_electron.ipcRenderer.invoke("am:call", method, params),
  methods: () => import_electron.ipcRenderer.invoke("am:methods"),
  onEvent: (cb) => {
    const listener = (_e, ev) => cb(ev);
    import_electron.ipcRenderer.on("am:event", listener);
    return () => import_electron.ipcRenderer.removeListener("am:event", listener);
  }
};
import_electron.contextBridge.exposeInMainWorld("apiManager", apiManager);
