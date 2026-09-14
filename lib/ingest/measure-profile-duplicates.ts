import { count, sql } from "drizzle-orm";
import type { Database } from "../../db/connection";
import { profiles } from "../../db/schema";

/**
 * Statistics about profiles that appear under multiple sources.
 */
export interface DuplicateStats {
  totalProfiles: number;
  profilesInMultipleSources: number;
  percentageInMultipleSources: number;
  worstOffenders: Array<{
    nameKey: string;
    sources: string[];
    count: number;
  }>;
}

/**
 * Analyze how many profiles appear under multiple sources by name_key.
 * Returns a DuplicateStats object with the count, percentage, and worst offenders.
 */
export async function measureProfileDuplicates(
  db: Database,
  ownerId: string,
): Promise<DuplicateStats> {
  // Get total count of all profiles
  const totalResult = await db
    .select({ count: count() })
    .from(profiles)
    .where(sql`${profiles.ownerId} = ${ownerId}`);

  const totalProfiles = totalResult[0]?.count ?? 0;

  // Find profiles that appear under multiple sources using raw SQL subquery
  // We need to use raw SQL for the aggregation and grouping
  type DuplicateRow = {
    name_key: string;
    sources: string[];
    source_count: number;
    profile_count: number;
  };

  const duplicatesResult = (await db.execute<DuplicateRow>(sql`
    select
      name_key,
      array_agg(distinct source order by source) as sources,
      count(distinct source) as source_count,
      count(*) as profile_count
    from profiles
    where owner_id = ${ownerId}
    group by name_key
    having count(distinct source) > 1
    order by source_count desc
  `)) as unknown;

  // Handle both array and object return types depending on database driver
  let duplicatesArray: DuplicateRow[] = [];
  if (Array.isArray(duplicatesResult)) {
    duplicatesArray = duplicatesResult;
  } else if (
    duplicatesResult !== null &&
    typeof duplicatesResult === "object" &&
    "rows" in duplicatesResult
  ) {
    duplicatesArray = (duplicatesResult as { rows: DuplicateRow[] }).rows;
  }

  const profilesInMultipleSources = duplicatesArray.reduce(
    (sum, row: DuplicateRow) => sum + Number(row.profile_count),
    0,
  );
  const percentageInMultipleSources =
    totalProfiles > 0
      ? Math.round((profilesInMultipleSources / totalProfiles) * 10000) / 100
      : 0;

  return {
    totalProfiles,
    profilesInMultipleSources,
    percentageInMultipleSources,
    worstOffenders: duplicatesArray.map((row: DuplicateRow) => ({
      nameKey: row.name_key,
      sources: row.sources,
      count: Number(row.source_count),
    })),
  };
}

/**
 * Format duplicate statistics for console output.
 */
export function formatDuplicateReport(stats: DuplicateStats): string {
  const lines: string[] = [];

  lines.push(
    `Profiles under multiple sources: ${stats.profilesInMultipleSources} of ${stats.totalProfiles} ` +
      `(${stats.percentageInMultipleSources}%)`,
  );

  if (stats.worstOffenders.length === 0) {
    lines.push("No profiles appear under multiple sources.");
  } else {
    lines.push("");
    lines.push("Worst offenders (appearing under most sources):");
    for (const offender of stats.worstOffenders) {
      lines.push(
        `  "${offender.nameKey}" appears under ${offender.count} sources: ${offender.sources.join(", ")}`,
      );
    }
  }

  return lines.join("\n");
}
