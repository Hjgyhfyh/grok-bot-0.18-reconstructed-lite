interface SyncIpc { on(channel: string, listener: (event: { returnValue: unknown }) => void): void }
/**
 * The tunnel is gone. `sand:egress-tunnel-get-sync` and `sand:egress-tunnel-status-get-sync`
 * stay registered because `production-ipc-contract.ts` lists them and `preload.ts` reads
 * them during construction; both answer with a permanently closed tunnel instead of
 * asking the main process for a controller that no longer exists.
 */
const EGRESS_TUNNEL_OFF_STATUS = Object.freeze({ state: "off", relayedStreams: 0, activeStreams: 0 });
export function registerSettingsIpc(deps: { readonly ipcMain: SyncIpc; readonly settingsStore: { getWebauthnProxyEnabled(): unknown }; readonly themeController: { getState(): unknown } }): void { deps.ipcMain.on("sand:theme-get-sync", (event) => { event.returnValue = deps.themeController.getState(); }); deps.ipcMain.on("sand:egress-tunnel-get-sync", (event) => { event.returnValue = false; }); deps.ipcMain.on("sand:egress-tunnel-status-get-sync", (event) => { event.returnValue = EGRESS_TUNNEL_OFF_STATUS; }); deps.ipcMain.on("sand:webauthn-proxy-get-sync", (event) => { event.returnValue = deps.settingsStore.getWebauthnProxyEnabled(); }); }
