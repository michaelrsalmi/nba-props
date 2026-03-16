exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const TANK01_KEY    = process.env.TANK01_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

  const TANK_HDR = {
    "x-rapidapi-key": TANK01_KEY || "",
    "x-rapidapi-host": "tank01-fantasy-stats.p.rapidapi.com",
  };

  const ODDS_API_KEY = process.env.ODDS_API_KEY;

  // ── Fetch FanDuel alternate player prop lines ─────────────────────────
  async function getFanDuelAltLines(homeTeam, awayTeam) {
    if (!ODDS_API_KEY) return {};
    const markets = [
      "player_points_alternate",
      "player_rebounds_alternate", 
      "player_assists_alternate",
      "player_threes_alternate",
    ];
    const allLines = {};

    try {
      // First get the event ID for this game
      const eventsRes = await get(
        `https://api.the-odds-api.com/v4/sports/basketball_nba/events?apiKey=${ODDS_API_KEY}&dateFormat=iso`
      );
      if (!eventsRes) return {};

      // Match game by team names
      const event = eventsRes.find(e => {
        const h = (e.home_team || "").toLowerCase();
        const a = (e.away_team || "").toLowerCase();
        const htLow = homeTeam.toLowerCase();
        const atLow = awayTeam.toLowerCase();
        return (h.includes(htLow.split(" ").pop()) || htLow.includes(h.split(" ").pop())) &&
               (a.includes(atLow.split(" ").pop()) || atLow.includes(a.split(" ").pop()));
      });

      if (!event) return {};

      // Fetch all alt prop markets for this event
      const oddsRes = await get(
        `https://api.the-odds-api.com/v4/sports/basketball_nba/events/${event.id}/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=${markets.join(",")}&bookmakers=fanduel&oddsFormat=american`
      );
      if (!oddsRes?.bookmakers?.length) return {};

      const fd = oddsRes.bookmakers[0];
      for (const market of (fd.markets || [])) {
        for (const outcome of (market.outcomes || [])) {
          const player = outcome.description || outcome.name || "";
          const name = outcome.name || ""; // "Over" or "Under"
          const point = outcome.point;
          const price = outcome.price;
          const cat = market.key; // e.g. player_points_alternate

          if (!player || name !== "Over") continue; // Only track Over lines

          if (!allLines[player]) allLines[player] = {};
          if (!allLines[player][cat]) allLines[player][cat] = [];
          allLines[player][cat].push({ line: point, odds: price, market: cat });
        }
      }

      // Sort each player's lines from lowest to highest
      for (const player of Object.keys(allLines)) {
        for (const cat of Object.keys(allLines[player])) {
          allLines[player][cat].sort((a, b) => a.line - b.line);
        }
      }
    } catch(e) {
      console.error("Odds API error:", e.message);
    }

    return allLines;
  }

  // ── Fetch real player game logs from NBA Stats API ──────────────────
  async function getNBAGameLogs(playerName, teamAbbr) {
    try {
      // First find player ID from NBA Stats
      const searchRes = await get(
        `https://stats.nba.com/stats/commonallplayers?LeagueID=00&Season=2025-26&IsOnlyCurrentSeason=1`,
        {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Referer": "https://www.nba.com/",
          "Origin": "https://www.nba.com",
          "Accept": "application/json",
          "x-nba-stats-origin": "stats",
          "x-nba-stats-token": "true",
        }
      );
      if (!searchRes?.resultSets?.[0]?.rowSet) return null;

      // Find player by name (case-insensitive)
      const nameLow = playerName.toLowerCase();
      const headers = searchRes.resultSets[0].headers;
      const rows = searchRes.resultSets[0].rowSet;
      const idIdx = headers.indexOf("PERSON_ID");
      const nameIdx = headers.indexOf("DISPLAY_FIRST_LAST");

      const player = rows.find(r => (r[nameIdx] || "").toLowerCase() === nameLow);
      if (!player) return null;

      const playerId = player[idIdx];

      // Get game log for this season
      const logRes = await get(
        `https://stats.nba.com/stats/playergamelog?PlayerID=${playerId}&Season=2025-26&SeasonType=Regular+Season`,
        {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Referer": "https://www.nba.com/",
          "Origin": "https://www.nba.com",
          "Accept": "application/json",
          "x-nba-stats-origin": "stats",
          "x-nba-stats-token": "true",
        }
      );
      if (!logRes?.resultSets?.[0]?.rowSet) return null;

      const lgHeaders = logRes.resultSets[0].headers;
      const lgRows = logRes.resultSets[0].rowSet;

      const minIdx = lgHeaders.indexOf("MIN");
      const ptsIdx = lgHeaders.indexOf("PTS");
      const rebIdx = lgHeaders.indexOf("REB");
      const astIdx = lgHeaders.indexOf("AST");
      const fg3mIdx = lgHeaders.indexOf("FG3M");

      // Most recent 10 games (rows are newest first)
      const last10 = lgRows.slice(0, 10).map(r => ({
        min: parseFloat(r[minIdx]) || 0,
        pts: parseFloat(r[ptsIdx]) || 0,
        reb: parseFloat(r[rebIdx]) || 0,
        ast: parseFloat(r[astIdx]) || 0,
        fg3m: parseFloat(r[fg3mIdx]) || 0,
      }));

      if (!last10.length) return null;

      // Minutes trend: last 5 games oldest→newest
      const last5mins = last10.slice(0, 5).reverse().map(g => Math.round(g.min));
      const minutesTrend = last5mins.join("→");

      // Real hit rates
      const calcHits = (arr, key, threshold) => arr.filter(g => g[key] >= threshold).length;

      return {
        minutesTrend,
        last10games: last10,
        // Pre-calculate hit rates for common thresholds
        hits: {
          pts5: calcHits(last10, "pts", 5),
          pts10: calcHits(last10, "pts", 10),
          pts15: calcHits(last10, "pts", 15),
          pts20: calcHits(last10, "pts", 20),
          pts25: calcHits(last10, "pts", 25),
          reb4: calcHits(last10, "pts", 4),
          reb6: calcHits(last10, "reb", 6),
          reb8: calcHits(last10, "reb", 8),
          ast2: calcHits(last10, "ast", 2),
          ast4: calcHits(last10, "ast", 4),
          fg3_1: calcHits(last10, "fg3m", 1),
          fg3_2: calcHits(last10, "fg3m", 2),
        },
        last5hits: {
          pts10: calcHits(last10.slice(0,5), "pts", 10),
          pts15: calcHits(last10.slice(0,5), "pts", 15),
          pts20: calcHits(last10.slice(0,5), "pts", 20),
          reb4: calcHits(last10.slice(0,5), "reb", 4),
          reb6: calcHits(last10.slice(0,5), "reb", 6),
          ast2: calcHits(last10.slice(0,5), "ast", 2),
          ast4: calcHits(last10.slice(0,5), "ast", 4),
          fg3_1: calcHits(last10.slice(0,5), "fg3m", 1),
          fg3_2: calcHits(last10.slice(0,5), "fg3m", 2),
        }
      };
    } catch(e) {
      console.error("NBA Stats game log error:", e.message);
      return null;
    }
  }

  // ── Fetch MLB/WBC HR props from Odds API ────────────────────────────
  async function getMLBHRProps(homeTeam, awayTeam, sport) {
    if (!ODDS_API_KEY) return {};
    const sportKey = sport === "wbc" ? "baseball_wbc" : "baseball_mlb";
    try {
      // Get events
      const events = await get(
        `https://api.the-odds-api.com/v4/sports/${sportKey}/events?apiKey=${ODDS_API_KEY}&dateFormat=iso`
      );
      if (!events?.length) return {};

      // Match game
      const event = events.find(e => {
        const h = (e.home_team || "").toLowerCase();
        const a = (e.away_team || "").toLowerCase();
        return (h.includes(homeTeam.toLowerCase().split(" ").pop()) || homeTeam.toLowerCase().includes(h.split(" ").pop())) &&
               (a.includes(awayTeam.toLowerCase().split(" ").pop()) || awayTeam.toLowerCase().includes(a.split(" ").pop()));
      });
      if (!event) return {};

      // Fetch HR props
      const odds = await get(
        `https://api.the-odds-api.com/v4/sports/${sportKey}/events/${event.id}/odds?apiKey=${ODDS_API_KEY}&regions=us&markets=batter_home_runs&bookmakers=fanduel&oddsFormat=american`
      );
      if (!odds?.bookmakers?.length) return {};

      const fd = odds.bookmakers[0];
      const hrProps = {};
      for (const market of (fd.markets || [])) {
        for (const outcome of (market.outcomes || [])) {
          const player = outcome.description || outcome.name || "";
          if (!player || outcome.name !== "Over") continue;
          if (!hrProps[player]) hrProps[player] = [];
          hrProps[player].push({ line: outcome.point, odds: outcome.price });
        }
      }
      return hrProps;
    } catch(e) {
      console.error("MLB HR props error:", e.message);
      return {};
    }
  }

  async function get(url, hdrs = {}) {
    try {
      const r = await fetch(url, { headers: hdrs, signal: AbortSignal.timeout(8000) });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  function todayET() {
    const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    return `${et.getFullYear()}${String(et.getMonth()+1).padStart(2,"0")}${String(et.getDate()).padStart(2,"0")}`;
  }

  function yesterdayET() {
    const et = new Date(new Date().toLocaleString("en-US", { timeZone: "America/New_York" }));
    et.setDate(et.getDate()-1);
    return `${et.getFullYear()}${String(et.getMonth()+1).padStart(2,"0")}${String(et.getDate()).padStart(2,"0")}`;
  }

  // ── Season-ending / long-term injuries (verified, won't return this season) ──
  const OUT_FOR_SEASON = [
    "Bradley Beal",       // LAC — fractured hip Nov 8, season-ending
    "Anthony Davis",      // WAS — hand/groin, out rest of season
    "Jimmy Butler",       // GS  — torn ACL, season-ending
    "Tyrese Haliburton",  // IND — torn Achilles, season-ending
    "Kyrie Irving",       // DAL — torn ACL surgery Mar 2025
    "Ja Morant",          // MEM — UCL elbow, out since Jan 21 (may return late)
    "Stephen Curry",      // GS  — knee, extended absence
    "Draymond Green",     // GS  — back, extended absence
    "Bogdan Bogdanovic",  // LAC — rarely plays, appeared twice since Jan
    "Kelly Olynyk",       // SA  — low usage, end of bench
    "Nicolas Batum",      // LAC — end of bench, minimal minutes
    "Cameron Payne",      // various — rarely active
    "Jordan McLaughlin",  // SA  — deep bench, minimal role
    "Reggie Bullock",     // various — bench
    "Darius Bazley",      // various — bench
    "Jaylen Nowell",      // various — bench
  ].map(n => n.toLowerCase());

  // ── Active players from ESPN recent box scores (last 5 games) ──────────
  async function getActivePlayers(espnTeamId) {
    if (!espnTeamId) return [];
    try {
      // Get team's recent schedule
      const sched = await get(
        `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${espnTeamId}/schedule`
      );
      if (!sched?.events) return [];

      // Get last 8 completed games
      const recentGames = sched.events
        .filter(e => e.competitions?.[0]?.status?.type?.completed)
        .slice(-8);

      if (!recentGames.length) return [];

      // Fetch box scores and track how many games each player appeared in
      const playerCount = {};
      const playerMins = {};
      const boxScores = await Promise.all(
        recentGames.map(e =>
          get(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${e.id}`)
        )
      );

      for (const box of boxScores) {
        if (!box?.boxscore?.players) continue;
        for (const team of box.boxscore.players) {
          const teamAbbr = team.team?.abbreviation || "";
          const normalizedAbbr = teamAbbr === "GS" ? "GSW" : teamAbbr === "SA" ? "SAS" : teamAbbr === "NO" ? "NOP" : teamAbbr === "NY" ? "NYK" : teamAbbr === "PHO" ? "PHX" : teamAbbr;
          if (normalizedAbbr !== abbr && teamAbbr !== abbr) continue;
          for (const stat of (team.statistics || [])) {
            for (const athlete of (stat.athletes || [])) {
              const name = athlete.athlete?.displayName || "";
              const minsStr = athlete.stats?.[0] || "0";
              const mins = parseFloat(minsStr) || 0;
              // Only count if they played meaningful minutes (10+)
              if (name && mins >= 15) {
                playerCount[name] = (playerCount[name] || 0) + 1;
                playerMins[name] = (playerMins[name] || 0) + mins;
              }
            }
          }
        }
      }

      // Only return players who appeared in at least 4 of last 8 games with 10+ min
      return Object.entries(playerCount)
        .filter(([name, count]) => count >= 4)
        .sort((a, b) => (playerMins[b[0]] || 0) - (playerMins[a[0]] || 0))
        .map(([name]) => name);
    } catch { return []; }
  }

  // ESPN team ID map
  const ESPN_IDS = {
    ATL:"1",BOS:"2",BKN:"17",CHA:"30",CHI:"4",CLE:"5",DAL:"6",DEN:"7",
    DET:"8",GSW:"9",GS:"9",HOU:"10",IND:"11",LAC:"12",LAL:"13",MEM:"29",
    MIA:"14",MIL:"15",MIN:"16",NOP:"3",NO:"3",NYK:"18",NY:"18",OKC:"25",
    ORL:"19",PHI:"20",PHX:"21",PHO:"21",POR:"22",SAC:"23",SAS:"24",SA:"24",
    TOR:"28",UTA:"26",UTAH:"26",WAS:"27",
  };

  // ── Live roster from Tank01 (fallback if ESPN active players fails) ───
  async function getRoster(abbr) {
    // Try ESPN active players first (most accurate — based on actual recent games)
    const espnId = ESPN_IDS[abbr];
    const activePlayers = await getActivePlayers(espnId);
    if (activePlayers.length >= 5) return activePlayers;

    // Fallback to Tank01 roster
    if (!TANK01_KEY) return [];
    const d = await get(
      `https://tank01-fantasy-stats.p.rapidapi.com/getNBATeamRoster?teamAbv=${abbr}`,
      TANK_HDR
    );
    if (!d?.body?.roster) return [];
    const obj = d.body.roster;
    const players = Array.isArray(obj) ? obj : Object.values(obj);
    return players.map(p => p.longName || p.espnName || p.name || "").filter(Boolean).slice(0, 13);
  }

  // ── Official NBA injury report from CDN ───────────────────────────────
  async function getInjuries(homeAbbr, awayAbbr) {
    const d = await get("https://cdn.nba.com/static/json/liveData/injuryreport/injuryreport.json");
    if (!d?.injuryReport) return [];
    const hLow = homeAbbr.toLowerCase();
    const aLow = awayAbbr.toLowerCase();
    return d.injuryReport
      .filter(p => {
        const t = (p.teamTricode || p.teamAbv || "").toLowerCase();
        const n = (p.teamName || "").toLowerCase();
        return t === hLow || t === aLow || n.includes(hLow) || n.includes(aLow);
      })
      .map(p => `${p.playerName} (${p.teamTricode||p.teamAbv||""}) — ${p.currentStatus}${p.reason ? ": "+p.reason : ""}`);
  }

  // ── B2B detection ─────────────────────────────────────────────────────
  async function getB2B(homeAbbr, awayAbbr) {
    const yd = yesterdayET();
    const d = await get(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${yd}`);
    const result = { home: false, away: false, homeYesterday: "", awayYesterday: "" };
    if (!d?.events) return result;
    for (const e of d.events) {
      const comp = e.competitions?.[0];
      const h = comp?.competitors?.find(c => c.homeAway === "home")?.team?.abbreviation;
      const a = comp?.competitors?.find(c => c.homeAway === "away")?.team?.abbreviation;
      if (!h || !a) continue;
      if (h === homeAbbr || a === homeAbbr) { result.home = true; result.homeYesterday = `${a}@${h}`; }
      if (h === awayAbbr || a === awayAbbr) { result.away = true; result.awayYesterday = `${a}@${h}`; }
    }
    return result;
  }

  // ── Web search for live injury news ──────────────────────────────────
  async function searchInjuries(homeTeam, awayTeam) {
    if (!ANTHROPIC_KEY) return "";
    const today = new Date().toLocaleDateString("en-US", { timeZone: "America/New_York", month: "long", day: "numeric", year: "numeric" });
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "web-search-2025-03-05",
        },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 600,
          tools: [{ type: "web_search_20250305", name: "web_search" }],
          system: "Search for NBA injury info and return ONLY a bullet list. No other text.",
          messages: [{ role: "user", content: `Search "${homeTeam} ${awayTeam} injury report ${today}" and list every player who is OUT, Doubtful, or Questionable tonight. Format: "- Name (TEAM) — Status" only.` }],
        }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await r.json();
      return (data.content || []).filter(b => b.type === "text").map(b => b.text).join("").trim();
    } catch { return ""; }
  }

  // ── SCHEDULE GET ──────────────────────────────────────────────────────
  if (event.httpMethod === "GET") {
    const d = await get("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard");
    if (!d?.events) return { statusCode: 500, headers, body: JSON.stringify({ error: "Schedule failed" }) };

    const games = d.events.map(e => {
      const comp = e.competitions?.[0];
      const home = comp?.competitors?.find(c => c.homeAway === "home");
      const away = comp?.competitors?.find(c => c.homeAway === "away");
      const homeAbbr = home?.team?.abbreviation || "???";
      const awayAbbr = away?.team?.abbreviation || "???";
      const time = new Date(e.date).toLocaleTimeString("en-US", {
        hour: "numeric", minute: "2-digit", timeZoneName: "short", timeZone: "America/New_York"
      });
      return {
        id: e.id,
        homeTeam: home?.team?.displayName || homeAbbr,
        awayTeam: away?.team?.displayName || awayAbbr,
        homeAbbr, awayAbbr,
        homeRecord: home?.records?.[0]?.summary || "",
        awayRecord: away?.records?.[0]?.summary || "",
        time,
        status: comp?.status?.type?.description || "Scheduled",
      };
    });

    return { statusCode: 200, headers, body: JSON.stringify({ games }) };
  }

  // ── ANALYZE POST ──────────────────────────────────────────────────────
  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

    // Non-NBA sport analysis (NCAAB, MLB, NFL)
    if (body.sport && body.sport !== "nba") {
      const game = body.game;
      const sport = body.sport;
      if (!game?.homeTeam) return { statusCode: 400, headers, body: JSON.stringify({ error: "No game" }) };
      if (!ANTHROPIC_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing Anthropic key" }) };

      const sportLabel = { ncaa: "COLLEGE BASKETBALL", mlb: "MLB BASEBALL", nfl: "NFL FOOTBALL" }[sport] || sport.toUpperCase();
      const today = new Date().toDateString();
      const prompt = `You are a sharp ${sportLabel} betting analyst. Today: ${today}.

GAME: ${game.awayTeam} (${game.awayAbbr} ${game.awayRecord || ""}) @ ${game.homeTeam} (${game.homeAbbr} ${game.homeRecord || ""})
TIME: ${game.time}
${game.spread ? "SPREAD: " + game.spread : ""}
${game.overUnder ? "TOTAL: " + game.overUnder : ""}

Return ONLY raw JSON:
{
  "bestBet": "best bet on spread or total with confidence ⭐⭐⭐-⭐⭐⭐⭐⭐",
  "trend": "key recent trend with specific numbers",
  "edge": "situational edge — home/away, rest, momentum",
  "risk": "one sentence risk",
  "sharpTake": "sharp one-liner",
  "spreadAnalysis": "2 sentences on the spread",
  "totalAnalysis": "2 sentences on the over/under",
  "keyFactors": ["factor 1", "factor 2", "factor 3"]
}`;

      const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model: "claude-haiku-4-5-20251001",
          max_tokens: 1000,
          system: "You are a sharp betting analyst JSON API. Return ONLY valid JSON starting with { and ending with }. No markdown.",
          messages: [{ role: "user", content: prompt }],
        }),
      });
      const aiData = await aiRes.json();
      if (aiData.error) return { statusCode: 500, headers, body: JSON.stringify({ error: "AI: " + JSON.stringify(aiData.error) }) };
      let raw = (aiData.content || []).map(b => b.text || "").join("").trim();
      raw = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();
      try {
        const parsed = JSON.parse(raw);
        return { statusCode: 200, headers, body: JSON.stringify(parsed) };
      } catch {
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) return { statusCode: 200, headers, body: match[0] };
        return { statusCode: 500, headers, body: JSON.stringify({ error: "Parse failed", raw: raw.substring(0, 200) }) };
      }
    }

    const game = body.game;
    if (!game?.homeTeam) return { statusCode: 400, headers, body: JSON.stringify({ error: "No game" }) };
    if (!ANTHROPIC_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing Anthropic key" }) };

    // Fetch roster, injuries, B2B, web search, and FanDuel alt lines in parallel
    const [homeRoster, awayRoster, cdnInjuries, b2b, webInjuries, fdLines] = await Promise.all([
      getRoster(game.homeAbbr),
      getRoster(game.awayAbbr),
      getInjuries(game.homeAbbr, game.awayAbbr),
      getB2B(game.homeAbbr, game.awayAbbr),
      searchInjuries(game.homeTeam, game.awayTeam),
      getFanDuelAltLines(game.homeTeam, game.awayTeam),
    ]);

    const today = new Date().toDateString();

    // Build roster validation — AI must only use these names
    const allRosterPlayers = [...homeRoster, ...awayRoster];
    const rosterStr = allRosterPlayers.length
      ? `VALID PLAYERS FOR PROPS (Tank01 live roster — use ONLY these names):\n${game.homeTeam}: ${homeRoster.join(", ")}\n${game.awayTeam}: ${awayRoster.join(", ")}`
      : "Roster unavailable — use your best 2025-26 knowledge";

    // Format FanDuel alt lines
    const CAT_MAP = {
      player_points_alternate: "POINTS",
      player_rebounds_alternate: "REBOUNDS",
      player_assists_alternate: "ASSISTS",
      player_threes_alternate: "THREES",
    };
    const fdPlayers = Object.keys(fdLines);
    const fdStr = fdPlayers.length
      ? `FANDUEL ALT LINES AVAILABLE TONIGHT (use ONLY these players and lines):\n` +
        fdPlayers.map(player => {
          const cats = Object.entries(fdLines[player]).map(([cat, lines]) => {
            const catName = CAT_MAP[cat] || cat;
            return catName + ": " + lines.map(l => `${l.line}+(${l.odds > 0 ? "+"+l.odds : l.odds})`).join(", ");
          }).join(" | ");
          return `  ${player}: ${cats}`;
        }).join("\n")
      : "FanDuel lines unavailable — use roster above";

    const injuryStr = [
      cdnInjuries.length ? `NBA CDN Report:\n${cdnInjuries.join("\n")}` : "",
      webInjuries ? `Web Search (most current):\n${webInjuries}` : "",
    ].filter(Boolean).join("\n\n") || "No injuries reported";

    const b2bStr = [
      b2b.home ? `🔴 ${game.homeTeam} ON B2B (played ${b2b.homeYesterday} yesterday)` : `✅ ${game.homeTeam}: rested`,
      b2b.away ? `🔴 ${game.awayTeam} ON B2B (played ${b2b.awayYesterday} yesterday)` : `✅ ${game.awayTeam}: rested`,
    ].join("\n");

    const prompt = `You are a sharp NBA SGP analyst for FanDuel. Today: ${today}.

GAME: ${game.awayTeam} (${game.awayAbbr} ${game.awayRecord}) @ ${game.homeTeam} (${game.homeAbbr} ${game.homeRecord})
TIME: ${game.time}

${fdPlayers.length ? fdStr : rosterStr}

━━ INJURY REPORT ━━
${injuryStr}

━━ BACK-TO-BACK ━━
${b2bStr}

━━ NEVER INCLUDE THESE PLAYERS — OUT FOR SEASON ━━
Bradley Beal (LAC) — fractured hip, OUT for season
Anthony Davis (WAS) — OUT for season
Jimmy Butler (GS) — torn ACL, OUT for season
Tyrese Haliburton (IND) — torn Achilles, OUT for season
Kyrie Irving (DAL) — torn ACL, OUT
Ja Morant (MEM) — UCL elbow, OUT extended
Stephen Curry (GS) — knee, OUT extended
Draymond Green (GS) — back, OUT extended

━━ RULES (follow exactly) ━━
1. NEVER include the OUT FOR SEASON players listed above
2. If FanDuel alt lines are provided above — ONLY use players and lines from that list
3. Pick the BEST VALUE alt line for each player — not too low (boring), not too high (risky)
4. Exclude ANY player listed as OUT or Doubtful in injury report
5. If a star is out, use their backup IF they appear in the FanDuel lines
6. B2B team players: lower confidence by 1 star
7. For the "prop" field use format: "OVER X.X PTS (odds)" e.g. "OVER 22.5 PTS (+105)"
8. For "avg" field use the FanDuel line as reference
9. Return ONLY raw JSON — no text before or after

FanDuel SGP formats:
"TO SCORE 20+ POINTS" / "TO SCORE 10+ POINTS" / "TO SCORE 5+ POINTS"
"1+ MADE THREES" / "2+ MADE THREES"
"TO RECORD 4+ REBOUNDS" / "TO RECORD 6+ REBOUNDS" / "TO RECORD 8+ REBOUNDS"
"TO RECORD 2+ ASSISTS" / "TO RECORD 4+ ASSISTS"

{
  "bestBet": "one sentence best bet",
  "trend": "specific trend with numbers",
  "edge": "injury/B2B/rest edge",
  "risk": "one sentence risk",
  "sharpTake": "sharp SGP pick",
  "sgpLegs": [
    {
      "player": "Full Name from roster above",
      "team": "ABBR",
      "prop": "TO SCORE 20+ POINTS",
      "category": "POINTS or THREES or REBOUNDS or ASSISTS",
      "last10": 8,
      "last5": 4,
      "h2h": 4,
      "avg": "27.3 PPG",
      "confidence": 4,
      "minutesTrend": "32→34→36→37→39",
      "usageBoost": "+6% without Morant",
      "injuryNote": "",
      "reason": "one sentence with stats"
    }
  ],
  "suggestedSGP": "Best 4-5 leg combo with correlation reasoning"
}

Include 8 legs. Mix all 4 categories. Only use players from the VALID PLAYERS list.`;

    // Single AI call with JSON-only system prompt
    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 3000,
        system: "You are a sharp NBA SGP analyst JSON API. Return ONLY a valid JSON object starting with { and ending with }. No text, no markdown, no backticks. Never include players not in the provided roster list.",
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const aiData = await aiRes.json();
    if (aiData.error) return { statusCode: 500, headers, body: JSON.stringify({ error: "AI: " + JSON.stringify(aiData.error) }) };

    let raw = (aiData.content || []).map(b => b.text || "").join("").trim();
    raw = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();

    let parsed;
    try { parsed = JSON.parse(raw); }
    catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); }
        catch { return { statusCode: 500, headers, body: JSON.stringify({ error: "JSON parse failed", raw: raw.substring(0, 300) }) }; }
      } else {
        return { statusCode: 500, headers, body: JSON.stringify({ error: "No JSON found", raw: raw.substring(0, 300) }) };
      }
    }

    // Post-process: remove props for players not in FD lines or roster, or on out list
    if (parsed.sgpLegs) {
      parsed.sgpLegs = parsed.sgpLegs.filter(leg => {
        const name = (leg.player || "").toLowerCase();
        // Remove if on season-ending list
        if (OUT_FOR_SEASON.some(out => name.includes(out.split(" ")[1] || out))) return false;
        // If FD lines available, only allow players with FD lines
        if (fdPlayers.length) {
          return fdPlayers.some(p => {
            const pLow = p.toLowerCase();
            return pLow.includes(name.split(" ").pop()) || name.includes(pLow.split(" ").pop());
          });
        }
        // Fallback: check roster
        if (allRosterPlayers.length) {
          return allRosterPlayers.some(p => {
            const pLow = p.toLowerCase();
            return pLow.includes(name.split(" ").pop()) || name.includes(pLow.split(" ").pop());
          });
        }
        return true;
      });
    }

    // Fetch real NBA Stats game logs for each prop player
    if (parsed.sgpLegs?.length) {
      const uniquePlayers = [...new Set(parsed.sgpLegs.map(l => l.player))];
      const logResults = await Promise.all(
        uniquePlayers.map(name => getNBAGameLogs(name, null))
      );
      const logMap = {};
      uniquePlayers.forEach((name, i) => { if (logResults[i]) logMap[name] = logResults[i]; });

      // Update each leg with real data
      parsed.sgpLegs = parsed.sgpLegs.map(leg => {
        const log = logMap[leg.player];
        if (!log) return leg;

        // Determine the right hit rate based on prop
        const prop = (leg.prop || "").toLowerCase();
        const h = log.hits;
        const h5 = log.last5hits;
        let last10 = leg.last10;
        let last5 = leg.last5;

        if (prop.includes("20")) { last10 = h.pts20; last5 = h5.pts20; }
        else if (prop.includes("25")) { last10 = h.pts25; last5 = h5.pts20; }
        else if (prop.includes("15")) { last10 = h.pts15; last5 = h5.pts15; }
        else if (prop.includes("10")) { last10 = h.pts10; last5 = h5.pts10; }
        else if (prop.includes("5+") && prop.includes("point")) { last10 = h.pts5; last5 = h5.pts10; }
        else if (prop.includes("8") && prop.includes("reb")) { last10 = h.reb8; last5 = h5.reb6; }
        else if (prop.includes("6") && prop.includes("reb")) { last10 = h.reb6; last5 = h5.reb6; }
        else if (prop.includes("4") && prop.includes("reb")) { last10 = h.reb4; last5 = h5.reb4; }
        else if (prop.includes("4") && prop.includes("ast")) { last10 = h.ast4; last5 = h5.ast4; }
        else if (prop.includes("2") && prop.includes("ast")) { last10 = h.ast2; last5 = h5.ast2; }
        else if (prop.includes("2+") && prop.includes("three")) { last10 = h.fg3_2; last5 = h5.fg3_2; }
        else if (prop.includes("1+") && prop.includes("three")) { last10 = h.fg3_1; last5 = h5.fg3_1; }

        return {
          ...leg,
          last10,
          last5,
          minutesTrend: log.minutesTrend,
        };
      });
    }

    parsed.injuryReport = [...cdnInjuries, ...(webInjuries ? webInjuries.split("\n").filter(l => l.trim()) : [])];
    parsed.liveRosters = { home: homeRoster, away: awayRoster };
    parsed.b2b = b2b;
    parsed.fdLinesAvailable = fdPlayers.length > 0;
    parsed.fdPlayerCount = fdPlayers.length;

    return { statusCode: 200, headers, body: JSON.stringify(parsed) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
};
