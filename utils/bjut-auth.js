// utils/bjut-auth.js
const si = require('systeminformation');
const axios = require('axios');
const qs = require('qs');
const cheerio = require('cheerio');
const eventBus = require('./event-bus');require('os');

async function getBJUTauthServersReachability() {
    return Promise.all({
            "sushe": axios.get('http://10.21.221.98/', {timeout: 1000}),
            "wlgn": axios.get('https://wlgn.bjut.edu.cn/', {timeout: 1000}),
            "lgn6": axios.get('https://lgn6.bjut.edu.cn/', {timeout: 1000}),
            "lgn" : axios.get('https://lgn.bjut.edu.cn/' , {timeout: 1000})
        }
    ).then(() => true).catch(() => false);
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
        //checkUrl('https://ipv4.quitsense.cn:10443/api/helloworld'),
        //checkUrl('https://ipv6.quitsense.cn:10443/api/helloworld')
        checkUrl('https://4.ipw.cn'),
        checkUrl('https://6.ipw.cn')
    ]);

    return {
        ipv4Access: ipv4Result.status === 'fulfilled' && ipv4Result.value,
        ipv6Access: ipv6Result.status === 'fulfilled' && ipv6Result.value,
    };
}

/*function getkey (ip = 'test'){
    if(typeof(ip) == 'undefined' || ip == '') return "";
    var ret=0;
    var len=ip.length;
    for(var i=0;i<len;i++)
        ret^=ip.charCodeAt(i);
    return ret;
}*/

const keys = 22;
const blueLgnPrefix = ',0,';

async function login(username, password) {
    try {
        let [ipv4Access, ipv6Access] = await checkConnectivity();
        if(ipv4Access && ipv6Access) {
            eventBus.emit('log', 'Login aborted: ipv4 and ipv6 OK, so you logged in already probably');
        }

        let reachable = await getBJUTauthServersReachability();
        eventBus.emit('log', `Reachability check: sushe: ${reachable.sushe}, wlgn: ${reachable.wlgn}, lgn: ${reachable.lgn}, lgn6: ${reachable.lgn6}`);

        if(!ipv4Access && ipv6Access) { // 掉ipv6，一般情况下仅需登录lgn6
            await lgn6Login(username, password);
        } else if(!ipv4Access && !ipv6Access) { // 无网络
            if(reachable.sushe) { // 可以连接红网关，一定是宿舍
                await susheLogin(username, password);
            } else if(reachable.wlgn) { // bjut_wifi 100%
                await wlgnLogin(username, password);
                await lgn6Login(username, password); // 补ipv6
            } else { // 应该是特殊地区有线，走lgn
                await lgnLogin46(username, password);
            }
        } else { // 没ipv4，但是有ipv6？
            if(reachable.sushe) { // 宿舍重登即可
                await susheLogout();
                await susheLogin(username, password);
            } else if(reachable.wlgn) { // bjut_wifi 只需要重登wlgn
                await wlgnLogin(username, password);
            } else { // 否则走lgn，同时关闭46登录，仅ipv4登录
                await lgnLogin46(username, password);
            }
        }
    } catch (error) {
        eventBus.emit('log', `Login aborted: ${error.message}`);
        throw error; // Re-throw error to be caught by caller
    }
}

function parse_respond(str) {
    const regex = /dr.{4}\(/g;
    return JSON.parse(str.replace(regex, '').replace(");", ''))
}

async function susheLogin(username, password) {
    const userAccount = `${username}@campus`;
    const data = {
        callback: 'dr1003',
        login_method: 1,
        user_account: userAccount,
        user_password: password,
        wlan_user_ip: '',
        wlan_user_ipv6: '',
        wlan_user_mac: '000000000000', // 原版网页登录也是这个空MAC
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
        console.log(res.data);
        const responseData = parse_respond(res.data);
        if (parseInt(responseData.result) === 1) {
            const msg = `宿舍网登录成功：${responseData.msg}`;
            eventBus.emit('log', msg);
            return { success: true, message: msg };
        } else {
            throw new Error(`宿舍网登录失败：${responseData.msg}`);
        }
    } catch (error) {
        eventBus.emit('log', `宿舍网登录错误: ${error.message}`);
        throw error;
    }
}

async function susheLogout() {
    const logoutUrl = "http://10.21.221.98:801/eportal/portal/logout?callback=dr1003&login_method=1&user_account=6LSm5Y%2B35LiN5a2Y5Zyo&user_password=5L2g54yc5LiN5Yiw&ac_logout=0&register_mode=0&wlan_user_ip=10.126.15.92&wlan_user_ipv6=&wlan_vlan_id=0&wlan_user_mac=000000000000&wlan_ac_ip=&wlan_ac_name=&jsVersion=4.2.1&v=4776&lang=zh";
    try {
        eventBus.emit('log', '尝试宿舍登出...');
        const res = await axios.get(logoutUrl, {
            headers: {
                'Referer': 'http://10.21.221.98/'
            }
        });
        const responseData = parse_respond(res.data);
        if (parseInt(responseData.result) === 1) {
            const msg = `宿舍登出成功: ${responseData.msg}`;
            eventBus.emit('log', msg);
            return { success: true, message: msg };
        } else {
            throw new Error(`宿舍登出失败: ${responseData.msg}`);
        }
    } catch (error) {
        eventBus.emit('log', `宿舍登出错误: ${error.message}`);
        throw error;
    }
}

async function wlgnLogin(username, password) {
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

async function lgn6Login(username, password, duallogin = false) {
    const v46s = duallogin ? 0 : 2; // dual login = false: only login ipv6
    eventBus.emit('log', 'Attempting IPv6-only (lgn6) login...');
    try {
        const response = await axios.post('https://lgn6.bjut.edu.cn', qs.stringify({
            DDDDD: username, upass: password, v46s: v46s, '0MKKey': ''
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
    susheLogin,
    wlgnLogin,
    lgn6Login,
    lgnLogin46,
    susheLogout
};
