const { app } = require('electron');

let isQuiting = false;

function markQuitting() {
	isQuiting = true;
}

function quitApp() {
    if (isQuiting) {
        return;
    }
	markQuitting();
    app.quit();
}

module.exports = {
    get isQuiting() {
        return isQuiting;
    },
    markQuitting,
    quitApp
};
