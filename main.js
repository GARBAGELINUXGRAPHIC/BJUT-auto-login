// Electron 主进程
const {app, BrowserWindow, ipcMain, powerMonitor, powerSaveBlocker, safeStorage} = require('electron');
const crypto = require('crypto');
const Store = require('electron-store');
const si = require('systeminformation');
const {
	login,
	checkUrl,
	checkConnectivity,
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
const {createHeartbeatLoop} = require('./utils/heartbeat-loop');
const {registerIpcHandlers} = require('./utils/ipc-handlers');
const {createUpdateService} = require('./utils/update');
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
let powerSaveBlockerId = null;
let isAutoLoginInProgress = false;
const LOG_BUFFER_LIMIT = 200;
const LOG_FLUSH_CHUNK_SIZE = 40;
let bufferedLogs = [];
let destroyWindowTimeout = null;
let showWindowTimeout = null;
let startUp = true;
const WINDOW_SHOW_TIMEOUT = 250;
const WINDOW_HIDE_TIMEOUT = 250;
let isReadyToQuit = false;

const heartbeatLoop = createHeartbeatLoop({
	store,
	mainWindowProvider: () => mainWindow,
	checkConnectivity,
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
	
	function createWindow() {
		if (showWindowTimeout) {
			clearTimeout(showWindowTimeout);
			showWindowTimeout = null;
		}

		mainWindow = new BrowserWindow({
			width: 880,
			height: 727,
			show: false,
			frame: true,
			webPreferences: {
				nodeIntegration: true,
				contextIsolation: false,
				autoHideMenuBar: true
			}
		});
		setMainWindow(mainWindow);
		mainWindow.loadFile('index.html');
		mainWindow.setMenu(null);
		if(startUp) {
			showWindowTimeout = setTimeout(() => {
				if (mainWindow && !mainWindow.isDestroyed()) {
					mainWindow.show();
					mainWindow.focus();
				}
				showWindowTimeout = null;
			}, WINDOW_SHOW_TIMEOUT);
		} else {
			mainWindow.once('ready-to-show', () => {
				if (mainWindow && !mainWindow.isDestroyed()) {
					mainWindow.show();
					mainWindow.focus();
				}
			});
		}
		mainWindow.webContents.on('did-finish-load', () => {
			flushPendingUpdatePopup();
			flushBufferedLogs(mainWindow);
		});
		
		mainWindow.on('close', (event) => {
			if (!quitAppModule.isQuiting) {
				event.preventDefault();
				const windowToDestroy = mainWindow;
				windowToDestroy.hide();

				if (destroyWindowTimeout) {
					clearTimeout(destroyWindowTimeout);
				}

				destroyWindowTimeout = setTimeout(() => {
					if (windowToDestroy && !windowToDestroy.isDestroyed()) {
						windowToDestroy.destroy();
					}
					destroyWindowTimeout = null;
				}, WINDOW_HIDE_TIMEOUT);
			}
		});

		mainWindow.on('closed', () => {
			if (showWindowTimeout) {
				clearTimeout(showWindowTimeout);
				showWindowTimeout = null;
			}
			if (destroyWindowTimeout) {
				clearTimeout(destroyWindowTimeout);
				destroyWindowTimeout = null;
			}
			setMainWindow(null);
			mainWindow = null;
		});
	}

	function showMainWindow() {
		if (destroyWindowTimeout) {
			clearTimeout(destroyWindowTimeout);
			destroyWindowTimeout = null;
		}
		if (!mainWindow || mainWindow.isDestroyed()) {
			createWindow();
			return;
		}

		if (mainWindow.isMinimized()) mainWindow.restore();
		if (!mainWindow.isVisible()) mainWindow.show();
		mainWindow.focus();
	}

	function openMainWindowDevTools() {
		showMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.openDevTools();
		}
	}
	
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
			
			setTimeout(() => {isReadyToQuit = true; app.quit()}, WINDOW_HIDE_TIMEOUT);
		}
	});
	
	
	eventBus.on('log', (message, level) => {
		sendLogMessage(message, level);
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
		dismissPendingUpdateInfo
	});
	
	
	// --- Utility Functions --- //

	function enqueueLog(message, level = 'debug') {
		bufferedLogs.push({message, level});
		if (bufferedLogs.length > LOG_BUFFER_LIMIT) {
			bufferedLogs = bufferedLogs.slice(-LOG_BUFFER_LIMIT);
		}
	}

	function flushBufferedLogs(targetWindow) {
		if (!targetWindow || targetWindow.isDestroyed() || bufferedLogs.length === 0) {
			return;
		}

		const logsToFlush = bufferedLogs.slice();
		let index = 0;

		function flushChunk() {
			if (!mainWindow || mainWindow !== targetWindow || targetWindow.isDestroyed()) {
				return;
			}

			const chunk = logsToFlush.slice(index, index + LOG_FLUSH_CHUNK_SIZE);
			if (chunk.length === 0) {
				return;
			}

			targetWindow.webContents.send('log-message-batch', chunk);
			index += chunk.length;

			if (index < logsToFlush.length) {
				setTimeout(flushChunk, 16);
			}
		}

		flushChunk();
	}
	
	function sendLogMessage(message, level = 'debug') {
		enqueueLog(message, level);
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send('log-message', message, level);
		}
	}
}
