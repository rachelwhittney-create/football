// POST /api/ask  (background function; the page polls /api/job?id=jobId)
// Body: { jobId, password, question, history: [{role, text}], context: { week, scoring, slots, plan, roster, opponentPlayers } }
// Answers a follow-up question about this week's game plan. Can run a couple of web searches
// for fresh news (e.g. "is McLaurin playing?").
import { getStore } from "@netlify/blobs";
import { checkCode, JOB_ID } from "../../lib/auth.mjs";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const MAX_SEARCHES = Number(process.env.MAX_QUESTION_SEARCHES || 3);

const clip = (s, n) => String(s ?? "").slice(0, n);

export default async (req) => {
  const jobs = getStore({ name: "jobs", consistency: "strong" });
  let b;
  try { b = await req.json(); } catch { return; }
  const jobId = String(b?.jobId || "");
  if (!JOB_ID.test(jobId)) return;
  const save = (obj) => jobs.setJSON(jobId, { ...obj, at: new Date().toISOString() });

  const problem = checkCode(b.password);
  if (problem) return save({ status: "error", error: problem });
  const question = clip(b.question, 600).trim();
  if (!question) return save({ status: "error", error: "Type a question first." });
  await save({ status: "working" });

  const c = b.context || {};
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "America/Chicago" });
  const roster = (Array.isArray(c.roster) ? c.roster : []).slice(0, 20).map((p) =>
    `- ${clip(p.name, 60)} | ${clip(p.pos, 4)} | ${clip(p.team, 4)}${p.injury ? ` | ${clip(p.injury, 12)}` : ""} | ${p.opp ? `${p.home === false ? "at" : "vs"} ${clip(p.opp, 4)}` : "no game"}` +
    (p.avg != null ? ` | top ${clip(p.pos, 4)} vs that defense avg ${p.avg} pts` : "") +
    (p.verdict ? ` | plan: ${clip(p.verdict, 6)} — ${clip(p.note, 240)}` : "")).join("\n");
  const plan = c.plan || {};
  const lineup = (Array.isArray(plan.lineup) ? plan.lineup : []).map((s) => `${clip(s.slot, 8)}: ${clip(s.name, 60)}`).join(", ");
  const impacts = (Array.isArray(plan.injuryImpacts) ? plan.injuryImpacts : []).slice(0, 10)
    .map((x) => `- ${clip(x.player, 80)} → ${clip(x.affects, 80)}: ${clip(x.effect, 200)}`).join("\n");

  const system = `You are a sharp, friendly fantasy football advisor answering follow-up questions about this week's game plan. Today is ${today}, NFL week ${clip(c.week, 3) || "unknown"}.
Scoring: ${clip(c.scoring, 12) || "PPR"}${c.scoringNotes ? ` (${clip(c.scoringNotes, 200)})` : ""}. Lineup slots: ${clip(c.slots, 160)}.

THIS WEEK'S GAME PLAN
Summary: ${clip(plan.summary, 800)}
Recommended lineup: ${lineup || "not available"}
${impacts ? `Injury ripple effects:\n${impacts}\n` : ""}${plan.opponentOutlook ? `Opponent outlook: ${clip(plan.opponentOutlook, 400)}\n` : ""}
MY ROSTER (with this week's matchup and the plan's verdict)
${roster}
${c.opponentPlayers ? `\nMY FANTASY OPPONENT'S PLAYERS\n${clip(c.opponentPlayers, 1200)}\n` : ""}
How to answer:
- Answer the question directly in the first sentence (e.g. "Start Doubs."), then give 2-4 short reasons. Keep it under about 120 words unless asked for more.
- Use web search (at most ${MAX_SEARCHES} searches) only when the answer depends on news newer than the plan: injuries, practice reports, inactives, weather, role changes. Otherwise answer from the information above.
- If the question changes the plan (say a player is ruled out), say exactly which lineup swap to make.
- Plain text only. No markdown headers, tables or bullet symbols other than short dashes.`;

  const history = (Array.isArray(b.history) ? b.history : []).slice(-8)
    .filter((t) => (t.role === "user" || t.role === "assistant") && t.text)
    .map((t) => ({ role: t.role, content: clip(t.text, 2000) }));
  while (history.length && history[0].role !== "user") history.shift();
  const messages = [...history, { role: "user", content: question }];
  // Keep roles alternating.
  const merged = [];
  for (const m of messages) {
    if (merged.length && merged[merged.length - 1].role === m.role) merged[merged.length - 1].content += "\n\n" + m.content;
    else merged.push({ ...m });
  }

  try {
    const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES }];
    const blocks = [];
    let last, msgs = merged;
    for (let i = 0; i < 4; i++) {
      last = await call({ model: MODEL, max_tokens: 3000, system, tools, messages: msgs });
      blocks.push(...(last.content || []));
      if (last.stop_reason !== "pause_turn") break;
      msgs = [...msgs, { role: "assistant", content: last.content }];
    }
    let start = 0;
    blocks.forEach((x, i) => { if (x.type === "web_search_tool_result") start = i + 1; });
    const answer = blocks.slice(start).filter((x) => x.type === "text").map((x) => x.text).join("").trim();
    if (!answer) throw new Error("empty");
    const seen = new Map();
    for (const x of blocks) for (const cit of x?.citations || []) if (cit.url && !seen.has(cit.url)) seen.set(cit.url, { url: cit.url, title: cit.title || cit.url });
    await save({ status: "done", result: { answer, sources: [...seen.values()].slice(0, 6) } });
  } catch (e) {
    await save({ status: "error", error:
      e.status === 401 ? "The service isn't set up correctly. Let the site owner know."
      : e.status === 429 ? "Too many requests right now. Try again in a minute."
      : e.status >= 500 ? "The service is temporarily unavailable. Try again shortly."
      : "That question didn't get an answer. Try asking again." });
  }
};

export const config = { path: "/api/ask", background: true };

async function call(body) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) { const e = new Error(`API ${res.status}`); e.status = res.status; throw e; }
  return res.json();
}
