// Electron 主进程
const { app, BrowserWindow, ipcMain } = require('electron');
const keytar = require('keytar');
const Store = require('electron-store');
const { login, checkConnectivity, susheLogin, wlgnLogin, lgn6Login, lgnLogin46, susheLogout, updateTrafficData } = require('./utils/bjut-auth');
const eventBus = require('./utils/event-bus');
const { createTray } = require('./utils/tray');
const { quitApp } = require('./utils/quitApp');

// Initialize persistent store
const store = new Store();

const KEYTAR_SERVICE = 'BJUT-Network-Autologin';
const KEYTAR_ACCOUNT = 'user_credentials';

// Keep a global reference of the window and tray object, if you don't, they will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow;
let tray;

// --- App Setup ---

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 900,
        height: 700,
        frame: true,
        webPreferences: {
            nodeIntegration: true,
            contextIsolation: false,
            autoHideMenuBar: true
        }
    });
    mainWindow.loadFile('index.html');
    mainWindow.setMenu(null);
}

app.whenReady().then(() => {
    createWindow();
    tray = createTray(mainWindow, quitApp);

    // Apply saved settings on startup
    const startOnLogin = store.get('startOnLogin', false);
    app.setLoginItemSettings({ openAtLogin: startOnLogin });


});

app.on('window-all-closed', function () {
    if (process.platform !== 'darwin') app.quit();
});

app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
});

// --- IPC Handlers --- //

eventBus.on('log', (message) => {
    sendLogMessage(message);
});

// Settings Management
ipcMain.handle('get-setting', async (event, key) => {
    return store.get(key);
});

ipcMain.on('set-setting', (event, { key, value }) => {
    store.set(key, value);
});

ipcMain.on('set-start-on-login', (event, enabled) => {
    app.setLoginItemSettings({ openAtLogin: enabled });
    store.set('startOnLogin', enabled);
});

// Credential Management
ipcMain.handle('get-credentials', async () => {
    try {
        const password = await keytar.getPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT);
        if (password) {
            return JSON.parse(password);
        }
    } catch (error) {
        eventBus.emit('log', 'Could not retrieve credentials.');
    }
    return null;
});

ipcMain.on('set-credentials', async (event, { username, password }) => {
    try {
        const credentials = JSON.stringify({ username, password });
        await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, credentials);
    } catch (error) {
        eventBus.emit('log', `Error saving credentials: ${error.message}`);
    }
});

// Network Operations
ipcMain.handle('check-connectivity', async () => {
    return await checkConnectivity();
});

ipcMain.handle('network-login', async (event, credentials) => {
    const { username, password } = credentials;
    eventBus.emit('log', 'Authentication process started...');
    
    try {
        const result = await login(username, password);
        eventBus.emit('log', 'Authentication process finished.');
        return result;
    } catch (error) {
        eventBus.emit('log', `Critical authentication error: ${error.message}`);
        console.error('Authentication failed:', error);
        return { success: false, message: error.message };
    }
});

// Specific Login/Logout Handlers
ipcMain.handle('sushe-login', async (event, { username, password }) => {
    return await susheLogin(username, password);
});

ipcMain.handle('wlgn-login', async (event, { username, password }) => {
    return await wlgnLogin(username, password);
});

ipcMain.handle('lgn6-login', async (event, { username, password }) => {
    return await lgn6Login(username, password);
});

ipcMain.handle('lgn-login-46', async (event, { username, password }) => {
    return await lgnLogin46(username, password);
});

ipcMain.handle('sushe-logout', async () => {
    return await susheLogout();
});

ipcMain.handle('get-traffic-info', async () => {
    return await updateTrafficData();
});


// --- Utility Functions --- //

function sendLogMessage(message) {
    if (mainWindow) {
        mainWindow.webContents.send('log-message', message);
    }
}
