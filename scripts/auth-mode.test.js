const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {createRequire} = require('node:module');
const {normalizeAuthMode, isConnectivitySatisfied} = require('../utils/auth-mode');
const {DEFAULT_OVERRIDES, applyAuthModeOverrides, createNetworkService, initNetworkSettings} = require('../utils/network-settings');
const {registerIpcHandlers} = require('../utils/ipc-handlers');

function loadWith(file, dependencies) {
	const filename = path.join(__dirname, '..', 'utils', file);
	const originalRequire = createRequire(filename);
	const module = {exports: {}};
	vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
		module, exports: module.exports,
		require: id => Object.hasOwn(dependencies, id) ? dependencies[id] : originalRequire(id),
		console: {log() {}}, setTimeout, clearTimeout
	}, {filename});
	return module.exports;
}

test('default mode requires both families; lgn6-only requires only IPv6', () => {
	assert.equal(normalizeAuthMode(undefined), 'dual');
	assert.equal(normalizeAuthMode('ipv4-only'), 'dual');
	assert.equal(isConnectivitySatisfied({ipv4Access: true, ipv6Access: false}, 'lgn6-only'), false);
	assert.equal(isConnectivitySatisfied({ipv4Access: false, ipv6Access: true}, 'lgn6-only'), true);
	assert.equal(isConnectivitySatisfied({ipv4Access: null, ipv6Access: true}, 'lgn6-only'), true);
	assert.equal(isConnectivitySatisfied({ipv4Access: false, ipv6Access: true}), false);
	assert.equal(isConnectivitySatisfied({ipv4Access: true, ipv6Access: true}), true);
});

test('mode changes persist lgn6 IP override atomically and all manual endpoints stay on IPv6-only lgn6', async t => {
	const settings = {networkOverrides: structuredClone(DEFAULT_OVERRIDES)};
	const store = {
		get: (key, fallback) => settings[key] ?? fallback,
		set: (key, value) => typeof key === 'object' ? Object.assign(settings, structuredClone(key)) : settings[key] = structuredClone(value)
	};
	initNetworkSettings(store);
	t.after(() => initNetworkSettings(null));
	const handlers = new Map();
	const calls = [];
	registerIpcHandlers({ipcMain: {handle: (key, fn) => handlers.set(key, fn), on() {}}, store,
		restartPolling: reason => calls.push(['poll', reason]),
		susheLogin: () => calls.push(['sushe']), wlgnLogin: () => calls.push(['wlgn']), lgnLogin46: () => calls.push(['lgn']),
		lgn6Login: (...args) => calls.push(['lgn6', ...args]), updateTrafficData: mode => {calls.push(['traffic', mode]); return {usedTraffic: '1 GB'};}});
	const invoke = (key, value) => handlers.get(key)(null, value);
	assert.equal(await invoke('get-setting', 'authMode'), 'dual');
	await invoke('set-setting', {key: 'authMode', value: 'lgn6-only'});
	assert.equal(settings.authMode, 'lgn6-only');
	assert.equal(settings.networkOverrides.lgn6.enabled, true);
	for (const key of ['sushe-login', 'wlgn-login', 'lgn6-login', 'lgn-login-46', 'lgn6-login-46']) {
		await invoke(key, {username: 'test', password: 'placeholder'});
	}
	assert.equal(calls.filter(call => call[0] === 'lgn6').length, 5);
	assert.ok(calls.filter(call => call[0] === 'lgn6').every(call => call.length === 3));
	assert.deepEqual(await invoke('get-traffic-info'), {usedTraffic: '1 GB'});
	assert.ok(calls.some(call => call[0] === 'traffic' && call[1] === 'lgn6-only'));
	assert.ok(!calls.some(call => ['sushe', 'wlgn', 'lgn'].includes(call[0])));
	const attempted = structuredClone(settings.networkOverrides);
	attempted.lgn6.enabled = false;
	await invoke('set-setting', {key: 'networkOverrides', value: attempted});
	assert.equal(settings.networkOverrides.lgn6.enabled, true);
	attempted.lgn6.address = 'lgn6.bjut.edu.cn';
	await assert.rejects(invoke('set-setting', {key: 'networkOverrides', value: attempted}), /IP 地址/);
	await invoke('set-setting', {key: 'authMode', value: 'dual'});
	await invoke('sushe-login', {username: 'test', password: 'placeholder'});
	assert.ok(calls.some(call => call[0] === 'sushe'));
	settings.networkOverrides.lgn6.address = 'custom.example';
	await assert.rejects(invoke('set-setting', {key: 'authMode', value: 'lgn6-only'}), /IP 地址/);
	assert.equal(settings.authMode, 'dual');
});

