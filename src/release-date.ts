/**
 * The date a release is shown as having.
 *
 * A release note carries one date, whether it was just written or is being
 * promoted from another environment, so both commands read it the same way:
 * `now`, the `to` tag's own date, or a date you name.
 */

import { getTagCreationDate } from "./git.js";

export interface ReleaseDateOptions {
  /** "now" (default), "tag", or a date such as "2026-07-20". */
  date?: string;
}

export function formatDate(date: Date): string {
  return date.toLocaleDateString("en-US", {
    day: "2-digit",
    month: "long",
    year: "numeric",
  });
}

export async function resolveReleaseDate(
  options: ReleaseDateOptions,
  toVersion: string
): Promise<string> {
  if (!options.date) {
    return formatDate(new Date());
  }

  const value = options.date.trim();
  if (value.toLowerCase() === "now") {
    return formatDate(new Date());
  }
  if (value.toLowerCase() === "tag") {
    const tagDate = await getTagCreationDate(toVersion);
    if (!tagDate) {
      throw new Error(
        `Could not find a creation date for tag "${toVersion}". ` +
        `Use --date now or an ISO date such as 2026-07-20.`
      );
    }
    return formatDate(tagDate);
  }

  const specificDate = parseSpecificDate(value);
  if (!specificDate) {
    throw new Error(
      `Invalid release date "${value}". Use now, tag, or an ISO date such as 2026-07-20.`
    );
  }
  return formatDate(specificDate);
}

function parseSpecificDate(value: string): Date | null {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    const [, year, month, day] = dateOnly;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    return date.getFullYear() === Number(year) && date.getMonth() === Number(month) - 1 && date.getDate() === Number(day)
      ? date
      : null;
  }

  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}
