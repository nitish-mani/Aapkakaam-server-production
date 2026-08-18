const ENV = require("../src/config/env");
const createAuthMiddleware = require("./_createAuthMiddleware");

module.exports = createAuthMiddleware({
  secret: ENV.JWT_USER_SECRET,
  payloadKey: "userId",
  reqKey: "userId",
  role: "user",
});
