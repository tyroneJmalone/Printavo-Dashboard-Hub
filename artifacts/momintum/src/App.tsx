import { useEffect, useRef } from "react";
import { Switch, Route, Redirect, useLocation, useSearch, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { ClerkProvider, Show, useClerk } from "@clerk/react";
import { publishableKeyFromHost } from "@clerk/react/internal";
import { shadcn } from "@clerk/themes";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";
import { AppLayout } from "@/components/layout/app-layout";
import { CurrentUserProvider } from "@/lib/current-user";
import { TaskDetailProvider } from "@/components/tasks/task-detail";
import { Today } from "@/pages/today";
import { Upcoming } from "@/pages/upcoming";
import { Inbox } from "@/pages/inbox";
import { Lists } from "@/pages/lists";
import { ListDetail } from "@/pages/list-detail";
import { Completed } from "@/pages/completed";
import { Team } from "@/pages/team";
import { Week } from "@/pages/week";
import { CalendarView } from "@/pages/calendar";
import { AllTasks } from "@/pages/all-tasks";
import { AssignedToMe } from "@/pages/assigned-to-me";
import { Landing } from "@/pages/landing";
import { SignInPage } from "@/pages/sign-in";
import { SignUpPage } from "@/pages/sign-up";
import { SearchPage } from "@/pages/search";
import { FeedbackAdmin } from "@/pages/feedback-admin";
import { StaffGate } from "@/components/auth/StaffGate";

const queryClient = new QueryClient({
  defaultOptions: { queries: { refetchInterval: 30_000 } },
});

function SearchRoute() {
  const search = useSearch();
  const params = new URLSearchParams(search);
  return <SearchPage query={params.get("q") ?? ""} />;
}

// REQUIRED — copy verbatim. Resolves the key from window.location.hostname so the
// same build serves multiple Clerk custom domains.
const clerkPubKey = publishableKeyFromHost(
  window.location.hostname,
  import.meta.env.VITE_CLERK_PUBLISHABLE_KEY,
);

// REQUIRED — copy verbatim. Empty in dev, auto-set in prod.
const clerkProxyUrl = import.meta.env.VITE_CLERK_PROXY_URL;

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function stripBase(path: string): string {
  return basePath && path.startsWith(basePath)
    ? path.slice(basePath.length) || "/"
    : path;
}

if (!clerkPubKey) {
  throw new Error("Missing VITE_CLERK_PUBLISHABLE_KEY in .env file");
}

const clerkAppearance = {
  theme: shadcn,
  cssLayerName: "clerk",
  options: {
    logoPlacement: "inside" as const,
    logoLinkUrl: basePath || "/",
    logoImageUrl: `${window.location.origin}${basePath}/logo.png`,
  },
  variables: {
    colorPrimary: "hsl(96 49% 45%)",
    colorForeground: "hsl(140 15% 10%)",
    colorMutedForeground: "hsl(140 10% 42%)",
    colorDanger: "hsl(11 81% 55%)",
    colorBackground: "hsl(0 0% 100%)",
    colorInput: "hsl(96 20% 90%)",
    colorInputForeground: "hsl(140 15% 10%)",
    colorNeutral: "hsl(96 20% 90%)",
    fontFamily: "Manrope, sans-serif",
    borderRadius: "0.75rem",
  },
  elements: {
    rootBox: "w-full flex justify-center",
    cardBox: "bg-white rounded-2xl w-[440px] max-w-full overflow-hidden shadow-lg border border-border",
    card: "!shadow-none !border-0 !bg-transparent !rounded-none",
    footer: "!shadow-none !border-0 !bg-transparent !rounded-none",
    headerTitle: "text-foreground font-bold",
    headerSubtitle: "text-muted-foreground",
    socialButtonsBlockButtonText: "text-foreground",
    formFieldLabel: "text-foreground",
    footerActionLink: "text-[#9e4a95] hover:text-[#ec6b4d]",
    footerActionText: "text-muted-foreground",
    dividerText: "text-muted-foreground",
    identityPreviewEditButton: "text-[#9e4a95]",
    formFieldSuccessText: "text-primary",
    alertText: "text-destructive",
    logoBox: "flex justify-center py-2",
    logoImage: "h-12 w-auto object-contain",
    socialButtonsBlockButton: "border-border",
    formButtonPrimary: "bg-primary hover:bg-primary/90 text-primary-foreground",
    formFieldInput: "border-border",
    footerAction: "pb-4",
    dividerLine: "bg-border",
    alert: "bg-destructive/10",
    otpCodeFieldInput: "border-border",
    formFieldRow: "",
    main: "px-6",
  },
};

function HomeRedirect() {
  return (
    <>
      <Show when="signed-in">
        <Redirect to="/today" />
      </Show>
      <Show when="signed-out">
        <Landing />
      </Show>
    </>
  );
}

function AuthenticatedApp() {
  return (
    <StaffGate>
    <CurrentUserProvider>
      <TaskDetailProvider>
        <AppLayout>
          <Switch>
            <Route path="/today" component={Today} />
            <Route path="/upcoming" component={Upcoming} />
            <Route path="/week" component={Week} />
            <Route path="/calendar" component={CalendarView} />
            <Route path="/inbox" component={Inbox} />
            <Route path="/search">
              <SearchRoute />
            </Route>
            <Route path="/lists" component={Lists} />
            <Route path="/lists/:id" component={ListDetail} />
            <Route path="/all-tasks" component={AllTasks} />
            <Route path="/assigned-to-me" component={AssignedToMe} />
            <Route path="/completed" component={Completed} />
            <Route path="/team" component={Team} />
            <Route path="/feedback" component={FeedbackAdmin} />
              <Route component={NotFound} />
          </Switch>
        </AppLayout>
      </TaskDetailProvider>
    </CurrentUserProvider>
    </StaffGate>
  );
}

function ProtectedRoute({ component: Component }: { component: () => React.ReactElement }) {
  return (
    <>
      <Show when="signed-in">
        <Component />
      </Show>
      <Show when="signed-out">
        <Redirect to="/" />
      </Show>
    </>
  );
}

function ClerkQueryClientCacheInvalidator() {
  const { addListener } = useClerk();
  const qc = useQueryClient();
  const prevUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const unsubscribe = addListener(({ user }) => {
      const userId = user?.id ?? null;
      if (
        prevUserIdRef.current !== undefined &&
        prevUserIdRef.current !== userId
      ) {
        qc.clear();
      }
      prevUserIdRef.current = userId;
    });
    return unsubscribe;
  }, [addListener, qc]);

  return null;
}

