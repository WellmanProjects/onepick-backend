import { serviceClient } from "./db.js";
import { resendMailer, runDigest } from "./digest.js";
import { runResults } from "./results.js";

/* npm run digest: the hourly email job. Sends the before-deadline preview and the after-gameweek results, whichever is due.
   Optional: TEST_TO=you@example.com sends just that account a copy now (TEST_KIND=preview or results), ignoring the timing and the log.
   DRY_RUN=1 lists who would be emailed without sending. */
const key = process.env.RESEND_API_KEY, from = process.env.MAIL_FROM, site = process.env.SITE_URL;
const dryRun = process.env.DRY_RUN === "1";
const testTo = process.env.TEST_TO?.trim() || undefined;
const kind = (process.env.TEST_KIND || "").trim();
if (!site || (!dryRun && (!key || !from))) { console.error("Set SITE_URL, RESEND_API_KEY and MAIL_FROM (or DRY_RUN=1 to preview without sending)"); process.exit(1); }
const mail = key && from ? resendMailer(key, from) : async () => {};
const db = serviceClient(); const now = new Date(); const opt = { siteUrl: site, dryRun, testTo };
(async () => {
  const out: Record<string, unknown> = {};
  if (!testTo || kind !== "results") out.preview = await runDigest(db, mail, now, opt);
  if (!testTo || kind === "results") out.results = await runResults(db, mail, now, opt);
  console.log(JSON.stringify(out));
  const failed = Object.values(out).some((r) => (r as { failed: number }).failed > 0);
  if (failed) process.exitCode = 1;
})().catch((e) => { console.error(e); process.exit(1); });
