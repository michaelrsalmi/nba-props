// Netlify Scheduled Function — runs at 9 AM ET and 5 PM ET daily
// Schedule defined in netlify.toml

const { schedule } = require("@netlify/functions");

const TANK01_KEY = process.env.TANK01_KEY;
const BLOB_TOKEN = process.env.NETLIFY_BLOBS_TOKEN || process.env.BLOB_TOKEN;

const TANK_HEADERS = {
  "x-rapidapi-key": TANK01_KEY || "",
  "x-rapidapi-host": "tank01-fantasy-stats.p.rapidapi.com",
};

const NBA_CDN_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
  "Referer": "https://www.nba.com/",
  "Accept": "application/json",
};

async function safeFetch(url, opts = {}) {
  try {
    const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(10000) });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

function todayET() {
  const now = new Date();
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const y = et.getFullYear();
  const m = String(et.getMonth()+1).padStart(2,"0");
  const d = String(et.getDate()).padStart(2,"0");
  return `${y}${m}${d}`;
}

const TEAM_ABBRS = [
  "ATL","BOS","BKN","CHA","CHI","CLE","DAL","DEN","DET","GS",
  "HOU","IND","LAC","LAL","MEM","MIA","MIL","MIN","NO","NYK",
  "OKC","ORL","PHI","PHO","POR","SAC","SA","TOR","UTA","WAS"
];

async function fetchAllRosters() {
  const rosters = {};
  // Fetch in batches of 5 to avoid rate limits
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
          const hitRate = (avg, threshold) => {
            if (avg <= 0) return 0;
            const r = avg / threshold;
            if (r >= 2.0) return 10; if (r >= 1.6) return 9;
            if (r >= 1.35) return 8; if (r >= 1.15) return 7;
            if (r >= 1.0)  return 6; if (r >= 0.85) return 4;
            if (r >= 0.7)  return 2; return 1;
          };
          stats.push({
            name, gp,
            pts: pts.toFixed(1), reb: reb.toFixed(1),
            ast: ast.toFixed(1), fg3m: fg3m.toFixed(1),
            pts20: hitRate(pts,20), pts15: hitRate(pts,15),
            pts10: hitRate(pts,10), pts5:  hitRate(pts,5),
            reb8:  hitRate(reb,8),  reb6:  hitRate(reb,6),  reb4: hitRate(reb,4),
            ast4:  hitRate(ast,4),  ast2:  hitRate(ast,2),
            fg3_2: hitRate(fg3m,2), fg3_1: hitRate(fg3m,1),
          });
        }
      }

      return {
        abbr,
        roster: roster.slice(0, 13),
        stats: stats.sort((a,b) => parseFloat(b.pts)-parseFloat(a.pts)).slice(0, 10)
      };
    }));
    for (const r of results) rosters[r.abbr] = { roster: r.roster, stats: r.stats };
    // Small delay between batches to be nice to rate limits
    if (i + 5 < TEAM_ABBRS.length) await new Promise(r => setTimeout(r, 500));
  }
  return rosters;
}

async function fetchAllInjuries() {
  const injuries = {};

  // Source 1: Tank01
  const tank = await safeFetch(
    `https://tank01-fantasy-stats.p.rapidapi.com/getNBAInjuryList`,
    { headers: TANK_HEADERS }
  );
  if (tank?.body) {
    const list = Array.isArray(tank.body) ? tank.body : Object.values(tank.body);
    for (const p of list) {
      const team = (p.teamAbv || p.team || "UNK").toUpperCase();
      if (!injuries[team]) injuries[team] = [];
      injuries[team].push({
        name: p.playerName || p.longName || "",
        team,
        status: p.injStatus || p.status || "Out",
        desc: p.injDescription || p.description || "",
        source: "Tank01",
      });
    }
  }

  // Source 2: NBA CDN official
  const nba = await safeFetch(
    "https://cdn.nba.com/static/json/liveData/injuryreport/injuryreport.json"
  );
  if (nba?.injuryReport) {
    for (const p of nba.injuryReport) {
      const tricode = (p.teamTricode || p.teamAbv || "UNK").toUpperCase();
      if (!injuries[tricode]) injuries[tricode] = [];
      // Check not already added
      const exists = injuries[tricode].find(x => x.name.toLowerCase() === (p.playerName||"").toLowerCase());
      if (!exists) {
        injuries[tricode].push({
          name: p.playerName || "",
          team: tricode,
          status: p.currentStatus || "Out",
          desc: p.reason || "",
          source: "NBA Official",
        });
      }
    }
  }

  return injuries;
}

const handler = schedule("0 9,17 * * *", async () => {
  console.log("Running scheduled data update...");
  const now = new Date().toISOString();
  const date = todayET();

  try {
    const [rosters, injuries] = await Promise.all([
      fetchAllRosters(),
      fetchAllInjuries(),
    ]);

    const payload = {
      updatedAt: now,
      date,
      rosters,
      injuries,
    };

    // Store in Netlify Blobs
    const { getStore } = require("@netlify/blobs");
    const store = getStore("nba-data");
    await store.set("latest", JSON.stringify(payload));

    console.log(`✅ Data updated at ${now} — ${Object.keys(rosters).length} teams, injuries for ${Object.keys(injuries).length} teams`);
    return { statusCode: 200 };
  } catch (err) {
    console.error("Update failed:", err);
    return { statusCode: 500 };
  }
});

module.exports = { handler };
