// GET /api/week -> this week's NFL games from ESPN's scoreboard.
import { currentWeek } from "../../lib/espn.mjs";

export default async () => {
  try {
    const data = await currentWeek();
    return Response.json(data, {
      headers: { "Cache-Control": "public, max-age=300", "Netlify-CDN-Cache-Control": "public, s-maxage=900" },
    });
  } catch (e) {
    return Response.json({ error: "Couldn't load this week's schedule from ESPN. Try again in a few minutes." }, { status: 502 });
  }
};

export const config = { path: "/api/week" };
