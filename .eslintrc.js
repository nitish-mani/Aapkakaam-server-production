module.exports = {
  root: true,
  env: {
    node: true,
    es2022: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: "script",
  },
  extends: ["eslint:recommended"],
  rules: {
    "no-console": ["warn", { allow: ["warn", "error"] }],
    "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    "no-empty": ["warn", { allowEmptyCatch: true }],
    // Legacy controllers occasionally intentionally use assignment inside if.
    // Downgraded to warn rather than error so CI stays green on untouched code.
    "no-cond-assign": ["warn", "always"],
    "no-param-reassign": "off",
    "prefer-const": "warn",
    "no-useless-catch": "warn",
    "no-prototype-builtins": "warn",
    "no-async-promise-executor": "warn",
  },
  overrides: [
    {
      files: ["tests/**/*.js", "**/*.test.js"],
      env: { jest: true, node: true },
    },
  ],
  ignorePatterns: [
    "node_modules/",
    "logs/",
    "coverage/",
    "dist/",
    "build/",
    "err.html",
  ],
};
