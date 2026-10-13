// 'YYYY-MM' of an instant, in UK time. Monthly rounds group gameweeks by the month of their first kickoff.
const fmt = new Intl.DateTimeFormat("en-CA", { year: "numeric", month: "2-digit", timeZone: "Europe/London" });
export const monthKey = (iso: string): string => fmt.format(new Date(iso));
