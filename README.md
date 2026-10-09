# Lineup Lock

A free fantasy football helper anyone can use. Visitors enter their roster (saved in their own browser), and the site shows each player's NFL opponent this week, who played that defense in its last four games, and what they scored. Visitors with your access code can tap **Analyze my lineup** to have Claude check injury news and pick their starters.

## What's inside

```
public/index.html              The whole website (one page)
netlify/functions/week.mjs     /api/week     — this week's NFL schedule (ESPN)
netlify/functions/matchup.mjs  /api/matchup  — last 4 games vs a defense (ESPN box scores)
netlify/functions/analyze.mjs  /api/analyze  — Claude lineup analysis (background function)
netlify/functions/job.mjs      /api/job      — checks whether an analysis is finished
lib/espn.mjs                   Shared ESPN + fantasy-points code
netlify.toml, package.json     Netlify settings
```

## Put it online (about 10 minutes)

1. **GitHub:** create a new repository (for example `lineup-lock`). Click **Add file → Upload files**, drag in everything from this folder (keep the folders as they are), and commit.
2. **Netlify:** go to **Add new project → Import an existing project → GitHub**, pick the repo. The build settings fill in from `netlify.toml`; just click **Deploy**.
3. **Add your secrets:** in Netlify go to **Project configuration → Environment variables** and add:
   - `ANTHROPIC_API_KEY` — your Claude API key
   - `LINEUP_PASSWORD` — the access code you'll give friends for "Analyze my lineup"
   - Optional: `ANTHROPIC_MODEL` (default `claude-sonnet-5-5`; use `claude-haiku-5-5` to spend less)
   - Optional: `MAX_WEB_SEARCHES` (default `5` per analysis)
4. **Redeploy** (Deploys → Trigger deploy) so the functions pick up the new variables.
5. Share your Netlify link.

Netlify Drop (drag-and-drop) won't work for this project because it skips the server functions. Use the GitHub route above, or the Netlify CLI (`npx netlify deploy --prod`).

## Costs

- Netlify's free plan covers the site, the functions and the storage for typical friend-group use.
- The matchup data is free. It comes from ESPN's public feeds, which are unofficial and could change without notice.
- Only **Analyze my lineup** costs money, billed to your Claude API account: the model's tokens plus web searches ($10 per 1,000 searches). Each analysis uses up to 5 searches. Only people with your access code can run it. Change `LINEUP_PASSWORD` any time to cut someone off.

## Notes

- Rosters live in each visitor's browser. Clearing site data or switching devices starts fresh.
- Matchup results are cached for 6 hours to keep the site fast.
- Kickers are listed but not graded.
