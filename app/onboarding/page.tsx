import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { needsOnboarding } from "../../lib/auth/onboarding";
import { HOME_PATH } from "../../lib/auth/paths";
import { requireUser } from "../../lib/auth/session";
import { ErrorBoundary } from "../../lib/ui/error-boundary";
import { Onboarding } from "./onboarding";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Before your Deck · Rolodeck AI",
};

/**
 * Sits outside the `(app)` route group, the same reason `/login` does: both sign-in paths send
 * a brand new User here before `HOME_PATH`, and a layout inside `(app)` has no way to tell "on
 * my way here" from "navigated here directly" without reading the request's own path. A User
 * who already has a User Profile — stated or skipped — is sent on to the Deck instead, so this
 * screen cannot be asked twice by typing its URL. See Ticket #191.
 */
export default async function OnboardingPage() {
  const user = await requireUser();

  if (!(await needsOnboarding(user.id))) {
    redirect(HOME_PATH);
  }

  return (
    <ErrorBoundary>
      <Onboarding />
    </ErrorBoundary>
  );
}
