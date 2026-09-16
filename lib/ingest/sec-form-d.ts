import { z } from "zod";

import {
  NOT_STATED_STAGE,
  parseProfileInput,
  type IngestRejection,
  type Stage,
} from "../../db/profile-input";
import type { Provenance } from "../../db/provenance";
import { issueField } from "../zod/issues";
import {
  attribute,
  type Capture,
  type ScrapedProfile,
} from "./scraped-profile";
import { sectorFromRawText } from "./sector";
import { stageFromRoundName, stageFromTeamSize } from "./stage";
import { parseXml, type XmlDocument } from "./xml";

/**
 * The SEC Form D Source: Californian companies that are raising, taken from the filing they
 * are legally required to make rather than from anyone's write-up of it.
 *
 * When a company sells securities in a private placement it files a Form D, and EDGAR
 * publishes it free, structured, with no key. Nothing else public states "this company is
 * raising right now" as a fact; an accelerator's portfolio page, by definition, lists only
 * companies that already have.
 *
 * Parsing only, as in `yc-company-page.ts`: nothing here fetches and nothing here writes, so
 * the whole of this module is tested offline against the captures in `db/fixtures/`. Getting
 * the filings in the first place is `edgar.ts`, the one module under `lib/ingest` that talks to
 * the network; writing what comes out of here is `persistProfiles` in `db/ingest.ts`.
 *
 * Per CLAUDE.md a filing is hostile input: every field crosses a Zod schema, and one that
 * cannot be read is counted with its field named rather than half-written.
 */

/** The Source slug this pipeline writes under. Half of a Profile's natural key — adr/0008. */
export const SEC_FORM_D_SOURCE = "sec-form-d";

/** EDGAR's own code for a Californian business address, which is the filter this Source is. */
export const CALIFORNIA = "CA";

/**
 * The shape a Form D has to have for a Profile to be readable from it.
 *
 * Structure is required and leaves are not, deliberately. A filing that stops carrying an
 * `offeringData` at all has changed shape and fails here naming the path; a filing that merely
 * omits a value falls through to `profileInputSchema`, which rejects it naming the Profile
 * field — `sector`, not `offeringData.industryGroup.industryGroupType`. `looseObject`
 * throughout because a Form D carries dozens of elements this Source has no use for, and a new
 * one is not a reason to stop ingesting.
 */
const issuerAddressSchema = z.looseObject({
  city: z.string().optional(),
  // Required: this is the California filter, and an address we cannot read is a shape change,
  // not a company somewhere else.
  stateOrCountry: z.string(),
});

const formDSchema = z.looseObject({
  primaryIssuer: z.looseObject({
    entityName: z.string().optional(),
    issuerAddress: issuerAddressSchema,
  }),
  offeringData: z.looseObject({
    industryGroup: z
      .looseObject({ industryGroupType: z.string().optional() })
      .optional(),
    typeOfFiling: z
      .looseObject({
        dateOfFirstSale: z
          .looseObject({ value: z.string().optional() })
          .optional(),
      })
      .optional(),
    typesOfSecuritiesOffered: z
      .looseObject({ descriptionOfOtherType: z.string().optional() })
      .optional(),
    offeringSalesAmounts: z
      .looseObject({
        totalOfferingAmount: z.string().optional(),
        totalAmountSold: z.string().optional(),
      })
      .optional(),
  }),
});

type FormD = z.infer<typeof formDSchema>;

/**
 * The Form D industry groups whose issuer holds assets rather than building a product: a
 * pooled investment fund, an investing vehicle, a piece of real estate. Such an issuer is not a
 * company at a funding stage, and a Deck of startups has nothing to say about it. Judge a group
 * not listed here against that rule rather than by resemblance to what is.
 *
 * Form D files every real-estate answer under one heading, and each is a property or the vehicle
 * that holds one, so all five are here — `Construction` included, which on a Form D is a
 * development being financed, not a builder raising to grow.
 *
 * Matched exactly, after trimming and case-folding, against the filing's `industryGroupType`.
 * Of a sample of 25 Californian filings in the week to 2026-09-15, 19 fell under this list; see
 * docs/adr/0015.
 */
export const ASSET_HOLDING_INDUSTRY_GROUPS = [
  "Pooled Investment Fund",
  "Investing",
  "Commercial",
  "Construction",
  "REITS & Finance",
  "Residential",
  "Other Real Estate",
] as const;

const ASSET_HOLDING = new Set(
  ASSET_HOLDING_INDUSTRY_GROUPS.map((group) => group.toLowerCase()),
);

/**
 * One captured filing. `teamSize` is the one thing a Form D does not carry and docs/adr/0007
 * needs: it is here so that a pipeline which learns a company's headcount elsewhere can still
 * get a stage out of a filing that names no round. Nothing in the live fetch supplies it
 * today, and a filing with neither a named round nor a headcount becomes a Profile whose stage
 * is `not-stated`. See docs/adr/0009 and docs/adr/0015.
 */
