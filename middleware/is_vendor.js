const ENV = require("../src/config/env");
const createAuthMiddleware = require("./_createAuthMiddleware");

module.exports = createAuthMiddleware({
  secret: ENV.JWT_VENDOR_SECRET,
  payloadKey: "vendorId",
  reqKey: "vendorId",
  role: "vendor",
});
