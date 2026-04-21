const eventBus = require('./event-bus');

function createHeartbeatLoop({
	store,
	mainWindowProvider,
	checkConnectivity,
	updateTrafficData,
	login,
	getStoredCredentials,
	getAutoLoginInProgress,
	setAutoLoginInProgress,
	sleep
}) {
	let pollingTimeoutId = null;
	let recursivePollingTimestamp = 0;
	let isPollingCheckInProgress = false;
	let latestPollingSnapshot = null;

	function sendPollingSnapshot(snapshot) {
		latestPollingSnapshot = snapshot;
		const mainWindow = mainWindowProvider();
		if (mainWindow) {
			mainWindow.webContents.send('polling-status', snapshot);
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
			} else if (allowAutoAuth && !getAutoLoginInProgress()) {
				const credentials = await getStoredCredentials();
				if (credentials && credentials.username && credentials.password) {
					setAutoLoginInProgress(true);
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
						setAutoLoginInProgress(false);
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

	function runPollingRecursively(timestamp, intervalMs, reason = 'polling') {
		if (timestamp < recursivePollingTimestamp) {
			return;
		}

		runConnectivityFlow({reason}).catch((error) => {
			eventBus.log(`后台轮询失败: ${error.message}`, 'error');
		}).finally(() => {
			pollingTimeoutId = setTimeout(() => {
				runPollingRecursively(timestamp, intervalMs, 'polling');
			}, intervalMs);
		});
	}

	function restartPolling(reason = 'polling') {
		const intervalMs = Number(store.get('pollingInterval', 10000));
		if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
			eventBus.log(`轮询间隔不合法: ${intervalMs}不是有效的时间间隔`, 'error');
			return;
		}

		const timestamp = ++recursivePollingTimestamp;
		runPollingRecursively(timestamp, intervalMs, reason);

		eventBus.log(`主进程轮询已启动，间隔 ${intervalMs}ms`, 'info');
	}

	function stopPolling() {
		recursivePollingTimestamp = Date.now();
		if (pollingTimeoutId) {
			clearTimeout(pollingTimeoutId);
			pollingTimeoutId = null;
		}
	}

	function getLatestPollingSnapshot() {
		return latestPollingSnapshot;
	}

	return {
		runConnectivityFlow,
		restartPolling,
		stopPolling,
		getLatestPollingSnapshot
	};
}

module.exports = {
	createHeartbeatLoop
};
