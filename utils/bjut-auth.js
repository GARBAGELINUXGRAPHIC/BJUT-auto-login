// utils/bjut-auth.js
const si = require('systeminformation');
const axios = require('axios');
const qs = require('qs');
const cheerio = require('cheerio');
const eventBus = require('./event-bus');

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

/**
 * Main login function. It orchestrates the login process.
 * @param {string} username
 * @param {string} password
 */
async function login(username, password) {
    try {
        const networkInterface = await getNetworkInterface();
        eventBus.emit('log', `Interface type: ${networkInterface.type}`);
        if (networkInterface.ssid) {
            eventBus.emit('log', `Wi-Fi SSID: ${networkInterface.ssid}`);
        }

        if (networkInterface.ssid && networkInterface.ssid.toLowerCase().includes('bjut-sushe')) {
            return await susheLogin(username, password, networkInterface.mac);
        } else if (networkInterface.ssid && networkInterface.ssid.toLowerCase() === 'bjut_wifi') {
            const connectivity = await checkConnectivity();
            if(!connectivity.ipv4Access) { // 无感知认证失败
                await wlgnLogin(username, password, networkInterface.mac);
            }
            await lgn6Login(username, password, networkInterface.mac);
        } else {
            eventBus.emit('log', 'Login skipped: not on a recognized BJUT Wi-Fi network.');
            throw new Error("Login skipped: not on a recognized BJUT Wi-Fi network.");
        }
    } catch (error) {
        eventBus.emit('log', `Login aborted: ${error.message}`);
    }
}

async function susheLogin(username, password, mac) { // 10.21.221.98 red login
    // susheLogout(); // to be safe invoke logout first
    const formattedMac = mac.replace(/:/g, '').toUpperCase();
    eventBus.emit('log', `Using MAC address: ${formattedMac}`);

    const response = await axios.get('http://10.21.221.98/a79.htm');
    const htmlText = response.data;
    const $ = cheerio.load(htmlText);
    let v46ip = '';
    $('script').each((index, element) => {
        const scriptContent = $(element).html();
        const variableValueMatch = scriptContent?.match(/v46ip\s*=\s*['"]([^'"]+)['"]/);
        if (variableValueMatch) {
            v46ip = variableValueMatch[1];
        }
    });
    const data = {
        callback: 'dr1003',
        'login_method': 1,
        user_account: username,
        user_password: password,
        wlan_user_ip: v46ip,
        wlan_user_ipv6: '',
        wlan_user_mac: formattedMac,
        wlan_ac_ip: '',
        wlan_ac_name: '',
        jsVersion: '4.2.1',
        terminal_type: '1',
        lang: 'zh-cn',
        'v': Math.random()*9000+1000,
    }
    const res = await axios.get(`http://10.21.221.98:801/eportal/portal/login?${qs.stringify(data)}`);
    if(res.status === 200 && res.data.result === 1) {
        eventBus.emit('log', 'Dormitory network (sushe) login success: ' + res.data.msg);
        return { success: true, message: res.data.msg };
    } else {
        throw new Error(res.data.msg);
    }
}

async function wlgnLogin(username, password, mac) { // bjut_wifi wlgn ipv4 login
    eventBus.emit('log', 'wlgnLogin function called, but it is not implemented.');
    return Promise.reject(new Error('wlgnLogin functionality is not implemented.'));
}

async function lgn6Login(username, password, mac) { // lgn6 login for bjut_wifi
    eventBus.emit('log', 'lgn6Login function called, but it is not implemented.');
    return Promise.reject(new Error('lgn6Login functionality is not implemented.'));
}

module.exports = {
    login,
    checkConnectivity,
};