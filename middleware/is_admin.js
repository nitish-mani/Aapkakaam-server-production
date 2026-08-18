const ENV = require("../src/config/env");
const createAuthMiddleware = require("./_createAuthMiddleware");

module.exports = createAuthMiddleware({
  secret: ENV.JWT_ADMIN_SECRET,
  payloadKey: "adminId",
  reqKey: "adminId",
  role: "admin",
});
