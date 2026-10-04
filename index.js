'use strict';

const register = require('./lib/plugin');
if (typeof hexo !== 'undefined') register(hexo);
module.exports = register;
