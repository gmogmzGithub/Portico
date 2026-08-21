const express = require("express");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
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
const {
  registerWorkspaceFileRoute,
} = require("../../src/services/workspace-file-serving");

const CHAT_ID = "workspace-svg-smoke";
let apiServer;
let projectRoot;

registerAppScheme(protocol);

async function listen(apiApp) {
  return new Promise((resolve, reject) => {
    const server = apiApp.listen(0, "127.0.0.1");
    server.once("listening", () => resolve(server));
    server.once("error", reject);
  });
}

function cleanup() {
  if (projectRoot) {
    fs.rmSync(projectRoot, { recursive: true, force: true });
    projectRoot = undefined;
  }
}

app.whenReady().then(async () => {
  installAppProtocol({
    protocol,
    net,
    appRoot: path.resolve(__dirname, "../.."),
  });

  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "workspace-svg-smoke-"));
  process.env.PORTICO_WORKSPACE_CFG_DIR = path.join(projectRoot, "workspace-cfg");
  const workspace = path.join(projectRoot, "workspaces", CHAT_ID);
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "valid.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80" viewBox="0 0 120 80"><rect width="120" height="80" fill="#2164f3"/><circle cx="60" cy="40" r="20" fill="white"/></svg>',
  );

  const apiApp = express();
  apiApp.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    next();
  });
  apiApp.get("/svg-security-probe", (_req, res) => res.sendStatus(204));
  registerWorkspaceFileRoute(apiApp, {
    projectRoot,
    logger: { error() {}, log() {}, warn() {} },
  });
  apiServer = await listen(apiApp);
  const port = apiServer.address().port;

  fs.writeFileSync(
    path.join(workspace, "active-content.svg"),
    [
      '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="80">',
      `<script>fetch('http://127.0.0.1:${port}/svg-security-probe?source=script')</script>`,
      `<image href="http://127.0.0.1:${port}/svg-security-probe?source=image" width="10" height="10"/>`,
      '<rect width="120" height="80" fill="#00a36c"/>',
      "</svg>",
    ].join(""),
  );

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
        conversationId: CHAT_ID,
        url: "http://localhost:3789/",
        theme: "dark",
        title: "Workspace SVG Smoke",
        windowType: "chat",
        viewKey: CHAT_ID,
        workspacePort: String(port),
      },
    }),
  );
});

app.on("window-all-closed", () => {
  if (apiServer) {
    apiServer.close(() => {
      cleanup();
      app.quit();
    });
    apiServer = undefined;
    return;
  }
  cleanup();
  app.quit();
});
