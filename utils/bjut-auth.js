// utils/bjut-auth.js
const si = require('systeminformation');
const axios = require('axios');
const qs = require('qs');
const cheerio = require('cheerio');
const eventBus = require('./event-bus');
const os = require('os'); // Added for MAC address retrieval

/**
 * Detects the active network interface, its type, SSID, and MAC address.
 * @returns {Promise<{name: string, type: 'wifi' | 'ethernet', ssid: string | null, mac: string}>}
 */
async function getNetworkInterface() {
    const interfaces = await si.networkInterfaces();
    const defaultInterface = interfaces.find(iface => iface.default === true);

    if (!defaultInterface) {
        throw new Error('Could not find the default network interface.');
    }

    const interfaceName = defaultInterface.iface;
    const mac = defaultInterface.mac;

    if (/(wi-fi|wifi|wlan|wireless|en0)/i.test(interfaceName)) {
        const wifiConnections = await si.wifiConnections();
        const activeConnection = wifiConnections.find(conn => conn.iface === interfaceName);
        const ssid = activeConnection ? activeConnection.ssid : null;
        return { name: interfaceName, type: 'wifi', ssid: ssid, mac: mac };
    } else {
        return { name: interfaceName, type: 'ethernet', ssid: null, mac: mac };
    }
}

/**
 * Checks only for internet connectivity by hitting two endpoints.
 * @returns {Promise<{ipv4Access: boolean, ipv6Access: boolean}>}
 */
async function checkConnectivity() {
    const checkUrl = async (url) => {
        try {
            const response = await axios.get(url, { timeout: 5000 });
            return response.status === 200;
        } catch (error) {
            return false;
        }
    };

    eventBus.emit('log', 'Checking IPv4/IPv6 connectivity...');
    const [ipv4Result, ipv6Result] = await Promise.allSettled([
        checkUrl('https://ipv4.quitsense.cn:10443/api/helloworld'),
        checkUrl('https://ipv6.quitsense.cn:10443/api/helloworld')
    ]);

    return {
        ipv4Access: ipv4Result.status === 'fulfilled' && ipv4Result.value,
        ipv6Access: ipv6Result.status === 'fulfilled' && ipv6Result.value,
    };
}


// --- NEW: Status Check Functions ---
async function checkLgnStatus() {
    try {
        const response = await axios.get('http://lgn.bjut.edu.cn', { timeout: 3000 });
        return !response.data.includes('<!--Dr.COMWebLoginID_1.htm-->');
    } catch (error) {
        return false;
    }
}

async function checkWlgnStatus() {
    try {
        const response = await axios.get('http://10.21.251.3/drcom/chkstatus', { params: { callback: `dr${Date.now()}` }, timeout: 3000 });
        const data = parseJsonp(response.data);
        return data.result === '1';
    } catch (error) {
        return false;
    }
}

async function check10221Status() {
    try {
        const response = await axios.get('http://10.21.221.98/drcom/chkstatus', { params: { callback: `dr${Date.now()}` }, timeout: 3000 });
        const data = parseJsonp(response.data);
        return data.result === '1';
    } catch (error) {
        return false;
    }
}

/**
 * NEW: Checks the login status by detecting the current network environment.
 * @returns {Promise<{environment: string, loggedIn: boolean, details: object}>}
 */
async function checkStatus() {
    eventBus.emit('log', 'Checking network environment and login status...');
    const network = await getNetworkInterface();

    if (network.type === 'wifi' && network.ssid && network.ssid.toLowerCase().includes('bjut-sushe')) {
        const loggedIn = await check10221Status();
        eventBus.emit('log', `Environment: Dormitory. Logged in: ${loggedIn}`);
        return { environment: 'dormitory', loggedIn };
    }

    if (network.type === 'wifi' && network.ssid && network.ssid.toLowerCase().includes('bjut_wifi')) {
        const wlgnLoggedIn = await checkWlgnStatus();
        const lgn6LoggedIn = await checkLgnStatus();
        eventBus.emit('log', `Environment: Campus Wi-Fi. WLGN Status: ${wlgnLoggedIn}, LGN6 Status: ${lgn6LoggedIn}`);
        return { environment: 'campus_wifi', loggedIn: wlgnLoggedIn && lgn6LoggedIn, details: { wlgn: wlgnLoggedIn, lgn6: lgn6LoggedIn } };
    }

    if (network.type === 'ethernet') {
        const loggedIn = await checkLgnStatus();
        eventBus.emit('log', `Environment: Ethernet. Logged in: ${loggedIn}`);
        return { environment: 'ethernet', loggedIn };
    }

    eventBus.emit('log', 'Environment: Unknown or disconnected.');
    return { environment: 'unknown', loggedIn: false };
}


