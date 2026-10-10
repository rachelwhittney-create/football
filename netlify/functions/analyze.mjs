// POST /api/analyze  (Netlify background function: the browser gets 202 right away)
// Body: { jobId, password, scoring, slots, week, roster: [{name,pos,team,opp,home,kickoff,matchup}], opponentPlayers }
// Checks the password, asks Claude (with web search for injury news) for start/sit calls,
// and saves the result to Netlify Blobs under jobId. The page polls /api/job?id=jobId.
import { getStore } from "@netlify/blobs";
import { createHash, timingSafeEqual } from "node:crypto";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const MAX_SEARCHES = Number(process.env.MAX_WEB_SEARCHES || 5);

export default async (req) => {
  const store = getStore({ name: "jobs", consistency: "strong" });
  let body;
  try { body = await req.json(); } catch { return; }
  const jobId = String(body?.jobId || "");
  if (!/^[a-z0-9]{12,40}$/.test(jobId)) return;
  const save = (obj) => store.setJSON(jobId, { ...obj, at: new Date().toISOString() });

  // Password gate
  const expected = process.env.LINEUP_PASSWORD || "";
  if (!expected) return save({ status: "error", error: "The site owner hasn't set a password yet." });
  if (!same(String(body.password || ""), expected)) return save({ status: "error", error: "Wrong password." });
  if (!process.env.ANTHROPIC_API_KEY) return save({ status: "error", error: "Lineup analysis isn't set up yet. Let the site owner know." });

  const roster = Array.isArray(body.roster) ? body.roster.slice(0, 30) : [];
  if (!roster.length) return save({ status: "error", error: "Add players to your roster first." });

  await save({ status: "working" });

  try {
    const prompt = buildPrompt({ ...body, roster });
    const { text, sources } = await askClaude(prompt);
    const result = parseJSON(text);
    if (!result || !Array.isArray(result.players)) throw Object.assign(new Error("format"), { format: true });
    await save({ status: "done", result, sources });
  } catch (e) {
    await save({ status: "error", error: friendly(e) });
  }
};

export const config = { path: "/api/analyze", background: true };

function same(a, b) {
  const h = (s) => createHash("sha256").update(s).digest();
  return timingSafeEqual(h(a), h(b));
}

function clip(s, n) { return String(s ?? "").slice(0, n); }

function buildPrompt(b) {
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/Chicago" });
  const players = b.roster.map((p) => {
    const m = p.matchup || {};
    const faced = (m.faced || []).slice(0, 4).map((f) => `wk${f.week} ${clip(f.name, 40)} (${clip(f.team, 12)}) ${clip(f.pts, 12)} — ${clip(f.line, 60)}`).join("; ");
    return `- ${clip(p.name, 60)} | ${clip(p.pos, 4)} | ${clip(p.team, 4)} | ${p.opp ? `${p.home === false ? "at" : "vs"} ${clip(p.opp, 4)} ${clip(p.kickoff, 30)}` : "BYE or no game found"}` +
      (m.avg != null ? ` | top ${clip(p.pos, 4)} vs this defense averaged ${m.avg} pts over last ${m.games} games: ${faced}` : "");
  }).join("\n");
  const opp = clip(b.opponentPlayers, 1500);
  return `You are a sharp, practical fantasy football advisor. Today is ${today}. NFL week ${clip(b.week, 3) || "unknown"}.
Scoring: ${clip(b.scoring, 12) || "PPR"}. Starting lineup slots: ${clip(b.slots, 120) || "QB, RB, RB, WR, WR, TE, FLEX, DST"}.

MY ROSTER with this week's opponent and how that defense has played (top player at the position in each of its last games, from ESPN box scores):
${players}
${opp ? `\nMY FANTASY OPPONENT'S STARTERS (optional context):\n${opp}\n` : ""}
Use web search (at most ${MAX_SEARCHES} searches) to check current injury designations and practice reports for players on MY roster who might be hurt or limited, and any major role changes. Don't search for every player.

Then decide who to start. Every player gets one verdict: START (in the lineup), FLEX (in the lineup in a flex slot, or a close call), SIT, or OUT (injured, bye, or ruled out). Fill every lineup slot from my roster. Players whose game has already been played this week keep their slot if they were the right call.

Reply with ONLY a JSON object, no other text, in this exact shape:
{"summary":"2-4 plain sentences on the key decisions","lineup":[{"slot":"QB","name":"..."}],"players":[{"name":"exact name from my roster","verdict":"START|FLEX|SIT|OUT","note":"1-2 sentences of reasoning","injury":"designation or empty string"}],"opponentOutlook":"1-2 sentences, or empty string"}`;
}

async function askClaude(prompt) {
  const messages = [{ role: "user", content: prompt }];
  const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES }];
  let last;
  // Server-side web search can pause a long turn; continue it a few times.
  for (let i = 0; i < 4; i++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({ model: MODEL, max_tokens: 4000, tools, messages }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      const err = new Error(`Claude API ${res.status}: ${t.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
    last = await res.json();
    if (last.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: last.content });
  }
  const blocks = (last.content || []).filter((b) => b.type === "text");
  const text = blocks.map((b) => b.text).join("");
  const seen = new Map();
  for (const m of messages.filter((m) => m.role === "assistant").map((m) => m.content).flat().concat(last.content || [])) {
    for (const c of m?.citations || []) if (c.url && !seen.has(c.url)) seen.set(c.url, { url: c.url, title: c.title || c.url });
  }
  return { text, sources: [...seen.values()].slice(0, 12) };
}

function parseJSON(text) {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const raw = fence ? fence[1] : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  try { return JSON.parse(raw); } catch { return null; }
}

function friendly(e) {
  if (e?.status === 401) return "The service isn't set up correctly. Let the site owner know.";
  if (e?.status === 429) return "Too many requests right now. Try again in a minute.";
  if (e?.status === 529 || e?.status >= 500) return "The service is temporarily unavailable. Try again shortly.";
  return e?.format ? "The analysis came back incomplete. Try again." : "The analysis didn't finish. Try again.";
}
