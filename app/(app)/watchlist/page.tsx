import type { Metadata } from "next";

import { ErrorBoundary } from "../../../lib/ui/error-boundary";
import { Watchlist } from "./watchlist";

export const metadata: Metadata = {
  title: "Watchlist · Rolodeck AI",
};

export default function WatchlistPage() {
  return (
    <ErrorBoundary>
      <Watchlist />
    </ErrorBoundary>
  );
}
