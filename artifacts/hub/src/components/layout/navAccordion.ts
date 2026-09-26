type SidebarGroup = {
  heading: string | null;
  items: readonly { id: string; href?: string; external?: boolean; disabled?: boolean }[];
};

/** Longest matching route wins, so a detail page highlights its parent only. */
export function activeSidebarItem(groups: readonly SidebarGroup[], location: string) {
  const path = location.split(/[?#]/)[0].replace(/\/+$/, "") || "/";
  return groups.flatMap((group) => group.items.map((item) => ({ item, heading: group.heading })))
    .filter(({ item }) => !item.external && !item.disabled && item.href &&
      (path === item.href || (item.href !== "/" && path.startsWith(`${item.href}/`))))
    .sort((a, b) => b.item.href!.length - a.item.href!.length)[0];
}

export function toggleSidebarGroup(current: string | null, heading: string): string | null {
  return current === heading ? null : heading;
}