export const app = { getAppPath: (): string => process.cwd(), isPackaged: false }
export const BrowserWindow = { getAllWindows: (): never[] => [] }
export const ipcMain = { handle: (): void => {}, on: (): void => {} }
export const shell = { openExternal: async (): Promise<void> => {} }
export const dialog = {}
