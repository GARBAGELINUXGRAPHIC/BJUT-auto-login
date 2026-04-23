const LOG_BUFFER_LIMIT = 200;
const LOG_FLUSH_CHUNK_SIZE = 200;

function initLogManager({mainWindowProvider}) {
	let bufferedLogs = [];

	function clearBufferedLogs() {
		bufferedLogs = [];
	}

	function enqueueLog(message, level = 'debug') {
		bufferedLogs.push({
			message,
			level,
			timestamp: new Date().toISOString()
		});

		if (bufferedLogs.length > LOG_BUFFER_LIMIT) {
			bufferedLogs = bufferedLogs.slice(-LOG_BUFFER_LIMIT);
		}

		return bufferedLogs[bufferedLogs.length - 1];
	}

	function flushBufferedLogs(targetWindow) {
		if (!targetWindow || targetWindow.isDestroyed() || bufferedLogs.length === 0) {
			return;
		}

		const logsToFlush = bufferedLogs.slice();
		let index = 0;

		function flushChunk() {
			const mainWindow = mainWindowProvider();
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
		const mainWindow = mainWindowProvider();
		if (mainWindow && !mainWindow.isDestroyed()) {
			mainWindow.webContents.send('log-message', bufferedLogs[bufferedLogs.length - 1]);
		}
	}

	return {
		clearBufferedLogs,
		enqueueLog,
		flushBufferedLogs,
		sendLogMessage
	};
}

module.exports = {
	initLogManager
};