const { app, BrowserWindow, Tray, Menu, nativeImage, dialog, shell } = require('electron');
const { spawn, execSync } = require('child_process');
const path = require('path');
const http = require('http');
const fs = require('fs');

let mainWindow = null;
let loadingWindow = null;
let tray = null;
let serverProcess = null;

const IS_PACKAGED = app.isPackaged;
const PROJECT_ROOT = IS_PACKAGED
  ? path.join(process.resourcesPath, 'project')
  : path.join(__dirname);

// ─── Wait for HTTP server to be ready ────────────────────────────────────────

function waitForServer(url, maxAttempts = 90, intervalMs = 1000) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const check = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on('error', () => {
        attempts++;
        if (attempts >= maxAttempts) reject(new Error('Server did not start in time'));
        else setTimeout(check, intervalMs);
      });
      req.setTimeout(600, () => {
        req.destroy();
        attempts++;
        if (attempts >= maxAttempts) reject(new Error('Server timed out'));
        else setTimeout(check, intervalMs);
      });
    };
    check();
  });
}

// ─── Loading splash screen ────────────────────────────────────────────────────

function createLoadingWindow() {
  loadingWindow = new BrowserWindow({
    width: 420,
    height: 260,
    frame: false,
    resizable: false,
    center: true,
    alwaysOnTop: true,
    backgroundColor: '#0A0717',
    webPreferences: { nodeIntegration: false, contextIsolation: true }
  });

  loadingWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(`
    <!DOCTYPE html>
    <html>
    <head>
    <meta charset="utf-8">
    <style>
      * { margin: 0; padding: 0; box-sizing: border-box; }
      body {
        background: #0A0717;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        height: 100vh;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
        color: white;
        -webkit-app-region: drag;
      }
      .emoji { font-size: 48px; margin-bottom: 16px; }
      h2 { font-size: 20px; font-weight: 600; margin-bottom: 8px; }
      p { font-size: 13px; color: #8B7BB5; }
      .dots span {
        display: inline-block;
        animation: bounce 1.2s infinite;
      }
      .dots span:nth-child(2) { animation-delay: 0.2s; }
      .dots span:nth-child(3) { animation-delay: 0.4s; }
      @keyframes bounce {
        0%, 80%, 100% { transform: translateY(0); opacity: 0.5; }
        40% { transform: translateY(-6px); opacity: 1; }
      }
    </style>
    </head>
    <body>
      <div class="emoji">🌯</div>
      <h2>Burrito Bot</h2>
      <p class="dots">Starting<span>.</span><span>.</span><span>.</span></p>
    </body>
    </html>
  `)}`);
}

// ─── Install node_modules on first launch ─────────────────────────────────────

function installDepsIfNeeded() {
  const nmPath = path.join(PROJECT_ROOT, 'node_modules');
  if (!fs.existsSync(nmPath)) {
    if (loadingWindow) {
      loadingWindow.webContents.executeJavaScript(
        `document.querySelector('p').textContent = 'Installing dependencies (first run)…'`
      ).catch(() => {});
    }
    try {
      execSync('npm install --omit=dev', { cwd: PROJECT_ROOT, stdio: 'inherit' });
    } catch (e) {
      dialog.showErrorBox(
        'Setup Failed',
        'Could not install dependencies.\n\nMake sure Node.js and npm are installed, then reopen the app.'
      );
      app.quit();
    }
  }
}

// ─── Start the Discord + Express server ──────────────────────────────────────

function startServer() {
  const tsxBin = path.join(PROJECT_ROOT, 'node_modules', '.bin', 'tsx');
  serverProcess = spawn(tsxBin, ['server.ts'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, ELECTRON: '1' },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  serverProcess.stdout.on('data', (d) => process.stdout.write(`[bot] ${d}`));
  serverProcess.stderr.on('data', (d) => process.stderr.write(`[bot] ${d}`));

  serverProcess.on('exit', (code) => {
    console.log(`Server process exited with code ${code}`);
    serverProcess = null;
  });
}

// ─── Main dashboard window ────────────────────────────────────────────────────

function createMainWindow() {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 600,
    title: 'Burrito Bot Dashboard',
    backgroundColor: '#0A0717',
    titleBarStyle: 'hiddenInset',
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    }
  });

  mainWindow.loadURL('http://localhost:3000');

  // Open external links in the default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith('http://localhost')) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

// ─── System tray ──────────────────────────────────────────────────────────────

function createTray() {
  // Minimal 16x16 template icon (white square — macOS will tint it)
  const iconData = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAFElEQVR42mNk' +
    'YGD4z8BQDwAEAAH/AJ/YO2UAAAAASUVORK5CYII=',
    'base64'
  );
  const icon = nativeImage.createFromBuffer(iconData).resize({ width: 16, height: 16 });
  icon.setTemplateImage(true);

  tray = new Tray(icon);
  tray.setToolTip('Burrito Bot');

  const buildMenu = () => Menu.buildFromTemplate([
    {
      label: '🌯 Open Dashboard',
      click: () => {
        if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
        else createMainWindow();
      }
    },
    { type: 'separator' },
    {
      label: '🔄 Restart Bot Server',
      click: () => {
        if (serverProcess) serverProcess.kill();
        setTimeout(() => { startServer(); }, 1500);
      }
    },
    { type: 'separator' },
    { label: 'Quit', click: () => app.quit() }
  ]);

  tray.setContextMenu(buildMenu());
  tray.on('click', () => {
    if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
    else createMainWindow();
  });
}

// ─── App lifecycle ────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
  // Prevent multiple instances
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  createLoadingWindow();

  // Run sync setup before async server start
  installDepsIfNeeded();
  startServer();
  createTray();

  try {
    await waitForServer('http://localhost:3000');
    if (loadingWindow && !loadingWindow.isDestroyed()) {
      loadingWindow.close();
      loadingWindow = null;
    }
    createMainWindow();
  } catch (e) {
    if (loadingWindow && !loadingWindow.isDestroyed()) loadingWindow.close();
    dialog.showErrorBox(
      'Startup Failed',
      'Burrito Bot server failed to start.\n\nCheck that your .env is configured correctly and try again.'
    );
    app.quit();
  }
});

app.on('second-instance', () => {
  if (mainWindow) { mainWindow.show(); mainWindow.focus(); }
});

// Keep app alive in tray when all windows are closed (macOS behavior)
app.on('window-all-closed', () => { /* stay in tray */ });

app.on('activate', () => {
  if (mainWindow === null) createMainWindow();
});

app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill('SIGTERM');
  }
});