// --- Core Login Logic (Original Structure Preserved) ---

/**
 * Main login function. It orchestrates the login process.
 * I've added an optional 'operator' parameter for the dormitory login.
 * @param {string} username
 * @param {string} password
 * @param {string} [operator='campus']
 */
async function login(username, password, operator = 'campus') {
    try {
        const networkInterface = await getNetworkInterface();
        eventBus.emit('log', `Interface type: ${networkInterface.type}`);
        if (networkInterface.ssid) {
            eventBus.emit('log', `Wi-Fi SSID: ${networkInterface.ssid}`);
        }

        if (networkInterface.ssid && networkInterface.ssid.toLowerCase().includes('bjut-sushe')) {
            return await susheLogin(username, password, networkInterface.mac, operator);
        } else if (networkInterface.ssid && networkInterface.ssid.toLowerCase() === 'bjut_wifi') {
            const connectivity = await checkConnectivity();
            if(!connectivity.ipv4Access) {
                await wlgnLogin(username, password, networkInterface.mac);
            }
            await lgn6Login(username, password, networkInterface.mac);
        } else {
            eventBus.emit('log', 'Login skipped: not on a recognized BJUT network.');
            throw new Error("Login skipped: not on a recognized BJUT network.");
        }
    } catch (error) {
        eventBus.emit('log', `Login aborted: ${error.message}`);
        throw error; // Re-throw error to be caught by caller
    }
}

// --- Helper Functions (Preserved and Added) ---

/**
 * Parses the JSONP response by stripping the callback wrapper.
 * @param {string} jsonp The JSONP string.
 * @returns {object} The parsed JSON object.
 */
function parseJsonp(jsonp) {
    const jsonString = jsonp.replace(/^.*?\((.*)\)$/, '$1');
    try {
        return JSON.parse(jsonString);
    } catch (error) {
        // If parsing fails, it might be a plain HTML error page
        const titleMatch = jsonp.match(/<title>(.*?)<\/title>/);
        const message = titleMatch ? titleMatch[1] : 'Failed to parse JSONP response and no error title found.';
        throw new Error(message);
    }
}

/**
 * ENHANCED: Handles dormitory network login with operator support and retry logic.
 */
async function susheLogin(username, password, mac, operator = 'campus') {
    eventBus.emit('log', `Attempting dormitory login with operator: ${operator}...`);
    const userAccount = `${username}@${operator}`;
    const formattedMac = mac.replace(/:/g, '').toUpperCase();
    const data = {
        callback: 'dr1003',
        'login_method': 1,
        user_account: userAccount,
        user_password: password,
        wlan_user_ip: '', // Server can figure this out
        wlan_user_ipv6: '',
        wlan_user_mac: formattedMac,
        wlan_ac_ip: '',
        wlan_ac_name: '',
        jsVersion: '4.2.1',
        terminal_type: '1',
        lang: 'zh-cn',
        'v': Math.floor(Math.random() * 9000) + 1000,
    };
    const loginUrl = `http://10.21.221.98:801/eportal/portal/login?${qs.stringify(data)}`;

    try {
        const res = await axios.get(loginUrl);
        const responseData = parseJsonp(res.data);

        if (responseData.result === '1') {
            const msg = `Dormitory login successful. Message: ${responseData.msg}`;
            eventBus.emit('log', msg);
            return { success: true, message: msg };
        } else {
            // Retry logic from shell script
            if (String(responseData.ret_code) === '2') {
                eventBus.emit('log', 'Stale session detected. Forcing logout and retrying...');
                await axios.get(`http://10.21.221.98:801/eportal/?c=Portal&a=logout`);
                const retryRes = await axios.get(loginUrl);
                const retryData = parseJsonp(retryRes.data);
                if (retryData.result === '1') {
                    const msg = `Dormitory login successful after retry. Message: ${retryData.msg}`;
                    eventBus.emit('log', msg);
                    return { success: true, message: msg };
                } else {
                    throw new Error(`Dormitory login failed on retry. Message: ${retryData.msg}`);
                }
            }
            throw new Error(`Dormitory login failed. Message: ${responseData.msg}`);
        }
    } catch (error) {
        eventBus.emit('log', `Dormitory login error: ${error.message}`);
        throw error;
    }
}

