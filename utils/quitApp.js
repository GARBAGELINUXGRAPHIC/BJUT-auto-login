const { app } = require('electron');

let isQuiting = false;

function quitApp() {
    isQuiting = true;
    app.quit();
}

module.exports = {
    get isQuiting() {
        return isQuiting;
    },
    quitApp
};
