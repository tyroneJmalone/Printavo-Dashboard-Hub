import { Link } from "wouter";
import { LogIn } from "lucide-react";
import mintLogo from "@assets/MINT_Scripty_1783693134382.png";

/** Public landing for signed-out visitors — never auto-redirects to sign-in. */
export default function Landing() {
  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-[#020617] px-4">
      <div className="w-full max-w-md text-center">
        <img
          src={mintLogo}
          alt="Mint Printworks"
          className="mx-auto h-16 w-auto drop-shadow-[0_0_14px_rgba(5,150,105,0.35)]"
        />
        <h1 className="mt-6 text-2xl font-semibold tracking-tight text-white">
          Printavo Hub
        </h1>
        <p className="mt-2 text-sm text-slate-400">
          Mint Printworks internal tools — orders, purchasing, production, and
          reporting in one place. Staff sign-in required.
        </p>
        <Link
          href="/sign-in"
          className="mt-8 inline-flex items-center gap-2 rounded-md bg-[#059669] px-5 py-2.5 text-sm font-semibold text-white shadow-lg shadow-emerald-900/30 transition-colors hover:bg-[#047857]"
        >
          <LogIn size={16} /> Staff sign in
        </Link>
      </div>
    </div>
  );
}
