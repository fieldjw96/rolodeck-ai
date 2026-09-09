import type { Metadata } from "next";

import { ErrorBoundary } from "../../../lib/ui/error-boundary";
import { Deck } from "./deck";

export const metadata: Metadata = {
  title: "Deck · Rolodeck AI",
};

export default function DeckPage() {
  return (
    <ErrorBoundary>
      <Deck />
    </ErrorBoundary>
  );
}
