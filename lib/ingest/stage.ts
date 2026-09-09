import { STAGE_VALUES, type Stage } from "../../db/profile-input";

/**
 * The two ways this project decides a Profile's `stage`, side by side because the difference
 * between them is the whole of the provenance argument.
 *
 * `stageFromRoundName` reads a round a filing named. That is a fact the Source stated, so a
 * Profile that gets its stage this way is attributed `scraped`.
 *
 * `stageFromTeamSize` infers a round from headcount, per docs/adr/0007. That is a proxy the
 * pipeline produced, so a Profile that gets its stage this way is attributed `enriched`, and a
 * well-funded eight-person team still reads as `seed`.
 *
 * Neither function attributes anything itself — provenance is the caller's to record, because
 * only the caller knows which of the two it used. See docs/adr/0009.
 */

/**
 * The conventional headcount bands, from docs/adr/0007: 500 and up is `growth`, 100 is
 * `series-b-plus`, 25 is `series-a`, 5 is `seed`, 1 is `pre-seed`.
 */
const STAGE_BY_MINIMUM_TEAM_SIZE = [
  [500, "growth"],
  [100, "series-b-plus"],
  [25, "series-a"],
  [5, "seed"],
  [1, "pre-seed"],
] as const satisfies ReadonlyArray<readonly [number, Stage]>;

/**
 * A stage from a headcount, or nothing at all. A source with no usable team size — zero
 * employees, or a page that stopped carrying the number — yields no stage, and the candidate
 * is rejected naming `stage` rather than filled in with a guess.
 */
export function stageFromTeamSize(
  teamSize: number | null | undefined,
): Stage | undefined {
  if (typeof teamSize !== "number" || !Number.isFinite(teamSize)) {
    return undefined;
  }

  return STAGE_BY_MINIMUM_TEAM_SIZE.find(
    ([minimum]) => teamSize >= minimum,
  )?.[1];
}

/**
 * The round names that appear in the free text an issuer writes on a Form D, ordered so that
 * `pre-seed` is tried before the bare `seed` inside it. Alternation is leftmost-first at a
 * given position, so "Pre-Seed" is consumed whole and never also counted as a plain seed.
 *
 * Letters stop at `j`: rounds do not run past there, and a looser class would read "Series of"
 * in a fund's own prose as a funding round.
 */
const ROUND_PATTERN =
  /\b(pre[-\s]?seed|series\s+seed|seed|series\s+a|series\s+[b-j])\b/gi;

function stageOfRound(match: string): Stage {
  const normalised = match.toLowerCase().replace(/[\s-]+/g, " ");

  if (normalised === "pre seed") return "pre-seed";
  if (normalised === "seed" || normalised === "series seed") return "seed";
  if (normalised === "series a") return "series-a";
  return "series-b-plus";
}

/**
 * The round a piece of a filing names, or nothing when it names none.
 *
 * Where more than one round is named, the most advanced wins. Issuers really do file one
 * Form D covering a "parallel Seed 3 + Series A Preferred Stock" offering, and a company
 * selling Series A preferred is at Series A whatever else is in the same round.
 *
 * A financing instrument is not a round: "Simple Agreement for Future Equity (SAFE)" says how
 * the money is taken, not what stage the company is at, and matches nothing here on purpose.
 */
export function stageFromRoundName(
  description: string | null | undefined,
): Stage | undefined {
  if (typeof description !== "string") {
    return undefined;
  }

  let best: Stage | undefined;

  for (const [match] of description.matchAll(ROUND_PATTERN)) {
    const stage = stageOfRound(match);

    if (
      best === undefined ||
      STAGE_VALUES.indexOf(stage) > STAGE_VALUES.indexOf(best)
    ) {
      best = stage;
    }
  }

  return best;
}
