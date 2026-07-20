import { ReactNode, useState, useCallback } from "react";
import { Link, useLocation } from "wouter";
import {
  Calendar, CalendarDays, Inbox, ListChecks, CheckSquare,
  Users, Menu, Moon, Sun, LogOut, AtSign, Search, ChevronRight,
  LayoutList, UserCheck, GripVertical, Lock, Globe, MessageSquarePlus, ArrowLeft,
  Folder, FolderOpen,
} from "lucide-react";
import {
  useGetDashboardSummary,
  useListMentions,
  useListLists,
  useListListGroups,
  useListTeams,
  useUpdateTask,
  getListTasksQueryKey,
  getGetDashboardSummaryQueryKey,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useClerk, useUser } from "@clerk/react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetTrigger } from "@/components/ui/sheet";
import { useCurrentUser } from "@/lib/current-user";
import { QuoteBanner } from "@/components/layout/quote-banner";
import { PrintavoSyncButton } from "@/components/printavo-sync-button";
import { FeedbackButton } from "@/components/feedback/feedback-button";
import logo from "@/assets/mint-logo.png";
import {
  DndContext,
  closestCenter,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  arrayMove,
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");
const LISTS_EXPANDED_KEY = "momintum-sidebar-lists-expanded";
const NAV_ORDER_KEY = "momintum-sidebar-nav-order";
const GROUPS_COLLAPSED_KEY = "momintum-sidebar-groups-collapsed";

function readCollapsedGroups(): number[] {
  try {
    const raw = localStorage.getItem(GROUPS_COLLAPSED_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed.filter((n) => typeof n === "number") : [];
  } catch {
    return [];
  }
}

const NAV_ITEM_DEFS = [
  { href: "/today", label: "Today", icon: Calendar, expandable: false },
  { href: "/week", label: "Week", icon: CalendarDays, expandable: false },
  { href: "/calendar", label: "Calendar", icon: Calendar, expandable: false },
  { href: "/all-tasks", label: "All Tasks", icon: LayoutList, expandable: false },
  { href: "/assigned-to-me", label: "Assigned to Me", icon: UserCheck, expandable: false },
  { href: "/lists", label: "Lists", icon: ListChecks, expandable: true },
  { href: "/inbox", label: "Inbox", icon: Inbox, expandable: false },
  { href: "/completed", label: "Completed / Deleted", icon: CheckSquare, expandable: false },
  { href: "/team", label: "Team", icon: Users, expandable: false },
];

function readNavOrder(): string[] {
  try {
    const raw = localStorage.getItem(NAV_ORDER_KEY);
    if (!raw) return NAV_ITEM_DEFS.map((n) => n.href);
    const parsed = JSON.parse(raw) as string[];
    const allHrefs = NAV_ITEM_DEFS.map((n) => n.href);
    const valid = parsed.filter((h) => allHrefs.includes(h));
    const missing = allHrefs.filter((h) => !valid.includes(h));
    return [...valid, ...missing];
  } catch {
    return NAV_ITEM_DEFS.map((n) => n.href);
  }
}

interface SortableNavRowProps {
  id: string;
  label: string;
  icon: React.ElementType;
  isActive: boolean;
  count?: number;
  alert?: boolean;
  badgeClass?: string;
  expandable?: boolean;
  listsExpanded?: boolean;
  onToggleExpand?: () => void;
  children?: ReactNode;
}

function SortableNavRow({
  id, label, icon: Icon, isActive, count, alert, badgeClass, expandable,
  listsExpanded, onToggleExpand, children,
}: SortableNavRowProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({ id });
  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    <div ref={setNodeRef} style={style} className="group">
      <div className="flex items-center">
        <button
          type="button"
          {...attributes}
          {...listeners}
          className="p-1 rounded opacity-0 group-hover:opacity-40 hover:!opacity-70 cursor-grab active:cursor-grabbing transition-opacity shrink-0 touch-none"
          aria-label="Drag to reorder"
          tabIndex={-1}
        >
          <GripVertical className="w-3.5 h-3.5 text-sidebar-foreground" />
        </button>
        <Link
          href={id}
          className={cn(
            "flex items-center gap-3 px-2 py-2 rounded-md transition-colors text-sm font-medium flex-1 min-w-0",
            isActive
              ? "bg-primary text-primary-foreground"
              : "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground text-sidebar-foreground/80",
          )}
        >
          <Icon className="w-4 h-4 shrink-0" />
          <span className="flex-1 truncate">{label}</span>
          {count !== undefined && count > 0 && (
            <span className={cn(
              "text-xs px-2 py-0.5 rounded-full font-bold shrink-0",
              isActive
                ? "bg-primary-foreground/20"
                : badgeClass
                  ? badgeClass
                  : alert
                    ? "bg-destructive text-destructive-foreground"
                    : "bg-sidebar-accent text-sidebar-foreground/60",
            )}>
              {count}
            </span>
          )}
        </Link>
        {expandable && (
          <button
            type="button"
            onClick={onToggleExpand}
            className="p-1.5 rounded-md hover:bg-sidebar-accent shrink-0"
            aria-label={listsExpanded ? "Collapse lists" : "Expand lists"}
          >
            <ChevronRight className={cn("w-3.5 h-3.5 transition-transform", listsExpanded && "rotate-90")} />
          </button>
        )}
      </div>
      {children}
    </div>
  );
}

export function AppLayout({ children }: { children: ReactNode }) {
  const [location, navigate] = useLocation();
  const { currentUser, darkMode, toggleDarkMode } = useCurrentUser();
  const { user } = useUser();
  const { signOut } = useClerk();
  const [searchValue, setSearchValue] = useState(
    location === "/search" ? new URLSearchParams(window.location.search).get("q") ?? "" : "",
  );
  const [listsExpanded, setListsExpanded] = useState(
    () => localStorage.getItem(LISTS_EXPANDED_KEY) !== "false",
  );
  const [navOrder, setNavOrder] = useState<string[]>(readNavOrder);
  const [dropTargetListId, setDropTargetListId] = useState<number | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<number[]>(readCollapsedGroups);
  const queryClient = useQueryClient();
  const updateTask = useUpdateTask();
  const { data: lists } = useListLists();
  const { data: listGroups } = useListListGroups();
  const { data: teams } = useListTeams();

  const toggleGroupCollapsed = (groupId: number) => {
    setCollapsedGroups((prev) => {
      const next = prev.includes(groupId)
        ? prev.filter((id) => id !== groupId)
        : [...prev, groupId];
      try { localStorage.setItem(GROUPS_COLLAPSED_KEY, JSON.stringify(next)); } catch { /* noop */ }
      return next;
    });
  };

  const visibleLists = (lists || []).filter(
    (list) => !list.ownerId || list.ownerId === currentUser?.id || currentUser?.isAdmin,
  );

  const teamsById = new Map((teams || []).map((t) => [t.id, t]));

  const toggleListsExpanded = () => {
    setListsExpanded((prev) => {
      const next = !prev;
      localStorage.setItem(LISTS_EXPANDED_KEY, String(next));
      return next;
    });
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const handleNavDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    if (!over || active.id === over.id) return;
    setNavOrder((prev) => {
      const oldIndex = prev.indexOf(active.id as string);
      const newIndex = prev.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1) return prev;
      const next = arrayMove(prev, oldIndex, newIndex);
      try { localStorage.setItem(NAV_ORDER_KEY, JSON.stringify(next)); } catch { /* noop */ }
      return next;
    });
  }, []);

  const handleDropOnList = (listId: number, e: React.DragEvent) => {
    e.preventDefault();
    setDropTargetListId(null);
    const taskId = Number(e.dataTransfer.getData("application/momintum-task-id"));
    if (!taskId) return;
    updateTask.mutate(
      { id: taskId, data: { listId } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: getListTasksQueryKey() });
          queryClient.invalidateQueries({ queryKey: getGetDashboardSummaryQueryKey() });
        },
      },
    );
  };

  const handleSearchChange = (value: string) => {
    setSearchValue(value);
    navigate(`/search?q=${encodeURIComponent(value)}`);
  };

  const { data: summary } = useGetDashboardSummary(
    currentUser?.isAdmin ? {} : { assigneeId: currentUser?.id },
  );
  const { data: mentions } = useListMentions(
    { memberId: currentUser?.id ?? 0 },
    { query: { enabled: !!currentUser?.id, queryKey: ["mentions", currentUser?.id] } },
  );

  const navCounts: Record<string, { count?: number; alert?: boolean; badgeClass?: string }> = {
    "/today": { count: summary?.todayCount, alert: summary?.overdueCount ? true : false },
    "/upcoming": { count: summary?.upcomingCount },
    "/inbox": { count: mentions?.length, badgeClass: "bg-[#9e4a95] text-white" },
  };

  const orderedNavDefs = navOrder.map((href) => NAV_ITEM_DEFS.find((n) => n.href === href)).filter(Boolean) as typeof NAV_ITEM_DEFS;

  const SidebarContent = () => (
    <div className="flex flex-col h-full bg-sidebar border-r border-sidebar-border w-64 text-sidebar-foreground">
      <div className="p-4">
        <div className="flex items-center gap-3 font-black text-2xl text-primary tracking-tight">
          <img src={logo} alt="Mint Printworks" className="w-12 h-12 object-contain" />
          MOMINTUM
        </div>
        <div className="text-sm text-brand-purple font-medium mt-1 whitespace-nowrap tracking-tight">
          Actionable tasks. Forward motion.
        </div>
      </div>

      <div className="px-2 py-4 flex flex-col gap-0.5 flex-1 overflow-y-auto">
        <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleNavDragEnd}>
          <SortableContext items={navOrder} strategy={verticalListSortingStrategy}>
            {orderedNavDefs.map((item) => {
              const isActive = location === item.href;
              const counts = navCounts[item.href] ?? {};
              return (
                <SortableNavRow
                  key={item.href}
                  id={item.href}
                  label={item.label}
                  icon={item.icon}
                  isActive={isActive}
                  count={counts.count}
                  alert={counts.alert}
                  badgeClass={counts.badgeClass}
                  expandable={item.expandable}
                  listsExpanded={listsExpanded}
                  onToggleExpand={toggleListsExpanded}
                >
                  {item.expandable && listsExpanded && (() => {
                    const myLists = visibleLists.filter(
                      (l) => !l.ownerId || l.ownerId === currentUser?.id,
                    );
                    const othersPrivateLists = currentUser?.isAdmin
                      ? visibleLists.filter((l) => l.ownerId && l.ownerId !== currentUser?.id)
                      : [];

                    const renderListLink = (list: (typeof visibleLists)[number]) => {
                      const listActive = location === `/lists/${list.id}`;
                      const isPrivate = !!list.ownerId;
                      const team = list.teamId ? teamsById.get(list.teamId) : undefined;
                      const tooltip = isPrivate
                        ? "Private list"
                        : team
                          ? `Shared with ${team.name}`
                          : "Shared with everyone";
                      return (
                        <Link
                          key={list.id}
                          href={`/lists/${list.id}`}
                          onDragOver={(e) => { e.preventDefault(); setDropTargetListId(list.id); }}
                          onDragLeave={() => setDropTargetListId((prev) => (prev === list.id ? null : prev))}
                          onDrop={(e) => handleDropOnList(list.id, e)}
                          title={tooltip}
                          className={cn(
                            "flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors",
                            listActive
                              ? "bg-primary text-primary-foreground"
                              : "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground text-sidebar-foreground/70",
                            dropTargetListId === list.id && "ring-2 ring-primary bg-sidebar-accent",
                          )}
                        >
                          <div className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: list.color }} />
                          <span className="truncate flex-1 min-w-0">{list.name}</span>
                          {isPrivate ? (
                            <Lock className="w-3 h-3 shrink-0 opacity-50" />
                          ) : team ? (
                            <div
                              className="w-3.5 h-3.5 rounded-full shrink-0 flex items-center justify-center text-[8px] font-bold text-white opacity-70"
                              style={{ backgroundColor: team.color }}
                            >
                              {team.name.slice(0, 1).toUpperCase()}
                            </div>
                          ) : (
                            <Globe className="w-3 h-3 shrink-0 opacity-30" />
                          )}
                        </Link>
                      );
                    };

                    const sortedGroups = (listGroups || [])
                      .slice()
                      .sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
                    const groupIds = new Set(sortedGroups.map((g) => g.id));
                    // Lists pointing at a deleted/not-yet-loaded group render
                    // as ungrouped rather than vanishing.
                    const myUngrouped = myLists.filter(
                      (l) => l.groupId == null || !groupIds.has(l.groupId),
                    );

                    return (
                      <div className="mt-1 ml-7 pl-3 border-l border-sidebar-border flex flex-col gap-0.5">
                        {visibleLists.length === 0 && (
                          <span className="text-xs text-sidebar-foreground/50 px-2 py-1">No lists yet</span>
                        )}
                        {sortedGroups.map((group) => {
                          const groupLists = myLists.filter((l) => l.groupId === group.id);
                          const collapsed = collapsedGroups.includes(group.id);
                          const GroupIcon = collapsed ? Folder : FolderOpen;
                          return (
                            <div key={`group-${group.id}`}>
                              <button
                                type="button"
                                onClick={() => toggleGroupCollapsed(group.id)}
                                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-sm font-medium transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground text-sidebar-foreground/80"
                              >
                                <GroupIcon className="w-3.5 h-3.5 shrink-0" style={{ color: group.color }} />
                                <span className="truncate flex-1 min-w-0 text-left">{group.name}</span>
                                <ChevronRight className={cn("w-3 h-3 shrink-0 opacity-50 transition-transform", !collapsed && "rotate-90")} />
                              </button>
                              {!collapsed && (
                                <div className="ml-3 pl-2 border-l border-sidebar-border flex flex-col gap-0.5">
                                  {groupLists.length === 0 ? (
                                    <span className="text-xs text-sidebar-foreground/40 px-2 py-1">Empty</span>
                                  ) : (
                                    groupLists.map(renderListLink)
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })}
                        {myUngrouped.map(renderListLink)}
                        {othersPrivateLists.length > 0 && (
                          <>
                            <div className="flex items-center gap-1 px-2 pt-2 pb-0.5">
                              <div className="flex-1 h-px bg-sidebar-border" />
                              <span className="text-[10px] text-sidebar-foreground/40 font-medium whitespace-nowrap">
                                Others' private
                              </span>
                              <div className="flex-1 h-px bg-sidebar-border" />
                            </div>
                            {othersPrivateLists.map(renderListLink)}
                          </>
                        )}
                      </div>
                    );
                  })()}
                </SortableNavRow>
              );
            })}
          </SortableContext>
        </DndContext>
      </div>

      {currentUser?.isAdmin && (
        <div className="px-3 pb-1 space-y-0.5">
          <PrintavoSyncButton />
          <Link
            href="/feedback"
            className={cn(
              "flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors w-full",
              location === "/feedback"
                ? "bg-primary text-primary-foreground"
                : "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground text-sidebar-foreground/50",
            )}
          >
            <MessageSquarePlus className="w-4 h-4 shrink-0" />
            <span className="truncate">Team Feedback</span>
          </Link>
        </div>
      )}


      <div className="px-3 pb-2">
        <a
          href="/"
          className="flex items-center gap-2 px-2 py-1.5 rounded-md text-sm transition-colors w-full hover:bg-sidebar-accent hover:text-sidebar-accent-foreground text-sidebar-foreground/50"
        >
          <ArrowLeft className="w-4 h-4 shrink-0" />
          <span className="truncate">Back to Printavo Hub</span>
        </a>
      </div>

      <div className="p-3 border-t border-sidebar-border space-y-2">
        <div className="flex items-center gap-2 px-1">
          <div
            className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white shrink-0"
            style={{ backgroundColor: currentUser?.color || "#9e4a95" }}
          >
            {(currentUser?.name || user?.fullName || "?").slice(0, 1).toUpperCase()}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-medium truncate">{currentUser?.name || user?.fullName || "..."}</div>
            {currentUser?.isAdmin && (
              <div className="text-[10px] uppercase tracking-wide text-[#2baeae] font-semibold">Admin</div>
            )}
          </div>
          <Button variant="ghost" size="icon" onClick={toggleDarkMode} className="shrink-0">
            {darkMode ? <Sun className="w-4 h-4" /> : <Moon className="w-4 h-4" />}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="shrink-0"
            onClick={() => signOut({ redirectUrl: basePath || "/" })}
          >
            <LogOut className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );

  return (
    <div className="flex h-screen w-full overflow-hidden bg-background">
      <div className="hidden md:block">
        <SidebarContent />
      </div>

      <div className="flex-1 flex flex-col h-full overflow-hidden">
        <div className="md:hidden flex items-center p-4 border-b bg-background">
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="mr-2">
                <Menu className="w-5 h-5" />
              </Button>
            </SheetTrigger>
            <SheetContent side="left" className="p-0 w-64">
              <SidebarContent />
            </SheetContent>
          </Sheet>
          <div className="font-black text-lg text-foreground flex items-center gap-2">
            <img src={logo} alt="Mint Printworks" className="w-9 h-9 object-contain" />
            MOMINTUM
          </div>
          {!!mentions?.length && (
            <span className="ml-auto flex items-center gap-1 text-xs font-bold text-white bg-[#9e4a95] px-2 py-0.5 rounded-full">
              <AtSign className="w-3 h-3" /> {mentions.length}
            </span>
          )}
        </div>

        <div className="hidden md:block px-8 pt-6">
          <QuoteBanner />
        </div>
        <div className="md:hidden px-4 pt-3">
          <QuoteBanner />
        </div>

        <div className="hidden md:flex items-center gap-2 px-8 pt-4">
          <div className="relative w-full max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={searchValue}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder="Search tasks..."
              className="pl-9 h-9"
            />
          </div>
        </div>
        <div className="md:hidden px-4 pt-3">
          <div className="relative w-full">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              value={searchValue}
              onChange={(e) => handleSearchChange(e.target.value)}
              placeholder="Search tasks..."
              className="pl-9 h-9"
            />
          </div>
        </div>

        <main className="flex-1 overflow-auto p-4 md:p-8">
          <div className="max-w-6xl mx-auto w-full">
            {children}
          </div>
        </main>
      </div>
      <FeedbackButton />
    </div>
  );
}
