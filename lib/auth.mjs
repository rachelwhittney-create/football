// Access-code check shared by the functions that spend Claude API credit.
import { createHash, timingSafeEqual } from "node:crypto";

export function checkCode(given) {
  const expected = process.env.LINEUP_PASSWORD || "";
  if (!expected) return "The site owner hasn't set an access code yet.";
  const h = (s) => createHash("sha256").update(String(s)).digest();
  if (!timingSafeEqual(h(given || ""), h(expected))) return "Wrong access code.";
  if (!process.env.ANTHROPIC_API_KEY) return "This feature isn't set up yet. Let the site owner know.";
  return null; // OK
}

export const JOB_ID = /^[a-z0-9]{12,40}$/;
