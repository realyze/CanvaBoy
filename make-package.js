const packager = require('electron-packager');

packager({
    dir: __dirname,
    name: 'CanvaBoy',
    platform: null,
    arch: null,
    electronVersion: '1.6.15',
    out: `${__dirname}/releases`,
    appBundleId: '',
    appVersion: '0.0.1',
    overwrite: true,
    asar: false,
    icon: `${__dirname}/images/icons/mac/icon.icns`,
    //icon: `/Users/tomasbrambora/Downloads/rocket.png`,
    bundle_id: '',
    appname: 'Canva Boy',
    sourcedir: `${__dirname}/dist`,
    ignore: `${__dirname}/releases`,
});
