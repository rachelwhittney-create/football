// POST /api/roster-read  (background function, started by /api/roster-upload)
// Reads the stored screenshots with Claude and saves the players it finds to the job.
import { getStore } from "@netlify/blobs";
import { JOB_ID } from "../../lib/auth.mjs";

const MODEL = process.env.ANTHROPIC_VISION_MODEL || "claude-haiku-5-5";
const POS = ["QB", "RB", "WR", "TE", "K", "DST"];
const TEAMS = "ARI ATL BAL BUF CAR CHI CIN CLE DAL DEN DET GB HOU IND JAX KC LAC LAR LV MIA MIN NE NO NYG NYJ PHI PIT SEA SF TB TEN WAS".split(" ");

export default async (req) => {
  let jobId = "";
  try { jobId = String((await req.json())?.jobId || ""); } catch { return; }
  if (!JOB_ID.test(jobId)) return;

  const uploads = getStore("uploads");
  const jobs = getStore({ name: "jobs", consistency: "strong" });
  const save = (obj) => jobs.setJSON(jobId, { ...obj, at: new Date().toISOString() });

  const upload = await uploads.get(jobId, { type: "json" });
  if (!upload?.images?.length) return; // nothing stored means the code check never passed

  try {
    const content = [
      ...upload.images.map((img) => ({ type: "image", source: { type: "base64", media_type: img.type, data: img.data } })),
      { type: "text", text:
        `These are screenshots of a fantasy football team page (starters and/or bench)${upload.kind === "opponent" ? ", or of a head-to-head matchup page. List the players on the OPPONENT's team (if both teams are shown, the opponent is the team that isn't the viewer's own; if only one team is shown, list that team)" : ". List every player on the roster"}.
Use full first and last names when you can tell who the player is (for example "J. Daniels" on Washington is Jayden Daniels). Team defenses use pos "DST" and a name like "Browns D/ST".
Team abbreviations must be one of: ${TEAMS.join(" ")} (Washington is WAS).
Add "status" only if the screenshot shows one (Q, O, IR, D, BYE), otherwise use "". Mark bench players with status "BE" only if the screenshot clearly labels them as bench.
If the fantasy team's name is visible, put it in "teamName", otherwise "".
Reply with ONLY a JSON object, no other text: {"teamName":"","players":[{"name":"Jayden Daniels","pos":"QB","team":"WAS","status":""}]}` },
    ];
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: 2000, messages: [{ role: "user", content }] }),
    });
    if (!res.ok) {
      const e = new Error(`Claude API ${res.status}`); e.status = res.status; throw e;
    }
    const data = await res.json();
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    const raw = fence ? fence[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
    let parsed = {};
    try { parsed = JSON.parse(raw); } catch { parsed = {}; }
    const list = Array.isArray(parsed) ? parsed : parsed.players;
    const teamName = Array.isArray(parsed) ? "" : String(parsed.teamName || "").slice(0, 60);
    const players = (Array.isArray(list) ? list : []).map((p) => {
      let pos = String(p?.pos || "").toUpperCase(); if (pos === "D/ST" || pos === "DEF") pos = "DST";
      let team = String(p?.team || "").toUpperCase(); if (team === "WSH") team = "WAS";
      return { name: String(p?.name || "").trim().slice(0, 60), pos: POS.includes(pos) ? pos : "", team: TEAMS.includes(team) ? team : "", status: String(p?.status || "").slice(0, 8) };
    }).filter((p) => p.name).slice(0, 40);
    if (!players.length) throw Object.assign(new Error("none"), { none: true });
    await save({ status: "done", result: { players, teamName } });
  } catch (e) {
    await save({ status: "error", error:
      e.none ? "Couldn't find any players in those screenshots. Try clearer screenshots of your team page."
      : e.status === 401 ? "The service isn't set up correctly. Let the site owner know."
      : e.status === 429 ? "Too many requests right now. Try again in a minute."
      : "Reading the screenshots didn't finish. Try again." });
  } finally {
    await uploads.delete(jobId).catch(() => {});
  }
};

export const config = { path: "/api/roster-read", background: true };
