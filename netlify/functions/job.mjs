// GET /api/job?id=... -> status of an "Analyze my lineup" request.
import { getStore } from "@netlify/blobs";

export default async (req) => {
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!/^[a-z0-9]{12,40}$/.test(id)) return Response.json({ error: "Bad request id." }, { status: 400 });
  const store = getStore({ name: "jobs", consistency: "strong" });
  const job = await store.get(id, { type: "json" });
  return Response.json(job || { status: "pending" }, { headers: { "Cache-Control": "no-store" } });
};

export const config = { path: "/api/job" };
