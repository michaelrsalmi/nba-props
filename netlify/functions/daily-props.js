const { schedule } = require("@netlify/functions");
const { getStore } = require("@netlify/blobs");

const TANK01_KEY    = process.env.TANK01_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

const TANK_HEADERS = {
  "x-rapidapi-key": TANK01_KEY || "",
  "x-rapidapi-host": "tank01-fantasy-stats.p.rapidapi.com",
};

const TEAM_ABBRS = [
  "ATL","BOS","BKN","CHA","CHI","CLE","DAL","DEN","DET","GS",
  "HOU","IND","LAC","LAL","MEM","MIA","MIL","MIN","NO","NYK",
  "OKC","ORL","PHI","PHO","POR","SAC","SA","TOR","UTA","WAS"
];

async function safeFetch(url, opts = {}) {
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function todayET() {
  const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
  return `${et.getFullYear()}${String(et.getMonth()+1).padStart(2,"0")}${String(et.getDate()).padStart(2,"0")}`;
}

function todayReadable() {
  return new Date().toLocaleDateString("en-US", {
    timeZone: "America/New_York",
    weekday: "long", month: "long", day: "numeric", year: "numeric"
  });
}

// ── Fetch all rosters + stats from Tank01 ──────────────────────────────
async function fetchAllRosters() {
  const rosters = {};
  for (let i = 0; i < TEAM_ABBRS.length; i += 5) {
    const batch = TEAM_ABBRS.slice(i, i+5);
    const results = await Promise.all(batch.map(async (abbr) => {
      const data = await safeFetch(
        `https://tank01-fantasy-stats.p.rapidapi.com/getNBATeamRoster?teamAbv=${abbr}&statsToGet=averages`,
        { headers: TANK_HEADERS }
      );
      if (!data?.body?.roster) return { abbr, roster: [], stats: [] };
      const rosterObj = data.body.roster;
      const players = Array.isArray(rosterObj) ? rosterObj : Object.values(rosterObj);
      const roster = [];
      const stats = [];
      for (const player of players) {
        const name = player.longName || player.espnName || player.name || "";
        if (!name) continue;
        roster.push(name);
        const s = player.stats;
        if (s && parseFloat(s.gamesPlayed || 0) >= 5) {
          const pts  = parseFloat(s.pts   || 0);
          const reb  = parseFloat(s.reb   || 0);
          const ast  = parseFloat(s.ast   || 0);
          const fg3m = parseFloat(s.tptfgm || s.TPM || s.fg3m || 0);
          const gp   = parseInt(s.gamesPlayed || 0);
          const hr = (avg, t) => {
            if (avg <= 0) return 0;
            const r = avg/t;
            if (r>=2.0) return 10; if (r>=1.6) return 9; if (r>=1.35) return 8;
            if (r>=1.15) return 7; if (r>=1.0) return 6; if (r>=0.85) return 4;
            if (r>=0.7) return 2; return 1;
          };
          stats.push({
            name, gp,
            pts: pts.toFixed(1), reb: reb.toFixed(1),
            ast: ast.toFixed(1), fg3m: fg3m.toFixed(1),
            pts20:hr(pts,20), pts15:hr(pts,15), pts10:hr(pts,10), pts5:hr(pts,5),
            reb8:hr(reb,8), reb6:hr(reb,6), reb4:hr(reb,4),
            ast4:hr(ast,4), ast2:hr(ast,2),
            fg3_2:hr(fg3m,2), fg3_1:hr(fg3m,1),
          });
        }
      }
      return {
        abbr,
        roster: roster.slice(0,13),
        stats: stats.sort((a,b) => parseFloat(b.pts)-parseFloat(a.pts)).slice(0,10)
      };
    }));
    for (const r of results) rosters[r.abbr] = { roster: r.roster, stats: r.stats };
    if (i+5 < TEAM_ABBRS.length) await new Promise(r => setTimeout(r, 500));
  }
  return rosters;
}

// ── Fetch base injuries from Tank01 + NBA CDN ──────────────────────────
async function fetchBaseInjuries() {
  const injuries = {};
  const add = (team, name, status, desc, src) => {
    if (!name || !team) return;
    const t = team.toUpperCase();
    if (!injuries[t]) injuries[t] = [];
    if (!injuries[t].find(x => x.name.toLowerCase() === name.toLowerCase())) {
      injuries[t].push({ name, team: t, status, desc, source: src });
    }
  };
  const [tank, nba] = await Promise.all([
    safeFetch(`https://tank01-fantasy-stats.p.rapidapi.com/getNBAInjuryList`, { headers: TANK_HEADERS }),
    safeFetch("https://cdn.nba.com/static/json/liveData/injuryreport/injuryreport.json"),
  ]);
  if (tank?.body) {
    const list = Array.isArray(tank.body) ? tank.body : Object.values(tank.body);
    for (const p of list) add(p.teamAbv||p.team, p.playerName||p.longName, p.injStatus||p.status||"Out", p.injDescription||p.description||"", "Tank01");
  }
  if (nba?.injuryReport) {
    for (const p of nba.injuryReport) add(p.teamTricode||p.teamAbv, p.playerName, p.currentStatus||"Out", p.reason||"", "NBA");
  }
  return injuries;
}

// ── Use Claude with web search to get latest injury news ──────────────
async function fetchAIInjuryUpdate(baseInjuries) {
  if (!ANTHROPIC_KEY) return { confirmed: [], notes: "No Anthropic key" };

  const today = todayReadable();

  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "web-search-2025-03-05",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1500,
        tools: [{ type: "web_search_20250305", name: "web_search" }],
        system: "You are an NBA injury reporter. Search for today's official NBA injury report and recent player injury news. Return ONLY a JSON object listing injured/out players.",
        messages: [{
          role: "user",
          content: `Today is ${today}. Search for the current NBA injury report and any players ruled out or questionable for tonight's games.

Search for: "NBA injury report ${today}" and "NBA players out tonight"

Return ONLY this JSON structure, no markdown:
{
  "updatedAt": "${today}",
  "injured": [
    {
      "player": "Full Player Name",
      "team": "TEAM_ABBR",
      "status": "Out or Questionable or Doubtful",
      "reason": "injury description",
      "returnTimeline": "e.g. out for season, re-evaluated March 21, day-to-day"
    }
  ],
  "notes": "any important context about trades or roster changes"
}`
        }]
      }),
      signal: AbortSignal.timeout(25000),
    });

    const data = await res.json();
    const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    const clean = text.replace(/^```json\s*/i,"").replace(/^```\s*/i,"").replace(/\s*```$/i,"").trim();

    let parsed;
    try { parsed = JSON.parse(clean); }
    catch {
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) parsed = JSON.parse(match[0]);
      else throw new Error("No JSON in AI response");
    }

    // Merge AI findings into base injuries
    if (parsed?.injured?.length) {
      for (const p of parsed.injured) {
        const team = (p.team || "").toUpperCase();
        if (!baseInjuries[team]) baseInjuries[team] = [];
        const exists = baseInjuries[team].find(x => x.name.toLowerCase() === (p.player||"").toLowerCase());
        if (!exists) {
          baseInjuries[team].push({
            name: p.player,
            team,
            status: p.status || "Out",
            desc: `${p.reason || ""}${p.returnTimeline ? " ("+p.returnTimeline+")" : ""}`,
            source: "AI Web Search"
          });
        } else {
          // Update existing entry with fresher AI data
          exists.status = p.status || exists.status;
          exists.desc = `${p.reason || exists.desc}${p.returnTimeline ? " ("+p.returnTimeline+")" : ""}`;
          exists.source = "AI Web Search + " + exists.source;
        }
      }
    }

    return { confirmed: parsed?.injured || [], notes: parsed?.notes || "" };
  } catch(e) {
    console.error("AI injury search failed:", e.message);
    return { confirmed: [], notes: `AI search failed: ${e.message}` };
  }
}

// ── Scheduled handler: 9 AM ET + 5 PM ET ──────────────────────────────
// 9 AM ET = 14:00 UTC, 5 PM ET = 22:00 UTC
exports.handler = schedule("0 14,22 * * *", async () => {
  const now = new Date().toISOString();
  console.log(`NBA data update starting at ${now}`);

  try {
    // Fetch rosters and base injuries in parallel
    const [rosters, baseInjuries] = await Promise.all([
      fetchAllRosters(),
      fetchBaseInjuries(),
    ]);

    // Then enhance injuries with AI web search
    const aiInjuries = await fetchAIInjuryUpdate(baseInjuries);

    const store = getStore("nba-data");
    await store.set("latest", JSON.stringify({
      updatedAt: now,
      date: todayET(),
      rosters,
      injuries: baseInjuries,
      aiInjuryNotes: aiInjuries.notes,
      aiInjuryCount: aiInjuries.confirmed.length,
    }));

    console.log(`✅ Done — ${Object.keys(rosters).length} teams, AI found ${aiInjuries.confirmed.length} injured players`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, updatedAt: now, aiInjuries: aiInjuries.confirmed.length }) };
  } catch (err) {
    console.error("Update failed:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
});
