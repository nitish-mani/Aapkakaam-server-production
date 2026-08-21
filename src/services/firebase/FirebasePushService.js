"use strict";

const admin = require("../../config/firebase");

async function sendPushNotification({ token, title, body, data = {} }) {
  const normalizedToken = String(token || "").trim();

  if (!normalizedToken) {
    const error = new Error("Firebase notification token is missing.");

    error.code = "INVALID_PUSH_RECIPIENT";
    throw error;
  }

  if (!title) {
    const error = new Error("Firebase notification title is missing.");

    error.code = "INVALID_PUSH_TITLE";
    throw error;
  }

  if (!body) {
    const error = new Error("Firebase notification body is missing.");

    error.code = "INVALID_PUSH_BODY";
    throw error;
  }

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

      click_action: data.click_action || "FLUTTER_NOTIFICATION_CLICK",

      screen: data.screen || "profile",
    },

    token: normalizedToken,
  };

  return await admin.messaging().send(message);
}

module.exports = {
  sendPushNotification,
};
