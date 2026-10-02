"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";

import { SECTOR_VALUES, STATED_STAGE_VALUES } from "../../db/profile-input";
import { HOME_PATH } from "../../lib/auth/paths";
import styles from "./onboarding.module.css";

type UserProfileBody = {
  sectors: string[];
  stages: string[];
  area: string | null;
  excluded_sectors: string[];
};

type SaveState =
  { status: "idle" } | { status: "saving" } | { status: "rejected" };

/** Shown when saving or skipping fails, so a User is not left staring at a form that quietly
 * did nothing. */
export const SAVE_ERROR_MESSAGE =
  "Couldn't save your preferences. Check your connection and try again.";

/**
 * `area` is out of scope for this screen (see the Ticket's own notes) and this screen never
 * offers an exclusion, so both are written as the User having stated nothing: null, and the
 * empty list.
 *
 * It mattered which "nothing" that is. This first wrote "Bay Area", on the reasoning that it is
 * what a never-saved User Profile reads back — which was true of `EMPTY_USER_PROFILE` and not
 * of what the Deck ranks by, because `db/deck.ts` kept a separate constant that blanked the area
 * out. So every User who passed through this screen, including by skipping it, silently switched
 * on area ranking at weight 1 and got a reordered Deck, which docs/adr/0011 and this Ticket both
 * forbid. `user_profiles.area` is nullable now precisely so this line can be honest.
 */
const AREA = null;

async function putUserProfile(body: UserProfileBody): Promise<boolean> {
  const response = await fetch("/api/user-profile", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

  return response.ok;
}

/** Toggles `value` in `set`, returning a new Set so React sees a change. */
function toggled(set: Set<string>, value: string): Set<string> {
  const next = new Set(set);

  if (next.has(value)) {
    next.delete(value);
  } else {
    next.add(value);
  }

  return next;
}

/**
 * Asks a brand new User for Sectors and Stages, once, before their first Deck.
 *
 * Both groups default to everything selected rather than nothing: a User who has not thought
 * about it yet should start from "surprise me with anything" — which is what an unsaved User
 * Profile already ranks like — rather than from a form that reads like a restriction before
 * they have touched it. Skip takes the same claim all the way and saves an empty User Profile
 * instead, which ranks the Deck exactly as if this screen had never run.
 *
 * Per docs/adr/0011, picking Sectors and Stages here *reorders* the Deck; it does not hide
 * anything. Excluding a Sector is a different, stronger claim — "never show me this" — and
 * stays in Settings, where it can wait until a User has actually seen enough to mean it. Saying
 * both of those plainly, in words rather than only in a checkbox's position, is what the
 * Ticket's Acceptance Criteria ask this screen to get right.
 */
export function Onboarding() {
  const router = useRouter();
  const [sectors, setSectors] = useState<Set<string>>(
    () => new Set(SECTOR_VALUES),
  );
  const [stages, setStages] = useState<Set<string>>(
    () => new Set(STATED_STAGE_VALUES),
  );
  const [save, setSave] = useState<SaveState>({ status: "idle" });

  async function submit(body: UserProfileBody) {
    setSave({ status: "saving" });

    const ok = await putUserProfile(body).catch(() => false);

    if (ok) {
      router.push(HOME_PATH);
      return;
    }

    setSave({ status: "rejected" });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    void submit({
      sectors: [...sectors],
      stages: [...stages],
      area: AREA,
      excluded_sectors: [],
    });
  }

  function handleSkip() {
    // One click, regardless of whatever is checked: skipping is a separate claim from
    // unchecking everything by hand, and it leaves no room to get that claim half right.
    void submit({ sectors: [], stages: [], area: AREA, excluded_sectors: [] });
  }

  const saving = save.status === "saving";

  return (
    <main className={styles.onboarding}>
      <h1 className={styles.title}>Before your Deck</h1>
      <p className={styles.intro}>
        Pick the Sectors and Stages you want to see more of. Both groups below
        reorder your Deck — whatever you pick comes up sooner, but nothing is
        ever hidden because of it. Excluding a Sector is a different setting: it
        lives in Settings, and it does remove it from your Deck for good. This
        screen never does that.
      </p>

      <form className={styles.form} onSubmit={handleSubmit}>
        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>
            Sectors — reorders your Deck
          </legend>
          <div className={styles.checkboxGrid}>
            {SECTOR_VALUES.map((sector) => (
              <label key={sector} className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={sectors.has(sector)}
                  onChange={() => setSectors(toggled(sectors, sector))}
                />
                {sector}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Stages — reorders your Deck</legend>
          <div className={styles.checkboxGrid}>
            {STATED_STAGE_VALUES.map((stage) => (
              <label key={stage} className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={stages.has(stage)}
                  onChange={() => setStages(toggled(stages, stage))}
                />
                {stage}
              </label>
            ))}
          </div>
        </fieldset>

        {save.status === "rejected" ? (
          <p className={styles.error} role="alert">
            {SAVE_ERROR_MESSAGE}
          </p>
        ) : null}

        <div className={styles.actions}>
          <button className={styles.submit} type="submit" disabled={saving}>
            {saving ? "Saving…" : "Save and see my Deck"}
          </button>
          <button
            className={styles.skip}
            type="button"
            disabled={saving}
            onClick={handleSkip}
          >
            Skip for now
          </button>
        </div>
      </form>
    </main>
  );
}
