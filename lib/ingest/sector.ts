import type { Sector } from "../../db/profile-input";
import { logLine } from "../observability/log";

/**
 * Raw sector or industry text, as every existing Source states or derives it, mapped onto the
 * twelve-value `Sector` vocabulary `profileInputSchema` now closes over. A lookup table rather
 * than inference at runtime, per the Ticket that introduced it: growing the taxonomy is adding
 * a line with evidence behind it, not tuning a heuristic.
 *
 * Keyed lowercase; matching is exact after trimming and case-folding, deliberately not fuzzy —
 * a near-miss is exactly the kind of silent guess `other` exists to avoid.
 */
const SECTOR_BY_RAW_TEXT: ReadonlyMap<string, Sector> = new Map([
  // ai-ml
  ["artificial intelligence", "ai-ml"],
  ["machine learning", "ai-ml"],
  ["neurotechnology", "ai-ml"],

  // developer-tools
  ["developer tools", "developer-tools"],
  ["open source", "developer-tools"],
  ["no-code software", "developer-tools"],

  // data-infrastructure
  ["data infrastructure", "data-infrastructure"],
  ["fintech infrastructure", "data-infrastructure"],
  ["data & analytics", "data-infrastructure"],

  // saas-enterprise
  ["saas", "saas-enterprise"],
  ["enterprise software", "saas-enterprise"],
  ["productivity software", "saas-enterprise"],
  ["workflow automation", "saas-enterprise"],
  ["productivity", "saas-enterprise"],
  ["marketing", "saas-enterprise"],

  // fintech
  ["fintech", "fintech"],
  ["banking as a service", "fintech"],

  // health-bio
  ["health tech", "health-bio"],
  ["healthcare", "health-bio"],

  // security
  ["security & compliance", "security"],
  ["security", "security"],

  // hardware-robotics
  ["robotics", "hardware-robotics"],
  ["autonomous vehicles", "hardware-robotics"],
  ["aerospace", "hardware-robotics"],
  ["augmented reality", "hardware-robotics"],

  // climate-energy
  ["climate technology", "climate-energy"],
  ["climate", "climate-energy"],

  // consumer-marketplace
  ["marketplace", "consumer-marketplace"],
  ["gig economy", "consumer-marketplace"],
  ["community", "consumer-marketplace"],
  ["e-commerce", "consumer-marketplace"],
  ["retailing", "consumer-marketplace"],

  // vertical-saas
  ["hr technology", "vertical-saas"],
  ["legal technology", "vertical-saas"],
  ["legaltech", "vertical-saas"],
  ["education", "vertical-saas"],
  ["hr", "vertical-saas"],
  ["legal", "vertical-saas"],

  // other, stated explicitly rather than left to the fallback below
  ["nonprofit", "other"],
]);

/**
 * Maps one Source's raw sector or industry text onto the closed `Sector` vocabulary, falling
 * back to `other` for anything the lookup table does not yet cover.
 *
 * A raw value that lands on `other` is logged with the text itself, so the taxonomy can be
 * grown from evidence — real values ingest actually saw — rather than guesswork.
 */
export function sectorFromRawText(raw: string): Sector {
  const sector = SECTOR_BY_RAW_TEXT.get(raw.trim().toLowerCase()) ?? "other";

  if (sector === "other") {
    logLine({ level: "info", event: "sector_mapped_to_other", raw });
  }

  return sector;
}
