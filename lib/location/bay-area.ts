/**
 * Whether a Company Profile's `location` is in the Bay Area — the product's central claim,
 * per CLAUDE.md, and otherwise unenforceable once `location` is free text. The Deck ranks
 * on it through `citiesInArea` below, so ranking has something fixed to call rather than a
 * scattered string match. See docs/adr/0011.
 *
 * A criterion on cities rather than counties, because `location` is stored as a human-
 * readable place — "San Francisco, CA" — not as a county, and a criterion cannot consult a
 * county no Source ever stated. Los Angeles is the case that matters: it passes the EDGAR
 * `CALIFORNIA` filter in `lib/ingest/edgar.ts` and is not the Bay Area, which is why this is
 * a named, checkable list rather than "does the state say CA".
 *
 * Covers the incorporated cities and well-known towns of the Bay Area's nine counties —
 * Alameda, Contra Costa, Marin, Napa, San Francisco, San Mateo, Santa Clara, Solano and
 * Sonoma — rather than every unincorporated place; a real Source naming somewhere this list
 * is missing is a reason to add a line here, not to fall back to fuzzy matching.
 */
const BAY_AREA_CITIES: ReadonlySet<string> = new Set([
  // San Francisco County
  "san francisco",

  // San Mateo County
  "san mateo",
  "redwood city",
  "south san francisco",
  "daly city",
  "san bruno",
  "burlingame",
  "millbrae",
  "foster city",
  "belmont",
  "san carlos",
  "menlo park",
  "east palo alto",
  "half moon bay",
  "pacifica",
  "brisbane",
  "atherton",
  "woodside",
  "portola valley",
  "hillsborough",

  // Santa Clara County
  "san jose",
  "palo alto",
  "mountain view",
  "sunnyvale",
  "santa clara",
  "cupertino",
  "milpitas",
  "campbell",
  "los gatos",
  "saratoga",
  "los altos",
  "los altos hills",
  "morgan hill",
  "gilroy",
  "monte sereno",

  // Alameda County
  "oakland",
  "berkeley",
  "fremont",
  "hayward",
  "alameda",
  "san leandro",
  "pleasanton",
  "livermore",
  "union city",
  "newark",
  "dublin",
  "emeryville",
  "albany",
  "piedmont",
  "castro valley",

  // Contra Costa County
  "concord",
  "richmond",
  "walnut creek",
  "antioch",
  "san ramon",
  "pittsburg",
  "martinez",
  "pleasant hill",
  "el cerrito",
  "danville",
  "lafayette",
  "orinda",
  "moraga",
  "san pablo",
  "hercules",
  "pinole",
  "brentwood",
  "oakley",

  // Marin County
  "san rafael",
  "novato",
  "sausalito",
  "mill valley",
  "tiburon",
  "larkspur",
  "san anselmo",
  "fairfax",
  "corte madera",
  "belvedere",

  // Napa County
  "napa",
  "american canyon",
  "st. helena",
  "saint helena",
  "calistoga",
  "yountville",

  // Solano County
  "vallejo",
  "fairfield",
  "vacaville",
  "benicia",
  "suisun city",
  "dixon",

  // Sonoma County
  "santa rosa",
  "petaluma",
  "rohnert park",
  "sonoma",
  "windsor",
  "cotati",
  "sebastopol",
  "cloverdale",
  "healdsburg",
]);

/**
 * A `location` reads "City, ST" per `db/profile-input.ts`; the city is everything before the
 * first comma. A location with no comma at all — a bare state, the fallback
 * `lib/ingest/sec-form-d.ts` writes when a filing states no city — has no city to check, and
 * is answered `false` rather than guessed at.
 */
function cityOf(location: string): string | undefined {
  const [city, rest] = location.split(",", 2);

  return rest === undefined ? undefined : city?.trim().toLowerCase();
}

/**
 * Whether `location` names a Bay Area city. Null — a Profile whose location is unknown — is
 * `false` rather than an error: it is not a Bay Area location, but it is not a claim that it
 * definitely isn't one either, which is exactly why the field is nullable at all.
 */
export function isBayArea(location: string | null): boolean {
  if (location === null) {
    return false;
  }

  const city = cityOf(location);

  return city !== undefined && BAY_AREA_CITIES.has(city);
}

/**
 * The cities a User Profile's `area` stands for, so the Deck can rank on it inside Postgres
 * rather than calling `isBayArea` on every row in TypeScript. `db/deck.ts` reproduces
 * `cityOf` in SQL against this list, and `db/deck-ranking.test.ts` holds the two to the same
 * answers.
 *
 * "Bay Area" is the one area with a list. Any other area is empty — it matches no Company
 * Profile rather than raising — because `area` is free text and an owner who types somewhere
 * this module does not know should get the Deck unranked by place, not an error.
 */
export function citiesInArea(area: string): readonly string[] {
  return area.trim().toLowerCase() === "bay area" ? [...BAY_AREA_CITIES] : [];
}
