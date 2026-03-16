exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const TANK01_KEY = process.env.TANK01_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  const TANK_HEADERS = {
    "x-rapidapi-key": TANK01_KEY || "",
    "x-rapidapi-host": "tank01-fantasy-stats.p.rapidapi.com",
  };

  async function safeFetch(url, opts = {}) {
    try {
      const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(9000) });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  // Format date as YYYYMMDD for Tank01
  function todayStr() {
    const now = new Date();
    // Use ET timezone
    const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    const y = et.getFullYear();
    const m = String(et.getMonth()+1).padStart(2,"0");
    const d = String(et.getDate()).padStart(2,"0");
    return `${y}${m}${d}`;
  }

  function yesterdayStr() {
    const now = new Date();
    const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
    et.setDate(et.getDate()-1);
    const y = et.getFullYear();
    const m = String(et.getMonth()+1).padStart(2,"0");
    const d = String(et.getDate()).padStart(2,"0");
    return `${y}${m}${d}`;
  }

  // ── Fetch today's schedule from Tank01 ───────────────────────────────
  async function fetchSchedule() {
    const date = todayStr();
    const data = await safeFetch(
      `https://tank01-fantasy-stats.p.rapidapi.com/getNBAGamesForDate?gameDate=${date}`,
      { headers: TANK_HEADERS }
    );
    return { data, date };
  }

  // ── Fetch live roster + stats from Tank01 ────────────────────────────
  async function fetchTeamData(teamAbv) {
    if (!TANK01_KEY) return { roster: [], stats: [] };
    const data = await safeFetch(
      `https://tank01-fantasy-stats.p.rapidapi.com/getNBATeamRoster?teamAbv=${teamAbv}&statsToGet=averages`,
      { headers: TANK_HEADERS }
    );
    if (!data?.body?.roster) return { roster: [], stats: [] };

    const roster = [];
    const stats = [];

    const rosterObj = data.body.roster;
    const players = Array.isArray(rosterObj) ? rosterObj : Object.values(rosterObj);

    for (const player of players) {
      const name = player.longName || player.espnName || player.name || "";
      if (!name) continue;
      roster.push(name);

      const s = player.stats;
      if (s && parseFloat(s.gamesPlayed || 0) >= 5) {
        const pts  = parseFloat(s.pts  || 0);
        const reb  = parseFloat(s.reb  || 0);
        const ast  = parseFloat(s.ast  || 0);
        const fg3m = parseFloat(s.tptfgm || s.TPM || s.fg3m || 0);
        const gp   = parseInt(s.gamesPlayed || 0);

        const hitRate = (avg, threshold) => {
          if (avg <= 0) return 0;
          const r = avg / threshold;
          if (r >= 2.0) return 10;
          if (r >= 1.6) return 9;
          if (r >= 1.35) return 8;
          if (r >= 1.15) return 7;
          if (r >= 1.0)  return 6;
          if (r >= 0.85) return 4;
          if (r >= 0.7)  return 2;
          return 1;
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
      roster,
      stats: stats.sort((a,b) => parseFloat(b.pts)-parseFloat(a.pts)).slice(0,10),
    };
  }

  // ── Fetch injuries from multiple sources ────────────────────────────
  async function fetchInjuries(homeAbv, awayAbv, gameId) {
    const allInjuries = new Map(); // keyed by player name to dedupe

    const addInjury = (name, team, status, desc) => {
      if (!name || name === "Unknown") return;
      const key = name.toLowerCase().trim();
      if (!allInjuries.has(key)) {
        allInjuries.set(key, { name, team, status, desc });
      }
    };

    // Source 1: NBA Official CDN (most authoritative)
    try {
      const nbaCdn = await safeFetch(
        "https://cdn.nba.com/static/json/liveData/injuryreport/injuryreport.json"
      );
      if (nbaCdn?.injuryReport) {
        const homeLast = homeAbv.toUpperCase();
        const awayLast = awayAbv.toUpperCase();
        // NBA CDN uses full team names, match by abbr via teamTricode
        for (const p of nbaCdn.injuryReport) {
          const tricode = (p.teamTricode || p.teamAbv || "").toUpperCase();
          const teamName = (p.teamName || "").toLowerCase();
          const matchesHome = tricode === homeLast || teamName.includes(homeAbv.toLowerCase());
          const matchesAway = tricode === awayLast || teamName.includes(awayAbv.toLowerCase());
          if (matchesHome || matchesAway) {
            addInjury(p.playerName, tricode || homeAbv, p.currentStatus, p.reason || "");
          }
        }
      }
    } catch {}

    // Source 2: Tank01 injury list
    if (TANK01_KEY) {
      try {
        const tank = await safeFetch(
          `https://tank01-fantasy-stats.p.rapidapi.com/getNBAInjuryList`,
          { headers: TANK_HEADERS }
        );
        if (tank?.body) {
          const list = Array.isArray(tank.body) ? tank.body : Object.values(tank.body);
          for (const p of list) {
            const t = (p.teamAbv || p.team || "").toUpperCase();
            if (t === homeAbv.toUpperCase() || t === awayAbv.toUpperCase()) {
              addInjury(
                p.playerName || p.longName || "",
                t,
                p.injStatus || p.status || "Out",
                p.injDescription || p.description || ""
              );
            }
          }
        }
      } catch {}
    }

    // Source 3: Tank01 game-specific injury report
    if (TANK01_KEY && gameId) {
      try {
        const gameData = await safeFetch(
          `https://tank01-fantasy-stats.p.rapidapi.com/getNBAGameInfo?gameID=${gameId}`,
          { headers: TANK_HEADERS }
        );
        const injSection = gameData?.body?.teamInjuries || gameData?.body?.injuries;
        if (injSection) {
          const list = Array.isArray(injSection) ? injSection : Object.values(injSection);
          for (const p of list) {
            const t = (p.teamAbv || p.team || "").toUpperCase();
            addInjury(
              p.playerName || p.longName || p.name || "",
              t,
              p.injStatus || p.status || p.designation || "Out",
              p.injDescription || p.description || ""
            );
          }
        }
      } catch {}
    }

    const lines = allInjuries.size > 0
      ? Array.from(allInjuries.values()).map(p =>
          `${p.name} (${p.team}) — ${p.status}${p.desc ? ": "+p.desc : ""}`
        )
      : ["No players on injury report for this game"];

    return { lines, source: "NBA Official + Tank01" };
  }

  // ── B2B: check yesterday's Tank01 schedule ────────────────────────────
  async function detectB2B(homeAbv, awayAbv) {
    const result = { home:false, away:false, homeYesterday:"", awayYesterday:"" };
    if (!TANK01_KEY) return result;
    const yd = yesterdayStr();
    const data = await safeFetch(
      `https://tank01-fantasy-stats.p.rapidapi.com/getNBAGamesForDate?gameDate=${yd}`,
      { headers: TANK_HEADERS }
    );
    const games = data?.body || [];
    const list = Array.isArray(games) ? games : Object.values(games);
    for (const g of list) {
      const h = (g.home || g.homeTeam || "").toUpperCase();
      const a = (g.away || g.awayTeam || "").toUpperCase();
      if (h === homeAbv || a === homeAbv) { result.home = true; result.homeYesterday = `${a}@${h}`; }
      if (h === awayAbv || a === awayAbv) { result.away = true; result.awayYesterday = `${a}@${h}`; }
    }
    return result;
  }

  // ── SCHEDULE GET ──────────────────────────────────────────────────────
  if (event.httpMethod === "GET") {
    if (!TANK01_KEY) {
      return { statusCode:500, headers, body: JSON.stringify({ error:"Missing TANK01_KEY" }) };
    }

    const { data, date } = await fetchSchedule();
    if (!data?.body) {
      return { statusCode:500, headers, body: JSON.stringify({ error:`No games found for ${date}` }) };
    }

    const gameList = Array.isArray(data.body) ? data.body : Object.values(data.body);

    // Fetch full game details to get times
    const gameDetailsPromises = gameList.map(g =>
      safeFetch(
        `https://tank01-fantasy-stats.p.rapidapi.com/getNBAGameInfo?gameID=${g.gameID || g.id}`,
        { headers: TANK_HEADERS }
      )
    );
    const gameDetails = await Promise.all(gameDetailsPromises);

    const TEAM_NAMES = {
      ATL:"Atlanta Hawks",BOS:"Boston Celtics",BKN:"Brooklyn Nets",
      CHA:"Charlotte Hornets",CHI:"Chicago Bulls",CLE:"Cleveland Cavaliers",
      DAL:"Dallas Mavericks",DEN:"Denver Nuggets",DET:"Detroit Pistons",
      GSW:"Golden State Warriors",GS:"Golden State Warriors",
      HOU:"Houston Rockets",IND:"Indiana Pacers",LAC:"LA Clippers",
      LAL:"Los Angeles Lakers",MEM:"Memphis Grizzlies",MIA:"Miami Heat",
      MIL:"Milwaukee Bucks",MIN:"Minnesota Timberwolves",
      NOP:"New Orleans Pelicans",NO:"New Orleans Pelicans",
      NYK:"New York Knicks",NY:"New York Knicks",OKC:"Oklahoma City Thunder",
      ORL:"Orlando Magic",PHI:"Philadelphia 76ers",PHX:"Phoenix Suns",PHO:"Phoenix Suns",
      POR:"Portland Trail Blazers",SAC:"Sacramento Kings",
      SAS:"San Antonio Spurs",SA:"San Antonio Spurs",
      TOR:"Toronto Raptors",UTA:"Utah Jazz",UTAH:"Utah Jazz",WAS:"Washington Wizards",
    };

    const games = gameList.map((g, i) => {
      const homeAbv = (g.homeTeam || g.home || "???").toUpperCase();
      const awayAbv = (g.awayTeam || g.away || "???").toUpperCase();
      const detail = gameDetails[i]?.body || {};

      // Parse time from gameTime field (epoch) or gameTimeTBD
      let timeStr = "TBD";
      const epochTime = detail.gameTime || g.gameTime;
      if (epochTime && epochTime !== "0") {
        try {
          const d = new Date(parseInt(epochTime) * 1000);
          timeStr = d.toLocaleTimeString("en-US", {
            hour: "numeric", minute: "2-digit",
            timeZoneName: "short", timeZone: "America/New_York"
          });
        } catch { timeStr = "TBD"; }
      }

      const homeWins = detail.homeTeamWins || g.homeTeamWins || "";
      const homeLoss = detail.homeTeamLosses || g.homeTeamLosses || "";
      const awayWins = detail.awayTeamWins || g.awayTeamWins || "";
      const awayLoss = detail.awayTeamLosses || g.awayTeamLosses || "";

      return {
        id: g.gameID || g.id || `game-${i}`,
        homeTeam: TEAM_NAMES[homeAbv] || homeAbv,
        awayTeam: TEAM_NAMES[awayAbv] || awayAbv,
        homeAbbr: homeAbv,
        awayAbbr: awayAbv,
        homeRecord: homeWins && homeLoss ? `${homeWins}-${homeLoss}` : "",
        awayRecord: awayWins && awayLoss ? `${awayWins}-${awayLoss}` : "",
        time: timeStr,
        status: detail.gameStatus || g.gameStatus || "Scheduled",
      };
    });

    return { statusCode:200, headers, body: JSON.stringify({ games, date }) };
  }

  // ── ANALYZE POST ──────────────────────────────────────────────────────
  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body||"{}"); }
    catch { return { statusCode:400, headers, body: JSON.stringify({ error:"Invalid JSON" }) }; }

    const game = body.game;
    if (!game?.homeTeam) return { statusCode:400, headers, body: JSON.stringify({ error:"No game" }) };
    if (!ANTHROPIC_KEY)  return { statusCode:500, headers, body: JSON.stringify({ error:"Missing Anthropic key" }) };

    // Try reading from cached data first (updated 9AM + 5PM ET daily)
    let homeData = { roster: [], stats: [] };
    let awayData = { roster: [], stats: [] };
    let cachedInjuries = null;
    let cacheAge = "live";

    try {
      const { getStore } = require("@netlify/blobs");
      const store = getStore("nba-data");
      const cached = await store.get("latest", { type: "text" });
      if (cached) {
        const parsed = JSON.parse(cached);
        const updatedAt = new Date(parsed.updatedAt);
        const ageHours = (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60);

        if (ageHours < 12) { // Use cache if less than 12 hours old
          homeData = parsed.rosters?.[game.homeAbbr] || { roster: [], stats: [] };
          awayData = parsed.rosters?.[game.awayAbbr] || { roster: [], stats: [] };
          cachedInjuries = parsed.injuries || null;
          cacheAge = `cached ${updatedAt.toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "numeric", minute: "2-digit" })} ET`;
        }
      }
    } catch {}

    // Fall back to live fetch if cache miss
    if (!homeData.roster.length) homeData = await fetchTeamData(game.homeAbbr);
    if (!awayData.roster.length) awayData = await fetchTeamData(game.awayAbbr);

    // Get injuries from cache or live
    let rawInjuries = null;
    if (cachedInjuries) {
      const homeInj = cachedInjuries[game.homeAbbr] || [];
      const awayInj = cachedInjuries[game.awayAbbr] || [];
      const combined = [...homeInj, ...awayInj];
      rawInjuries = {
        lines: combined.length
          ? combined.map(p => `${p.name} (${p.team}) — ${p.status}${p.desc ? ": "+p.desc : ""}`)
          : ["No players on injury report for this game"],
        source: `Tank01 + NBA Official (${cacheAge})`,
      };
    }

    const [injuryData, b2b] = await Promise.all([
      rawInjuries ? Promise.resolve(rawInjuries) : fetchInjuries(game.homeAbbr, game.awayAbbr, game.id),
      detectB2B(game.homeAbbr, game.awayAbbr),
    ]);

    const statsAvail = homeData.stats.length > 0 || awayData.stats.length > 0;

    const outPlayers = injuryData.lines
      .filter(l => /out|doubtful/i.test(l))
      .map(l => l.split(" (")[0].toLowerCase().trim());

    const fmtStats = (data, teamName) => {
      if (!data.stats.length) return `${teamName}: stats unavailable`;
      return `${teamName} (live 2025-26):\n` +
        data.stats
          .filter(p => !outPlayers.some(op => p.name.toLowerCase().includes(op)))
          .map(p =>
            `  ${p.name}: ${p.pts}pts/${p.reb}reb/${p.ast}ast/${p.fg3m}3pm (${p.gp}G) | ` +
            `20+pts:${p.pts20}/10 15+pts:${p.pts15}/10 10+pts:${p.pts10}/10 5+pts:${p.pts5}/10 | ` +
            `8+reb:${p.reb8}/10 6+reb:${p.reb6}/10 4+reb:${p.reb4}/10 | ` +
            `4+ast:${p.ast4}/10 2+ast:${p.ast2}/10 | 2+3:${p.fg3_2}/10 1+3:${p.fg3_1}/10`
          ).join("\n");
    };

    const today = new Date().toDateString();

    const prompt = `You are a sharp NBA SGP analyst for FanDuel. Today: ${today}.

GAME: ${game.awayTeam} (${game.awayAbbr}) @ ${game.homeTeam} (${game.homeAbbr})
TIME: ${game.time}
RECORDS: ${game.homeTeam} ${game.homeRecord} | ${game.awayTeam} ${game.awayRecord}

━━ LIVE ROSTERS (Tank01) ━━
${game.homeTeam}: ${homeData.roster.length ? homeData.roster.join(", ") : "unavailable"}
${game.awayTeam}: ${awayData.roster.length ? awayData.roster.join(", ") : "unavailable"}

━━ INJURY REPORT (Tank01) ━━
${injuryData.lines.join("\n")}

━━ BACK-TO-BACK (verified) ━━
${b2b.home ? `🔴 ${game.homeTeam} ON B2B — played ${b2b.homeYesterday} yesterday` : `✅ ${game.homeTeam}: rested`}
${b2b.away ? `🔴 ${game.awayTeam} ON B2B — played ${b2b.awayYesterday} yesterday` : `✅ ${game.awayTeam}: rested`}

━━ LIVE PLAYER STATS + HIT RATES (Tank01 2025-26) ━━
${statsAvail
  ? fmtStats(homeData, game.homeTeam)+"\n\n"+fmtStats(awayData, game.awayTeam)
  : "Stats unavailable — use your 2025-26 knowledge"}

━━ CONFIRMED ROSTER CHANGES & INJURIES (verified March 16 2026) ━━
These are facts — do not contradict them regardless of what your training data says:

TRADES (players are on NEW teams):
- Luka Doncic → Los Angeles Lakers (traded from DAL Feb 2025)
- Anthony Davis → Washington Wizards (traded from DAL Feb 6 2026)
- De'Aaron Fox → San Antonio Spurs
- Trae Young → Washington Wizards (traded from ATL)
- Jaren Jackson Jr. → Utah Jazz (traded from MEM at 2026 deadline)
- Desmond Bane → Orlando Magic (traded from MEM offseason 2025)
- Khris Middleton → Dallas Mavericks
- D'Angelo Russell → Washington Wizards

CONFIRMED OUT TONIGHT / EXTENDED ABSENCES:
- Stephen Curry (GSW) — OUT, missed 17 straight games, knee (patellofemoral pain), re-evaluated March 21
- Jimmy Butler (GSW) — OUT for season, torn ACL right knee
- Ja Morant (MEM) — OUT, UCL sprain left elbow, hasn't played since Jan 21, re-evaluated in ~2 weeks from March 5
- Kyrie Irving (DAL) — OUT, recovering from torn ACL (surgery March 2025)
- Anthony Davis (WAS) — likely OUT or limited, hand ligament injury, rarely playing this season
- Tyrese Haliburton (IND) — OUT for season, torn Achilles from 2025 NBA Finals

━━ CRITICAL INSTRUCTIONS ━━
YOUR TRAINING DATA FOR ROSTERS IS OUTDATED. MANY TRADES HAVE HAPPENED.
The confirmed information above OVERRIDES your training data completely.
DO NOT include any of the OUT players above as prop legs.
ONLY use the live roster listed above for all other players.
If a player is not in the live roster, DO NOT include them.

- Use EXACT hit rates for last10 values
- ONLY use players from the live rosters above
- Exclude ALL confirmed OUT players listed above
- Boost teammates of injured stars with injuryNote
- B2B teams: reduce confidence by 1 star
- Pick SAFE low thresholds for reliable SGP legs
- ALWAYS return 8-10 props using ONLY players from the live rosters

FanDuel SGP formats:
"TO SCORE 10+ POINTS" / "TO SCORE 20+ POINTS" / "TO SCORE 5+ POINTS"
"OVER 17.5 ALT POINTS"
"1+ MADE THREES" / "2+ MADE THREES"
"TO RECORD 4+ REBOUNDS" / "TO RECORD 8+ REBOUNDS"
"TO RECORD 2+ ASSISTS" / "TO RECORD 4+ ASSISTS"

Return ONLY raw JSON:
{
  "bestBet": "one sentence with real stats",
  "trend": "specific trend using live data",
  "edge": "injury/B2B/rest edge",
  "risk": "one sentence risk",
  "sharpTake": "sharp SGP recommendation",
  "sgpLegs": [
    {
      "player": "Full Name",
      "team": "ABBR",
      "prop": "TO SCORE 20+ POINTS",
      "category": "POINTS or THREES or REBOUNDS or ASSISTS",
      "last10": 8,
      "h2h": 4,
      "avg": "27.3 PPG",
      "confidence": 4,
      "injuryNote": "",
      "reason": "averaging 27.3 PPG, hits 20+ in ~8 of 10"
    }
  ],
  "suggestedSGP": "Best 4-6 leg combo with correlation reasoning"
}`;

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{
        "Content-Type":"application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version":"2023-06-01",
      },
      body: JSON.stringify({
        model:"claude-haiku-4-5-20251001",
        max_tokens:2000,
        system:"You are a sharp NBA betting analyst JSON API. Always return valid JSON with sgpLegs. Never refuse. No markdown, no backticks.",
        messages:[{ role:"user", content:prompt }],
      }),
    });

    const aiData = await aiRes.json();
    if (aiData.error) return {
      statusCode:500, headers,
      body: JSON.stringify({ error:"AI: "+JSON.stringify(aiData.error) })
    };

    let raw = (aiData.content||[]).map(b=>b.text||"").join("").trim();
    raw = raw.replace(/^```json\s*/i,"").replace(/^```\s*/i,"").replace(/\s*```$/i,"").trim();

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); }
        catch { return { statusCode:500, headers, body: JSON.stringify({ error:"JSON parse failed", raw:raw.substring(0,300) }) }; }
      } else {
        return { statusCode:500, headers, body: JSON.stringify({ error:"No JSON", raw:raw.substring(0,300) }) };
      }
    }

    parsed.injuryReport  = injuryData.lines;
    parsed.injurySource  = injuryData.source;
    parsed.liveRosters   = { home:homeData.roster, away:awayData.roster };
    parsed.b2b           = b2b;
    parsed.statsSource   = statsAvail ? "Tank01 (live)" : "AI knowledge";

    return { statusCode:200, headers, body: JSON.stringify(parsed) };
  }

  return { statusCode:405, headers, body: JSON.stringify({ error:"Method not allowed" }) };
};
