import http from "k6/http";
import { check } from "k6";

const BASE_URL = "http://localhost:3000";

// Use ONLY a development/test JWT here.
const TOKEN =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJwaG9uZU5vIjo3Mzc2NjEwMzYwLCJ1c2VySWQiOiI2YTg5NjI1Nzk5M2M0YTFmNDNlNjY2MzEiLCJpYXQiOjE3ODczODg1MTYsImV4cCI6MTc4NzY0NzcxNn0.aB1V4V_i98Njz5r-pkqneG9pouFgNQ1_3gEQExEAmYo";

export const options = {
  scenarios: {
    vendor_search_load: {
      executor: "ramping-arrival-rate",

      startRate: 20,
      timeUnit: "1s",

      preAllocatedVUs: 200,
      maxVUs: 500,

      stages: [
        { target: 20, duration: "30s" },
        { target: 50, duration: "30s" },
        { target: 75, duration: "30s" },

        // Reach 100 RPS
        { target: 100, duration: "30s" },

        // Hold 100 RPS
        { target: 100, duration: "5m" },

        // Ramp down
        { target: 0, duration: "30s" },
      ],

      gracefulStop: "30s",
    },
  },

  thresholds: {
    http_req_failed: ["rate<0.01"],

    http_req_duration: ["p(95)<500", "p(99)<1000"],
  },
};

export default function () {
  const url =
    `${BASE_URL}/api/vendor/getAll/` +
    `electrician/` +
    `274001/` +
    `2026-08-23/` +
    `1/` +
    `0/` +
    `0`;

  const params = {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
    },
  };

  const response = http.get(url, params);

  check(response, {
    "HTTP 200": (r) => r.status === 200,
    "not rate limited": (r) => r.status !== 429,
    "response received": (r) => r.body && r.body.length > 0,
  });
}
