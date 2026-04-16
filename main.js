// Electron 主进程
const {app, BrowserWindow, ipcMain, Notification, powerSaveBlocker, safeStorage} = require('electron');
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
const axios = require('axios');

// Initialize persistent store
const store = new Store();

let fallbackCredentialKeyPromise = null;

function getOrCreateCredentialSalt() {
	let credentialSalt = store.get('credentialSalt');
	if (!credentialSalt) {
		credentialSalt = `${Date.now()}-${crypto.randomBytes(16).toString('base64')}`;
		store.set('credentialSalt', credentialSalt);
	}
	return credentialSalt;
}

async function getFallbackCredentialKey() {
	if (!fallbackCredentialKeyPromise) {
		fallbackCredentialKeyPromise = si.system()
			.then((systemInfo) => {
				const machineIdentity = [
					systemInfo.uuid,
					systemInfo.serial,
					systemInfo.sku,
					systemInfo.model,
					app.getName(),
					'mr3qu0c+3rcm-+#Crm_+'
				]
					.filter(Boolean)
					.join('::');


				return crypto.pbkdf2Sync(
					machineIdentity,
					getOrCreateCredentialSalt(),
					120000,
					32,
					'sha256'
				);
			})
			.catch((error) => {
				fallbackCredentialKeyPromise = null;
				throw error;
			});
	}

	return fallbackCredentialKeyPromise;
}

async function encryptCredentials(credentials) {
	const serialized = JSON.stringify(credentials);

	if (safeStorage.isEncryptionAvailable()) {
		return {
			type: 'safeStorage',
			payload: safeStorage.encryptString(serialized).toString('base64')
		};
	}

	const key = await getFallbackCredentialKey();
	const iv = crypto.randomBytes(12);
	const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
	const encrypted = Buffer.concat([cipher.update(serialized, 'utf8'), cipher.final()]);

	return {
		type: 'crypto',
		iv: iv.toString('base64'),
		tag: cipher.getAuthTag().toString('base64'),
		payload: encrypted.toString('base64')
	};
}

async function decryptCredentials(savedCredentials) {
	if (!savedCredentials) {
		return null;
	}

	// Migrate old plaintext credentials after a successful read.
	if (savedCredentials.username || savedCredentials.password) {
		store.set('credentials', await encryptCredentials(savedCredentials));
		return savedCredentials;
	}

	if (savedCredentials.type === 'safeStorage') {
		if (!safeStorage.isEncryptionAvailable()) {
			throw new Error('safeStorage不可用，读取凭证失败');
		}

		return JSON.parse(
			safeStorage.decryptString(Buffer.from(savedCredentials.payload, 'base64'))
		);
	}

	if (savedCredentials.type === 'crypto') {
		eventBus.log('正在使用crypto库存储加密凭证，安全性低于safeStorage', 'warn')
		const key = await getFallbackCredentialKey();
		const decipher = crypto.createDecipheriv(
			'aes-256-gcm',
			key,
			Buffer.from(savedCredentials.iv, 'base64')
		);
		decipher.setAuthTag(Buffer.from(savedCredentials.tag, 'base64'));

		const decrypted = Buffer.concat([
			decipher.update(Buffer.from(savedCredentials.payload, 'base64')),
			decipher.final()
		]).toString('utf8');

		return JSON.parse(decrypted);
	}

	throw new Error('无法读取本地保存的凭证');
}

// Keep a global reference of the window and tray object, if you don't, they will
// be closed automatically when the JavaScript object is garbage collected.
let mainWindow;
let tray;
let powerSaveBlockerId = null;
let pendingUpdateInfo = null;
let pollingIntervalId = null;
let isPollingCheckInProgress = false;
let isAutoLoginInProgress = false;
let latestPollingSnapshot = null;

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function sendPollingSnapshot(snapshot) {
	latestPollingSnapshot = snapshot;
	if (mainWindow) {
		mainWindow.webContents.send('polling-status', snapshot);
	}
}

async function getStoredCredentials() {
	try {
		return await decryptCredentials(store.get('credentials', null));
	} catch (error) {
		eventBus.log(`无法读取已存储的凭证: ${error.message}`, 'error');
		return null;
	}
}

