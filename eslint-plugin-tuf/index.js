'use strict';

module.exports = {
  rules: {
    'no-unsafe-user-include': require('./rules/no-unsafe-user-include'),
    'no-raw-user-in-response': require('./rules/no-raw-user-in-response'),
  },
};
