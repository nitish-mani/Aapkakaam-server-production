"use strict";

class RetryableError extends Error {
  constructor(message) {
    super(message);
    this.name = "RetryableError";
    this.retryable = true;
  }
}

class PermanentError extends Error {
  constructor(message) {
    super(message);
    this.name = "PermanentError";
    this.retryable = false;
  }
}

function isRetryable(error) {
  return error?.retryable === true;
}

module.exports = {
  RetryableError,
  PermanentError,
  isRetryable,
};