export type FormDFiling = {
  readonly xml: string;
  readonly capture: Capture;
  readonly teamSize?: number;
};

/**
 * Three outcomes, not two. An issuer in another state is *filtered* — there is nothing wrong
 * with the filing, it is simply not what this Deck is for — while a filing that cannot be read
 * is *rejected* with the offending field named. Counting them together would hide a parser
 * that had gone stale behind a filter that was working.
 */
export type FormDFilingResult =
  | { readonly outcome: "profile"; readonly profile: ScrapedProfile }
  | { readonly outcome: "filtered"; readonly stateOrCountry: string }
  | { readonly outcome: "rejected"; readonly rejection: IngestRejection };

const rejected = (
  field: string,
  reason: string,
  raw: unknown,
): FormDFilingResult => ({
  outcome: "rejected",
  rejection: { field, reason, raw },
});

/** A trimmed value, or undefined when the filing held nothing worth carrying. */
function trimmed(value: string | null | undefined): string | undefined {
  const text = value?.trim();
  return text === undefined || text.length === 0 ? undefined : text;
}

/**
 * Thousands separators without `Intl`, whose grouping depends on a locale the ingest host
 * happens to have. A Form D states whole dollars, and non-numeric answers — "Indefinite" is a
 * real one — are passed through as the issuer wrote them.
 */
function formatAmount(amount: string | undefined): string | undefined {
  const value = trimmed(amount);

  if (value === undefined) {
    return undefined;
  }

  return /^\d+$/.test(value)
    ? `$${value.replace(/\B(?=(\d{3})+$)/g, ",")}`
    : value;
}

/** EDGAR holds addresses in capitals; a Deck card should not shout. */
function titleCase(value: string): string {
  return value.replace(
    /[^\s-]+/g,
    (word) => `${word[0]!}${word.slice(1).toLowerCase()}`,
  );
}

/**
 * The issuer's own address, human-readable: "San Francisco, CA" where the filing states a
 * city, "CA" alone where it does not. Shared by `describeOffering`, which folds it into a
 * sentence, and by the `location` Profile field, which carries the same fact on its own —
 * this is the parsing docs/adr/0002 already required, now reaching the schema. See CLAUDE.md.
 */
function filingLocation(
  address: FormD["primaryIssuer"]["issuerAddress"],
): string {
  const city = trimmed(address.city);

  return city === undefined
    ? address.stateOrCountry
    : `${titleCase(city)}, ${address.stateOrCountry}`;
}

/**
 * A Form D states facts and writes no prose, so a Profile's `description` is composed from the
 * facts it does state: the industry, where the issuer is, how much it is raising, how much it
 * has sold and when the first sale was. Every ingredient is read off the filing, but the
 * sentence is ours, so the field is attributed `enriched` — the filing never said this.
 */
function describeOffering(filing: FormD, sector: string): string {
  const address = filing.primaryIssuer.issuerAddress;
  const amounts = filing.offeringData.offeringSalesAmounts;
  const where = filingLocation(address);

  const offering = formatAmount(amounts?.totalOfferingAmount);
  const sold = formatAmount(amounts?.totalAmountSold);
  const firstSale = trimmed(
    filing.offeringData.typeOfFiling?.dateOfFirstSale?.value,
  );

  const sentences = [`${sector} issuer in ${where}.`];

  if (offering !== undefined) {
    sentences.push(
      sold === undefined
        ? `Raising ${offering} in a private placement.`
        : `Raising ${offering} in a private placement, of which ${sold} has been sold.`,
    );
  }

  if (firstSale !== undefined) {
    sentences.push(`First sale ${firstSale}.`);
  }

  return sentences.join(" ");
}

type DerivedStage = { readonly stage: Stage; readonly provenance: Provenance };

/**
 * Where a Profile's `stage` comes from on this Source, and why it is attributed as it is.
 *
 * A Form D's "type of security" free text is where an issuer writes what it is selling, and
 * issuers write round names there — "Series Seed Preferred Stock", "Senior Series B Preferred
 * Stock". That is the filing stating its own round, so it is `scraped`: docs/adr/0007's
 * headcount proxy is replaced by a fact, not by a better guess.
 *
 * Where the filing names no round, adr/0007's derivation is what is left, and it stays
 * `enriched`. Per-field provenance is what lets the two live in one column honestly.
 *
 * Where neither gives a stage — most often a filing whose only security is a SAFE, which
 * adr/0009 declines to read as a round — the stage is `not-stated`. That too is `enriched`: the
 * filing did not say it, this pipeline wrote the marker. See docs/adr/0015.
 */
function deriveStage(
  filing: FormD,
  teamSize: number | undefined,
): DerivedStage {
  const named = stageFromRoundName(
    filing.offeringData.typesOfSecuritiesOffered?.descriptionOfOtherType,
  );

  if (named !== undefined) {
    return { stage: named, provenance: "scraped" };
  }

  return {
    stage: stageFromTeamSize(teamSize) ?? NOT_STATED_STAGE,
    provenance: "enriched",
  };
}

