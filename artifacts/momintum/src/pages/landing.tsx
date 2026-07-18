import { Link } from "wouter";
import { Button } from "@/components/ui/button";
import logo from "@/assets/mint-logo.png";

export function Landing() {
  return (
    <div className="min-h-[100dvh] flex flex-col items-center justify-center bg-background px-4 text-center">
      <img src={logo} alt="Mint Printworks" className="w-40 h-auto mb-6" />
      <h1 className="text-7xl font-black text-foreground tracking-tight">MOMINTUM</h1>
      <p className="text-brand-purple font-medium mt-3 mb-8 whitespace-nowrap">
        Actionable tasks. Forward motion.
      </p>
      <div className="flex gap-3">
        <Link href="/sign-in">
          <Button size="lg">Sign in</Button>
        </Link>
        <Link href="/sign-up">
          <Button size="lg" variant="outline">
            Sign up
          </Button>
        </Link>
      </div>
    </div>
  );
}