function ClerkProviderWithRoutes() {
  const [, setLocation] = useLocation();

  return (
    <ClerkProvider
      publishableKey={clerkPubKey}
      proxyUrl={clerkProxyUrl}
      appearance={clerkAppearance}
      signInUrl={`${basePath}/sign-in`}
      signUpUrl={`${basePath}/sign-up`}
      localization={{
        signIn: {
          start: {
            title: "Welcome back",
            subtitle: "Sign in to moMINTum",
          },
        },
        signUp: {
          start: {
            title: "Join the team",
            subtitle: "Create your moMINTum account",
          },
        },
      }}
      routerPush={(to) => setLocation(stripBase(to))}
      routerReplace={(to) => setLocation(stripBase(to), { replace: true })}
    >
      <QueryClientProvider client={queryClient}>
        <ClerkQueryClientCacheInvalidator />
        <Switch>
          <Route path="/" component={HomeRedirect} />
          <Route path="/sign-in/*?" component={SignInPage} />
          <Route path="/sign-up/*?" component={SignUpPage} />
          <Route>
            <ProtectedRoute component={AuthenticatedApp} />
          </Route>
        </Switch>
      </QueryClientProvider>
    </ClerkProvider>
  );
}

function App() {
  return (
    <TooltipProvider>
      <WouterRouter base={basePath}>
        <ClerkProviderWithRoutes />
      </WouterRouter>
      <Toaster />
    </TooltipProvider>
  );
}

export default App;
