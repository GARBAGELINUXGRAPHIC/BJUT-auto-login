function createWindowManager({
	BrowserWindow,
	quitAppModule,
	logManager,
	flushPendingUpdatePopup,
	onWindowChange,
	loadFile = 'index.html',
	showTimeoutMs = 250,
	hideTimeoutMs = 250
}) {
	let mainWindow = null;
	let destroyWindowTimeout = null;
	let showWindowTimeout = null;
	let startUp = true;

	function clearShowWindowTimeout() {
		if (showWindowTimeout) {
			clearTimeout(showWindowTimeout);
			showWindowTimeout = null;
		}
	}

	function clearDestroyWindowTimeout() {
		if (destroyWindowTimeout) {
			clearTimeout(destroyWindowTimeout);
			destroyWindowTimeout = null;
		}
	}

	function createWindow() {
		clearShowWindowTimeout();

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

		onWindowChange(mainWindow);
		mainWindow.loadFile(loadFile);
		mainWindow.setMenu(null);

		if (startUp) {
			showWindowTimeout = setTimeout(() => {
				if (mainWindow && !mainWindow.isDestroyed()) {
					mainWindow.show();
					mainWindow.focus();
				}
				showWindowTimeout = null;
			}, showTimeoutMs);
			startUp = false;
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
			logManager.flushBufferedLogs(mainWindow);
		});

		mainWindow.on('close', (event) => {
			if (!quitAppModule.isQuiting) {
				event.preventDefault();
				const windowToDestroy = mainWindow;
				windowToDestroy.hide();

				clearDestroyWindowTimeout();

				destroyWindowTimeout = setTimeout(() => {
					if (windowToDestroy && !windowToDestroy.isDestroyed()) {
						windowToDestroy.destroy();
					}
					destroyWindowTimeout = null;
				}, hideTimeoutMs);
			}
		});

		mainWindow.on('closed', () => {
			clearShowWindowTimeout();
			clearDestroyWindowTimeout();
			onWindowChange(null);
			mainWindow = null;
		});
	}

	function showMainWindow() {
		clearDestroyWindowTimeout();

		if (!mainWindow || mainWindow.isDestroyed()) {
			createWindow();
			return;
		}

		if (mainWindow.isMinimized()) {
			mainWindow.restore();
		}
		if (!mainWindow.isVisible()) {
			mainWindow.show();
		}
		mainWindow.focus();
	}

	function openMainWindowDevTools() {
		showMainWindow();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.openDevTools();
		}
	}

	function getMainWindow() {
		return mainWindow;
	}

	function getHideTimeoutMs() {
		return hideTimeoutMs;
	}

	return {
		createWindow,
		showMainWindow,
		openMainWindowDevTools,
		getMainWindow,
		getHideTimeoutMs
	};
}

module.exports = {
	createWindowManager
};