import type { Metadata } from "next";

import { ErrorBoundary } from "../../../lib/ui/error-boundary";
import { Diary } from "./diary";

export const metadata: Metadata = {
  title: "Diary · Rolodeck AI",
};

export default function DiaryPage() {
  return (
    <ErrorBoundary>
      <Diary />
    </ErrorBoundary>
  );
}
