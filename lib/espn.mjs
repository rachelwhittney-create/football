// Shared helpers for reading ESPN's public NFL feeds and turning box scores into fantasy points.
// These feeds are unofficial: if ESPN changes them, the functions return an error instead of bad data.

const BASE = "https://site.api.espn.com/apis/site/v2/sports/football/nfl";

// Our app uses WAS for Washington; ESPN uses WSH.
export const toEspn = (t) => (String(t).toUpperCase() === "WAS" ? "WSH" : String(t).toUpperCase());
export const fromEspn = (t) => (String(t).toUpperCase() === "WSH" ? "WAS" : String(t).toUpperCase());

export const TEAMS = "ARI ATL BAL BUF CAR CHI CIN CLE DAL DEN DET GB HOU IND JAX KC LAC LAR LV MIA MIN NE NO NYG NYJ PHI PIT SEA SF TB TEN WAS".split(" ");

export async function getJSON(path) {
  const res = await fetch(BASE + path, { headers: { "User-Agent": "LineupLock/1.0", Accept: "application/json" } });
  if (!res.ok) throw new Error(`ESPN ${res.status} for ${path}`);
  return res.json();
}

// This week's games: { season, week, games: [{ home, away, date, state }] }
export async function currentWeek() {
  const sb = await getJSON("/scoreboard");
  const games = (sb.events || []).map((ev) => {
    const comp = ev.competitions?.[0] || {};
    const home = comp.competitors?.find((c) => c.homeAway === "home");
    const away = comp.competitors?.find((c) => c.homeAway === "away");
    return {
      id: ev.id,
      date: ev.date,
      state: comp.status?.type?.state || "pre", // pre | in | post
      home: fromEspn(home?.team?.abbreviation || ""),
      away: fromEspn(away?.team?.abbreviation || ""),
      homeScore: home?.score ?? null,
      awayScore: away?.score ?? null,
    };
  });
  return { season: sb.season?.year ?? null, week: sb.week?.number ?? null, games };
}

// A team's completed regular-season games, most recent first.
export async function completedGames(team) {
  const data = await getJSON(`/teams/${toEspn(team).toLowerCase()}/schedule?seasontype=2`);
  return (data.events || [])
    .map((ev) => {
      const comp = ev.competitions?.[0] || {};
      const me = comp.competitors?.find((c) => fromEspn(c.team?.abbreviation) === fromEspn(team));
      const them = comp.competitors?.find((c) => fromEspn(c.team?.abbreviation) !== fromEspn(team));
      return {
        id: ev.id,
        week: ev.week?.number ?? null,
        date: ev.date,
        done: !!comp.status?.type?.completed,
        opp: fromEspn(them?.team?.abbreviation || ""),
        oppScore: Number(them?.score?.value ?? them?.score?.displayValue ?? them?.score ?? 0),
        myScore: Number(me?.score?.value ?? me?.score?.displayValue ?? me?.score ?? 0),
      };
    })
    .filter((g) => g.done && g.opp)
    .sort((a, b) => new Date(b.date) - new Date(a.date));
}

// Map of athlete id -> position abbreviation for a team (QB, RB, WR, TE, FB...).
export async function rosterPositions(team) {
  const data = await getJSON(`/teams/${toEspn(team).toLowerCase()}/roster`);
  const map = {};
  for (const group of data.athletes || []) {
    for (const a of group.items || []) map[a.id] = a.position?.abbreviation || "";
  }
  return map;
}

export async function boxscore(eventId) {
  return getJSON(`/summary?event=${encodeURIComponent(eventId)}`);
}

const num = (v) => {
  const n = parseFloat(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
};
const col = (group, label) => (group.labels || []).indexOf(label);

// Per-player stat lines for one team in one box score.
export function playerLines(summary, team) {
  const side = (summary.boxscore?.players || []).find((p) => fromEspn(p.team?.abbreviation) === fromEspn(team));
  const lines = {};
  if (!side) return lines;
  const get = (id, name) => (lines[id] ||= { id, name, pass: [0, 0, 0], rush: [0, 0, 0], rec: [0, 0, 0, 0], fumLost: 0 });
  for (const g of side.statistics || []) {
    for (const a of g.athletes || []) {
      const id = a.athlete?.id;
      if (!id) continue;
      const L = get(id, a.athlete.displayName);
      const s = a.stats || [];
      if (g.name === "passing") L.pass = [num(s[col(g, "YDS")]), num(s[col(g, "TD")]), num(s[col(g, "INT")])];
      if (g.name === "rushing") L.rush = [num(s[col(g, "YDS")]), num(s[col(g, "TD")]), num(s[col(g, "CAR")])];
      if (g.name === "receiving") L.rec = [num(s[col(g, "REC")]), num(s[col(g, "YDS")]), num(s[col(g, "TD")]), num(s[col(g, "TGTS")])];
      if (g.name === "fumbles") L.fumLost = num(s[col(g, "LOST")]);
    }
  }
  return lines;
}

// Fantasy points. recPts: 1 for PPR, 0.5 for half, 0 for standard.
export function fantasyPoints(L, recPts = 1) {
  const [pYds, pTd, pInt] = L.pass;
  const [rYds, rTd] = L.rush;
  const [rec, recYds, recTd] = L.rec;
  return pYds * 0.04 + pTd * 4 - pInt * 2 + rYds * 0.1 + rTd * 6 + rec * recPts + recYds * 0.1 + recTd * 6 - L.fumLost * 2;
}

export function statLine(L, pos) {
  const [pYds, pTd, pInt] = L.pass;
  const [rYds, rTd, car] = L.rush;
  const [rec, recYds, recTd] = L.rec;
  if (pos === "QB") return `${pYds} pass yds, ${pTd} TD, ${pInt} INT${rYds ? `, ${rYds} rush yds` : ""}${rTd ? `, ${rTd} rush TD` : ""}`;
  const parts = [];
  if (car) parts.push(`${car}-${rYds} rush`);
  if (rec || recYds) parts.push(`${rec}-${recYds} rec`);
  const td = rTd + recTd;
  if (td) parts.push(`${td} TD`);
  return parts.join(", ") || "0 yds";
}

// Offensive summary for a team in one box score (used for D/ST matchups).
export function offenseSummary(summary, team, points) {
  const side = (summary.boxscore?.players || []).find((p) => fromEspn(p.team?.abbreviation) === fromEspn(team));
  let sacks = 0, ints = 0, fumLost = 0;
  for (const g of side?.statistics || []) {
    for (const a of g.athletes || []) {
      const s = a.stats || [];
      if (g.name === "passing") {
        ints += num(s[col(g, "INT")]);
        sacks += num(String(s[col(g, "SACKS")] || "0").split("-")[0]);
      }
      if (g.name === "fumbles") fumLost += num(s[col(g, "LOST")]);
    }
  }
  return { points, sacks, turnovers: ints + fumLost };
}
