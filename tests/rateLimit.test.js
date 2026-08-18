require("./setupEnv");

// Tight limit specifically for this suite.
process.env.AUTH_RATE_LIMIT_MAX = "3";

const request = require("supertest");
const app = require("../src/app");

describe("authRateLimiter on /api/user/login", () => {
  test("returns 429 after AUTH_RATE_LIMIT_MAX+1 attempts", async () => {
    const max = Number(process.env.AUTH_RATE_LIMIT_MAX);

    // Hit the endpoint max+1 times.
    const statuses = [];
    for (let i = 0; i < max + 2; i++) {
      // eslint-disable-next-line no-await-in-loop
      const res = await request(app)
        .post("/api/user/login")
        // Empty body → handler returns 400 immediately (no DB required),
        // which lets us exercise the limiter deterministically & fast.
        .send({});
      statuses.push(res.status);
    }

    // The last response must be 429 (rate-limited). Earlier ones are handler
    // responses (400/401/500 depending on whether DB is reachable — we don't
    // care here, only that the limiter kicked in).
    expect(statuses[statuses.length - 1]).toBe(429);
  });
});
