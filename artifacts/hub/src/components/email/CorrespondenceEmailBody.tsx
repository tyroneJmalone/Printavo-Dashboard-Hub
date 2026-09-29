import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "@/lib/api";
import { EmailBody } from "./EmailBody";

/** Recover legacy imports only when their message approaches the visible area. */
export function CorrespondenceEmailBody({
  threadId, messageId, body,
}: { threadId: string; messageId: string; body: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const needsSpacing = !body.trim().includes("\n");
  useEffect(() => {
    if (!needsSpacing || !container.current) return;
    const observer = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "200px" });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [needsSpacing]);

  const recovered = useQuery({
    queryKey: ["correspondence", "readable-body", threadId, messageId],
    queryFn: () => apiFetch<{ bodyText: string }>(
      `/correspondence/threads/${encodeURIComponent(threadId)}/messages/${encodeURIComponent(messageId)}/readable-body`,
    ),
    enabled: visible && needsSpacing,
    staleTime: 5 * 60_000,
    gcTime: 5 * 60_000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  return (
    <div ref={container} className="min-w-0">
      {recovered.isFetching && <p role="status" className="mb-2 text-xs text-slate-500">Restoring original email spacing…</p>}
      {recovered.isError && (
        <p role="status" className="mb-2 text-xs text-amber-300">
          Original spacing is unavailable; showing saved text.{" "}
          <button type="button" className="underline" onClick={() => void recovered.refetch()}>Retry</button>
        </p>
      )}
      <EmailBody body={recovered.data?.bodyText || body} allowPlainText />
    </div>
  );
}