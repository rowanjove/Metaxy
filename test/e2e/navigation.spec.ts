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

test("Drive stays behind the admin session boundary", async ({ page }) => {
  await page.goto("/drive");
  await expect(page.getByText(/管理权限验证失败|authentication failed|authentication required/)).toBeVisible();
});

test("public navigation keeps the admin entry hidden and exposes an icon theme toggle", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('a[href="/admin"], a[href="/admin/login"]')).toHaveCount(0);

  const themeToggle = page.locator("button.theme-toggle");
  await expect(themeToggle).toHaveCount(1);
  await expect(themeToggle).toHaveAttribute("aria-label", /亮色|暗色|Light|Dark/);
  await expect(themeToggle).not.toContainText(/亮色|暗色|Light|Dark/);
});
