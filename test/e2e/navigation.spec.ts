import { test, expect } from "@playwright/test";

test("health API and retrieval links are reachable", async ({ page, request }) => {
  const health = await request.get("/api/v1/health");
  expect(health.status()).toBe(200);
  await expect(page.goto("/d/ABC123")).resolves.not.toBeNull();
  await expect(page.locator("body")).toContainText(/之间门|Metaxy/);
});

test("composer paste button inserts clipboard text", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await page.evaluate(() => navigator.clipboard.writeText("clipboard text"));
  await page.getByRole("button", { name: /粘贴|Paste/ }).click();
  await expect(page.locator("textarea")).toHaveValue("clipboard text");
});
