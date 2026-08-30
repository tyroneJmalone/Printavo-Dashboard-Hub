import { Link, useParams } from "wouter";
import {
  useGetCustomerBranding,
  getGetCustomerBrandingQueryKey,
  useGetCustomerArtwork,
  getGetCustomerArtworkQueryKey,
  useGetCustomerProfile,
  getGetCustomerProfileQueryKey,
} from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { ArrowLeft, Loader2, Printer } from "lucide-react";
import { hexToRgb, USE_CASE_LABELS, formatEventDate } from "@/lib/branding";

function previewUrl(customerId: string, locator: string): string {
  return `/api/customers/${encodeURIComponent(customerId)}/artwork/temporary-link?locator=${encodeURIComponent(locator)}&inline=true`;
}

function canShowImage(name: string): boolean {
  return /\.(?:gif|jpe?g|png|webp)$/i.test(name);
}

function Value({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div className="flex gap-2 text-[13px] leading-6">
      <span className="w-20 shrink-0 font-semibold uppercase tracking-wide text-[10px] leading-6 text-neutral-500">{label}</span>
      {value ? (
        <span className="text-neutral-900 break-all">{value}</span>
      ) : (
        <span className="italic text-neutral-400">not on file</span>
      )}
    </div>
  );
}

/**
 * Printable brand-standards sheet. Deliberately rendered without the app
 * shell on a white background; shows ONLY current approved standards —
 * retired colors, fonts, and logos never appear here.
 */
