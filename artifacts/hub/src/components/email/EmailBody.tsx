import { useMemo, useState } from "react";
import { segmentEmailBody } from "./emailBodySegments";

export function EmailBody({ body, allowPlainText = false }: { body: string; allowPlainText?: boolean }) {
  const [plainText, setPlainText] = useState(false);
  const segments = useMemo(() => segmentEmailBody(body), [body]);
  const textStyle = "whitespace-pre-wrap break-words [overflow-wrap:anywhere]";

  return (
    <div className="min-w-0">
      {allowPlainText && (
        <div className="mb-3 flex justify-end">
          <button
            type="button"
            aria-pressed={plainText}
            onClick={() => setPlainText((current) => !current)}
            className="rounded-md border border-slate-700 px-2 py-1 text-xs text-slate-400 hover:bg-slate-800 hover:text-slate-100"
          >
            {plainText ? "Formatted view" : "Plain-text view"}
          </button>
        </div>
      )}
      {plainText ? (
        <div className={textStyle}>{body}</div>
      ) : (
        <div className="space-y-3">
          {segments.map((segment, index) => (
            <section
              key={index}
              aria-label={segment.kind === "quote" ? "Quoted reply" : segment.kind === "signature" ? "Signature" : undefined}
              className={
                segment.kind === "quote"
                  ? "min-w-0 rounded-r-md border-l-2 border-sky-700/70 bg-slate-800/40 px-3 py-2 text-slate-400"
                  : segment.kind === "signature"
                    ? "min-w-0 border-t border-slate-700/70 pt-3 text-slate-400"
                    : "min-w-0"
              }
            >
              {segment.kind !== "message" && (
                <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-500">
                  {segment.kind === "quote" ? "Quoted reply" : "Signature"}
                </div>
              )}
              <div className={textStyle}>{segment.text}</div>
            </section>
          ))}
        </div>
      )}
    </div>
  );
}