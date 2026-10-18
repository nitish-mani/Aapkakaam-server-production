"use strict";

const crypto = require("crypto");

const User = require("../models/user");
const Vendor = require("../models/vendor");
const NotificationService = require("../src/services/NotificationService");

const ALLOWED_AUDIENCES = ["all", "user", "vendor"];

function validateLink(value) {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  try {
    const url = new URL(value.trim());

    if (url.protocol !== "https:" || !url.hostname || url.username || url.password) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

async function sendAdminLinkNotification(req, res) {
  try {
    const { title, body, link, audience } = req.body || {};

    // Require explicit audience selection.
    if (!ALLOWED_AUDIENCES.includes(audience)) {
      return res.status(400).json({
        success: false,
        message: "Audience must be all, user, or vendor.",
      });
    }

    if (typeof title !== "string" || !title.trim() || typeof body !== "string" || !body.trim()) {
      return res.status(400).json({
        success: false,
        message: "Title and body are required.",
      });
    }

    if (title.trim().length > 100 || body.trim().length > 500) {
      return res.status(400).json({
        success: false,
        message: "Title or body exceeds the allowed length.",
      });
    }

    const safeLink = validateLink(link);

    if (!safeLink) {
      return res.status(400).json({
        success: false,
        message: "A valid HTTPS link is required.",
      });
    }

    const campaignId = crypto.randomUUID();

    let recipients = 0;
    let queued = 0;
    let failed = 0;

    async function enqueueRecipient(recipient, role) {
      const token = String(recipient.fcmToken || "").trim();

      if (!token) {
        return;
      }

      recipients++;

      try {
        await NotificationService.createNotification({
          type: "PUSH",

          userId: role === "user" ? recipient._id : null,
          vendorId: role === "vendor" ? recipient._id : null,

          recipient: {
            pushToken: token,
          },

          template: "admin_link",

          templateData: {
            title: title.trim(),
            body: body.trim(),

            // Flutter notification handler
            type: "admin_link",
            screen: "external_link",

            // PushProvider forwards these values to FCM.
            data: {
              link: safeLink,
              notificationType: "admin_link",
              campaignId: String(campaignId),
              recipientRole: role,
            },
          },

          source: "admin",
          sourceId: campaignId,
          requestId: req.id || req.requestId || null,

          priority: 5,

          channelPolicy: {
            channels: ["PUSH"],
            fallback: false,
          },

          tags: ["admin", "admin_link", role],

          idempotencyKey: `admin-link:${campaignId}:${role}:${recipient._id}`,
        });

        queued++;
      } catch (error) {
        failed++;

        // Never log FCM tokens.
        console.error("Admin notification enqueue failed", {
          campaignId,
          role,
          recipientId: String(recipient._id),
          error: error.message,
        });
      }
    }

    async function processModel(Model, role) {
      const cursor = Model.find({
        fcmToken: { $exists: true, $nin: ["", null] },
      })
        .select("_id fcmToken")
        .lean()
        .cursor();

      for await (const recipient of cursor) {
        await enqueueRecipient(recipient, role);
      }
    }

    if (audience === "all" || audience === "user") {
      await processModel(User, "user");
    }

    if (audience === "all" || audience === "vendor") {
      await processModel(Vendor, "vendor");
    }

    if (recipients === 0) {
      return res.status(404).json({
        success: false,
        campaignId,
        message: "No recipients with an FCM token were found.",
      });
    }

    return res.status(202).json({
      success: queued > 0,
      message: queued > 0 ? "Notification jobs queued." : "No notification jobs were queued.",
      campaignId,
      audience,
      recipients,
      queued,
      failed,
    });
  } catch (error) {
    console.error("sendAdminLinkNotification failed", {
      message: error.message,
    });

    return res.status(500).json({
      success: false,
      message: "Unable to process admin notification.",
    });
  }
}

module.exports = {
  sendAdminLinkNotification,
};
