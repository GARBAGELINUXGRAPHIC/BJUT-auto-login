const AUTH_MODES = ['dual', 'lgn6-only'];

function normalizeAuthMode(mode) {
	return AUTH_MODES.includes(mode) ? mode : 'dual';
}

function isConnectivitySatisfied(connectivity, mode = 'dual') {
	if (!connectivity) return false;
	return normalizeAuthMode(mode) === 'lgn6-only'
		? connectivity.ipv6Access === true
		: connectivity.ipv4Access === true && connectivity.ipv6Access === true;
}

module.exports = {AUTH_MODES, normalizeAuthMode, isConnectivitySatisfied};
