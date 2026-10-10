import { test, expect, type Page } from "@playwright/test";
import { mkdir } from "node:fs/promises";

const BASE = process.env.AUTOPRINT_URL ?? "http://localhost:5180/auto-print";
const EVIDENCE_DIR = "/tmp/autoprint-notifications";

async function safety(page: Page) {
  const blocked: string[] = [];
  await page.route("**/*", async (route) => {
    const url = route.request().url();
    if (/\/api\//i.test(url) || !url.startsWith("http://localhost:5180/")) {
      blocked.push(url);
      await route.abort();
      return;
    }
    await route.continue();
  });
  return blocked;
}

function visibleBell(page: Page) {
  return page.getByTestId("button-autoprint-bell").filter({ visible: true }).last();
}

async function screenshot(page: Page, name: string) {
  await mkdir(EVIDENCE_DIR, { recursive: true });
  await page.screenshot({ path: `${EVIDENCE_DIR}/${name}.png` });
}

test("isolated AutoPrint notification journey", async ({ page }) => {
  const blocked = await safety(page);
  const layoutIssues: string[] = [];
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(BASE);

  await expect(page.getByTestId("badge-autoprint-unread").first()).toHaveText("35");
  await visibleBell(page).click();
  const desktopRect = await page.getByRole("dialog").evaluate((el) => {
    const r = el.getBoundingClientRect();
    const point = document.elementFromPoint(r.right - 10, r.top + 150);
    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
      position: getComputedStyle(el).position, rightSideVisible: !!point && el.contains(point),
      viewport: { width: innerWidth, height: innerHeight } };
  });
  await expect(page.getByRole("dialog")).toBeVisible();
  await screenshot(page, "desktop-notification-dialog");
  if (desktopRect.x < 0 || desktopRect.y < 0 || desktopRect.right > 1440 || desktopRect.bottom > 1000) {
    layoutIssues.push(`Desktop dialog outside viewport: ${JSON.stringify(desktopRect)}`);
  }
  if (!desktopRect.rightSideVisible) {
    layoutIssues.push(`Expanded-sidebar popover is obscured: ${JSON.stringify(desktopRect)}`);
  }
  await expect(page.getByRole("dialog")).toContainText("This may already be printed");
  await expect(page.getByRole("dialog")).toContainText("PrintNode");
  await expect(page.getByRole("dialog")).toContainText("physical printer");
  await expect(page.getByRole("dialog")).toContainText("At failure");
  await expect(page.getByRole("dialog")).toContainText("Current");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await visibleBell(page).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.mouse.click(700, 30);
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Hide sidebar" }).click();
  await expect(page.getByRole("button", { name: "Show sidebar" })).toBeVisible();
  const collapsedBox = await visibleBell(page).boundingBox();
  expect(collapsedBox).not.toBeNull();
  expect(collapsedBox!.x + collapsedBox!.width).toBeLessThanOrEqual(1440);
  await visibleBell(page).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByTestId("link-notification-inbox").click();
  await expect(page).toHaveURL(/#autoprint-notifications$/);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  await page.getByTestId("button-mark-read-alert-1").click();
  await expect(page.getByTestId("badge-autoprint-unread").first()).toHaveText("34");
  await expect(page.getByTestId("button-mark-read-alert-1")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("button-mark-read-alert-1")).toHaveCount(0);
  await page.evaluate(() => localStorage.setItem("test-admin", "admin-b"));
  await page.reload();
  await expect(page.getByTestId("badge-autoprint-unread").first()).toHaveText("35");
  await expect(page.getByTestId("button-mark-read-alert-1")).toHaveCount(1);
  await page.evaluate(() => localStorage.removeItem("test-admin"));
  await page.reload();
  await expect(page.getByTestId("badge-autoprint-unread").first()).toHaveText("34");

  await page.evaluate(() => localStorage.setItem("test-read-error", "1"));
  await page.getByTestId("button-mark-read-alert-2").click();
  await expect(page.getByTestId("card-notification-alert-2")).toContainText("Mock mark-read failure");
  await expect(page.getByTestId("badge-autoprint-unread").first()).toHaveText("34");
  await page.evaluate(() => localStorage.removeItem("test-read-error"));
  await page.getByTestId("button-mark-read-alert-2").click();
  await expect(page.getByTestId("badge-autoprint-unread").first()).toHaveText("33");

  await page.getByTestId("button-notifications-next").click();
  await expect(page.getByTestId("autoprint-notification-inbox")).toContainText("31–35 of 35");
  await expect(page.getByTestId("button-notifications-next")).toBeDisabled();
  await page.getByTestId("button-notifications-prev").click();
  await page.getByTestId("select-notification-kind").selectOption({ label: "Acceptance unknown" });
  await page.getByTestId("select-notification-read").selectOption({ label: "Read" });
  await expect(page.getByTestId("autoprint-notification-inbox")).toContainText("No notifications on this page");
  await page.getByTestId("select-notification-kind").selectOption({ label: "All types" });
  await page.getByTestId("select-notification-read").selectOption({ label: "Read and unread" });

  await page.evaluate(() => localStorage.setItem("test-list-error", "1"));
  await page.getByTestId("button-refresh-notifications").click();
  await expect(page.getByTestId("autoprint-notification-inbox")).toContainText("Could not load notifications");
  await expect(page.getByTestId("badge-autoprint-unread").first()).toHaveText("!");
  await page.evaluate(() => localStorage.removeItem("test-list-error"));
  await page.getByTestId("autoprint-notification-inbox").getByRole("button", { name: "Retry", exact: true }).click();

  await page.getByTestId("link-notification-alert-1").click();
  await expect(page).toHaveURL(/\?job=job-first/);
  await expect(page.locator("#autoprint-job-job-first")).toHaveCount(1);
  await page.getByTestId("link-notification-alert-3").click();
  await expect(page).toHaveURL(/\?job=job-unknown/);
  await expect(page.getByTestId("autoprint-retry-queue")).toContainText("Record verified acceptance");
  await expect(page.getByTestId("autoprint-retry-queue")).toContainText("Verify nothing submitted");
  await page.getByTestId("link-notification-alert-4").click();
  await expect(page.getByTestId("row-run-run-recent")).toContainText("Mock run failure");
  await page.getByTestId("link-notification-alert-8").click();
  await expect(page.getByTestId("panel-linked-run")).toContainText("Mock older linked run");

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => window.scrollTo(0, 0));
  await visibleBell(page).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  const mobileRect = await page.getByRole("dialog").evaluate((el) => {
    const r = el.getBoundingClientRect();
    const list = [...el.querySelectorAll("*")].find((node) =>
      getComputedStyle(node).overflowY === "auto" && node.scrollHeight > node.clientHeight);
    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height,
      position: getComputedStyle(el).position,
      list: list ? { scrollHeight: list.scrollHeight, clientHeight: list.clientHeight,
        overflowY: getComputedStyle(list).overflowY } : null,
      viewport: { width: innerWidth, height: innerHeight } };
  });
  await screenshot(page, "mobile-notification-dialog");
  if (mobileRect.x < 0 || mobileRect.y < 0 || mobileRect.right > 390 || mobileRect.bottom > 844) {
    layoutIssues.push(`Mobile dialog outside viewport: ${JSON.stringify(mobileRect)}`);
  }
  expect(mobileRect.list?.overflowY).toBe("auto");
  expect(mobileRect.list?.scrollHeight).toBeGreaterThan(mobileRect.list?.clientHeight ?? 0);
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page.getByRole("button", { name: "Open menu" }).click();
  const drawer = page.getByRole("complementary");
  await expect(drawer).toBeVisible();
  await expect(drawer.getByTestId("button-autoprint-bell")).toBeHidden();
  await page.getByRole("button", { name: "Close menu" }).click();
  await expect(page.locator("#hub-sidebar")).toBeHidden();
  await visibleBell(page).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.mouse.click(4, 500);
  await expect(page.getByRole("dialog")).toHaveCount(0);

  const requests = await page.evaluate(() => (window as any).notificationTest?.requests ?? []);
  expect(requests.filter((r: any) => r.method !== "GET" &&
    !/\/notifications\/[^/]+\/read$/.test(r.path))).toEqual([]);
  expect(blocked.filter((url) => /\/api\//i.test(url))).toEqual([]);
  expect(layoutIssues, "Known UI layout regressions").toEqual([]);
});

for (const role of ["manager", "staff"] as const) {
  test(`${role} has no notification/retry access`, async ({ page }) => {
    const blocked = await safety(page);
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(BASE);
    await page.evaluate((value) => {
      localStorage.setItem("test-role", value);
      localStorage.removeItem("test-list-error");
      localStorage.removeItem("test-read-error");
    }, role);
    await page.reload();
    await expect(page.getByTestId("button-autoprint-bell")).toHaveCount(0);
    await expect(page.getByTestId("autoprint-notification-inbox")).toHaveCount(0);
    await expect(page.getByTestId("autoprint-retry-queue")).toHaveCount(0);
    const calls = await page.evaluate(() => (window as any).notificationTest?.requests ?? []);
    expect(calls.filter((r: any) => /notifications|retry/i.test(r.path))).toEqual([]);
    expect(blocked.filter((url) => /\/api\//i.test(url))).toEqual([]);
  });
}
