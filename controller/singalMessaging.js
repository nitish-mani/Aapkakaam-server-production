"use strict";

const admin = require("./firebase");

/**
 * Send Push Notification using Firebase Cloud Messaging
 *
 * Returns:
 *   Firebase message ID
 *
 * Throws:
 *   Firebase Admin SDK error
 */
async function sendPushNotification({ token, title, body, data = {} }) {
  // --------------------------------------------------
  // Validate token
  // --------------------------------------------------

  const normalizedToken = String(token || "").trim();

  if (!normalizedToken) {
    const error = new Error("Firebase notification token is missing.");

    error.code = "INVALID_PUSH_RECIPIENT";

    throw error;
  }

  // --------------------------------------------------
  // Validate title
  // --------------------------------------------------

  if (!title) {
    const error = new Error("Firebase notification title is missing.");

    error.code = "INVALID_PUSH_TITLE";

    throw error;
  }

  // --------------------------------------------------
  // Validate body
  // --------------------------------------------------

  if (!body) {
    const error = new Error("Firebase notification body is missing.");

    error.code = "INVALID_PUSH_BODY";

    throw error;
  }

  // --------------------------------------------------
  // Build Firebase message
  // --------------------------------------------------

  const message = {
    notification: {
      title: String(title),
      body: String(body),
    },

    android: {
      notification: {
        icon: "logo",
        priority: "high",
      },
    },

    data: {
      ...data,

      // Preserve old Flutter behavior
      click_action: data.click_action || "FLUTTER_NOTIFICATION_CLICK",

      screen: data.screen || "profile",
    },

    token: normalizedToken,
  };

  // --------------------------------------------------
  // Send through Firebase
  //
  // IMPORTANT:
  // Do not catch the error here.
  //
  // PushProvider must receive the original Firebase
  // error code so it can decide:
  //
  //   RetryableError
  //   PermanentError
  //
  // BullMQ will then handle the retry.
  // --------------------------------------------------

  return await admin.messaging().send(message);
}

module.exports = {
  sendPushNotification,
};
