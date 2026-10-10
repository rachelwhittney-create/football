// POST /api/espn-league
// Body: { leagueId, season?, espn_s2?, swid? }  or  { useDefault: true, password? } for the site owner's league
// Reads an ESPN Fantasy Football league: scoring rules, lineup slots, every team's roster,
// and this week's matchups. Private leagues need the visitor's espn_s2 and SWID cookies.
// Those are passed through to ESPN for this one request and are never stored or logged.
// ESPN's fantasy feed is unofficial and may change.

import { checkCode } from "../../lib/auth.mjs";

const POS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DST" };
const PRO = { 1: "ATL", 2: "BUF", 3: "CHI", 4: "CIN", 5: "CLE", 6: "DAL", 7: "DEN", 8: "DET", 9: "GB", 10: "TEN",
  11: "IND", 12: "KC", 13: "LV", 14: "LAR", 15: "MIA", 16: "MIN", 17: "NE", 18: "NO", 19: "NYG", 20: "NYJ",
  21: "PHI", 22: "ARI", 23: "PIT", 24: "LAC", 25: "SF", 26: "SEA", 27: "TB", 28: "WAS", 29: "CAR", 30: "JAX",
  33: "BAL", 34: "HOU" };
// Lineup slot ids -> names, in the order a lineup is usually listed.
const SLOT = { 0: "QB", 2: "RB", 4: "WR", 6: "TE", 23: "FLEX", 3: "RB/WR", 5: "WR/TE", 7: "OP", 16: "DST", 17: "K", 20: "BE", 21: "IR" };
const SLOT_ORDER = [0, 2, 4, 6, 23, 3, 5, 7, 16, 17];
const INJ = { QUESTIONABLE: "Q", DOUBTFUL: "D", OUT: "O", INJURY_RESERVE: "IR", SUSPENSION: "SSPD" };

