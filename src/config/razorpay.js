/**
 * Lazy Razorpay client.
 *
 * The Razorpay constructor throws immediately if `key_id` is missing, which
 * would take down the entire server if credentials aren't provisioned yet
 * (e.g. in staging/tests). We defer instantiation to first use and surface a
 * clear operational error instead.
 */
const Razorpay = require("razorpay");
const ENV = require("./env");

let instance = null;

function getInstance() {
  if (instance) return instance;

  if (!ENV.RAZORPAY_KEY_ID || !ENV.RAZORPAY_SECRET) {
    throw new Error("Razorpay is not configured — set RAZORPAY_KEY_ID and RAZORPAY_SECRET.");
  }

  const headers = {};
  // if (ENV.MERCHANT_ACCOUNT_ID) {
  //   headers["X-Razorpay-Account"] = ENV.MERCHANT_ACCOUNT_ID;
  // }

  instance = new Razorpay({
    key_id: ENV.RAZORPAY_KEY_ID,
    key_secret: ENV.RAZORPAY_SECRET,
    // headers,
  });

  return instance;
}

// Proxy so consumers can keep using `razorpay.orders.create(...)` today.
module.exports = new Proxy(
  {},
  {
    get(_target, prop) {
      const real = getInstance();
      const value = real[prop];
      return typeof value === "function" ? value.bind(real) : value;
    },
  },
);
