const dns = require('node:dns');
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');
const axios = require('axios');
const {normalizeAuthMode} = require('./auth-mode');

// Queried on the campus network using DHCP DNS 10.21.200.25.
const DEFAULT_OVERRIDES = {
	dns: {enabled: false, address: '10.21.200.25'},
	sushe: {enabled: false, address: '10.21.221.98'},
	lgn: {enabled: false, address: '172.30.201.10'},
	lgn6: {enabled: false, address: '[2001:da8:216:30c9::2]'},
	wlgn: {enabled: false, address: '10.21.251.3'}
};
const SERVER_HOSTS = {
	'10.21.221.98': 'sushe',
	'lgn.bjut.edu.cn': 'lgn',
	'lgn6.bjut.edu.cn': 'lgn6',
	'wlgn.bjut.edu.cn': 'wlgn',
	'10.21.251.3': 'wlgn'
};

function normalizeAddress(value, dnsOnly = false) {
	const address = String(value || '').trim();
	const bare = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
	const family = net.isIP(bare);
	if (family === 6 && address !== `[${bare}]`) throw new Error('IPv6 地址请使用 [...] 格式');
	if (family) return family === 6 ? `[${bare}]` : bare;
	if (/^[\d.]+$/.test(address)) throw new Error('IPv4 地址不合法');
	if (dnsOnly) throw new Error('DNS 必须填写 IPv4 或 [...] 格式的 IPv6 地址');
	if (address.length > 253 || !address.split('.').every(label => /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label))) {
		throw new Error('请填写域名或 IP 地址，不含协议、端口和路径');
	}
	return address.toLowerCase();
}

function normalizeOverrides(value = {}) {
	return Object.fromEntries(Object.entries(DEFAULT_OVERRIDES).map(([key, fallback]) => {
		const entry = value[key] || fallback;
		return [key, {enabled: entry.enabled === true, address: normalizeAddress(entry.address, key === 'dns')}];
	}));
}

function applyAuthModeOverrides(overrides, mode) {
	const value = normalizeOverrides(overrides);
	if (mode === 'lgn6-only') {
		if (!net.isIP(value.lgn6.address.replace(/^\[|\]$/g, ''))) {
			throw new Error('仅 lgn6 模式需要填写 lgn6 的 IP 地址，IPv6 请使用 [...] 格式');
		}
		value.lgn6.enabled = true;
	}
	return value;
}

function createNetworkService({getSettings = () => DEFAULT_OVERRIDES, systemLookup = dns.lookup, Resolver = dns.promises.Resolver} = {}) {
	let resolver;
	let resolverAddress;
	function lookup(hostname, options, callback) {
		if (typeof options === 'function') { callback = options; options = {}; }
		if (typeof options === 'number') options = {family: options};
		options = options || {};
		const setting = getSettings().dns;
		if (!setting.enabled) return systemLookup(hostname, options, callback);
		if (!resolver || resolverAddress !== setting.address) {
			resolver = new Resolver({timeout: 3000, tries: 1});
			resolver.setServers([setting.address.replace(/^\[|\]$/g, '')]);
			resolverAddress = setting.address;
		}
		const families = options.family === 4 ? [4] : options.family === 6 ? [6] : [4, 6];
		Promise.allSettled(families.map(async family => {
			const addresses = await resolver[family === 4 ? 'resolve4' : 'resolve6'](hostname);
			return addresses.map(address => ({address, family}));
		})).then(results => {
			const addresses = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
			if (!addresses.length) return callback(results.find(result => result.status === 'rejected')?.reason || new Error(`无法解析 ${hostname}`));
			if (options.all) callback(null, addresses);
			else callback(null, addresses[0].address, addresses[0].family);
		}).catch(callback);
	}
	const httpAgent = new http.Agent({lookup});
	const httpsAgent = new https.Agent({lookup});
	const client = axios.create({httpAgent, httpsAgent});
	client.interceptors.request.use(config => {
		const url = new URL(config.url, config.baseURL);
		const settings = getSettings();
		const key = SERVER_HOSTS[url.hostname];
		const setting = key && settings[key];
		// The dual-stack login includes the lgn origin inside lgn6's /V6 query.
		for (const [host, service] of Object.entries(SERVER_HOSTS)) {
			if (settings[service].enabled) url.search = url.search.replaceAll(`https://${host}`, `https://${settings[service].address}`);
		}
		if (settings.dns.enabled || setting?.enabled) config.proxy = false;
		if (setting?.enabled) {
			const originalHost = url.host;
			const originalHostname = url.hostname;
			url.hostname = setting.address;
			config.headers.set('Host', originalHost);
			// Keep certificate verification and SNI for the original service when connecting to an overridden address.
			if (url.protocol === 'https:') config.httpsAgent = new https.Agent({lookup, servername: originalHostname});
		}
		config.url = url.href;
		return config;
	});
	return {client, lookup};
}

let store;
function getAuthMode() {
	return normalizeAuthMode(store?.get('authMode'));
}
function getNetworkOverrides() {
	return applyAuthModeOverrides(store?.get('networkOverrides') || DEFAULT_OVERRIDES, getAuthMode());
}
function initNetworkSettings(settingsStore) { store = settingsStore; }
const {client: networkClient} = createNetworkService({getSettings: getNetworkOverrides});

module.exports = {DEFAULT_OVERRIDES, normalizeAddress, normalizeOverrides, applyAuthModeOverrides, createNetworkService, initNetworkSettings, getNetworkOverrides, getAuthMode, networkClient};