async function runConnectivityFlow(options = {}) {
	const {
		reason = 'polling',
		allowAutoAuth = store.get('autoAuthEnabled', true),
		broadcast = true
	} = options;

	if (isPollingCheckInProgress) {
		return latestPollingSnapshot;
	}

	isPollingCheckInProgress = true;
	try {
		let connectivity = await checkConnectivity();

		let trafficInfo = null;
		if (connectivity.ipv4Access && connectivity.ipv6Access) {
			try {
				trafficInfo = await updateTrafficData();
			} catch (error) {
				eventBus.log(`获取流量信息失败: ${error.message}`, 'warn');
			}
		} else if (allowAutoAuth && !isAutoLoginInProgress) {
			const credentials = await getStoredCredentials();
			if (credentials && credentials.username && credentials.password) {
				isAutoLoginInProgress = true;
				try {
					eventBus.log('无网络，尝试自动登录...', 'info');
					await login(credentials.username, credentials.password);
					await sleep(5000);
					connectivity = await checkConnectivity();
					if (connectivity.ipv4Access && connectivity.ipv6Access) {
						try {
							trafficInfo = await updateTrafficData();
						} catch (error) {
							eventBus.log(`自动登录后获取流量信息失败: ${error.message}`, 'warn');
						}
					}
				} catch (error) {
					eventBus.log(`主进程自动登录失败: ${error.message}`, 'error');
				} finally {
					isAutoLoginInProgress = false;
				}
			} else if (allowAutoAuth) {
				eventBus.log('已启用自动认证，但本地没有可用凭证', 'error');
			}
		}

		const snapshot = {
			reason,
			checkedAt: Date.now(),
			connectivity,
			trafficInfo
		};

		if (broadcast) {
			sendPollingSnapshot(snapshot);
		} else {
			latestPollingSnapshot = snapshot;
		}

		return snapshot;
	} finally {
		isPollingCheckInProgress = false;
	}
}

