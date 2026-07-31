import { useState } from "react";
import { useRequestMbUploadUrl } from "@workspace/api-client-react";

interface UseMbImageUploadOptions {
  onSuccess: (response: { objectPath: string }) => void;
  onError?: (err: Error) => void;
}

/**
 * Two-step upload for Mint Bucks email images:
 * 1. Ask the API server for a presigned PUT URL (staff-gated).
 * 2. PUT the file bytes directly to Google Cloud Storage.
 *
 * Returns the /objects/... path to store on the rule/credit. The server
 * normalizes and marks it public when the rule/credit is saved.
 */
export function useMbImageUpload({ onSuccess, onError }: UseMbImageUploadOptions) {
  const requestUrl = useRequestMbUploadUrl();
  const [isUploading, setIsUploading] = useState(false);

  const uploadFile = async (file: File) => {
    setIsUploading(true);
    try {
      const { uploadURL, objectPath } = await requestUrl.mutateAsync({
        data: { name: file.name, size: file.size, contentType: file.type || "application/octet-stream" },
      });
      const put = await fetch(uploadURL, {
        method: "PUT",
        body: file,
        headers: { "Content-Type": file.type || "application/octet-stream" },
      });
      if (!put.ok) throw new Error(`Upload failed (HTTP ${put.status})`);
      onSuccess({ objectPath });
    } catch (err) {
      onError?.(err instanceof Error ? err : new Error("Upload failed"));
    } finally {
      setIsUploading(false);
    }
  };

  return { uploadFile, isUploading };
}
