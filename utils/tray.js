const { Tray, Menu, nativeImage } = require('electron');
const path = require('path');

let tray = null;
const isMac = process.platform === 'darwin';

function loadStatusIcon(status) {
    let imagePath;

    if (status === 'green') {
        imagePath = path.join(__dirname, 'icon-green.png');
    } else if (status === 'red') {
        imagePath = path.join(__dirname, 'icon-red.png');
    } else { // 'default'
        if (isMac) {
            imagePath = path.join(__dirname, 'icon-macTemplate.png');
        } else {
            imagePath = path.join(__dirname, 'icon-blue.png');
        }
    }

    const image = nativeImage.createFromPath(imagePath);
    if (isMac) {
        image.setTemplateImage(true);
    }
    return image;
}

function createTray(mainWindow, quitApp) {
    tray = new Tray(loadStatusIcon('default'));

    const contextMenu = Menu.buildFromTemplate([
        { label: '显示主界面', click: () => { mainWindow.show(); } },
        { label: '打开开发者工具', click: () => { mainWindow.webContents.openDevTools(); } },
        { type: 'separator' },
        {
            label: '退出', click: () => {
                quitApp();
            }
        }
    ]);

    tray.setToolTip('BJUT-Network-Autologin');
    tray.setContextMenu(contextMenu);
    tray.on('double-click', () => mainWindow.show());

    return tray;
}

function setTrayStatus(status) {
    if (tray) {
        const icon = loadStatusIcon(status);
        tray.setImage(icon);
    }
}

module.exports = { createTray, setTrayStatus };
