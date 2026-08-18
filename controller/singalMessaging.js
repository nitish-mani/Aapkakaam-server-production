const admin = require("./firebase");

// Function to send notification
function sendNotification(token, title, id, body, type, month, year) {
  const message = {
    notification: {
      title: title,
      body: body,
    },
    android: {
      notification: {
        icon: "logo", // The name of the drawable resource
        priority: "high",
      },
    },
    data: {
      // Custom payload data
      click_action: "FLUTTER_NOTIFICATION_CLICK",
      screen: "profile",
      type: type,
    },
    token: token, // The FCM token of the target device
  };

  // Send the message
  admin
    .messaging()
    .send(message)
    .then((response) => {
      console.log("Successfully sent message:", response);
    })
    .catch((error) => {
      console.error("Error sending message:", error);
    });
}

exports.sendNotification = sendNotification;
