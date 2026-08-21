const path = require("path");
const {
  app,
  BrowserWindow,
  net,
  protocol,
} = require("electron");
const {
  buildAppPageUrl,
  installAppProtocol,
  registerAppScheme,
} = require("../../src/services/app-protocol");

registerAppScheme(protocol);

app.whenReady().then(async () => {
  installAppProtocol({
    protocol,
    net,
    appRoot: path.resolve(__dirname, "../.."),
  });

  const windowRef = new BrowserWindow({
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  await windowRef.loadURL(
    buildAppPageUrl("conversation-window.html", {
      query: {
        conversationId: "protocol-smoke",
        url: "http://localhost:3789/",
        theme: "dark",
        title: "Protocol Smoke",
        windowType: "chat",
        viewKey: "protocol-smoke",
      },
    }),
  );
});

app.on("window-all-closed", () => {
  app.quit();
});
