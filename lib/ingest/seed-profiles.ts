import type { ProfileCandidate } from "../../db/ingest";
import type { ProfileInput } from "../../db/profile-input";
import type { ProfileProvenance } from "../../db/provenance";
import { sectorFromRawText } from "./sector";

/**
 * The Source slug this pipeline writes under — half of a Profile's natural key, per
 * docs/adr/0008. Distinct from `provenance: "jack"`, which every field below also carries:
 * `source` says which pipeline wrote the row, `provenance` says what kind of value each field
 * is, and CONTEXT.md draws that line for every Source, not just this one.
 */
export const SEED_SOURCE = "jack";

/** A hand-curated row, with `sector` still in Jack's own words rather than the controlled list. */
type RawSeedProfile = Omit<ProfileInput, "sector"> & {
  readonly sector: string;
};

/**
 * Real, named, Bay-Area-headquartered startups, hand-curated from public knowledge rather than
 * scraped — the fallback docs/adr/0002 describes for when the live scrapers alone do not reach
 * a useful Deck size. `db/seed.ts` backfills from this list only as far as `profiles` needs to
 * reach `MINIMUM_PROFILE_COUNT`, so order matters: earlier entries are the ones an empty table
 * gets first. Kept a few deep past the minimum so the guarantee holds even if some of it is
 * already spoken for by a `source` that isn't this one.
 *
 * `sector` is written here the way Jack would actually describe each company, and mapped onto
 * the controlled vocabulary below with the same `sectorFromRawText` every scraped Source uses —
 * seed data is hand-curated, not scraped, but it is still raw sector text until it crosses that
 * mapping.
 */
