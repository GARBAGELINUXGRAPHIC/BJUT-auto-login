let app;
let axios;
let eventBus;
let mainWindow = null;
let pendingUpdateInfo = null;

function createUpdateService(deps) {
	app = deps.app;
	axios = deps.axios;
	eventBus = deps.eventBus;
	mainWindow = deps.mainWindow || null;
	
	return {
		flushPendingUpdatePopup,
		checkUpdates,
		getPendingUpdateInfo,
		dismissPendingUpdateInfo,
		setMainWindow
	};
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
		if (!need_update) {
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
		eventBus.log('检查更新失败: ' + e.message, 'error');
		throw e;
	}
}

function getPendingUpdateInfo() {
	return pendingUpdateInfo;
}

function dismissPendingUpdateInfo() {
	pendingUpdateInfo = null;
}

function setMainWindow(window) {
	mainWindow = window;
}

module.exports = {
	createUpdateService
};