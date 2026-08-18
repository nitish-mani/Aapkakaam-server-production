"use strict";

const axios = require("axios");
const ENV = require("../../config/env");
const logger = require("../../logger/logger");

class SmsProvider {
  /**
   * Send SMS Notification
   *
   * Supported templates:
   * - payment_success
   * - payment_failed
   * - booking_created_vendor
   * - booking_cancelled
   *
   * Booking behavior intentionally preserves the old system:
   *
   * Booking:
   * FAST2SMSBOOKING
   * variables:
   *   Name - CUSTOMER_NAME and Mob - CUSTOMER_PHONE
   *   BOOKING_DATE
   *
   * Cancellation:
   * FAST2SMSCANCEL
   * variables:
   *   NAME
   *   DATE
   */
  static async send(notification) {
    const started = Date.now();

    const { _id, recipient, template, content, requestId } = notification;

    // --------------------------------------------------
    // Basic validation
    // --------------------------------------------------

    if (!recipient?.phoneNumber) {
      const error = new Error("SMS recipient phone number is missing.");
      error.code = "INVALID_SMS_RECIPIENT";
      error.retryable = false;
      throw error;
    }

    if (!template) {
      const error = new Error("SMS template is missing.");
      error.code = "INVALID_SMS_TEMPLATE";
      error.retryable = false;
      throw error;
    }

    const templateData = content?.templateData;

    if (!templateData || typeof templateData !== "object") {
      const error = new Error(`Template data missing for notification ${_id}`);

      error.code = "INVALID_TEMPLATE_DATA";
      error.retryable = false;

      throw error;
    }

    const phone = String(recipient.phoneNumber).trim();

    let url;

    // --------------------------------------------------
    // Build Fast2SMS URL
    // --------------------------------------------------

    switch (template) {
      /**
       * PAYMENT SUCCESS
       */
      case "payment_success": {
        const { name, balance } = templateData;

        if (!name || balance === undefined || balance === null) {
          const error = new Error("payment_success requires { name, balance }");

          error.code = "INVALID_TEMPLATE_DATA";
          error.retryable = false;

          throw error;
        }

        url =
          `${ENV.FAST2SMSPAYMENTSUCCESS}` +
          `variables_values=${encodeURIComponent(name)}%7C` +
          `${encodeURIComponent(balance)}%7C` +
          `&flash=1` +
          `&numbers=${encodeURIComponent(phone)}` +
          `&schedule_time=`;

        break;
      }

      /**
       * PAYMENT FAILED
       */
      case "payment_failed": {
        const { name, balance } = templateData;

        if (!name || balance === undefined || balance === null) {
          const error = new Error("payment_failed requires { name, balance }");

          error.code = "INVALID_TEMPLATE_DATA";
          error.retryable = false;

          throw error;
        }

        url =
          `${ENV.FAST2SMSPAYMENTFAILED}` +
          `variables_values=${encodeURIComponent(name)}%7C` +
          `${encodeURIComponent(balance)}%7C` +
          `&flash=1` +
          `&numbers=${encodeURIComponent(phone)}` +
          `&schedule_time=`;

        break;
      }

      /**
       * BOOKING CREATED
       *
       * OLD BEHAVIOR:
       *
       * const userData =
       *   `Name - ${name.toUpperCase().slice(0, 11)}
       *    and Mob - ${userPhoneNo}`;
       *
       * FAST2SMSBOOKING
       *
       * variables:
       * userData | bookingDate
       *
       * SMS goes to VENDOR only.
       */
      case "booking_created_vendor": {
        const { name, userPhoneNo, bookingDate } = templateData;
        if (!name) {
          const error = new Error("booking_created_vendor requires name");

          error.code = "INVALID_TEMPLATE_DATA";
          error.retryable = false;

          throw error;
        }

        if (!userPhoneNo) {
          const error = new Error("booking_created_vendor requires userPhoneNo");

          error.code = "INVALID_TEMPLATE_DATA";
          error.retryable = false;

          throw error;
        }

        if (!bookingDate) {
          const error = new Error("booking_created_vendor requires bookingDate");

          error.code = "INVALID_TEMPLATE_DATA";
          error.retryable = false;

          throw error;
        }

        const normalizedName = String(name).toUpperCase().slice(0, 11);

        const userData = `Name - ${normalizedName} and Mob - ${userPhoneNo}`;

        url =
          `${ENV.FAST2SMSBOOKING}` +
          `variables_values=${encodeURIComponent(userData)}%7C` +
          `${encodeURIComponent(bookingDate)}%7C` +
          `&flash=1` +
          `&numbers=${encodeURIComponent(phone)}` +
          `&schedule_time=`;

        break;
      }

      /**
       * BOOKING CANCELLED
       *
       * OLD BEHAVIOR:
       *
       * FAST2SMSCANCEL
       *
       * variables:
       * name | formattedDate
       */
      case "booking_cancelled": {
        const { name, formattedDate, bookingDate } = templateData;

        const date = formattedDate || bookingDate;

        if (!name) {
          const error = new Error("booking_cancelled requires name");

          error.code = "INVALID_TEMPLATE_DATA";
          error.retryable = false;

          throw error;
        }

        if (!date) {
          const error = new Error("booking_cancelled requires formattedDate or bookingDate");

          error.code = "INVALID_TEMPLATE_DATA";
          error.retryable = false;

          throw error;
        }

        const normalizedName = String(name).toUpperCase().slice(0, 20);

        url =
          `${ENV.FAST2SMSCANCEL}` +
          `variables_values=${encodeURIComponent(normalizedName)}%7C` +
          `${encodeURIComponent(date)}%7C` +
          `&flash=0` +
          `&numbers=${encodeURIComponent(phone)}` +
          `&schedule_time=`;

        break;
      }

      /**
       * UNKNOWN TEMPLATE
       *
       * Programming/configuration error.
       * BullMQ should NOT retry this.
       */
      default: {
        const error = new Error(`Unknown SMS template '${template}'`);

        error.code = "UNKNOWN_SMS_TEMPLATE";
        error.retryable = false;

        throw error;
      }
    }

    // --------------------------------------------------
    // Send SMS
    // --------------------------------------------------

    // try {
    //   const response = await axios.get(url, {
    //     timeout: 15000,

    //     validateStatus: (status) => status >= 200 && status < 300,
    //   });

    //   const duration = Date.now() - started;

    //   logger.info(
    //     {
    //       event: "SMS_SENT",

    //       notificationId: _id,

    //       requestId,

    //       template,

    //       phone,

    //       provider: "Fast2SMS",

    //       duration,

    //       providerMessageId: response.data?.request_id || response.data?.requestId || null,

    //       providerStatus: response.data?.return || response.data?.status || null,
    //     },
    //     "SMS sent successfully",
    //   );

    //   return {
    //     provider: "Fast2SMS",

    //     accepted: true,

    //     success: true,

    //     status: response.data?.return || response.data?.status || "SUCCESS",

    //     providerMessageId: response.data?.request_id || response.data?.requestId || null,

    //     latency: duration,
    //   };
    // } catch (error) {
    //   const duration = Date.now() - started;

    //   logger.error(
    //     {
    //       event: "SMS_SEND_FAILED",

    //       notificationId: _id,

    //       requestId,

    //       template,

    //       phone,

    //       provider: "Fast2SMS",

    //       duration,

    //       error: {
    //         message: error.message,
    //         code: error.code,
    //         status: error.response?.status,
    //         data: error.response?.data,
    //       },
    //     },
    //     "SMS sending failed",
    //   );

    //   throw error;
    // }
  }
}

module.exports = SmsProvider;
