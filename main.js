const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const http = require('http');
const { startServer } = require('./server');

let mainWindow = null;
const PORT = 3737;

// Prevent unhandled exception crash dialogs
process.on('uncaughtException', (err) => {
  console.error('Main process uncaught exception (handled):', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('Main process unhandled rejection (handled):', reason);
});

function isServerAlive(port) {
  return new Promise((resolve) => {
    const req = http.get(`http://localhost:${port}/api/status`, (res) => {
      resolve(res.statusCode === 200);
    });
    req.on('error', () => resolve(false));
    req.setTimeout(800, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function createWindow() {
  if (mainWindow) {
    mainWindow.focus();
    return;
  }

  const iconPath = path.join(__dirname, 'build', 'icon.png');

  mainWindow = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: 'Codex Studio',
    icon: iconPath,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#f6f6f4',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true
    }
  });

  // Open external links (e.g. Google OAuth) in system default browser to avoid Google 403 disallowed_useragent
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  const appUrl = `http://localhost:${PORT}`;

  const loadWithRetry = (retries = 8) => {
    mainWindow.loadURL(appUrl).catch((err) => {
      if (retries > 0) {
        console.log(`Waiting for server at ${appUrl}... retries left: ${retries}`);
        setTimeout(() => loadWithRetry(retries - 1), 500);
      } else {
        console.error('Failed to load application URL:', err);
      }
    });
  };

  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(iconPath); } catch (e) {}
  }

  loadWithRetry();

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC Handlers for native macOS dialogs
ipcMain.handle('dialog:openFolder', async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory']
  });
  if (!result.canceled && result.filePaths && result.filePaths.length > 0) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('shell:showItemInFolder', async (event, fullPath) => {
  if (fullPath) {
    shell.showItemInFolder(fullPath);
    return true;
  }
  return false;
});

app.whenReady().then(async () => {
  const alive = await isServerAlive(PORT);
  if (alive) {
    console.log(`Detected active backend on port ${PORT}, opening window directly.`);
    createWindow();
  } else {
    console.log(`Starting backend server on port ${PORT}...`);
    startServer((port) => {
      console.log(`Codex Custom Studio backend ready on port ${port}`);
      createWindow();
    });
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
