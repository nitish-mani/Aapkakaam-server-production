"use strict";

const { sendPaymentSuccessSMS } = require("../../NotificationService");

module.exports = async function paymentSuccess(notification) {
  return sendPaymentSuccessSMS(
    notification.phoneNumber,
    notification.data.name,
    notification.data.amount,
    notification.data.transactionId,
  );
};
