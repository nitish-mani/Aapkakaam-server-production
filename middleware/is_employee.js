const ENV = require("../src/config/env");
const createAuthMiddleware = require("./_createAuthMiddleware");

module.exports = createAuthMiddleware({
  secret: ENV.JWT_EMPLOYEE_SECRET,
  payloadKey: "employeeId",
  reqKey: "employeeId",
  role: "employee",
});