function restartPolling() {
	if (pollingIntervalId) {
		clearInterval(pollingIntervalId);
		pollingIntervalId = null;
	}

	const intervalMs = Number(store.get('pollingInterval', 10000));
	if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
		eventBus.log(`轮询间隔不合法: ${intervalMs}不是有效的时间间隔`, 'error');
		return;
	}
	
	// set interval不会立刻执行
	runConnectivityFlow({reason: 'polling'}).catch((error) => {
		eventBus.log(`后台轮询失败: ${error.message}`, 'error');
	});
		
	pollingIntervalId = setInterval(() => {
		runConnectivityFlow({reason: 'polling'}).catch((error) => {
			eventBus.log(`后台轮询失败: ${error.message}`, 'error');
		});
	}, intervalMs);

	eventBus.log(`主进程轮询已启动，间隔 ${intervalMs}ms`, 'info');
}

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
			width: 880,
			height: 727,
			frame: true,
			webPreferences: {
				nodeIntegration: true,
				contextIsolation: false,
				autoHideMenuBar: true
			}
		});
		mainWindow.loadFile('index.html');
		mainWindow.setMenu(null);
		mainWindow.webContents.on('did-finish-load', () => {
			flushPendingUpdatePopup();
		});
		
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
		
		// Load and apply saved log level
		const savedLogLevel = store.get('logLevel', 'debug');
		eventBus.setLogLevel(savedLogLevel);
		
		// Prevent App Nap on macOS to ensure background tasks continue
		// if (process.platform === 'darwin') {
		// 	powerSaveBlockerId = powerSaveBlocker.start('prevent-app-suspension');
		// 	setTimeout(()=>{eventBus.log('Power save blocker started to prevent App Nap on macOS');}, 1000)
		// }

		restartPolling();
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
			quitAppModule.markQuitting();
			// Stop power save blocker before quitting
			if (powerSaveBlockerId !== null && powerSaveBlocker.isStarted(powerSaveBlockerId)) {
				powerSaveBlocker.stop(powerSaveBlockerId);
				eventBus.log('Power save blocker stopped');
			}
		});
	}
	
	// --- IPC Handlers --- //
	
	eventBus.on('log', (message, level) => {
		sendLogMessage(message, level);
	});
	
	// Settings Management
	ipcMain.handle('get-setting', async (event, key) => {
		return store.get(key);
	});
	
	ipcMain.handle('set-setting', async (event, {key, value}) => {
		store.set(key, value);
		// Update log level in event bus if it's being changed
		if (key === 'logLevel') {
			eventBus.setLogLevel(value);
		}
		if (key === 'pollingInterval') {
			restartPolling();
		}
		return true;
	});
	
	ipcMain.on('set-start-on-login', (event, enabled) => {
		app.setLoginItemSettings({openAtLogin: enabled});
		store.set('startOnLogin', enabled);
	});
	
	// Credential Management
	ipcMain.handle('get-credentials', async () => {
		try {
			return await decryptCredentials(store.get('credentials', null));
		} catch (error) {
			eventBus.log(`无法读取已存储的凭证: ${error.message}`, 'error');
			return null;
		}
	});
	
	ipcMain.on('set-credentials', async (event, {username, password}) => {
		if (!username && !password) {
			store.delete('credentials');
			return;
		}

		try {
			store.set('credentials', await encryptCredentials({username, password}));
		} catch (error) {
			eventBus.log(`无法存储凭证: ${error.message}`, 'error');
		}
	});

	// Network Operations
	ipcMain.handle('check-connectivity', async () => {
		return await checkConnectivity();
	});

	ipcMain.handle('get-latest-polling-status', async () => {
		return latestPollingSnapshot;
	});

	ipcMain.handle('test-connectivity-url', async (event, url) => {
		return await checkUrl(url);
	});
	
	ipcMain.handle('network-login', async (event, credentials) => {
		const {username, password} = credentials;
		isAutoLoginInProgress = true;
		try {
			return await login(username, password);
		} finally {
			isAutoLoginInProgress = false;
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

	ipcMain.handle('get-pending-update-info', async () => {
		return pendingUpdateInfo;
	});

	ipcMain.on('dismiss-pending-update-info', () => {
		pendingUpdateInfo = null;
	});
	
	
	// --- Utility Functions --- //
	
	function sendLogMessage(message, level = 'debug') {
		if (mainWindow) {
			mainWindow.webContents.send('log-message', message, level);
		}
	}

	function flushPendingUpdatePopup() {
		if (mainWindow && pendingUpdateInfo) {
			mainWindow.webContents.send('show-update-popup', pendingUpdateInfo);
		}
	}

	function queueUpdatePopup(updateInfo) {
		pendingUpdateInfo = updateInfo;
		flushPendingUpdatePopup();
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
		eventBus.log(`Update notification shown for version ${latestVersion}`);
	}
	
	async function checkUpdates() {
		try {
			eventBus.log('正在检测更新...', 'info');
			eventBus.log('Current Version: ' + app.getVersion()); // X.Y.Z
			const [tagRes, notesRes] = await Promise.all([
				axios.get('https://ipv4.quitsense.cn:10443/api/bjutautologin/getLatestTag'),
				axios.get('https://ipv4.quitsense.cn:10443/api/bjutautologin/getLatestReleaseNotes')
			]);
			if (!tagRes.data.success) {
				throw new Error('无法获取最新版本: ' + tagRes.data.message);
			}
			if (!notesRes.data.success) {
				throw new Error('无法获取更新说明: ' + notesRes.data.message);
			}
			let tagstr = tagRes.data.data; // yes, my api is shit
			const releaseNotes = notesRes.data.data;
			eventBus.log('Get tagstr success! Latest version = ' + tagstr);
			if (tagstr.at(0).toLowerCase() === 'v') { // remove v at front
				tagstr = tagstr.substring(1);
			}
			// Remove -, _, and spaces from version string (e.g., "0.19.15-alpha" -> "0.19.15")
			tagstr = tagstr.replace(/[-_ ]/g, '');
			
			// compare
			const currentTags = app.getVersion().split('.');
			const latestTags = tagstr.split('.');
			let need_update = false;
			for (let i = 0; i < Math.min(latestTags.length, currentTags.length); ++i) {
				if (parseInt(latestTags[i]) > parseInt(currentTags[i])) {
					need_update = true;
					break;
				} else if (parseInt(latestTags[i]) < parseInt(currentTags[i])) { // wtf...
					eventBus.log('It seems that latest Tag is SMALLER than current Tag? Am I in future?(' + tagstr + ' < ' + app.getVersion() + ')');
					return;
				}
			}
			if (!need_update && latestTags.length > currentTags.length) need_update = true;
			
			// show notification if update is needed
			if(!need_update) {
				eventBus.log('已是最新版本(' + tagstr + ' = ' + app.getVersion() + ')', 'info');
				return;
			}
			eventBus.log('找到更新！(' + tagstr + ' > ' + app.getVersion() + ')');
			queueUpdatePopup({
				version: tagstr,
				releaseNotes
			});
			createUpdatePopup(tagstr);
			return {
				version: tagstr,
				releaseNotes,
				needUpdate: true
			};
		} catch (e) {
			eventBus.log('检查更新失败: ' + e.message + '，1h后重试', 'error');
			setTimeout(checkUpdates, 3600 * 1000);
			throw e;
		}
	}
}
