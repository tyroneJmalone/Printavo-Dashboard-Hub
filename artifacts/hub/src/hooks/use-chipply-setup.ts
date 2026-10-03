import { useQueryClient } from "@tanstack/react-query";
import {
  ApiError,
  useGetChipplySetup,
  useSaveChipplySetup as useGeneratedSave,
  getGetChipplySetupQueryKey,
  type ChipplySetupResponse,
  type ChipplySetupRequest,
} from "@workspace/api-client-react";

export type ChipplySetup = ChipplySetupResponse;
export type ChipplySetupUpdate = Omit<ChipplySetupRequest, "version" | "evidenceKey">;

export const chipplySetupKey = (id: string) => getGetChipplySetupQueryKey(id);

export function setupErrorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    const d = err.data as { error?: string } | null | undefined;
    return d?.error ?? err.message;
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}
export const isConflict = (err: unknown) => err instanceof ApiError && err.status === 409;

export function useChipplySetup(id: string) {
  return useGetChipplySetup(id, { query: { enabled: !!id, queryKey: getGetChipplySetupQueryKey(id), refetchOnWindowFocus: true } });
}

/** Saves against the version + evidence the user is looking at. A 409 is surfaced, never retried. */
export function useSaveChipplySetup(id: string) {
  const client = useQueryClient();
  const m = useGeneratedSave({ mutation: { retry: false, onSuccess: (data) => client.setQueryData(getGetChipplySetupQueryKey(id), data) } });
  return {
    isPending: m.isPending,
    mutate: (
      { base, next }: { base: ChipplySetup; next: ChipplySetupUpdate },
      opts: { onSuccess?: () => void; onError?: (err: unknown) => void },
    ) => m.mutate({ id, data: { version: base.version, evidenceKey: base.evidenceKey, ...next } }, opts),
  };
}