/**
 * Parses one Form D into a validated Profile, or says why it could not.
 *
 * Never throws: malformed XML, a document that is not a Form D, and a filing missing a field a
 * Profile needs are all outcomes, so one bad filing cannot abort a batch.
 */
export function parseFormDFiling({
  xml,
  capture,
  teamSize,
}: FormDFiling): FormDFilingResult {
  let document: XmlDocument;

  try {
    document = parseXml(xml);
  } catch (error) {
    return rejected(
      "xml",
      `filing was not well-formed XML: ${error instanceof Error ? error.message : "unknown"}`,
      xml,
    );
  }

  if (document.root !== "edgarSubmission") {
    return rejected(
      "edgarSubmission",
      `expected an EDGAR submission, found <${document.root}>`,
      xml,
    );
  }

  const parsed = formDSchema.safeParse(document.content);

  if (!parsed.success) {
    // A failed safeParse always carries at least one issue.
    const issue = parsed.error.issues[0]!;
    return rejected(issueField(issue), issue.message, document.content);
  }

  const filing = parsed.data;
  const stateOrCountry = filing.primaryIssuer.issuerAddress.stateOrCountry;

  // The filter, applied to the address the issuer swore to rather than to EDGAR's search
  // index. The live fetch asks EDGAR for Californian issuers as well, but a filter that only
  // exists in a query string is one an API change can quietly drop.
  if (stateOrCountry.trim().toUpperCase() !== CALIFORNIA) {
    return { outcome: "filtered", stateOrCountry };
  }

  const sector = trimmed(filing.offeringData.industryGroup?.industryGroupType);

  // Rejected here rather than left to `profileInputSchema`, because the description is
  // composed from the sector: leaving it would report a missing `description` and send whoever
  // reads the count looking at the wrong field.
  if (sector === undefined) {
    return rejected(
      "sector",
      "the filing states no industry group",
      filing.offeringData.industryGroup ?? null,
    );
  }

  // A fund, an investing vehicle or a property is not a company, however it is raising. See
  // `ASSET_HOLDING_INDUSTRY_GROUPS`.
  if (ASSET_HOLDING.has(sector.toLowerCase())) {
    return rejected(
      "industryGroup",
      `the issuer's industry group, ${JSON.stringify(sector)}, holds assets rather than building a product`,
      filing.offeringData.industryGroup ?? null,
    );
  }

  const derived = deriveStage(filing, teamSize);

  const input = parseProfileInput({
    name: trimmed(filing.primaryIssuer.entityName),
    // Composed from the filing's own facts, using its own industry text verbatim. A Form D
    // writes no prose of its own.
    description: describeOffering(filing, sector),
    // Mapped onto the controlled vocabulary; the filing's own words stay in `description`
    // above. See `lib/ingest/sector.ts`.
    sector: sectorFromRawText(sector),
    stage: derived.stage,
    // A Form D carries a phone number and an address, and no website at all. The field is
    // optional, so it is left off rather than guessed at from the company's name.
    // The issuer's own sworn address, the fact the California filter above is already
    // applied against. See `filingLocation`.
    location: filingLocation(filing.primaryIssuer.issuerAddress),
  });

  if (!input.success) {
    return { outcome: "rejected", rejection: input.rejection };
  }

  const scraped = attribute(capture, "scraped");

  return {
    outcome: "profile",
    profile: {
      input: input.data,
      attribution: {
        name: scraped,
        // Assembled by this pipeline out of stated facts. The filing wrote no prose.
        description: attribute(capture, "enriched"),
        sector: scraped,
        // `scraped` when the filing named its round, `enriched` when adr/0007's headcount
        // proxy stood in for one or neither did and the stage is `not-stated`. All reach the
        // same column, saying different things.
        stage: attribute(capture, derived.provenance),
        website: null,
        // The filing's own sworn address, stated rather than derived.
        location: scraped,
      },
    },
  };
}

/**
 * The result of parsing a batch. `rejections.length` is the count a stale parser shows up in:
 * a rising number with a field name attached, rather than a batch that quietly returned fewer
 * Profiles than it used to. `filtered` is kept apart because it is the Source working.
 */
export type FormDBatch = {
  readonly profiles: readonly ScrapedProfile[];
  readonly rejections: readonly IngestRejection[];
  readonly filtered: number;
};

export function parseFormDFilings(filings: Iterable<FormDFiling>): FormDBatch {
  const profiles: ScrapedProfile[] = [];
  const rejections: IngestRejection[] = [];
  let filtered = 0;

  for (const filing of filings) {
    const result = parseFormDFiling(filing);

    if (result.outcome === "profile") {
      profiles.push(result.profile);
    } else if (result.outcome === "rejected") {
      rejections.push(result.rejection);
    } else {
      filtered += 1;
    }
  }

  return { profiles, rejections, filtered };
}
