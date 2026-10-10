// POST /api/roster-upload
// Body: { jobId, password, images: [{ type: "image/jpeg", data: "<base64>" }] }  (up to 4 screenshots)
// Checks the access code, stores the screenshots briefly, and starts the background reader.
// The page then polls /api/job?id=jobId for the players Claude found.
import { getStore } from "@netlify/blobs";
import { checkCode, JOB_ID } from "../../lib/auth.mjs";

const TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_B64 = 2_000_000; // ~1.5 MB per image after the page shrinks it

export default async (req) => {
  if (req.method !== "POST") return Response.json({ error: "Use POST." }, { status: 405 });
  let body;
  try { body = await req.json(); } catch { return Response.json({ error: "Bad request." }, { status: 400 }); }

  const jobId = String(body?.jobId || "");
  if (!JOB_ID.test(jobId)) return Response.json({ error: "Bad request id." }, { status: 400 });
  const problem = checkCode(body.password);
  if (problem) return Response.json({ error: problem }, { status: 403 });

  const images = (Array.isArray(body.images) ? body.images : []).slice(0, 4)
    .filter((i) => TYPES.includes(i?.type) && typeof i?.data === "string" && i.data.length < MAX_B64);
  if (!images.length) return Response.json({ error: "Attach at least one PNG or JPG screenshot." }, { status: 400 });

  await getStore("uploads").setJSON(jobId, { images });
  await getStore({ name: "jobs", consistency: "strong" }).setJSON(jobId, { status: "working", at: new Date().toISOString() });

  // Kick off the background reader (it answers 202 immediately).
  await fetch(new URL("/api/roster-read", req.url), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId }),
  }).catch(() => {});

  return Response.json({ ok: true, jobId }, { status: 202 });
};

export const config = { path: "/api/roster-upload" };