export default async (req) => {
  if (req.method !== "POST") return Response.json({ error: "Use POST." }, { status: 405 });
  let b;
  try { b = await req.json(); } catch { return Response.json({ error: "Bad request." }, { status: 400 }); }

  // The site owner's league, set once in Netlify (ESPN_LEAGUE_ID, ESPN_S2, ESPN_SWID).
  const useDefault = b?.useDefault === true;
  if (useDefault) {
    if (!process.env.ESPN_LEAGUE_ID) return Response.json({ error: "No league is set up on this site." }, { status: 404 });
    if (process.env.ESPN_REQUIRE_CODE === "true") {
      const problem = checkCode(b.password);
      if (problem) return Response.json({ error: problem === "Wrong access code." ? "Enter the access code to view this league." : problem }, { status: 403 });
    }
  }
  const leagueId = String(useDefault ? process.env.ESPN_LEAGUE_ID : b?.leagueId || "").trim();
  if (!/^\d{3,12}$/.test(leagueId)) return Response.json({ error: "League ID should be the number from your ESPN league's web address (leagueId=...)." }, { status: 400 });
  const season = /^\d{4}$/.test(String(b?.season)) ? String(b.season) : String(new Date().getFullYear());
  const s2 = String((useDefault ? process.env.ESPN_S2 : b?.espn_s2) || "").trim();
  let swid = String((useDefault ? process.env.ESPN_SWID : b?.swid) || "").trim();
  if (swid && !swid.startsWith("{")) swid = `{${swid}}`;
  if ((s2 && !/^[A-Za-z0-9%+/=._-]{20,600}$/.test(s2)) || (swid && !/^\{[0-9A-Fa-f-]{36}\}$/.test(swid))) {
    return Response.json({ error: "Those cookie values don't look right. Copy espn_s2 and SWID again." }, { status: 400 });
  }

  const url = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}` +
    `?view=mSettings&view=mTeam&view=mRoster&view=mMatchup`;
  const headers = { Accept: "application/json", "User-Agent": "LineupLock/1.0" };
  if (s2 && swid) headers.Cookie = `espn_s2=${s2}; SWID=${swid}`;

  let data;
  try {
    const res = await fetch(url, { headers, redirect: "manual" });
    const type = res.headers.get("content-type") || "";
    if (res.status === 404) return Response.json({ error: `No league ${leagueId} found for the ${season} season.` }, { status: 404 });
    if (res.status === 401 || res.status === 403 || (res.status >= 300 && res.status < 400) || !type.includes("json")) {
      return Response.json({ error: useDefault
        ? "The league connection has expired. Let the site owner know so they can update it."
        : s2 ? "ESPN didn't accept those cookies. They may have expired: copy fresh espn_s2 and SWID values." : "This league is private. Add your espn_s2 and SWID cookies." }, { status: 403 });
    }
    if (!res.ok) throw new Error(String(res.status));
    data = await res.json();
  } catch {
    return Response.json({ error: "Couldn't reach ESPN Fantasy. Try again in a few minutes." }, { status: 502 });
  }

  const settings = data.settings || {};
  const items = settings.scoringSettings?.scoringItems || [];
  const pts = (id) => items.find((i) => i.statId === id)?.points;
  const recPts = pts(53) ?? 0;
  const scoring = recPts >= 1 ? "PPR" : recPts >= 0.5 ? "Half PPR" : "Standard";
  const notes = [];
  if (recPts && recPts !== 1 && recPts !== 0.5) notes.push(`${recPts} pts per reception`);
  const passTd = pts(4); if (passTd != null && passTd !== 4) notes.push(`${passTd} pts per passing TD`);
  const int = pts(20); if (int != null && int !== -2) notes.push(`${int} pts per interception thrown`);
  const teRec = items.find((i) => i.statId === 53 && i.pointsOverrides?.["6"] != null)?.pointsOverrides?.["6"];
  if (teRec != null && teRec !== recPts) notes.push(`TE premium: ${teRec} pts per TE reception`);

  const counts = settings.rosterSettings?.lineupSlotCounts || {};
  const slots = [];
  for (const id of SLOT_ORDER) for (let n = 0; n < (counts[id] || 0); n++) slots.push(SLOT[id] === "OP" ? "SUPERFLEX" : SLOT[id]);
  const rosterSize = Object.entries(counts).reduce((t, [id, n]) => t + (Number(id) === 21 ? 0 : n), 0);

  const period = data.status?.currentMatchupPeriod ?? data.scoringPeriodId ?? null;
  const teams = (data.teams || []).map((t) => ({
    id: t.id,
    name: (t.name || `${t.location || ""} ${t.nickname || ""}`).trim() || `Team ${t.id}`,
    abbrev: t.abbrev || "",
    owners: (t.owners || []).map(String),
    players: (t.roster?.entries || []).map((e) => {
      const p = e.playerPoolEntry?.player || {};
      return {
        name: p.fullName || "",
        pos: POS[p.defaultPositionId] || "",
        team: PRO[p.proTeamId] || "",
        status: INJ[p.injuryStatus] || (e.lineupSlotId === 21 ? "IR" : ""),
        slot: SLOT[e.lineupSlotId] || "",
      };
    }).filter((p) => p.name),
  }));
  const matchups = (data.schedule || [])
    .filter((m) => m.matchupPeriodId === period && m.home && m.away)
    .map((m) => ({ home: m.home.teamId, away: m.away.teamId }));
  // On the shared league everyone sees the same owner login, so let each visitor pick their own team.
  const myTeamId = swid && !useDefault ? teams.find((t) => t.owners.some((o) => o.toUpperCase() === swid.toUpperCase()))?.id ?? null : null;

  return Response.json({
    league: { id: leagueId, season, name: settings.name || "ESPN league", scoring, scoringNotes: notes.join("; "), slots: slots.join(", "), rosterSize, week: period },
    teams: teams.map(({ owners, ...t }) => t),
    matchups,
    myTeamId,
  }, { headers: { "Cache-Control": "no-store" } });
};

export const config = { path: "/api/espn-league" };
