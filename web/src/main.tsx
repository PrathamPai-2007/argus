import { Component, lazy, StrictMode, Suspense, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { Shell } from "@/components/Shell.tsx";
import { ErrorNote, TipProvider } from "@/components/ui.tsx";
import { connectLive } from "@/lib/live.ts";
import { usePath } from "@/lib/router.tsx";
import { ActivityPage } from "@/pages/Activity.tsx";
import { Opportunities } from "@/pages/Opportunities.tsx";
import { System } from "@/pages/System.tsx";
import { Wallets } from "@/pages/Wallets.tsx";

// The two heaviest views (xyflow + candles, recharts) load on demand.
const Token = lazy(() => import("@/pages/Token.tsx").then((m) => ({ default: m.Token })));
const TrackRecord = lazy(() => import("@/pages/TrackRecord.tsx").then((m) => ({ default: m.TrackRecord })));

class Boundary extends Component<{ children: ReactNode; resetKey: string }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidUpdate(prev: { resetKey: string }) {
    if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null });
  }
  render() {
    return this.state.error ? <ErrorNote message={`This view failed to render: ${this.state.error.message}`} onRetry={() => this.setState({ error: null })} /> : this.props.children;
  }
}

function Routes() {
  const path = usePath();
  const token = /^\/token\/(\d+)\/(0x[0-9a-fA-F]{40})$/.exec(path);
  let page: ReactNode;
  if (token) page = <Token key={path} chainId={Number(token[1])} address={token[2]!.toLowerCase()} />;
  else if (path.startsWith("/track-record")) page = <TrackRecord />;
  else if (path.startsWith("/activity")) page = <ActivityPage />;
  else if (path.startsWith("/wallets")) page = <Wallets />;
  else if (path.startsWith("/system")) page = <System />;
  else page = <Opportunities />;
  return (
    <Shell>
      <Boundary resetKey={path}>
        <Suspense fallback={null}>{page}</Suspense>
      </Boundary>
    </Shell>
  );
}

connectLive();
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <TipProvider>
      <Routes />
    </TipProvider>
  </StrictMode>,
);
