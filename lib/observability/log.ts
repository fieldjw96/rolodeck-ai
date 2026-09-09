export type LogFields = Record<string, unknown>;

/**
 * The one place a structured line reaches stdout: one `console.log` call, one JSON object,
 * so a production incident is diagnosable by parsing lines rather than grepping prose. Ticket
 * #14 scopes this repo to stdout — no Sentry, no Datadog — on the basis that a platform like
 * Vercel already collects it from there.
 */
export function logLine(fields: LogFields): void {
  console.log(JSON.stringify({ time: new Date().toISOString(), ...fields }));
}