test('lgn6-only calls only the overridden IP with the IPv6-only API parameters, in every network location', async () => {
	for (const ipv4Access of [false, true]) {
		const requests = [];
		let ipv6Access = false;
		const overrides = applyAuthModeOverrides(DEFAULT_OVERRIDES, 'lgn6-only');
		const {client} = createNetworkService({getSettings: () => overrides});
		client.defaults.adapter = async config => {
			requests.push({url: config.url, data: config.data, host: config.headers.get('Host'), servername: config.httpsAgent.options.servername});
			return {data: 'ok', status: 200, headers: {}, config};
		};
		const {login} = loadWith('bjut-auth.js', {
			'./network-settings': {networkClient: client, getAuthMode: () => 'lgn6-only'},
			'./heartbeat-loop': {checkConnectivity: async () => ({ipv4Access, ipv6Access})}
		});
		await login('test', 'placeholder');
		assert.equal(requests.length, 1);
		assert.equal(requests[0].url, 'https://[2001:da8:216:30c9::2]/');
		assert.equal(new URLSearchParams(requests[0].data).get('v46s'), '2');
		assert.equal(requests[0].host, 'lgn6.bjut.edu.cn');
		assert.equal(requests[0].servername, 'lgn6.bjut.edu.cn');
		ipv6Access = true;
		await login('test', 'placeholder');
		assert.equal(requests.length, 1, 'IPv6 connected: no repeat authentication or server probes');
	}
});

test('IPv6-only polling skips IPv4, queries traffic through lgn6 and retries a lost IPv6 connection once', async () => {
	let online = true;
	const requests = [], authentications = [], tray = [];
	class Store {get(key, fallback) {return fallback;}}
	const {checkConnectivity, createHeartbeatLoop} = loadWith('heartbeat-loop.js', {
		'electron-store': Store,
		'./network-settings': {getAuthMode: () => 'lgn6-only', networkClient: {get: async url => {
			requests.push(url);
			if (!online) throw new Error('offline');
			return {status: 200};
		}}},
		'./tray': {setTrayStatus: status => tray.push(status)}
	});
	const result = await checkConnectivity();
	assert.equal(result.ipv4Access, null);
	assert.equal(result.ipv6Access, true);
	assert.equal(tray.at(-1), 'green');
	const trafficModes = [];
	const loop = createHeartbeatLoop({store: new Store(), mainWindowProvider: () => null,
		updateTrafficData: async mode => {trafficModes.push(mode); return {usedTraffic: '1 GB'};},
		login: async (...args) => {authentications.push(args); online = true;},
		getStoredCredentials: async () => ({username: 'test', password: 'placeholder'}),
		getAutoLoginInProgress: () => false, setAutoLoginInProgress() {}, sleep: async () => {}});
	await loop.runConnectivityFlow();
	assert.equal(authentications.length, 0);
	online = false;
	await loop.runConnectivityFlow();
	await loop.runConnectivityFlow();
	assert.equal(authentications.length, 1);
	assert.equal(authentications[0][2], 'lgn6-only');
	assert.deepEqual(trafficModes, ['lgn6-only', 'lgn6-only', 'lgn6-only']);
	assert.ok(requests.every(url => url.includes('ipv6.msftconnecttest.com')));
	assert.equal(tray.at(-1), 'green');
});

test('traffic queries choose lgn or lgn6 by mode and honor the corresponding IP override and port', async () => {
	for (const mode of ['dual', 'lgn6-only']) {
		const overrides = applyAuthModeOverrides(DEFAULT_OVERRIDES, mode);
		overrides.lgn = {enabled: true, address: '192.0.2.10'};
		const {client} = createNetworkService({getSettings: () => overrides});
		let request;
		client.defaults.adapter = async config => {
			request = config;
			return {data: 'dr1003({"user_info":{"package_group_name":"本科生默认套餐","use_flow":"1 GB","balance":"2.5"}});', status: 200, headers: {}, config};
		};
		const {updateTrafficData} = loadWith('bjut-auth.js', {
			'./network-settings': {networkClient: client, getAuthMode: () => mode},
			'./heartbeat-loop': {}
		});
		const info = await updateTrafficData();
		assert.equal(info.usedTraffic, '1 GB');
		assert.equal(info.totalTraffic, '30 GB');
		const url = new URL(request.url);
		assert.equal(url.hostname, mode === 'dual' ? '192.0.2.10' : '[2001:da8:216:30c9::2]');
		assert.equal(url.port, '802');
		assert.equal(url.pathname, '/eportal/portal/page/loadUserInfo');
		assert.equal(request.headers.get('Host'), mode === 'dual' ? 'lgn.bjut.edu.cn:802' : 'lgn6.bjut.edu.cn:802');
	}
});
