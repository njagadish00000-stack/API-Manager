/**
 * Preload bridge — exposes the IPC API surface to the sandboxed renderer.
 */
import { contextBridge, ipcRenderer } from 'electron';

const apiManager = {
  call: (method: string, params?: unknown): Promise<unknown> => ipcRenderer.invoke('am:call', method, params),
  methods: (): Promise<string[]> => ipcRenderer.invoke('am:methods'),
  onEvent: (cb: (ev: { type: string; payload: unknown; timestamp: string }) => void): (() => void) => {
    const listener = (_e: unknown, ev: { type: string; payload: unknown; timestamp: string }): void => cb(ev);
    ipcRenderer.on('am:event', listener);
    return () => ipcRenderer.removeListener('am:event', listener);
  },
};

declare global { interface Window { apiManager?: typeof apiManager } }

contextBridge.exposeInMainWorld('apiManager', apiManager);
