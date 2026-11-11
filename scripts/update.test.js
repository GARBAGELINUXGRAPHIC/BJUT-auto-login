const assert = require('node:assert/strict');
const {setImmediate} = require('node:timers/promises');
const {test} = require('node:test');
const {createUpdateService} = require('../utils/update');

const RETRY_INTERVAL_MS = 15 * 60 * 1000;

function setup(t) {
	t.mock.timers.enable({apis: ['setTimeout']});
	const requests = [];
	let respond = (url) => Promise.resolve({
		data: {success: true, data: url.endsWith('getLatestTag') ? 'v2.0.9' : '更新说明'}
	});
	const service = createUpdateService({
		app: {getVersion: () => '2.0.9'},
		axios: {
			get(url, options) {
				requests.push({url, options});
				return respond(url);
			}
		},
		eventBus: {log() {}}
	});
	t.after(() => service.stopAutomaticChecks());
	return {
		service,
		requests,
		setResponse(response) {
			respond = response;
		}
	};
}

test('失败后每隔 15 分钟重试，成功后停止', async (t) => {
	const {service, requests, setResponse} = setup(t);
	let online = false;
	setResponse((url) => online
		? Promise.resolve({data: {success: true, data: url.endsWith('getLatestTag') ? 'v2.0.9' : ''}})
		: Promise.reject(new Error('网络不可用')));

	service.startAutomaticChecks();
	await setImmediate();
	assert.equal(requests.length, 2);
	assert.ok(requests.every(({options}) => options.timeout === 15000));

	t.mock.timers.tick(RETRY_INTERVAL_MS - 1);
	await setImmediate();
	assert.equal(requests.length, 2);
	t.mock.timers.tick(1);
	await setImmediate();
	assert.equal(requests.length, 4);

	online = true;
	t.mock.timers.tick(RETRY_INTERVAL_MS);
	await setImmediate();
	assert.equal(requests.length, 6);
	t.mock.timers.tick(RETRY_INTERVAL_MS * 3);
	service.startAutomaticChecks();
	await setImmediate();
	assert.equal(requests.length, 6);
});

test('版本或更新说明接口返回失败时仍需重试', async (t) => {
	const {service, requests, setResponse} = setup(t);
	let failedEndpoint = 'getLatestTag';
	setResponse((url) => Promise.resolve({data: url.endsWith(failedEndpoint)
		? {success: false, message: '暂不可用'}
		: {success: true, data: url.endsWith('getLatestTag') ? 'v2.0.9' : ''}}));
	service.startAutomaticChecks();
	await setImmediate();
	failedEndpoint = 'getLatestReleaseNotes';
	t.mock.timers.tick(RETRY_INTERVAL_MS);
	await setImmediate();
	assert.equal(requests.length, 4);
	t.mock.timers.tick(RETRY_INTERVAL_MS);
	await setImmediate();
	assert.equal(requests.length, 6);
});

test('手动检查成功会取消已经安排的自动重试', async (t) => {
	const {service, requests, setResponse} = setup(t);
	setResponse(() => Promise.reject(new Error('网络不可用')));
	service.startAutomaticChecks();
	await setImmediate();
	setResponse((url) => Promise.resolve({data: {
		success: true, data: url.endsWith('getLatestTag') ? 'v2.0.8' : ''
	}}));
	await service.checkUpdates();
	t.mock.timers.tick(RETRY_INTERVAL_MS * 2);
	await setImmediate();
	assert.equal(requests.length, 4);
});

test('自动检查和手动检查共享正在进行的请求', async (t) => {
	const {service, requests, setResponse} = setup(t);
	const complete = [];
	setResponse((url) => new Promise((resolve) => {
		complete.push(() => resolve({data: {
			success: true, data: url.endsWith('getLatestTag') ? 'v2.0.9' : ''
		}}));
	}));
	service.startAutomaticChecks();
	const first = service.checkUpdates();
	const second = service.checkUpdates();
	assert.equal(first, second);
	assert.equal(requests.length, 2);
	complete.forEach((resolve) => resolve());
	await first;
	t.mock.timers.tick(RETRY_INTERVAL_MS);
	await setImmediate();
	assert.equal(requests.length, 2);
});

test('关闭自动检查会取消重试，重新开启后继续尝试', async (t) => {
	const {service, requests, setResponse} = setup(t);
	setResponse(() => Promise.reject(new Error('网络不可用')));
	service.startAutomaticChecks();
	await setImmediate();
	service.stopAutomaticChecks();
	t.mock.timers.tick(RETRY_INTERVAL_MS * 2);
	await setImmediate();
	assert.equal(requests.length, 2);
	service.startAutomaticChecks();
	await setImmediate();
	assert.equal(requests.length, 4);
});

test('停止时尚未完成的失败请求不会再安排重试', async (t) => {
	const {service, requests, setResponse} = setup(t);
	const fail = [];
	setResponse(() => new Promise((resolve, reject) => fail.push(reject)));
	service.startAutomaticChecks();
	service.stopAutomaticChecks();
	fail.forEach((reject) => reject(new Error('请求超时')));
	await setImmediate();
	t.mock.timers.tick(RETRY_INTERVAL_MS * 2);
	await setImmediate();
	assert.equal(requests.length, 2);
});

test('自动检查关闭时，手动检查失败不会启动后台重试', async (t) => {
	const {service, requests, setResponse} = setup(t);
	setResponse(() => Promise.reject(new Error('网络不可用')));
	await assert.rejects(service.checkUpdates(), /网络不可用/);
	t.mock.timers.tick(RETRY_INTERVAL_MS * 2);
	await setImmediate();
	assert.equal(requests.length, 2);
});
