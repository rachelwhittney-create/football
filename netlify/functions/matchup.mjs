// GET /api/matchup?opp=BAL&pos=WR&scoring=PPR
// Who played the `opp` defense in its last 4 games at `pos`, and what they scored.
// For pos=DST it describes the `opp` OFFENSE instead (points scored, sacks taken, turnovers),
// since that's what a fantasy defense is up against.
import { getStore } from "@netlify/blobs";
import {
  TEAMS, completedGames, rosterPositions, boxscore, playerLines, fantasyPoints, statLine, offenseSummary,
} from "../../lib/espn.mjs";

const POS = ["QB", "RB", "WR", "TE", "DST"];
const REC_PTS = { PPR: 1, HALF: 0.5, STANDARD: 0 };
const FRESH_MS = 6 * 60 * 60 * 1000;

export default async (req) => {
  const url = new URL(req.url);
  const opp = String(url.searchParams.get("opp") || "").toUpperCase();
  const pos = String(url.searchParams.get("pos") || "").toUpperCase();
  const scoring = String(url.searchParams.get("scoring") || "PPR").toUpperCase().replace(/\s+/g, "");
  const recPts = REC_PTS[scoring === "HALFPPR" ? "HALF" : scoring] ?? 1;
  if (!TEAMS.includes(opp) || !POS.includes(pos)) {
    return Response.json({ error: "Unknown team or position." }, { status: 400 });
  }

  const key = `${opp}-${pos}-${recPts}`;
  let store = null;
  try { store = getStore("matchups"); } catch { /* Blobs unavailable (e.g. plain local run) */ }
  if (store) {
    try {
      const cached = await store.get(key, { type: "json" });
      if (cached && Date.now() - cached.fetchedAt < FRESH_MS) return reply(cached);
    } catch { /* ignore cache errors */ }
  }

  try {
    const games = (await completedGames(opp)).slice(0, 4);
    let faced;
    if (pos === "DST") {
      faced = await Promise.all(games.map(async (g) => {
        const s = await boxscore(g.id);
        const o = offenseSummary(s, opp, g.myScore);
        return { week: g.week, name: `${opp} offense`, team: `vs ${g.opp}`, value: o.points,
          pts: `${o.points} pts`, line: `${o.sacks} sacks taken, ${o.turnovers} turnovers` };
      }));
    } else {
      faced = await Promise.all(games.map(async (g) => {
        const [s, positions] = await Promise.all([boxscore(g.id), rosterPositions(g.opp)]);
        const lines = Object.values(playerLines(s, g.opp)).filter((L) => {
          const p = positions[L.id] || "";
          return pos === "RB" ? p === "RB" || p === "FB" : p === pos;
        });
        lines.sort((a, b) => fantasyPoints(b, recPts) - fantasyPoints(a, recPts));
        const top = lines[0];
        if (!top) return { week: g.week, name: "—", team: g.opp, value: 0, pts: "0.0", line: "No player at this position recorded stats" };
        const v = fantasyPoints(top, recPts);
        return { week: g.week, name: top.name, team: g.opp, value: Math.round(v * 10) / 10, pts: v.toFixed(1), line: statLine(top, pos) };
      }));
    }
    const avg = faced.length ? Math.round((faced.reduce((t, f) => t + f.value, 0) / faced.length) * 10) / 10 : null;
    const data = { opp, pos, recPts, games: faced.length, avg, faced, fetchedAt: Date.now() };
    if (store) { try { await store.setJSON(key, data); } catch { /* ignore */ } }
    return reply(data);
  } catch (e) {
    return Response.json({ error: "Couldn't load game data from ESPN. Try again in a few minutes." }, { status: 502 });
  }
};

function reply(data) {
  return Response.json(data, {
    headers: { "Cache-Control": "public, max-age=600", "Netlify-CDN-Cache-Control": "public, s-maxage=3600" },
  });
}

export const config = { path: "/api/matchup" };
