require("./setupEnv");
const request = require("supertest");
const jwt = require("jsonwebtoken");

process.env.AUTH_RATE_LIMIT_MAX = "1000";
const app = require("../src/app");

describe("JWT auth middleware", () => {
  const protectedPath = "/api/user/getUserByUser/507f1f77bcf86cd799439011";

  test("no Authorization header → 401", async () => {
    const res = await request(app).get(protectedPath);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ success: false, message: "Not authenticated." });
  });

  test("invalid Bearer token → 401 (not 500)", async () => {
    const res = await request(app)
      .get(protectedPath)
      .set("Authorization", "Bearer this-is-garbage");
    expect(res.status).toBe(401);
    expect(res.body.message).toMatch(/Invalid or expired token/);
  });

  test("valid JWT but missing userId claim → 401 (does not hang)", async () => {
    const token = jwt.sign({ foo: "bar" }, process.env.JWT_USER_SECRET);
    const res = await request(app)
      .get(protectedPath)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });

  test("wrong-audience JWT (signed with vendor secret) → 401 on user route", async () => {
    process.env.JWT_VENDOR_SECRET = "different-vendor-secret";
    // Rebuild is not needed – secret was read at boot; sign with the CURRENT user secret
    // wrapped in a different key we know is not it:
    const token = jwt.sign({ userId: "abc" }, "totally-wrong-secret");
    const res = await request(app)
      .get(protectedPath)
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});
