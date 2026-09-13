import type { Metadata } from "next";

import { ErrorBoundary } from "../../../lib/ui/error-boundary";
import { Settings } from "./settings";

export const metadata: Metadata = {
  title: "Settings · Rolodeck AI",
};

export default function SettingsPage() {
  return (
    <ErrorBoundary>
      <Settings />
    </ErrorBoundary>
  );
}
