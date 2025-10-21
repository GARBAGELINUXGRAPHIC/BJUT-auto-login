// Electron 主进程
const {app, BrowserWindow, ipcMain} = require('electron');
const keytar = require('keytar');
const Store = require('electron-store');
const {
	login,
	checkConnectivity,
	susheLogin,
	wlgnLogin,
	lgn6Login,
	lgnLogin46,
	susheLogout,
	updateTrafficData
} = require('./utils/bjut-auth');
const eventBus = require('./utils/event-bus');
const {createTray, setTrayStatus} = require('./utils/tray');
const quitAppModule = require('./utils/quitApp');
const axios = require('axios');

// Initialize persistent store
const store = new Store();

const KEYTAR_SERVICE = 'BJUT-Network-Autologin';
const KEYTAR_ACCOUNT = 'user_credentials';

// Keep a global reference of the window and tray object, if you don't, they will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow;
let tray;

// --- Single Instance Lock ---
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
	app.quit();
} else {
	app.on('second-instance', (event, commandLine, workingDirectory) => {
		// Someone tried to run a second instance, we should focus our window.
		if (mainWindow) {
			if (mainWindow.isMinimized()) mainWindow.restore();
			if (!mainWindow.isVisible()) mainWindow.show();
			mainWindow.focus();
		}
	});
	
	// --- App Setup ---
	
	function createWindow() {
		mainWindow = new BrowserWindow({
			width: 900,
			height: 750,
			frame: true,
			webPreferences: {
				nodeIntegration: true,
				contextIsolation: false,
				autoHideMenuBar: true
			}
		});
		mainWindow.loadFile('index.html');
		mainWindow.setMenu(null);
		
		mainWindow.on('close', (event) => {
			if (!quitAppModule.isQuiting) {
				event.preventDefault();
				mainWindow.hide();
			}
		});
		
		app.on('window-all-closed', () => {
			if (process.platform !== 'darwin') {
				app.quit();
			}
		});
	}
	
	app.whenReady().then(() => {
		createWindow();
		tray = createTray(mainWindow, quitAppModule.quitApp);
		
		// Apply saved settings on startup
		const startOnLogin = store.get('startOnLogin', false);
		app.setLoginItemSettings({openAtLogin: startOnLogin});
	});
	
	app.on('activate', function () {
		// On macOS it's common to re-create a window in the app when the
		// dock icon is clicked and there are no other windows open.
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		} else if (mainWindow) {
			mainWindow.show();
		}
	});
	
	// Handle macOS dock quit - set isQuiting flag so window can close properly
	if (process.platform === 'darwin') {
		app.on('before-quit', () => {
			quitAppModule.quitApp();
		});
	}
	
	// --- IPC Handlers --- //
	
	eventBus.on('log', (message) => {
		sendLogMessage(message);
	});
	
	// Settings Management
	ipcMain.handle('get-setting', async (event, key) => {
		return store.get(key);
	});
	
	ipcMain.on('set-setting', (event, {key, value}) => {
		store.set(key, value);
	});
	
	ipcMain.on('set-start-on-login', (event, enabled) => {
		app.setLoginItemSettings({openAtLogin: enabled});
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
	
	ipcMain.on('set-credentials', async (event, {username, password}) => {
		try {
			const credentials = JSON.stringify({username, password});
			await keytar.setPassword(KEYTAR_SERVICE, KEYTAR_ACCOUNT, credentials);
		} catch (error) {
			eventBus.emit('log', `Error saving credentials: ${error.message}`);
		}
	});

	// Network Operations
	ipcMain.handle('check-connectivity', async () => {
		const connectivity = await checkConnectivity();
		if (connectivity.ipv4Access && connectivity.ipv6Access) {
			setTrayStatus('green');
		} else if (!connectivity.ipv4Access && !connectivity.ipv6Access) {
			setTrayStatus('red');
		} else {
			setTrayStatus('default');
		}
		return connectivity;
	});
	
	ipcMain.handle('network-login', async (event, credentials) => {
		const {username, password} = credentials;
		eventBus.emit('log', 'Authentication process started...');
		
		try {
			const result = await login(username, password);
			eventBus.emit('log', 'Authentication process finished.');
			return result;
		} catch (error) {
			eventBus.emit('log', `Critical authentication error: ${error.message}`);
			console.error('Authentication failed:', error);
			return {success: false, message: error.message};
		}
	});
	
	// Specific Login/Logout Handlers
	ipcMain.handle('sushe-login', async (event, {username, password}) => {
		return await susheLogin(username, password);
	});
	
	ipcMain.handle('wlgn-login', async (event, {username, password}) => {
		return await wlgnLogin(username, password);
	});
	
	ipcMain.handle('lgn6-login', async (event, {username, password}) => {
		return await lgn6Login(username, password);
	});
	
	ipcMain.handle('lgn-login-46', async (event, {username, password}) => {
		return await lgnLogin46(username, password);
	});
	
	ipcMain.handle('lgn6-login-46', async (event, {username, password}) => {
		return await lgn6Login(username, password, true);
	});
	
	ipcMain.handle('get-traffic-info', async () => {
		return await updateTrafficData();
	});
	
	ipcMain.handle('check-updates', async () => {
		return await checkUpdates();
	});
	
	
	// --- Utility Functions --- //
	
	function sendLogMessage(message) {
		if (mainWindow) {
			mainWindow.webContents.send('log-message', message);
		}
	}
	
	function createUpdatePopup(latestVersion) {
		const {Notification} = require('electron');
		
		const notification = new Notification({
			title: 'BJUT 校园网自动认证 - 更新可用',
			body: `新版本 ${latestVersion} 已发布！\n点击查看更新详情。`,
			icon: process.platform === 'darwin' ? undefined : './utils/basic.png',
			urgency: 'normal',
			timeoutType: 'default'
		});
		
		notification.on('click', () => {
			require('electron').shell.openExternal('https://quitsense.cn/apps/bjutautologin/download');
		});
		
		notification.show();
		eventBus.emit('log', `Update notification shown for version ${latestVersion}`);
	}
	
	async function checkUpdates() {
		try {
			eventBus.emit('log', 'Current Version: ' + app.getVersion()); // X.Y.Z
			const res = await axios.get('https://ipv4.quitsense.cn/api/bjutautologin/getLatestTag'); // returns 'VX.Y.Z', github release tag
			if (!res.data.success) {
				throw new Error('Failed to get latest tag: ' + res.data.message);
			}
			let tagstr = res.data.data; // yes, my api is shit
			if (tagstr.at(0).toLowerCase() === 'v') { // remove v at front
				tagstr = tagstr.substring(1);
			}
			tagstr = tagstr.substring(0, 5); // X.Y.Z just like getVersion()
			
			// compare
			const currentTags = app.getVersion().split('.');
			const latestTags = tagstr.split('.');
			let need_update = false;
			for (let i = 0; i < Math.min(latestTags.length, currentTags.length); ++i) {
				if (latestTags[i] > currentTags[i]) {
					need_update = true;
					break;
				} else if (latestTags[i] < currentTags[i]) { // wtf...
					eventBus.emit('log', 'It seems that latest Tag is SMALLER than current Tag? Am I in future?(' + tagstr + ' < ' + app.getVersion() + ')');
					return;
				}
			}
			if (!need_update && latestTags.length > currentTags.length) need_update = true;
			
			// show notification if update is needed
			if(!need_update) return;
			
			createUpdatePopup(tagstr);
		} catch (e) {
			eventBus.emit('log', 'check updates failed: ' + e.message);
			setTimeout(checkUpdates, 3600 * 1000);
		}
	}
}