const RAW_SEED_PROFILES: readonly RawSeedProfile[] = [
  {
    name: "Anthropic",
    description:
      "AI safety company that builds the Claude family of large language models.",
    sector: "Artificial Intelligence",
    stage: "growth",
    website: "https://www.anthropic.com",
    location: "San Francisco, CA",
  },
  {
    name: "OpenAI",
    description:
      "AI research and deployment company behind the GPT model family and ChatGPT.",
    sector: "Artificial Intelligence",
    stage: "growth",
    website: "https://openai.com",
    location: "San Francisco, CA",
  },
  {
    name: "Databricks",
    description:
      "Unified platform for data engineering, analytics, and AI built around Apache Spark.",
    sector: "Data Infrastructure",
    stage: "growth",
    website: "https://www.databricks.com",
    location: "San Francisco, CA",
  },
  {
    name: "Stripe",
    description:
      "Payment processing and financial infrastructure APIs for internet businesses.",
    sector: "Fintech",
    stage: "growth",
    website: "https://stripe.com",
    location: "South San Francisco, CA",
  },
  {
    name: "Scale AI",
    description:
      "Data labeling and infrastructure platform for training AI models.",
    sector: "Artificial Intelligence",
    stage: "growth",
    website: "https://scale.com",
    location: "San Francisco, CA",
  },
  {
    name: "Notion Labs",
    description:
      "All-in-one workspace combining notes, docs, wikis, and project tracking.",
    sector: "Productivity Software",
    stage: "growth",
    website: "https://www.notion.so",
    location: "San Francisco, CA",
  },
  {
    name: "Rippling",
    description:
      "Unified platform for managing payroll, HR, IT, and finance from one system.",
    sector: "HR Technology",
    stage: "growth",
    website: "https://www.rippling.com",
    location: "San Francisco, CA",
  },
  {
    name: "Brex",
    description:
      "Corporate credit cards and spend management software for businesses.",
    sector: "Fintech",
    stage: "growth",
    website: "https://www.brex.com",
    location: "San Francisco, CA",
  },
  {
    name: "Plaid",
    description:
      "APIs that let applications connect securely to users' bank accounts.",
    sector: "Fintech Infrastructure",
    stage: "growth",
    website: "https://plaid.com",
    location: "San Francisco, CA",
  },
  {
    name: "Airtable",
    description:
      "No-code platform for building custom applications on a spreadsheet-like database.",
    sector: "No-Code Software",
    stage: "growth",
    website: "https://www.airtable.com",
    location: "San Francisco, CA",
  },
  {
    name: "Gusto",
    description:
      "Payroll, benefits, and HR platform built for small businesses.",
    sector: "HR Technology",
    stage: "growth",
    website: "https://gusto.com",
    location: "San Francisco, CA",
  },
  {
    name: "Deel",
    description:
      "Global payroll and compliance platform for hiring and paying distributed teams.",
    sector: "HR Technology",
    stage: "growth",
    website: "https://www.deel.com",
    location: "San Francisco, CA",
  },
  {
    name: "Vanta",
    description:
      "Automated security compliance monitoring for SOC 2, ISO 27001, and similar frameworks.",
    sector: "Security & Compliance",
    stage: "series-b-plus",
    website: "https://www.vanta.com",
    location: "San Francisco, CA",
  },
  {
    name: "Retool",
    description:
      "Low-code platform for building internal business tools quickly.",
    sector: "Developer Tools",
    stage: "series-b-plus",
    website: "https://retool.com",
    location: "San Francisco, CA",
  },
  {
    name: "Mercury",
    description: "Banking and financial services built for startups.",
    sector: "Fintech",
    stage: "series-b-plus",
    website: "https://mercury.com",
    location: "San Francisco, CA",
  },
  {
    name: "Ironclad",
    description:
      "Contract lifecycle management software for legal and business teams.",
    sector: "Legal Technology",
    stage: "series-b-plus",
    website: "https://ironcladapp.com",
    location: "San Francisco, CA",
  },
  {
    name: "Sourcegraph",
    description:
      "Code search and intelligence platform for large software codebases.",
    sector: "Developer Tools",
    stage: "series-b-plus",
    website: "https://sourcegraph.com",
    location: "San Francisco, CA",
  },
  {
    name: "Replit",
    description:
      "Browser-based platform for writing, running, and collaborating on code.",
    sector: "Developer Tools",
    stage: "series-b-plus",
    website: "https://replit.com",
    location: "San Francisco, CA",
  },
  {
    name: "Glean",
    description:
      "Enterprise search and AI assistant that indexes a company's internal knowledge.",
    sector: "Enterprise Software",
    stage: "series-b-plus",
    website: "https://www.glean.com",
    location: "Palo Alto, CA",
  },
  {
    name: "Together AI",
    description:
      "Cloud platform for training and running open-source AI models at scale.",
    sector: "Artificial Intelligence",
    stage: "series-b-plus",
    website: "https://www.together.ai",
    location: "San Francisco, CA",
  },
  {
    name: "Weights & Biases",
    description:
      "Experiment tracking and MLOps tooling for machine learning teams.",
    sector: "Developer Tools",
    stage: "series-b-plus",
    website: "https://wandb.ai",
    location: "San Francisco, CA",
  },
  {
    name: "Applied Intuition",
    description:
      "Simulation and software tools for developing and testing autonomous vehicles.",
    sector: "Autonomous Vehicles",
    stage: "series-b-plus",
    website: "https://www.appliedintuition.com",
    location: "Mountain View, CA",
  },
  {
    name: "Vercel",
    description:
      "Cloud platform for deploying and hosting frontend web applications.",
    sector: "Developer Tools",
    stage: "series-b-plus",
    website: "https://vercel.com",
    location: "San Francisco, CA",
  },
  {
    name: "Cresta",
    description:
      "AI coaching and real-time guidance software for contact center agents.",
    sector: "Artificial Intelligence",
    stage: "series-b-plus",
    website: "https://cresta.com",
    location: "Palo Alto, CA",
  },
  {
    name: "Anyscale",
    description:
      "Distributed computing platform built around the open-source Ray framework.",
    sector: "Developer Tools",
    stage: "series-b-plus",
    website: "https://www.anyscale.com",
    location: "San Francisco, CA",
  },
  {
    name: "Skydio",
    description:
      "Autonomous drone hardware and software for inspection and defense.",
    sector: "Robotics",
    stage: "series-b-plus",
    website: "https://www.skydio.com",
    location: "San Mateo, CA",
  },
  {
    name: "Nuro",
    description: "Autonomous vehicles purpose-built for local goods delivery.",
    sector: "Robotics",
    stage: "series-b-plus",
    website: "https://www.nuro.ai",
    location: "Mountain View, CA",
  },
  {
    name: "Astranis",
    description:
      "Builds small geostationary satellites for dedicated regional broadband coverage.",
    sector: "Aerospace",
    stage: "series-b-plus",
    website: "https://www.astranis.com",
    location: "San Francisco, CA",
  },
  {
    name: "Watershed",
    description:
      "Carbon accounting and climate management software for enterprises.",
    sector: "Climate Technology",
    stage: "series-b-plus",
    website: "https://watershed.com",
    location: "San Francisco, CA",
  },
  {
    name: "Ashby",
    description: "Recruiting and applicant tracking software for talent teams.",
    sector: "HR Technology",
    stage: "series-a",
    website: "https://www.ashbyhq.com",
    location: "San Francisco, CA",
  },
  {
    name: "Modal Labs",
    description:
      "Serverless cloud compute platform for running AI and data workloads.",
    sector: "Developer Tools",
    stage: "series-a",
    website: "https://modal.com",
    location: "San Francisco, CA",
  },
  {
    name: "LlamaIndex",
    description:
      "Data framework for connecting large language models to external data sources.",
    sector: "Artificial Intelligence",
    stage: "seed",
    website: "https://www.llamaindex.ai",
    location: "San Francisco, CA",
  },
];

/** `RAW_SEED_PROFILES`, with `sector` mapped onto the controlled vocabulary. */
export const SEED_PROFILES: readonly ProfileInput[] = RAW_SEED_PROFILES.map(
  (profile) => ({
    ...profile,
    sector: sectorFromRawText(profile.sector),
  }),
);

/**
 * Every field on a hand-written seed row is Jack's own manual curation rather than scraped or
 * agent-enriched, so every field — the website and location included, when there is one — is
 * attributed `jack`. Per the `profiles_provenance_covers_every_field` check constraint, each
 * one's provenance is null exactly when there is no value to attribute.
 */
function jackProvenance(input: ProfileInput): ProfileProvenance {
  return {
    name: "jack",
    description: "jack",
    sector: "jack",
    stage: "jack",
    website: input.website === undefined ? null : "jack",
    location: input.location === undefined ? null : "jack",
    founders: input.founders === undefined ? null : "jack",
    links: input.links === undefined ? null : "jack",
  };
}

/** `SEED_PROFILES`, ready for `persistProfiles`: every field attributed `provenance: jack`. */
export const SEED_CANDIDATES: readonly ProfileCandidate[] = SEED_PROFILES.map(
  (input) => ({ input, provenance: jackProvenance(input) }),
);
