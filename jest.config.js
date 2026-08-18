module.exports = {
  testEnvironment: "node",

  testMatch: ["**/tests/**/*.test.js"],

  setupFilesAfterEnv: ["<rootDir>/tests/helpers/setup.js"],

  testTimeout: 60000,

  clearMocks: true,

  restoreMocks: true,

  resetMocks: true,

  detectOpenHandles: true,

  verbose: true,

  collectCoverage: false,
};
