const eventBus = require('./event-bus');

function createCredentialService({ app, store, safeStorage, crypto, si }) {
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
			eventBus.log('正在使用crypto库存储加密凭证，安全性低于safeStorage', 'warn');
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

	async function getStoredCredentials() {
		try {
			return await decryptCredentials(store.get('credentials', null));
		} catch (error) {
			eventBus.log(`无法读取已存储的凭证: ${error.message}`, 'error');
			return null;
		}
	}

	return {
		encryptCredentials,
		decryptCredentials,
		getStoredCredentials
	};
}

module.exports = {
	createCredentialService
};