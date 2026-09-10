/**
 * Electron main process.
 *
 * Owns the AppContainer + registry directly (no separate hub in desktop mode)
 * and exposes the whole ApiSurface to the renderer over contextBridged IPC.
 * Renderer speaks `window.apiManager.call(method, params)`; events arrive via
 * `apiManager.onEvent(cb)`.
 *
 * Native capabilities (clipboard/dialog/shell) are handled here so the
 * renderer's bridge works identically in browser mode (hub fallbacks).
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, shell, Menu, session } from 'electron';
import { join } from 'node:path';
import { writeFileSync, existsSync } from 'node:fs';
import { createContainer } from '../runtime/container';
import { createRegistry } from '../runtime/registry';
import { startHub } from '../hub/server';

const NATIVE_METHODS = new Set([
  'clipboard.read', 'clipboard.write',
  'dialog.openFile', 'dialog.saveFile',
  'shell.openExternal', 'shell.showItemInFolder',
]);

let mainWindow: BrowserWindow | null = null;

async function nativeCall(method: string, params: Record<string, never>): Promise<unknown> {
  switch (method) {
    case 'clipboard.read': return clipboard.readText();
    case 'clipboard.write': clipboard.writeText(String((params as { text: string }).text)); return undefined;
    case 'dialog.openFile': {
      const p = params as unknown as { filters?: { name: string; extensions: string[] }[]; multiple?: boolean };
      const r = await dialog.showOpenDialog(mainWindow!, {
        filters: p.filters, properties: p.multiple ? ['openFile', 'multiSelections'] : ['openFile'],
      });
      return r.canceled ? [] : r.filePaths;
    }
    case 'dialog.saveFile': {
      const p = params as unknown as { defaultName: string; filters?: { name: string; extensions: string[] }[]; contentBase64?: string; contentText?: string };
      const r = await dialog.showSaveDialog(mainWindow!, { defaultPath: p.defaultName, filters: p.filters });
      if (r.canceled || !r.filePath) return null;
      if (p.contentBase64 !== undefined) writeFileSync(r.filePath, Buffer.from(p.contentBase64, 'base64'));
      else if (p.contentText !== undefined) writeFileSync(r.filePath, p.contentText, 'utf8');
      return { path: r.filePath };
    }
    case 'shell.openExternal': await shell.openExternal(String((params as { url: string }).url)); return undefined;
    case 'shell.showItemInFolder': shell.showItemInFolder(String((params as { path: string }).path)); return undefined;
    default: throw new Error(`Not a native method: ${method}`);
  }
}

async function createWindow(container: Awaited<ReturnType<typeof createContainer>>): Promise<BrowserWindow> {
  const w = container.session.get().window;
  const win = new BrowserWindow({
    width: w?.width ?? 1480,
    height: w?.height ?? 960,
    x: w?.x,
    y: w?.y,
    minWidth: 1100, minHeight: 700,
    title: 'API Manager', backgroundColor: '#0f1115',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
      webSecurity: true, devTools: !app.isPackaged || process.env.API_MANAGER_DEVTOOLS === '1',
    },
    show: false,
  });
  if (w?.maximized) win.maximize();
  else if (w?.fullscreen) win.setFullScreen(true);
  win.on('ready-to-show', () => win.show());

  // Persist window bounds (debounced) — part of crash-safe session restoration
  let timer: NodeJS.Timeout | null = null;
  const saveBounds = (): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      const maximized = win.isMaximized();
      const fullscreen = win.isFullScreen();
      const bounds = win.getNormalBounds?.() ?? win.getBounds();
      container.session.save({ window: { ...bounds, maximized, fullscreen } });
    }, 400);
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);
  win.on('maximize', saveBounds);
  win.on('unmaximize', saveBounds);
  win.on('enter-full-screen', saveBounds);
  win.on('leave-full-screen', saveBounds);

  Menu.setApplicationMenu(null);

  // CSP for renderer
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ["default-src 'self'; worker-src 'self' blob:; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws: wss: http: https:; script-src 'self'"],
      },
    });
  });

  await win.loadFile(join(__dirname, '..', '..', 'renderer', 'index.html'));
  return win;
}

async function main(): Promise<void> {
  await app.whenReady();

  const dataDir = process.env.API_MANAGER_DATA_DIR ?? join(app.getPath('userData'));
  const container = await createContainer({ dataDir });
  const registry = createRegistry(container);

  container.setEmit((type, payload) => {
    const ev = { type, payload, timestamp: new Date().toISOString() };
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('am:event', ev);
    }
  });

  ipcMain.handle('am:call', async (_e, method: string, params: unknown) => {
    if (NATIVE_METHODS.has(method)) return nativeCall(method, (params ?? {}) as Record<string, never>);
    return registry.call(method, params);
  });
  ipcMain.handle('am:methods', async () => registry.methods);

  // Support web/preview mode too: when started with --hub, also run the bridge
  if (process.argv.includes('--hub')) {
    const handle = await startHub({ container, registry, port: 7654, log: (m) => console.log(m) });
    console.log(`[api-manager] hub on ${handle.url}`);
  }

  mainWindow = await createWindow(container);
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) void createWindow(container).then((w) => { mainWindow = w; }); });

  const gracefulShutdown = (): void => {
    try { container.session.markCleanExit(); } catch { /* never block quit on session I/O */ }
    void container.flush();
  };
  app.on('before-quit', gracefulShutdown);
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      gracefulShutdown();
      app.quit();
    }
  });
}

main().catch((e) => { console.error('API Manager failed to start:', e); app.exit(1); });
