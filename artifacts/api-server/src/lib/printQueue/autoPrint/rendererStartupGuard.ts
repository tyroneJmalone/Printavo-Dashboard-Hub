export const PDF_RENDERER_STARTUP_ERROR_PREFIX =
  "PDF renderer startup failed before printing: ";

export interface AutoPrintPdfRenderer {
  renderUrl(url: string, options?: { excludeAttachments?: boolean }): Promise<Buffer>;
  close(): Promise<void>;
}

export class AutoPrintRendererStartupError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AutoPrintRendererStartupError";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Opens the shared renderer before allowing any per-document work to begin.
 * If startup is exhausted, the complete pending document list is handed to
 * one persistence callback and `work` is never entered.
 */
export async function withRendererStartupGuard<Document, Result, Renderer extends AutoPrintPdfRenderer>(
  documents: readonly Document[],
  openRenderer: () => Promise<Renderer>,
  recordStartupFailures: (
    documents: readonly Document[],
    message: string,
  ) => Promise<void>,
  work: (
    renderer: Renderer,
    documents: readonly Document[],
  ) => Promise<Result>,
): Promise<Result> {
  let renderer: Renderer;
  try {
    renderer = await openRenderer();
  } catch (error) {
    const message = `${PDF_RENDERER_STARTUP_ERROR_PREFIX}${errorMessage(error)}`;
    await recordStartupFailures(documents, message);
    throw new AutoPrintRendererStartupError(message, { cause: error });
  }

  try {
    return await work(renderer, documents);
  } finally {
    await renderer.close();
  }
}