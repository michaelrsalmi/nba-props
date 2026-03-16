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
              if (name && mins >= 10) {
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
    const game = body.game;
    if (!game?.homeTeam) return { statusCode: 400, headers, body: JSON.stringify({ error: "No game" }) };
    if (!ANTHROPIC_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing Anthropic key" }) };

    // Fetch roster, CDN injuries, B2B, and web search injuries in parallel
    const [homeRoster, awayRoster, cdnInjuries, b2b, webInjuries] = await Promise.all([
      getRoster(game.homeAbbr),
      getRoster(game.awayAbbr),
      getInjuries(game.homeAbbr, game.awayAbbr),
      getB2B(game.homeAbbr, game.awayAbbr),
      searchInjuries(game.homeTeam, game.awayTeam),
    ]);

    const today = new Date().toDateString();

    // Build roster validation — AI must only use these names
    const allRosterPlayers = [...homeRoster, ...awayRoster];
    const rosterStr = allRosterPlayers.length
      ? `VALID PLAYERS FOR PROPS (Tank01 live roster — use ONLY these names):\n${game.homeTeam}: ${homeRoster.join(", ")}\n${game.awayTeam}: ${awayRoster.join(", ")}`
      : "Roster unavailable — use your best 2025-26 knowledge";

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

${rosterStr}

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
1. NEVER include the players listed above under any circumstances
2. ONLY generate props for players in the VALID PLAYERS list above
3. NEVER include players not in that list — they are on different teams or inactive
4. Exclude ANY player listed as OUT or Doubtful in injury report
5. If a star is out, boost their backup who IS in the roster list
6. B2B team players: lower confidence by 1 star
7. ONLY pick players who are genuine rotation players averaging 20+ minutes per game
8. NEVER pick bench players, end-of-rotation guys, or players with fewer than 30 games played
9. Focus on the top 6-8 players per team by usage and minutes
10. Use your 2025-26 season knowledge for stats and hit rates
11. Return ONLY raw JSON — no text before or after

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
      "h2h": 4,
      "avg": "27.3 PPG",
      "confidence": 4,
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

    // Post-process: remove props for players not in roster OR on season-ending list
    if (parsed.sgpLegs) {
      parsed.sgpLegs = parsed.sgpLegs.filter(leg => {
        const name = (leg.player || "").toLowerCase();
        // Remove if on season-ending list
        if (OUT_FOR_SEASON.some(out => name.includes(out.split(" ")[1] || out))) return false;
        // Remove if not in roster (when roster available)
        if (allRosterPlayers.length) {
          return allRosterPlayers.some(p => {
            const pLow = p.toLowerCase();
            return pLow.includes(name) || name.includes(pLow) ||
              (name.split(" ")[1] && pLow.includes(name.split(" ")[1]));
          });
        }
        return true;
      });
    }

    parsed.injuryReport = [...cdnInjuries, ...(webInjuries ? webInjuries.split("\n").filter(l => l.trim()) : [])];
    parsed.liveRosters = { home: homeRoster, away: awayRoster };
    parsed.b2b = b2b;

    return { statusCode: 200, headers, body: JSON.stringify(parsed) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
};
