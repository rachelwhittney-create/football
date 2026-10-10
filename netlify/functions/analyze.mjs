// POST /api/analyze  (Netlify background function: the browser gets 202 right away)
// Body: { jobId, password, scoring, scoringNotes, slots, week, roster: [{name,pos,team,injury,opp,home,kickoff,matchup}], opponentPlayers }
// Checks the access code, asks Claude (with web search for injury news across rosters, teammates
// and opposing defenses) for start/sit calls, and saves the result to Netlify Blobs under jobId.
// The page polls /api/job?id=jobId.
import { getStore } from "@netlify/blobs";
import { checkCode, JOB_ID } from "../../lib/auth.mjs";

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const MAX_SEARCHES = Number(process.env.MAX_WEB_SEARCHES || 8);

export default async (req) => {
  const store = getStore({ name: "jobs", consistency: "strong" });
  let body;
  try { body = await req.json(); } catch { return; }
  const jobId = String(body?.jobId || "");
  if (!JOB_ID.test(jobId)) return;
  const save = (obj) => store.setJSON(jobId, { ...obj, at: new Date().toISOString() });

  const problem = checkCode(body.password);
  if (problem) return save({ status: "error", error: problem });

  const roster = Array.isArray(body.roster) ? body.roster.slice(0, 20) : [];
  if (!roster.length) return save({ status: "error", error: "Add players to your roster first." });

  await save({ status: "working" });

  try {
    const prompt = buildPrompt({ ...body, roster });
    const { text, sources } = await askClaude(prompt);
    let result = parseJSON(text);
    // If the researched answer was cut off or wrapped in prose, ask once more for just the JSON
    // (no web search this time, so it's quick and cheap).
    if (!result) result = parseJSON(await repairJSON(prompt, text));
    if (!result) throw Object.assign(new Error("format"), { format: true });
    await save({ status: "done", result, sources });
  } catch (e) {
    await save({ status: "error", error: friendly(e) });
  }
};

export const config = { path: "/api/analyze", background: true };

function clip(s, n) { return String(s ?? "").slice(0, n); }

