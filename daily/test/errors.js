"use strict";

/**
 * Conflux runtime 注入的 ExtensionError 替身。
 * 构造参数与协议一致：{ code, message, retryable }
 * https://docs.conflux.one/runtime.html
 */

var CODES = {
  invalid_params: { retryable: false },
  not_found: { retryable: false },
  rate_limited: { retryable: true },
  unavailable: { retryable: true },
  internal: { retryable: false },
};

function ExtensionError(payload) {
  payload = payload || {};
  var message = payload.message || payload.code || "extension error";
  var err = Error.call(this, message) || this;
  err.name = "ExtensionError";
  err.message = message;
  err.code = payload.code;
  err.retryable = !!payload.retryable;
  if (Error.captureStackTrace) Error.captureStackTrace(err, ExtensionError);
  return err;
}

ExtensionError.prototype = Object.create(Error.prototype);
ExtensionError.prototype.constructor = ExtensionError;

function isExtensionError(err) {
  return !!(err && (err.name === "ExtensionError" || err instanceof ExtensionError));
}

function assertError(err, code) {
  if (!isExtensionError(err)) {
    throw new Error("expected ExtensionError, got " + (err && (err.stack || err.message || err)));
  }
  if (code && err.code !== code) {
    throw new Error("expected code " + code + ", got " + err.code + " (" + err.message + ")");
  }
  var spec = CODES[err.code];
  if (spec && err.retryable !== spec.retryable) {
    throw new Error(
      "code " + err.code + " should have retryable=" + spec.retryable + ", got " + err.retryable
    );
  }
  return err;
}

module.exports = {
  ExtensionError: ExtensionError,
  isExtensionError: isExtensionError,
  assertError: assertError,
  CODES: CODES,
};
