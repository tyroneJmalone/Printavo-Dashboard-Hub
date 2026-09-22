export type UploadStatus = "pending" | "reserving" | "uploading" | "completing" | "queued" | "error";
export type UploadResumePoint = "reserve" | "upload" | "complete";

export type UploadItem = {
  id: string;
  filename: string;
  byteSize: number;
  contentType: string;
  status: UploadStatus;
  resumeAt: UploadResumePoint;
  file?: File;
  jobId?: string;
  uploadURL?: string;
  reservedAt?: number;
  serverState?: string;
  error?: string;
  retryable: boolean;
};

type JobState = { id?: string; state: string };
type PutResult = { ok: boolean; status: number };

export type UploadAttemptDependencies = {
  reserve: (item: UploadItem) => Promise<{ job: JobState & { id: string }; uploadURL: string }>;
  put: (url: string, item: UploadItem) => Promise<PutResult>;
  getJob: (id: string) => Promise<JobState>;
  complete: (id: string) => Promise<JobState>;
  now?: () => number;
  onReserved?: (jobId: string) => void;
  onUpdate?: (item: UploadItem) => void;
};

export function nextPendingUpload(items: UploadItem[]): UploadItem | undefined {
  return items.find(item => item.status === "pending");
}

function uploadError(error: any): { message: string; retryable: boolean } {
  const status = error?.status ?? error?.response?.status ?? error?.data?.status;
  if (status === 429) {
    return {
      message: "SepScope's 20-job queue is full. Retry this file when a queue slot is available.",
      retryable: true
    };
  }
  return {
    message: error?.data?.error ?? error?.message ?? "Upload failed.",
    retryable: error?.retryable !== false
  };
}

export async function runUploadAttempt(
  initialItem: UploadItem,
  dependencies: UploadAttemptDependencies
): Promise<UploadItem> {
  if (initialItem.status === "queued") return initialItem;

  const now = dependencies.now ?? Date.now;
  let item = initialItem;
  const update = (patch: Partial<UploadItem>) => {
    item = { ...item, ...patch };
    dependencies.onUpdate?.(item);
  };

  try {
    if (item.resumeAt === "reserve") {
      update({ status: "reserving", error: undefined });
      const reserved = await dependencies.reserve(item);
      update({
        status: "uploading",
        resumeAt: "upload",
        jobId: reserved.job.id,
        uploadURL: reserved.uploadURL,
        reservedAt: now()
      });
      dependencies.onReserved?.(reserved.job.id);
    }

    if (item.resumeAt === "upload") {
      if (!item.file || !item.uploadURL) {
        throw new Error("The local file is no longer available. Select it again to upload.");
      }
      const uploadURL = item.uploadURL;
      update({ status: "uploading", error: undefined });
      const putResult = await dependencies.put(uploadURL, item);
      if (!putResult.ok) {
        const signedURLExpired = !!item.reservedAt && now() - item.reservedAt >= 15 * 60 * 1000;
        const error: any = new Error(
          putResult.status === 429
            ? "SepScope's 20-job queue is full. Retry this file when a queue slot is available."
            : signedURLExpired
            ? "This signed upload URL expired. SepScope cannot refresh reserved upload URLs yet; select the file again rather than retrying this reservation."
            : `Storage upload failed (${putResult.status}).`
        );
        error.status = putResult.status;
        error.retryable = !signedURLExpired;
        throw error;
      }
      update({
        status: "completing",
        resumeAt: "complete",
        file: undefined,
        uploadURL: undefined
      });
    }

    if (!item.jobId) throw new Error("The reserved job could not be found.");
    update({ status: "completing", error: undefined });
    const currentJob = await dependencies.getJob(item.jobId);
    const finalJob = currentJob.state === "uploading"
      ? await dependencies.complete(item.jobId)
      : currentJob;
    update({
      status: "queued",
      serverState: finalJob.state,
      file: undefined,
      uploadURL: undefined,
      error: undefined,
      retryable: false
    });
  } catch (error) {
    const failure = uploadError(error);
    update({
      status: "error",
      error: failure.message,
      retryable: failure.retryable,
      file: failure.retryable ? item.file : undefined
    });
  }

  return item;
}