export default function BrandSheet() {
  const params = useParams<{ id: string }>();
  const customerId = params.id;

  const { data: profile } = useGetCustomerProfile(customerId, undefined, {
    query: { enabled: !!customerId, queryKey: getGetCustomerProfileQueryKey(customerId) },
  });
  const { data: branding, isLoading } = useGetCustomerBranding(customerId, {
    query: { enabled: !!customerId, queryKey: getGetCustomerBrandingQueryKey(customerId) },
  });
  const { data: artwork } = useGetCustomerArtwork(customerId, {
    query: { enabled: !!customerId, queryKey: getGetCustomerArtworkQueryKey(customerId) },
  });

  const customerName =
    (profile as { customer?: { companyName?: string | null; fullName?: string | null } } | undefined)?.customer
      ?.companyName ||
    (profile as { customer?: { fullName?: string | null } } | undefined)?.customer?.fullName ||
    `Customer ${customerId}`;

  const colors = (branding?.colors || []).filter((c) => c.status === "current");
  const typography = (branding?.typography || []).filter((t) => t.status === "current");
  const logos = (artwork?.bookmarks || []).filter((b) => !b.retired);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-neutral-100 flex items-center justify-center">
        <Loader2 className="animate-spin text-neutral-400" size={24} />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-neutral-200 print:bg-white">
      <style>{`
        @media print {
          @page { margin: 14mm; }
          .no-print { display: none !important; }
          .sheet { box-shadow: none !important; margin: 0 !important; max-width: none !important; border-radius: 0 !important; }
        }
      `}</style>

      <div className="no-print sticky top-0 z-10 bg-neutral-900 border-b border-neutral-800 px-4 py-3 flex items-center justify-between">
        <Button asChild variant="ghost" size="sm" className="text-neutral-300 hover:text-white">
          <Link href={`/customers/${customerId}`}>
            <ArrowLeft size={15} className="mr-1.5" /> Back to profile
          </Link>
        </Button>
        <Button size="sm" onClick={() => window.print()} className="bg-blue-600 hover:bg-blue-500 text-white" data-testid="button-print-sheet">
          <Printer size={15} className="mr-1.5" /> Print / Save PDF
        </Button>
      </div>

      <div className="sheet max-w-3xl mx-auto my-8 bg-white shadow-xl rounded-lg overflow-hidden">
        <div className="px-10 pt-10 pb-6 border-b-2 border-neutral-900">
          <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-neutral-500">Brand Standards</p>
          <h1 className="text-3xl font-bold text-neutral-900 mt-1" data-testid="text-brand-sheet-customer">{customerName}</h1>
          <p className="text-xs text-neutral-500 mt-2">
            Prepared by Mint Printworks · {new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" })}
            {branding?.audit ? ` · Standards last updated ${formatEventDate(branding.audit.updatedAt)}` : ""}
          </p>
        </div>

        <div className="px-10 py-8 space-y-10">
          {colors.length === 0 && typography.length === 0 && logos.length === 0 && !branding?.notes && (
            <p className="text-sm text-neutral-500 italic">No approved brand standards on file yet.</p>
          )}

          {colors.length > 0 && (
            <section>
              <h2 className="text-sm font-bold uppercase tracking-widest text-neutral-900 border-b border-neutral-300 pb-2 mb-4">Colors</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                {colors.map((color) => (
                  <div key={color.assignmentId} className="break-inside-avoid">
                    <div className="flex items-center gap-3 mb-2">
                      <div
                        className="w-12 h-12 rounded-md border border-neutral-300 shrink-0"
                        style={{ backgroundColor: color.hex }}
                      />
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{color.role}</p>
                        <p className="text-base font-semibold text-neutral-900">{color.name}</p>
                      </div>
                    </div>
                    <Value label="Pantone" value={color.pantoneCode} />
                    <Value label="Hex" value={color.hex} />
                    <Value label="RGB" value={hexToRgb(color.hex)} />
                    <Value label="CMYK" value={color.cmyk} />
                    <Value label="Ink" value={color.inkReferences} />
                    <Value label="Thread" value={color.threadReferences} />
                  </div>
                ))}
              </div>
            </section>
          )}

          {typography.length > 0 && (
            <section>
              <h2 className="text-sm font-bold uppercase tracking-widest text-neutral-900 border-b border-neutral-300 pb-2 mb-4">Typography</h2>
              <table className="w-full text-[13px]">
                <thead>
                  <tr className="text-left text-[10px] uppercase tracking-wide text-neutral-500">
                    <th className="pb-2 pr-4 font-semibold w-32">Use</th>
                    <th className="pb-2 pr-4 font-semibold">Font</th>
                    <th className="pb-2 pr-4 font-semibold w-32">Case</th>
                    <th className="pb-2 font-semibold">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {typography.map((entry) => (
                    <tr key={entry.id} className="border-t border-neutral-200 align-top">
                      <td className="py-2 pr-4 text-neutral-600">{entry.role}</td>
                      <td className="py-2 pr-4 font-semibold text-neutral-900">{entry.fontName}</td>
                      <td className="py-2 pr-4 text-neutral-700">{entry.capitalization || "—"}</td>
                      <td className="py-2 text-neutral-600">{entry.usageNotes || "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {logos.length > 0 && (
            <section>
              <h2 className="text-sm font-bold uppercase tracking-widest text-neutral-900 border-b border-neutral-300 pb-2 mb-4">Approved Logos</h2>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
                {logos.map((logo) => (
                  <div key={logo.id} className="break-inside-avoid border border-neutral-200 rounded-md overflow-hidden">
                    {canShowImage(logo.name) ? (
                      <img
                        src={previewUrl(customerId, logo.pathLower || logo.dropboxId)}
                        alt={logo.label}
                        className="h-28 w-full object-contain bg-white border-b border-neutral-200 p-2"
                      />
                    ) : (
                      <div className="h-28 w-full flex items-center justify-center bg-neutral-50 border-b border-neutral-200 text-xs font-semibold text-neutral-400 uppercase">
                        {logo.name.split(".").pop()}
                      </div>
                    )}
                    <div className="p-2.5">
                      <p className="text-xs font-semibold text-neutral-900 break-words">
                        {logo.label}
                        {logo.preferred ? " ★" : ""}
                      </p>
                      {logo.useCases && logo.useCases.length > 0 && (
                        <p className="text-[10px] text-neutral-500 mt-1 leading-relaxed">
                          {logo.useCases.map((useCase) => USE_CASE_LABELS[useCase]).join(" · ")}
                        </p>
                      )}
                      {logo.notes && (
                        <p className="text-[10px] text-neutral-500 mt-1 leading-relaxed">{logo.notes}</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {branding?.notes && (
            <section>
              <h2 className="text-sm font-bold uppercase tracking-widest text-neutral-900 border-b border-neutral-300 pb-2 mb-4">Production Notes</h2>
              <p className="text-[13px] text-neutral-700 whitespace-pre-wrap leading-relaxed">{branding.notes}</p>
            </section>
          )}
        </div>

        <div className="px-10 py-4 border-t border-neutral-200 flex items-center justify-between">
          <p className="text-[10px] text-neutral-400">Current approved standards only — retired items are excluded.</p>
          <p className="text-[10px] text-neutral-400">Mint Printworks · Printavo Hub</p>
        </div>
      </div>
    </div>
  );
}
