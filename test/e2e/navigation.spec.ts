import { test, expect } from "@playwright/test";

test("health API and retrieval links are reachable", async ({ page, request }) => {
  const health = await request.get("/api/v1/health");
  expect(health.status()).toBe(200);
  await expect(page.goto("/d/ABC123")).resolves.not.toBeNull();
  await expect(page.locator("body")).toContainText(/之间门|Metaxy/);
});
