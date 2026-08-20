import { defineConfig } from "@playwright/test";

const reviewToken = "synthetic-review-token-0000000000001";

export default defineConfig({
  testDir: "./tests",
  timeout: 45_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: "http://127.0.0.1:4173",
    trace: "retain-on-failure"
  },
  webServer: [
    {
      command: `npm run build && PORT=8080 RXFLOW_REVIEW_BEARER_TOKEN=${reviewToken} RXFLOW_REVIEW_PRINCIPAL=synthetic-reviewer node dist/src/server.js`,
      cwd: "..",
      url: "http://127.0.0.1:8080/health",
      reuseExistingServer: false,
      timeout: 120_000
    },
    {
      command: "npm run build && PORT=4173 HOST=127.0.0.1 RXFLOW_API_BASE=http://127.0.0.1:8080 node build/index.js",
      cwd: ".",
      url: "http://127.0.0.1:4173",
      reuseExistingServer: false,
      timeout: 120_000
    }
  ]
});

export { reviewToken };
