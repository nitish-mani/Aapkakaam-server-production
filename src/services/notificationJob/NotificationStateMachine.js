"use strict";

const CONFIG = require("../../config/notification.config");

/**
 * NotificationStateMachine - Single source of truth for notification states
 * All state-related rules and transitions are defined here
 */
class NotificationStateMachine {
  /**
   * Valid status values
   */
  static get STATUSES() {
    return Object.freeze({
      QUEUED: "queued",
      PROCESSING: "processing",
      RETRYING: "retrying",
      SENT: "sent",
      FAILED: "failed",
      CANCELLED: "cancelled",
    });
  }

  /**
   * Valid state transitions
   */
  static get TRANSITIONS() {
    return Object.freeze({
      queued: ["processing"],
      processing: ["sent", "failed", "retrying"],
      retrying: ["processing", "failed"],
      sent: [],
      failed: [],
      cancelled: [],
    });
  }

  /**
   * Terminal states (no further processing)
   */
  static get TERMINAL_STATES() {
    return Object.freeze(["sent", "failed", "cancelled"]);
  }

  /**
   * Processing states (actively being worked on)
   */
  static get PROCESSING_STATES() {
    return Object.freeze(["processing"]);
  }

  /**
   * Pending states (waiting to be processed)
   */
  static get PENDING_STATES() {
    return Object.freeze(["queued", "retrying"]);
  }

  /**
   * Check if status is terminal
   */
  static isTerminal(status) {
    return this.TERMINAL_STATES.includes(status);
  }

  /**
   * Check if status is processing
   */
  static isProcessing(status) {
    return this.PROCESSING_STATES.includes(status);
  }

  /**
   * Check if status is pending
   */
  static isPending(status) {
    return this.PENDING_STATES.includes(status);
  }

  /**
   * Check if transition is valid
   */
  static isValidTransition(fromStatus, toStatus) {
    const allowed = this.TRANSITIONS[fromStatus] || [];
    return allowed.includes(toStatus);
  }

  /**
   * Check if notification can be cancelled
   */
  static canCancel(status) {
    return ["queued", "processing"].includes(status);
  }

  /**
   * Check if notification can be retried
   */
  static canRetry(status, attemptsMade, maxAttempts) {
    return status === "failed" && attemptsMade < maxAttempts && !this.isTerminal(status);
  }

  /**
   * Get next allowed statuses
   */
  static getNextStatuses(status) {
    return this.TRANSITIONS[status] || [];
  }

  /**
   * Validate status exists
   */
  static validateStatus(status) {
    if (!status || !Object.values(this.STATUSES).includes(status)) {
      throw new Error(`Invalid notification status: ${status}`);
    }
    return true;
  }
}

module.exports = NotificationStateMachine;
