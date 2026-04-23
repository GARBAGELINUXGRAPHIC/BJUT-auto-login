// Electron 主进程
const {app, BrowserWindow, ipcMain, powerMonitor, powerSaveBlocker, safeStorage} = require('electron');
const crypto = require('crypto');
const Store = require('electron-store');
const si = require('systeminformation');
const {
	login,
	susheLogin,
	wlgnLogin,
	lgn6Login,
	lgnLogin46,
	updateTrafficData
} = require('./utils/bjut-auth');
const eventBus = require('./utils/event-bus');
const {createTray} = require('./utils/tray');
const quitAppModule = require('./utils/quitApp');
const {createCredentialService} = require('./utils/credentials');
const {createHeartbeatLoop, checkUrl, checkConnectivity} = require('./utils/heartbeat-loop');
const {registerIpcHandlers} = require('./utils/ipc-handlers');
const {initLogManager} = require('./utils/log-manager');
const {createUpdateService} = require('./utils/update');
const {createWindowManager} = require('./utils/window-management');
const axios = require('axios');

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

// Initialize persistent store
const store = new Store();

const {encryptCredentials, decryptCredentials, getStoredCredentials} = createCredentialService({
	app,
	store,
	safeStorage,
	crypto,
	si
});

// Keep a global reference of the window and tray object, if you don't, they will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow;
let tray;
// let powerSaveBlockerId = null;
let isAutoLoginInProgress = false;
let isReadyToQuit = false;
let windowManager;
const logManager = initLogManager({mainWindowProvider: () => mainWindow});

const heartbeatLoop = createHeartbeatLoop({
	store,
	mainWindowProvider: () => mainWindow,
	updateTrafficData,
	login,
	getStoredCredentials,
	getAutoLoginInProgress: () => isAutoLoginInProgress,
	setAutoLoginInProgress: (value) => {
		isAutoLoginInProgress = value;
	},
	sleep
});

const {restartPolling, stopPolling, getLatestPollingSnapshot} = heartbeatLoop;

const updateService = createUpdateService({
	app,
	axios,
	eventBus,
	mainWindow
});

const {
	flushPendingUpdatePopup,
	checkUpdates,
	getPendingUpdateInfo,
	dismissPendingUpdateInfo,
	setMainWindow
} = updateService;

function handleMainWindowChange(window) {
	mainWindow = window;
	setMainWindow(window);
}

// --- Single Instance Lock ---
const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
	app.quit();
} else {
	app.on('second-instance', (event, commandLine, workingDirectory) => {
		// Someone tried to run a second instance, we should focus our window.
		showMainWindow();
	});
	
	// --- App Setup ---
	windowManager = createWindowManager({
		BrowserWindow,
		quitAppModule,
		logManager,
		flushPendingUpdatePopup,
		onWindowChange: handleMainWindowChange
	});

	const {createWindow, showMainWindow, openMainWindowDevTools} = windowManager;
	
	app.whenReady().then(() => {
		showMainWindow();
		tray = createTray({
			showMainWindow,
			openDevTools: openMainWindowDevTools
		}, quitAppModule.quitApp);
		powerMonitor.on('resume', () => {
			eventBus.log('检测到系统从睡眠中恢复，正在重启轮询', 'info');
			restartPolling('resume');
		});
		
		// Apply saved settings on startup
		const startOnLogin = store.get('startOnLogin', false);
		app.setLoginItemSettings({openAtLogin: startOnLogin});
		
		// Load and apply saved log level
		const savedLogLevel = store.get('logLevel', 'debug');
		eventBus.setLogLevel(savedLogLevel);
		
		// Prevent App Nap on macOS to ensure background tasks continue
		// if (process.platform === 'darwin') {
		// 	powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
		// 	setTimeout(()=>{eventBus.log('Power save blocker started to prevent App Nap on macOS');}, 1000)
		// }
		
		restartPolling('startup');
	});
	
	app.on('activate', function () {
		// On macOS it's common to re-create a window in the app when the
		// dock icon is clicked and there are no other windows open.
		if (BrowserWindow.getAllWindows().length === 0) {
			createWindow();
		} else if (mainWindow) {
			showMainWindow();
		}
	});

	// Keep the app and tray alive after the last window is closed.
	app.on('window-all-closed', () => {
		// Intentionally do nothing.
	});
	
	app.on('before-quit', (event) => {
		if (!isReadyToQuit) {
			event.preventDefault();
			if (process.platform === 'darwin') quitAppModule.markQuitting(); // macos dock关闭用
			
			if (mainWindow && !mainWindow.isDestroyed()) {
				mainWindow.hide();
			}
			
			// other cleaning
			stopPolling();
			// Stop power save blocker before quitting
			// if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
			// 	powerSaveBlocker.stop(powerSaveBlockerId);
			// 	eventBus.log('Power save blocker stopped');
			// }
			
			setTimeout(() => {isReadyToQuit = true; app.quit()}, windowManager.getHideTimeoutMs());
		}
	});
	
	
	eventBus.on('log', (message, level) => {
		logManager.sendLogMessage(message, level);
	});

	registerIpcHandlers({
		ipcMain,
		app,
		store,
		eventBus,
		restartPolling,
		decryptCredentials,
		encryptCredentials,
		checkConnectivity,
		checkUrl,
		login,
		susheLogin,
		wlgnLogin,
		lgn6Login,
		lgnLogin46,
		updateTrafficData,
		checkUpdates,
		getLatestPollingSnapshot,
		setAutoLoginInProgress: (value) => {
			isAutoLoginInProgress = value;
		},
		getPendingUpdateInfo,
		dismissPendingUpdateInfo,
		clearBufferedLogs: logManager.clearBufferedLogs
	});
}
