const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("trayApp", {
  requestData() {
    ipcRenderer.send("request-data");
  },
  refresh() {
    ipcRenderer.send("refresh");
  },
  login() {
    ipcRenderer.send("login");
  },
  logout() {
    ipcRenderer.send("logout");
  },
  quit() {
    ipcRenderer.send("quit");
  },
  onUpdateData(handler) {
    const listener = (_event, data) => handler(data);
    ipcRenderer.on("update-data", listener);
    return () => {
      ipcRenderer.removeListener("update-data", listener);
    };
  },
});
