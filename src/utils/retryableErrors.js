"use strict";

class RetryableError extends Error {
  constructor(message, options = {}) {
    super(message);

    this.name = "RetryableError";
    this.retryable = true;

    if (options.code) {
      this.code = options.code;
    }

    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

class PermanentError extends Error {
  constructor(message, options = {}) {
    super(message);

    this.name = "PermanentError";
    this.retryable = false;

    if (options.code) {
      this.code = options.code;
    }

    if (options.cause) {
      this.cause = options.cause;
    }
  }
}

function isRetryable(error) {
  return error?.retryable === true;
}

function isPermanent(error) {
  return error?.retryable === false || error?.name === "PermanentError";
}

module.exports = {
  RetryableError,
  PermanentError,
  isRetryable,
  isPermanent,
};
