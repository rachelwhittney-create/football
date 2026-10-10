// POST /api/roster-read  (background function, started by /api/roster-upload)
// Reads the stored screenshots with Claude and saves the players it finds to the job.
// The page sends tall phone screenshots as overlapping slices so small text stays readable.
// A roster is at most 15 players including one team defense; if the first read comes back
// short (fewer players than rows it counted, or no defense), it gets one corrective retry.
import { getStore } from "@netlify/blobs";
import { JOB_ID } from "../../lib/auth.mjs";

const MODEL = process.env.ANTHROPIC_VISION_MODEL || "claude-sonnet-5-5";
const MAX_PLAYERS = 15;
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
    const images = upload.images.map((img) => ({ type: "image", source: { type: "base64", media_type: img.type, data: img.data } }));
    const who = upload.kind === "opponent"
      ? "List the players on the OPPONENT's fantasy team. If both teams are shown side by side, the opponent is the team that isn't the viewer's own; if only one team is shown, list that team."
      : "List every player on this fantasy team.";
    const prompt = `These images are screenshots of a fantasy football team page or matchup page. Tall screenshots were cut into overlapping slices, so consecutive images may repeat a few rows: list each player only once.
${who}

Rules:
- A fantasy roster has at most ${MAX_PLAYERS} players, and that includes exactly one team defense (D/ST). Include starters, bench, and IR/injured players. Do not skip anyone.
- Go row by row, top to bottom through every image, and count the player rows you see before answering.
- Use full first and last names when you can tell who the player is (for example "J. Daniels" on Washington is Jayden Daniels). The team defense uses pos "DST" and a name like "Browns D/ST", with that team's abbreviation.
- Team abbreviations must be one of: ${TEAMS.join(" ")} (Washington is WAS).
- "status": the injury or slot tag shown (Q, O, D, IR, BYE), or "BE" if the row is clearly labeled bench, otherwise "".
- "teamName": the fantasy team's name if it's visible, otherwise "".

Reply with ONLY a JSON object, no other text:
{"teamName":"","rowsCounted":15,"players":[{"name":"Jayden Daniels","pos":"QB","team":"WAS","status":""}]}`;

    const messages = [{ role: "user", content: [...images, { type: "text", text: prompt }] }];
    let first = await ask(messages);
    let result = clean(first.parsed);

    const short = result.players.length < Math.min(result.rowsCounted || 0, MAX_PLAYERS);
    const noDefense = !result.players.some((p) => p.pos === "DST");
    if (short || noDefense) {
      const issues = [];
      if (short) issues.push(`you counted ${result.rowsCounted} player rows but listed ${result.players.length}`);
      if (noDefense) issues.push("no team defense (D/ST) was listed, but every roster has one");
      messages.push({ role: "assistant", content: first.text });
      messages.push({ role: "user", content: `Check again: ${issues.join(", and ")}. Look through every image carefully, including the bottom of each one, and reply with the complete corrected JSON object only.` });
      const second = clean((await ask(messages)).parsed);
      if (second.players.length >= result.players.length) result = second;
    }

    if (!result.players.length) throw Object.assign(new Error("none"), { none: true });
    await save({ status: "done", result: { players: result.players, teamName: result.teamName } });
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

async function ask(messages) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify({ model: MODEL, max_tokens: 3000, messages }),
  });
  if (!res.ok) { const e = new Error(`API ${res.status}`); e.status = res.status; throw e; }
  const data = await res.json();
  const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  let parsed = {};
  try { parsed = JSON.parse(raw); } catch { parsed = {}; }
  return { text: text || "{}", parsed };
}

// Normalize, drop duplicates from overlapping slices, keep one defense, cap at 15.
function clean(parsed) {
  const list = Array.isArray(parsed) ? parsed : parsed?.players;
  const seen = new Set();
  const players = [];
  let haveDst = false;
  for (const p of Array.isArray(list) ? list : []) {
    let pos = String(p?.pos || "").toUpperCase(); if (pos === "D/ST" || pos === "DEF") pos = "DST";
    let team = String(p?.team || "").toUpperCase(); if (team === "WSH") team = "WAS";
    const name = String(p?.name || "").trim().slice(0, 60);
    if (!name) continue;
    if (pos === "DST") { if (haveDst) continue; haveDst = true; }
    const last = name.toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\.?$/,"").trim().split(/\s+/).pop();
    const key = pos === "DST" ? "dst" : `${last}|${team}|${pos}`;
    if (seen.has(key)) continue;
    seen.add(key);
    players.push({ name, pos: POS.includes(pos) ? pos : "", team: TEAMS.includes(team) ? team : "", status: String(p?.status || "").slice(0, 8) });
  }
  return {
    players: players.slice(0, MAX_PLAYERS),
    rowsCounted: Number(parsed?.rowsCounted) || 0,
    teamName: Array.isArray(parsed) ? "" : String(parsed?.teamName || "").slice(0, 60),
  };
}
