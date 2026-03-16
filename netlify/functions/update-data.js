const { schedule } = require("@netlify/functions");
const { getStore } = require("@netlify/blobs");

const TANK01_KEY = process.env.TANK01_KEY;
const TANK_HEADERS = {
  "x-rapidapi-key": TANK01_KEY || "",
  "x-rapidapi-host": "tank01-fantasy-stats.p.rapidapi.com",
};

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

const TEAM_ABBRS = [
  "ATL","BOS","BKN","CHA","CHI","CLE","DAL","DEN","DET","GS",
  "HOU","IND","LAC","LAL","MEM","MIA","MIL","MIN","NO","NYK",
  "OKC","ORL","PHI","PHO","POR","SAC","SA","TOR","UTA","WAS"
];

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
            pts: pts.toFixed(1), reb: reb.toFixed(1), ast: ast.toFixed(1), fg3m: fg3m.toFixed(1),
            pts20:hr(pts,20), pts15:hr(pts,15), pts10:hr(pts,10), pts5:hr(pts,5),
            reb8:hr(reb,8), reb6:hr(reb,6), reb4:hr(reb,4),
            ast4:hr(ast,4), ast2:hr(ast,2),
            fg3_2:hr(fg3m,2), fg3_1:hr(fg3m,1),
          });
        }
      }
      return { abbr, roster: roster.slice(0,13), stats: stats.sort((a,b)=>parseFloat(b.pts)-parseFloat(a.pts)).slice(0,10) };
    }));
    for (const r of results) rosters[r.abbr] = { roster: r.roster, stats: r.stats };
    if (i+5 < TEAM_ABBRS.length) await new Promise(r => setTimeout(r, 500));
  }
  return rosters;
}

async function fetchAllInjuries() {
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

// 9 AM ET = 14:00 UTC, 5 PM ET = 22:00 UTC
exports.handler = schedule("0 14,22 * * *", async () => {
  const now = new Date().toISOString();
  console.log(`NBA data update starting at ${now}`);
  try {
    const [rosters, injuries] = await Promise.all([fetchAllRosters(), fetchAllInjuries()]);
    const store = getStore("nba-data");
    await store.set("latest", JSON.stringify({ updatedAt: now, date: todayET(), rosters, injuries }));
    console.log(`✅ Done — ${Object.keys(rosters).length} teams`);
    return { statusCode: 200, body: JSON.stringify({ ok: true, updatedAt: now }) };
  } catch (err) {
    console.error("Failed:", err.message);
    return { statusCode: 500, body: JSON.stringify({ error: err.message }) };
  }
});
