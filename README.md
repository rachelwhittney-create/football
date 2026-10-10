# Lineup Lock

A free fantasy football helper anyone can use. Visitors enter their roster (saved in their own browser), and the site shows each player's NFL opponent this week, who played that defense in its last four games, and what they scored. Visitors with your access code can tap **Analyze my lineup** to have Claude check injury news and pick their starters.

## What's inside

```
public/index.html              The whole website (one page)
netlify/functions/week.mjs     /api/week     — this week's NFL schedule (ESPN)
netlify/functions/matchup.mjs  /api/matchup  — last 4 games vs a defense (ESPN box scores)
netlify/functions/analyze.mjs  /api/analyze  — Claude lineup analysis (background function)
netlify/functions/roster-upload.mjs  /api/roster-upload — takes team-page screenshots (access code required)
netlify/functions/roster-read.mjs    /api/roster-read   — Claude reads the players from them (background function)
netlify/functions/ask.mjs      /api/ask      — answers questions about the game plan (background function)
netlify/functions/job.mjs      /api/job      — checks whether an analysis or screenshot read is finished
lib/espn.mjs                   Shared ESPN + fantasy-points code
lib/auth.mjs                   Access-code check
netlify.toml, package.json     Netlify settings
```

## Put it online (about 10 minutes)

1. **GitHub:** create a new repository (for example `lineup-lock`). Click **Add file → Upload files**, drag in everything from this folder (keep the folders as they are), and commit.
2. **Netlify:** go to **Add new project → Import an existing project → GitHub**, pick the repo. The build settings fill in from `netlify.toml`; just click **Deploy**.
3. **Add your secrets:** in Netlify go to **Project configuration → Environment variables** and add:
   - `ANTHROPIC_API_KEY` — your Claude API key
   - `LINEUP_PASSWORD` — the access code you'll give friends for "Analyze my lineup"
   - Optional: `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`; use `claude-haiku-5-5` to spend less)
   - Optional: `MAX_WEB_SEARCHES` (default `8` per analysis; it checks your players, their teammates, the defenses they face and your opponent's players)
   - Optional: `ANTHROPIC_VISION_MODEL` for reading screenshots (default `claude-sonnet-5-5`; `claude-haiku-5-5` is cheaper but misses more)
   - For your own league built into the site (recommended if friends are in your league): `ESPN_LEAGUE_ID` (the number after `leagueId=` in your league's address), `ESPN_S2` and `ESPN_SWID` (your ESPN cookies; see "Where do I find espn_s2 and SWID?" on the site). Mark all three as secret. Optional: `ESPN_REQUIRE_CODE` = `true` to make visitors enter the access code before the league loads.
4. **Redeploy** (Deploys → Trigger deploy) so the functions pick up the new variables.
5. Share your Netlify link.

Netlify Drop (drag-and-drop) won't work for this project because it skips the server functions. Use the GitHub route above, or the Netlify CLI (`npx netlify deploy --prod`).

## Costs

- Netlify's free plan covers the site, the functions and the storage for typical friend-group use.
- The matchup data is free. It comes from ESPN's public feeds, which are unofficial and could change without notice.
- **Import from screenshots** costs a fraction of a cent per import and also needs the access code. Screenshots are deleted right after Claude reads them.
- **Analyze my lineup** costs more, billed to your Claude API account: the model's tokens plus web searches ($10 per 1,000 searches). Each analysis uses up to 8 searches. Only people with your access code can run it. Change `LINEUP_PASSWORD` any time to cut someone off.

- **Ask about your game plan** questions cost about a cent or two each (up to 3 web searches when fresh news matters; change with `MAX_QUESTION_SEARCHES`). Also needs the access code.

## ESPN league connection

**Your league, built in:** with `ESPN_LEAGUE_ID`, `ESPN_S2` and `ESPN_SWID` set, visitors just pick their team on **My roster** and everything loads, on phones too, with no cookies of their own. When your ESPN cookies expire, the site says so; copy fresh ones into Netlify and redeploy.

**Other leagues:** On **My roster**, visitors can enter their ESPN League ID to pull their league's scoring rules, lineup slots, roster and this week's opponent. Private leagues also need the visitor's `espn_s2` and `SWID` cookies (instructions are on the page). Those stay in the visitor's browser and are passed to ESPN for each request only; `netlify/functions/espn-league.mjs` never stores or logs them. ESPN's fantasy feed is unofficial and could change; screenshot import and manual entry still work as a backup.

## Notes

- Rosters live in each visitor's browser. Clearing site data or switching devices starts fresh.
- Matchup results are cached for 6 hours to keep the site fast.
- Kickers are listed but not graded.
