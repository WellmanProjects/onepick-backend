import type { DataProvider } from "./types.js";
import { fplProvider } from "./providers/fpl.js";

// Add a licensed provider here later (e.g. Sportmonks) and switch with PROVIDER=... — nothing else changes.
export function getProvider(): DataProvider {
  const name = process.env.PROVIDER ?? "fpl";
  if (name === "fpl") return fplProvider;
  throw new Error(`Unknown PROVIDER "${name}"`);
}
