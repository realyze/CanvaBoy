process.chdir(__dirname.replace("/app.asar", ""));
require('ts-node').register();
require('./main');
