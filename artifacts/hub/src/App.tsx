import { Switch, Route, Router as WouterRouter } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import NotFound from "@/pages/not-found";

import Dashboard from "./pages/Dashboard";
import Orders from "./pages/Orders";
import Payments from "./pages/Payments";
import VendorOrders from "./pages/VendorOrders";
import PoLog from "./pages/PoLog";
import StatusRules from "./pages/StatusRules";
import PrintQueue from "./pages/PrintQueue";
import PrintQueueRules from "./pages/PrintQueueRules";
import PriceCalculator from "./pages/PriceCalculator";
import Settings from "./pages/Settings";

const queryClient = new QueryClient();

function Router() {
  return (
    <Switch>
      <Route path="/" component={Dashboard} />
      <Route path="/orders" component={Orders} />
      <Route path="/payments" component={Payments} />
      <Route path="/vendor-orders" component={VendorOrders} />
      <Route path="/po-log" component={PoLog} />
      <Route path="/status-rules" component={StatusRules} />
      <Route path="/print-queue" component={PrintQueue} />
      <Route path="/print-queue-rules" component={PrintQueueRules} />
      <Route path="/price-calculator" component={PriceCalculator} />
      <Route path="/settings" component={Settings} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