function buildPrompt(b) {
  const today = new Date().toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric", timeZone: "America/Chicago" });
  const players = b.roster.map((p) => {
    const m = p.matchup || {};
    const faced = (m.faced || []).slice(0, 4).map((f) => `wk${f.week} ${clip(f.name, 40)} (${clip(f.team, 12)}) ${clip(f.pts, 12)} — ${clip(f.line, 60)}`).join("; ");
    return `- ${clip(p.name, 60)} | ${clip(p.pos, 4)} | ${clip(p.team, 4)}${p.injury ? ` | listed: ${clip(p.injury, 20)}` : ""}${p.slot ? ` | currently in ${clip(p.slot, 8)}` : ""} | ${p.opp ? `${p.home === false ? "at" : "vs"} ${clip(p.opp, 4)} ${clip(p.kickoff, 30)}` : "BYE or no game found"}` +
      (m.avg != null ? ` | top ${clip(p.pos, 4)} vs this defense averaged ${m.avg} pts over last ${m.games} games: ${faced}` : "");
  }).join("\n");
  const opp = clip(b.opponentPlayers, 1500);
  return `You are a sharp, practical fantasy football advisor. Today is ${today}. NFL week ${clip(b.week, 3) || "unknown"}.
Scoring: ${clip(b.scoring, 12) || "PPR"}${b.scoringNotes ? ` (${clip(b.scoringNotes, 300)})` : ""}. Starting lineup slots: ${clip(b.slots, 160) || "QB, RB, RB, WR, WR, TE, FLEX, DST"}.

MY ROSTER with this week's opponent and how that defense has played (top player at the position in each of its last games, from ESPN box scores):
${players}
${opp ? `\nMY FANTASY OPPONENT'S PLAYERS:\n${opp}\n` : ""}
Use web search (at most ${MAX_SEARCHES} searches; combine topics into broad queries such as a team's injury report) to check, in this order of importance:
1. My players: current injury designations, practice reports, and role or depth-chart changes.
2. My players' teammates: injuries that change their workload. A starting QB out hurts his receivers; a WR1 or RB1 out means more targets or carries for the next man up; injured offensive linemen hurt the run game and QB.
3. The defenses my players face: missing cornerbacks, safeties, edge rushers or linebackers that make a matchup easier, or key players returning that make it harder.
4. My fantasy opponent's players: who is likely out or limited, so I know how much I need.

Then decide who to start. Every player gets one verdict: START (in the lineup), FLEX (in the lineup in a flex slot, or a close call), SIT, or OUT (injured, bye, or ruled out). Fill every lineup slot from my roster. Players whose game has already been played this week keep their slot if they were the right call.

Reply with ONLY a JSON object, no other text, in this exact shape:
{"summary":"2-4 plain sentences on the key decisions","lineup":[{"slot":"QB","name":"..."}],"players":[{"name":"exact name from my roster","verdict":"START|FLEX|SIT|OUT","note":"1-2 sentences of reasoning, mentioning any teammate or defense injury that matters","injury":"designation or empty string"}],"injuryImpacts":[{"player":"injured player and team","affects":"which of my or my opponent's players","effect":"one short sentence"}],"opponentOutlook":"1-2 sentences, or empty string"}`;
}

async function callApi(body) {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    const err = new Error(`API ${res.status}: ${t.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function askClaude(prompt) {
  const messages = [{ role: "user", content: prompt }];
  const tools = [{ type: "web_search_20250305", name: "web_search", max_uses: MAX_SEARCHES }];
  const allBlocks = [];
  let last;
  // Server-side web search can pause a long turn; continue it a few times.
  for (let i = 0; i < 5; i++) {
    last = await callApi({ model: MODEL, max_tokens: 16000, tools, messages });
    allBlocks.push(...(last.content || []));
    if (last.stop_reason !== "pause_turn") break;
    messages.push({ role: "assistant", content: last.content });
  }
  // The answer is the text written after the last search result.
  let start = 0;
  allBlocks.forEach((b, i) => { if (b.type === "web_search_tool_result") start = i + 1; });
  const answer = allBlocks.slice(start).filter((b) => b.type === "text").map((b) => b.text).join("");
  const everything = allBlocks.filter((b) => b.type === "text").map((b) => b.text).join("\n");
  const seen = new Map();
  for (const b of allBlocks) for (const c of b?.citations || []) {
    if (c.url && !seen.has(c.url)) seen.set(c.url, { url: c.url, title: c.title || c.url });
  }
  return { text: parseJSON(answer) ? answer : everything, sources: [...seen.values()].slice(0, 12) };
}

async function repairJSON(prompt, draft) {
  const data = await callApi({
    model: MODEL,
    max_tokens: 8000,
    messages: [
      { role: "user", content: prompt },
      { role: "assistant", content: (draft || "").slice(-30000) || "(no answer)" },
      { role: "user", content: "Your answer above was cut off or wasn't valid JSON. Using the same research, reply now with ONLY the complete JSON object in the exact shape requested. Keep each note to one sentence. No other text." },
    ],
  });
  return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
}

// Find the first complete JSON object in the text that has a "players" list.
function parseJSON(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = fence ? [fence[1], text] : [text];
  for (const t of candidates) {
    for (let i = t.indexOf("{"); i !== -1; i = t.indexOf("{", i + 1)) {
      let depth = 0, inStr = false, esc = false;
      for (let j = i; j < t.length; j++) {
        const ch = t[j];
        if (inStr) { if (esc) esc = false; else if (ch === "\\") esc = true; else if (ch === '"') inStr = false; continue; }
        if (ch === '"') inStr = true;
        else if (ch === "{") depth++;
        else if (ch === "}" && --depth === 0) {
          try { const obj = JSON.parse(t.slice(i, j + 1)); if (obj && Array.isArray(obj.players)) return obj; } catch {}
          break;
        }
      }
    }
  }
  return null;
}

function friendly(e) {
  if (e?.status === 401) return "The service isn't set up correctly. Let the site owner know.";
  if (e?.status === 429) return "Too many requests right now. Try again in a minute.";
  if (e?.status === 529 || e?.status >= 500) return "The service is temporarily unavailable. Try again shortly.";
  return e?.format ? "The analysis came back incomplete. Try again." : "The analysis didn't finish. Try again.";
}
