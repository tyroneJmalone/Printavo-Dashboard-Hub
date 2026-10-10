import { useQueryClient } from "@tanstack/react-query";
import {
  useListAutoPrintNotifications,
  useReadAutoPrintNotification,
  getListAutoPrintNotificationsQueryKey,
  type ListAutoPrintNotifications200,
} from "@workspace/api-client-react";
import { useStaff } from "@/components/auth/StaffGate";

export const NOTIFICATION_PAGE_SIZE = 30;

/** Admin-only list query. Staff/managers never issue the request. Cached data is hidden on error. */
export function useAutoPrintNotificationList(offset: number) {
  const { role } = useStaff();
  const admin = role === "admin";
  const params = { offset };
  const query = useListAutoPrintNotifications(params, {
    query: {
      queryKey: getListAutoPrintNotificationsQueryKey(params),
      enabled: admin,
      refetchInterval: admin ? 30_000 : false,
    },
  });
  return { admin, query, data: query.isError ? undefined : query.data };
}

export function apiErrorMessage(err: unknown, fallback: string): string {
  const data = err && typeof err === "object" && "data" in err
    ? (err as { data?: { error?: string } }).data
    : undefined;
  return data?.error ?? fallback;
}

/** Marks one notification read for the current admin and patches every cached offset page. */
export function useMarkNotificationRead() {
  const cache = useQueryClient();
  const baseKey = getListAutoPrintNotificationsQueryKey();
  return useReadAutoPrintNotification({
    mutation: {
      onSuccess: async (_res, { id }) => {
        cache.setQueriesData<ListAutoPrintNotifications200>({ queryKey: baseKey }, (old) => {
          if (!old) return old;
          const hit = old.items.some((n) => n.id === id && !n.read);
          return {
            ...old,
            unread: hit ? Math.max(0, old.unread - 1) : old.unread,
            items: old.items.map((n) => (n.id === id ? { ...n, read: true } : n)),
          };
        });
        await cache.invalidateQueries({ queryKey: baseKey });
      },
    },
  });
}
