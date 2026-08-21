module.exports = {
  testEnvironment: 'node',
  testMatch: ['**/*.test.js'],
  collectCoverageFrom: ['electron-app/src/**/*.js', '!**/*.test.js'],
};
