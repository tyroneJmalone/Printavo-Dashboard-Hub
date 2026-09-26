import assert from "node:assert/strict";
import test from "node:test";
import { activeSidebarItem, toggleSidebarGroup } from "./navAccordion";

const groups = [
  { heading: null, items: [{ id: "home", href: "/" }] },
  { heading: "Sales", items: [{ id: "products", href: "/product-finder" }] },
  { heading: "Clients", items: [
    { id: "customers", href: "/customers" },
    { id: "report", href: "/customers/report" },
  ] },
  { heading: "Mint Bucks", items: [
    { id: "mb-home", href: "/mintbucks" },
    { id: "mb-customers", href: "/mintbucks/customers" },
  ] },
  { heading: "Team", items: [{ id: "tasks", href: "/momintum/", external: true }] },
];

test("opening a category replaces the previous one; clicking it again closes it", () => {
  let open: string | null = null;
  open = toggleSidebarGroup(open, "Sales");
  assert.equal(open, "Sales");
  open = toggleSidebarGroup(open, "Clients");
  assert.equal(open, "Clients");
  assert.equal(toggleSidebarGroup(open, "Clients"), null);
});

test("routes resolve the category and most specific active module", () => {
  assert.equal(activeSidebarItem(groups, "/product-finder?tab=garment-pantones")?.heading, "Sales");
  assert.equal(activeSidebarItem(groups, "/customers/123")?.item.id, "customers");
  assert.equal(activeSidebarItem(groups, "/customers/report")?.item.id, "report");
  assert.equal(activeSidebarItem(groups, "/mintbucks/customers/123")?.item.id, "mb-customers");
  assert.equal(activeSidebarItem(groups, "/mintbucks/")?.heading, "Mint Bucks");
});

test("ungrouped pages, hidden modules and external links do not open another category", () => {
  assert.equal(activeSidebarItem(groups, "/")?.heading, null);
  assert.equal(activeSidebarItem(groups, "/settings"), undefined);
  assert.equal(activeSidebarItem(groups, "/customers-other"), undefined);
  assert.equal(activeSidebarItem(groups.filter((group) => group.heading !== "Sales"), "/product-finder"), undefined);
  assert.equal(activeSidebarItem(groups, "/momintum/"), undefined);
});