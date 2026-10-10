// GET /api/config -> what this site has set up (no secrets).
export default async () => Response.json({
  defaultLeague: !!process.env.ESPN_LEAGUE_ID,
  leagueNeedsCode: process.env.ESPN_REQUIRE_CODE === "true",
}, { headers: { "Cache-Control": "public, max-age=300" } });

export const config = { path: "/api/config" };
