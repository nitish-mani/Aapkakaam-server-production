const admin = require("firebase-admin");

// Send a notification to multiple devices
function sendBulkNotification(tokens, title, body) {
  const message = {
    notification: {
      title: title,
      body: body,
    },
    tokens: tokens, // Array of FCM tokens
  };

  admin
    .messaging()
    .sendMulticast(message)
    .then((response) => {
      console.log(response.successCount + " messages were sent successfully");
    })
    .catch((error) => {
      console.error("Error sending message:", error);
    });
}

exports.sendBulkNotification = sendBulkNotification;