/**
 * IMPLEMENTED: Handles campus Wi-Fi (bjut_wifi) login.
 */
async function wlgnLogin(username, password, mac) {
    eventBus.emit('log', 'Attempting campus Wi-Fi (wlgn) login...');
    try {
        const params = {
            callback: 'dr1002', DDDDD: username, upass: password, '0MKKey': '123456',
            R1: '0', R2: '', R3: '0', R6: '0', para: '00', v6ip: '',
            terminal_type: '1', lang: 'zh-cn', jsVersion: '4.1', v: Math.floor(Math.random() * 1000) + 1,
        };
        const response = await axios.get('http://10.21.251.3/drcom/login', { params });
        const data = parseJsonp(response.data);

        if (data.result === '1') {
            const msg = `Campus Wi-Fi (wlgn) login successful. Message: ${data.msga || 'N/A'}`;
            eventBus.emit('log', msg);
            return { success: true, message: msg };
        } else {
            throw new Error(`WLGN login failed. Result: ${data.result}, Message: ${data.msga}`);
        }
    } catch (error) {
        eventBus.emit('log', `WLGN login error: ${error.message}`);
        throw error;
    }
}

/**
 * IMPLEMENTED: Handles IPv6-only login, often for bjut_wifi.
 */
async function lgn6Login(username, password, mac) {
    eventBus.emit('log', 'Attempting IPv6-only (lgn6) login...');
    try {
        const response = await axios.post('https://lgn6.bjut.edu.cn', qs.stringify({
            DDDDD: username, upass: password, v46s: 2, '0MKKey': ''
        }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

        if (response.data.includes('successfully logged in')) {
            const msg = 'IPv6-only (lgn6) login successful.';
            eventBus.emit('log', msg);
            return { success: true, message: msg };
        } else {
            throw new Error('LGN6 login failed. The returned page did not contain a success message.');
        }
    } catch (error) {
        eventBus.emit('log', `LGN6 login error: ${error.message}`);
        throw error;
    }
}

/**
 * NEW: Full dual-stack login for Ethernet connections.
 */
async function lgnLogin46(username, password) {
    eventBus.emit('log', 'Attempting dual-stack (lgn) login...');
    try {
        const res1 = await axios.post('https://lgn6.bjut.edu.cn/V6?https://lgn.bjut.edu.cn', qs.stringify({
            DDDDD: username, upass: password, v46s: 0, '0MKKey': ''
        }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

        const $ = cheerio.load(res1.data);
        const v6ip = $('input[name=v6ip]').val();
        if (!v6ip) throw new Error('Could not retrieve v6ip from lgn6. IPv6 might be unavailable.');

        const res2 = await axios.post('https://lgn.bjut.edu.cn', qs.stringify({
            DDDDD: username, upass: password, '0MKKey': 'Login', v6ip: v6ip
        }), { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });

        if (res2.data.includes('successfully logged in')) {
            const msg = 'Dual-stack (lgn) login successful.';
            eventBus.emit('log', msg);
            return { success: true, message: msg };
        } else {
            throw new Error('LGN login failed. The returned page did not contain a success message.');
        }
    } catch (error) {
        eventBus.emit('log', `LGN login error: ${error.message}`);
        throw error;
    }
}

// Preserving original exports and adding the new checkStatus function
module.exports = {
    login,
    checkConnectivity,
    checkStatus,
};
