import { useState, useCallback } from "react";

export function useTaskSelection() {
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());

  const toggle = useCallback((id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }, []);

  const clear = useCallback(() => {
    setSelectedIds(new Set());
    setSelecting(false);
  }, []);

  const startSelecting = useCallback((id?: number) => {
    setSelecting(true);
    if (id !== undefined) {
      setSelectedIds((prev) => new Set(prev).add(id));
    }
  }, []);

  return {
    selecting,
    selectedIds,
    toggle,
    clear,
    startSelecting,
  };
}
