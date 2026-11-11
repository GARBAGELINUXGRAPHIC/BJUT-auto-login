const {test} = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const {once} = require('node:events');
const {DEFAULT_OVERRIDES, normalizeOverrides, normalizeAddress, createNetworkService} = require('../utils/network-settings');

function settings() { return structuredClone(DEFAULT_OVERRIDES); }

test('validates domains, IPv4 and bracketed IPv6 before settings are saved', () => {
	assert.equal(normalizeAddress(' example.edu.cn '), 'example.edu.cn');
	assert.equal(normalizeAddress('[2001:db8::1]'), '[2001:db8::1]');
	for (const invalid of ['2001:db8::1', 'http://example.com', 'example.com:80', '1.2.3.999', '', 'a/b']) {
		assert.throws(() => normalizeAddress(invalid));
	}
	assert.throws(() => normalizeOverrides({dns: {enabled: true, address: 'example.com'}}));
	assert.deepEqual(normalizeOverrides(), DEFAULT_OVERRIDES);
});

test('overrides a real HTTP request, preserving its service host, path, port and query', async t => {
	let received;
	const server = http.createServer((req, res) => {
		received = {host: req.headers.host, url: req.url};
		res.end('ok');
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	t.after(() => new Promise(resolve => server.close(resolve)));
	const state = settings();
	state.lgn = {enabled: true, address: '127.0.0.1'};
	const {client} = createNetworkService({getSettings: () => state});
	const port = server.address().port;
	const response = await client.get(`http://lgn.bjut.edu.cn:${port}/test?a=1`);
	assert.equal(response.data, 'ok');
	assert.deepEqual(received, {host: `lgn.bjut.edu.cn:${port}`, url: '/test?a=1'});
});

test('all authentication services and nested dual-stack URL honor live settings and HTTPS keeps SNI', async () => {
	const state = settings();
	const {client} = createNetworkService({getSettings: () => state});
	const capture = config => Promise.resolve({status: 200, data: config, headers: {}, config});
	for (const [key, host] of Object.entries({sushe: '10.21.221.98', lgn: 'lgn.bjut.edu.cn', lgn6: 'lgn6.bjut.edu.cn', wlgn: 'wlgn.bjut.edu.cn'})) {
		state[key] = {enabled: true, address: '[::1]'};
		const {data} = await client.get(`https://${host}:802/path?q=1`, {adapter: capture});
		assert.equal(new URL(data.url).hostname, '[::1]');
		assert.equal(data.headers.get('Host'), `${host}:802`);
		assert.equal(data.httpsAgent.options.servername, host);
		assert.notEqual(data.httpsAgent.options.rejectUnauthorized, false);
		state[key].enabled = false;
		assert.equal(new URL((await client.get(`https://${host}`, {adapter: capture})).data.url).hostname, host);
	}
	state.lgn = {enabled: true, address: 'custom.example'};
	const {data} = await client.get('https://lgn6.bjut.edu.cn/V6?https://lgn.bjut.edu.cn', {adapter: capture});
	assert.equal(data.url, 'https://lgn6.bjut.edu.cn/V6?https://custom.example');
	state.wlgn = {enabled: true, address: '127.0.0.1'};
	assert.equal(new URL((await client.get('http://10.21.251.3/drcom/login', {adapter: capture})).data.url).hostname, '127.0.0.1');
});

test('DNS override handles both families, all mode, errors and switching back to system DNS', async () => {
	const state = settings();
	let servers;
	class Resolver {
		setServers(value) { servers = value; }
		async resolve4(host) { if (host === 'missing') throw new Error('ENOTFOUND'); return ['192.0.2.1']; }
		async resolve6(host) { if (host === 'missing') throw new Error('ENOTFOUND'); return ['2001:db8::1']; }
	}
	const {lookup} = createNetworkService({getSettings: () => state, Resolver, systemLookup: (host, options, cb) => cb(null, '127.0.0.2', 4)});
	const resolve = (host, options = {}) => new Promise((yes, no) => lookup(host, options, (err, address, family) => err ? no(err) : yes({address, family})));
	assert.equal((await resolve('example')).address, '127.0.0.2');
	state.dns = {enabled: true, address: '[::1]'};
	assert.deepEqual(await resolve('example', {family: 6}), {address: '2001:db8::1', family: 6});
	assert.deepEqual(servers, ['::1']);
	assert.equal((await resolve('example', {all: true})).address.length, 2);
	await assert.rejects(resolve('missing'), /ENOTFOUND/);
	state.dns.enabled = false;
	assert.equal((await resolve('example')).address, '127.0.0.2');
});
