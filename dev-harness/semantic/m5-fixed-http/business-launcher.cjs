'use strict';
const { launch } = require('./launcher.cjs');
const [, , file, pin] = process.argv;
launch(file, pin, undefined, true);
