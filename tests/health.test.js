require("./setupEnv");
const request = require("supertest");

// Bump the auth limit up for THIS suite so unrelated 200-checks don't hit it.
process.env.AUTH_RATE_LIMIT_MAX = "1000";

const app = require("../src/app");

describe("health & routing", () => {
  test("GET /health returns 200 with status ok", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ status: "ok" }));
    expect(typeof res.body.uptime).toBe("number");
  });

  test("GET /api/health returns detailed payload", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual(
      expect.objectContaining({
        status: "ok",
        service: "aapkakaam-server",
      }),
    );
    expect(res.body.timestamp).toEqual(expect.any(String));
  });

  test("unknown route returns 404 JSON (not HTML)", async () => {
    const res = await request(app).get("/definitely-not-a-route");
    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      success: false,
      message: expect.stringMatching(/Route not found: GET \/definitely-not-a-route/),
    });
  });

  test("security headers are applied", async () => {
    const res = await request(app).get("/health");
    // helmet sets these by default
    expect(res.headers["x-dns-prefetch-control"]).toBeDefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });
});
