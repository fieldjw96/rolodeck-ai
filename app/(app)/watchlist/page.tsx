import type { Metadata } from "next";

import { Watchlist } from "./watchlist";

export const metadata: Metadata = {
  title: "Watchlist · Rolodeck AI",
};

export default function WatchlistPage() {
  return <Watchlist />;
}
