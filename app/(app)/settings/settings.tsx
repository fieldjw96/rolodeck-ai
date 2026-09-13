"use client";

import { useEffect, useState, type FormEvent } from "react";

import { SECTOR_VALUES, STAGE_VALUES } from "../../../db/profile-input";
import { StateNotice } from "../../../lib/ui/state-notice";
import styles from "./settings.module.css";

type UserProfileBody = {
  sectors: string[];
  stages: string[];
  area: string;
  excluded_sectors: string[];
};

type FormValues = {
  sectors: Set<string>;
  stages: Set<string>;
  area: string;
  excludedSectors: Set<string>;
};

type SaveState =
  | { status: "idle" }
  | { status: "saving" }
  | { status: "saved" }
  | { status: "rejected"; message: string };

type SettingsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; values: FormValues; save: SaveState };

/** Shown while the first `GET /api/user-profile` is in flight. */
export const LOADING_SETTINGS_MESSAGE = "Loading your preferences…";

/** Shown when the initial `GET /api/user-profile` fails. */
export const LOAD_ERROR_MESSAGE = "Couldn't load your preferences.";

/** Shown once `PUT /api/user-profile` succeeds. */
export const SAVED_MESSAGE = "Saved.";

const LOADING_SETTINGS_DETAIL = "Reading back what you last told the Deck.";
const LOAD_ERROR_DETAIL = "Check your connection, then reload the page.";

function toBody(values: FormValues): UserProfileBody {
  return {
    sectors: [...values.sectors],
    stages: [...values.stages],
    area: values.area,
    excluded_sectors: [...values.excludedSectors],
  };
}

function toValues(body: UserProfileBody): FormValues {
  return {
    sectors: new Set(body.sectors),
    stages: new Set(body.stages),
    area: body.area,
    excludedSectors: new Set(body.excluded_sectors),
  };
}

async function fetchUserProfile(): Promise<UserProfileBody> {
  const response = await fetch("/api/user-profile");

  if (!response.ok) {
    throw new Error(`GET /api/user-profile failed with ${response.status}`);
  }

  return (await response.json()) as UserProfileBody;
}

type SaveResult =
  { ok: true; body: UserProfileBody } | { ok: false; message: string };

async function saveUserProfile(values: FormValues): Promise<SaveResult> {
  const response = await fetch("/api/user-profile", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(toBody(values)),
  });

  if (response.status === 422) {
    const rejection = (await response.json()) as {
      field: string;
      reason: string;
    };
    return { ok: false, message: `${rejection.field}: ${rejection.reason}` };
  }

  if (!response.ok) {
    throw new Error(`PUT /api/user-profile failed with ${response.status}`);
  }

  return { ok: true, body: (await response.json()) as UserProfileBody };
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
 * Lets the owner set the four things the ranking Ticket will read: `sectors`, `stages`,
 * `area` and `excluded_sectors`. Sectors and stages are chosen from the controlled lists —
 * `SECTOR_VALUES` and `STAGE_VALUES`, the same ones a Company Profile is ranked against —
 * rather than typed freely, per the Ticket.
 *
 * A Sector checked as stated is unchecked as excluded, and the reverse, so the one rule the
 * server enforces (`db/user-profile-input.ts`) cannot even be expressed in the form.
 */
export function Settings() {
  const [state, setState] = useState<SettingsState>({ status: "loading" });

  useEffect(() => {
    fetchUserProfile()
      .then((body) =>
        setState({
          status: "ready",
          values: toValues(body),
          save: { status: "idle" },
        }),
      )
      .catch((error: unknown) => {
        console.error(error);
        setState({ status: "error", message: LOAD_ERROR_MESSAGE });
      });
  }, []);

  if (state.status === "loading") {
    return (
      <main className={styles.settings}>
        <StateNotice
          busy
          title={LOADING_SETTINGS_MESSAGE}
          body={LOADING_SETTINGS_DETAIL}
        />
      </main>
    );
  }

  if (state.status === "error") {
    return (
      <main className={styles.settings}>
        <StateNotice
          tone="danger"
          live="alert"
          title={state.message}
          body={LOAD_ERROR_DETAIL}
        />
      </main>
    );
  }

  const { values } = state;

  function setValues(next: FormValues) {
    setState({ status: "ready", values: next, save: { status: "idle" } });
  }

  function toggleSector(sector: string) {
    setValues({
      ...values,
      sectors: toggled(values.sectors, sector),
      excludedSectors: (() => {
        const next = new Set(values.excludedSectors);
        next.delete(sector);
        return next;
      })(),
    });
  }

  function toggleExcludedSector(sector: string) {
    setValues({
      ...values,
      excludedSectors: toggled(values.excludedSectors, sector),
      sectors: (() => {
        const next = new Set(values.sectors);
        next.delete(sector);
        return next;
      })(),
    });
  }

  function toggleStage(stage: string) {
    setValues({ ...values, stages: toggled(values.stages, stage) });
  }

  function setArea(area: string) {
    setValues({ ...values, area });
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    setState({ status: "ready", values, save: { status: "saving" } });

    saveUserProfile(values)
      .then((result) => {
        if (result.ok) {
          setState({
            status: "ready",
            values: toValues(result.body),
            save: { status: "saved" },
          });
        } else {
          setState({
            status: "ready",
            values,
            save: { status: "rejected", message: result.message },
          });
        }
      })
      .catch((error: unknown) => {
        console.error(error);
        setState({
          status: "ready",
          values,
          save: {
            status: "rejected",
            message: "Couldn't save your preferences.",
          },
        });
      });
  }

  return (
    <main className={styles.settings}>
      <h1 className={styles.title}>Settings</h1>
      <form className={styles.form} onSubmit={handleSubmit}>
        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Sectors</legend>
          <div className={styles.checkboxGrid}>
            {SECTOR_VALUES.map((sector) => (
              <label key={sector} className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={values.sectors.has(sector)}
                  onChange={() => toggleSector(sector)}
                />
                {sector}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Excluded sectors</legend>
          <div className={styles.checkboxGrid}>
            {SECTOR_VALUES.map((sector) => (
              <label key={sector} className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={values.excludedSectors.has(sector)}
                  onChange={() => toggleExcludedSector(sector)}
                />
                {sector}
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>Stages</legend>
          <div className={styles.checkboxGrid}>
            {STAGE_VALUES.map((stage) => (
              <label key={stage} className={styles.checkboxLabel}>
                <input
                  type="checkbox"
                  checked={values.stages.has(stage)}
                  onChange={() => toggleStage(stage)}
                />
                {stage}
              </label>
            ))}
          </div>
        </fieldset>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="area">
            Area
          </label>
          <input
            className={styles.input}
            id="area"
            name="area"
            type="text"
            value={values.area}
            onChange={(event) => setArea(event.target.value)}
            required
          />
        </div>

        {state.save.status === "rejected" ? (
          <p className={styles.error} role="alert">
            {state.save.message}
          </p>
        ) : null}

        {state.save.status === "saved" ? (
          <p className={styles.saved} role="status">
            {SAVED_MESSAGE}
          </p>
        ) : null}

        <button
          className={styles.submit}
          type="submit"
          disabled={state.save.status === "saving"}
        >
          {state.save.status === "saving" ? "Saving…" : "Save"}
        </button>
      </form>
    </main>
  );
}
