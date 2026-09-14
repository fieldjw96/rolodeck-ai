import type { Metadata } from "next";

import { ErrorBoundary } from "../../../lib/ui/error-boundary";
import { News } from "./news";

export const metadata: Metadata = {
  title: "News · Rolodeck AI",
};

export default function NewsPage() {
  return (
    <ErrorBoundary>
      <News />
    </ErrorBoundary>
  );
}
