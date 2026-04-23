function registerIpcHandlers({
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
	setAutoLoginInProgress,
	getPendingUpdateInfo,
	dismissPendingUpdateInfo,
	clearBufferedLogs
}) {
	// Settings Management
	ipcMain.handle('get-setting', async (event, key) => {
		return store.get(key);
	});

	ipcMain.handle('set-setting', async (event, {key, value}) => {
		store.set(key, value);
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

	ipcMain.on('append-log', (event, entry) => {
		if (!entry || typeof entry.message !== 'string') {
			return;
		}

		eventBus.log(entry.message, entry.level || 'debug');
	});
	
	ipcMain.on('clear-logs', () => {
		clearBufferedLogs();
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
		return getLatestPollingSnapshot();
	});

	ipcMain.handle('test-connectivity-url', async (event, url) => {
		return await checkUrl(url);
	});

	ipcMain.handle('network-login', async (event, credentials) => {
		const {username, password} = credentials;
		setAutoLoginInProgress(true);
		try {
			return await login(username, password);
		} finally {
			setAutoLoginInProgress(false);
		}
	});

	// Specific Login Handlers
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
		return getPendingUpdateInfo();
	});

	ipcMain.on('dismiss-pending-update-info', () => {
		dismissPendingUpdateInfo();
	});
}

module.exports = {
	registerIpcHandlers
};
