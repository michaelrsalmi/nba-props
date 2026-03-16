exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const NBA_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://www.nba.com/",
    "Origin": "https://www.nba.com",
    "Accept": "application/json, text/plain, */*",
    "x-nba-stats-origin": "stats",
    "x-nba-stats-token": "true",
  };

  const SLUG_MAP = {
    ATL:"atlanta-hawks",BOS:"boston-celtics",BKN:"brooklyn-nets",
    CHA:"charlotte-hornets",CHI:"chicago-bulls",CLE:"cleveland-cavaliers",
    DAL:"dallas-mavericks",DEN:"denver-nuggets",DET:"detroit-pistons",
    GSW:"golden-state-warriors",GS:"golden-state-warriors",
    HOU:"houston-rockets",IND:"indiana-pacers",
    LAC:"la-clippers",LAL:"los-angeles-lakers",
    MEM:"memphis-grizzlies",MIA:"miami-heat",MIL:"milwaukee-bucks",
    MIN:"minnesota-timberwolves",NOP:"new-orleans-pelicans",NO:"new-orleans-pelicans",
    NYK:"new-york-knicks",NY:"new-york-knicks",
    OKC:"oklahoma-city-thunder",ORL:"orlando-magic",
    PHI:"philadelphia-76ers",PHX:"phoenix-suns",PHO:"phoenix-suns",
    POR:"portland-trail-blazers",SAC:"sacramento-kings",
    SAS:"san-antonio-spurs",SA:"san-antonio-spurs",
    TOR:"toronto-raptors",UTA:"utah-jazz",UTAH:"utah-jazz",
    WAS:"washington-wizards",
  };

  // ESPN team ID map
  const ESPN_ID_MAP = {
    ATL:"1",BOS:"2",BKN:"17",CHA:"30",CHI:"4",CLE:"5",DAL:"6",DEN:"7",
    DET:"8",GSW:"9",GS:"9",HOU:"10",IND:"11",LAC:"12",LAL:"13",MEM:"29",
    MIA:"14",MIL:"15",MIN:"16",NOP:"3",NO:"3",NYK:"18",NY:"18",OKC:"25",
    ORL:"19",PHI:"20",PHX:"21",PHO:"21",POR:"22",SAC:"23",SAS:"24",SA:"24",
    TOR:"28",UTA:"26",UTAH:"26",WAS:"27",
  };

  // ── HELPERS ────────────────────────────────────────────────────────────

  async function safeFetch(url, opts = {}) {
    try {
      const res = await fetch(url, { ...opts, headers: { ...NBA_HEADERS, ...(opts.headers || {}) } });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  // Fetch live roster from ESPN
  async function fetchRoster(abbr) {
    const slug = SLUG_MAP[abbr];
    if (!slug) return [];
    const data = await safeFetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${slug}/roster`);
    if (!data) return [];
    const players = [];
    for (const group of (data.athletes || [])) {
      for (const p of (group.items || [])) {
        players.push(p.displayName || p.fullName || "");
      }
    }
    return players.filter(Boolean).slice(0, 10);
  }

  // Fetch injury report from NBA CDN
  async function fetchInjuries(homeTeam, awayTeam) {
    const data = await safeFetch("https://cdn.nba.com/static/json/liveData/injuryreport/injuryreport.json");
    if (!data) return { lines: ["Injury report unavailable"], source: "failed" };
    const report = data.injuryReport || [];
    const homeLast = homeTeam.split(" ").pop().toLowerCase();
    const awayLast = awayTeam.split(" ").pop().toLowerCase();
    const filtered = report.filter(p => {
      const t = (p.teamName || "").toLowerCase();
      return t.includes(homeLast) || t.includes(awayLast);
    });
    return {
      lines: filtered.length
        ? filtered.map(p => `${p.playerName} (${p.teamName}) — ${p.currentStatus}${p.reason ? ": "+p.reason : ""}`)
        : ["No players on injury report for this game"],
      source: "NBA Official"
    };
  }

  // Detect back-to-back by checking last 2 days of ESPN schedule
  async function detectB2B(homeAbbr, awayAbbr) {
    const result = { home: false, away: false, homeYesterday: "", awayYesterday: "" };
    try {
      const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
      const yd = yesterday.toISOString().slice(0,10).replace(/-/g,"");
      const data = await safeFetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${yd}`);
      if (!data) return result;
      for (const e of (data.events || [])) {
        const comp = e.competitions?.[0];
        const home = comp?.competitors?.find(c => c.homeAway === "home");
        const away = comp?.competitors?.find(c => c.homeAway === "away");
        const h = home?.team?.abbreviation;
        const a = away?.team?.abbreviation;
        const opp = `${a} @ ${h}`;
        if (h === homeAbbr || a === homeAbbr) { result.home = true; result.homeYesterday = opp; }
        if (h === awayAbbr || a === awayAbbr) { result.away = true; result.awayYesterday = opp; }
      }
    } catch {}
    return result;
  }

  // Fetch last 10 team games with results
  async function fetchTeamLast10(abbr) {
    try {
      const espnId = ESPN_ID_MAP[abbr];
      if (!espnId) return [];
      const data = await safeFetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${espnId}/schedule`);
      if (!data) return [];
      const completed = (data.events || [])
        .filter(e => e.competitions?.[0]?.status?.type?.completed)
        .slice(-10)
        .map(e => {
          const comp = e.competitions[0];
          const home = comp.competitors.find(c => c.homeAway === "home");
          const away = comp.competitors.find(c => c.homeAway === "away");
          const isHome = home?.team?.abbreviation === abbr;
          const us = isHome ? home : away;
          const them = isHome ? away : home;
          const won = parseInt(us?.score) > parseInt(them?.score);
          return `${won?"W":"L"} ${us?.score}-${them?.score} vs ${them?.team?.abbreviation}`;
        });
      return completed;
    } catch { return []; }
  }

  // Fetch H2H last 5 matchups
  async function fetchH2H(homeAbbr, awayAbbr) {
    try {
      const espnId = ESPN_ID_MAP[homeAbbr];
      if (!espnId) return [];
      const data = await safeFetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${espnId}/schedule`);
      if (!data) return [];
      const h2h = (data.events || [])
        .filter(e => {
          const comp = e.competitions?.[0];
          if (!comp?.status?.type?.completed) return false;
          const abbrs = comp.competitors.map(c => c.team?.abbreviation);
          return abbrs.includes(homeAbbr) && abbrs.includes(awayAbbr);
        })
        .slice(-5)
        .map(e => {
          const comp = e.competitions[0];
          const home = comp.competitors.find(c => c.homeAway === "home");
          const away = comp.competitors.find(c => c.homeAway === "away");
          return `${away?.team?.abbreviation} @ ${home?.team?.abbreviation}: ${away?.score}-${home?.score}`;
        });
      return h2h;
    } catch { return []; }
  }

  // Fetch top player season averages from NBA Stats
  async function fetchPlayerAverages(teamAbbr) {
    try {
      const data = await safeFetch(
        `https://stats.nba.com/stats/leaguedashplayerstats?College=&Conference=&Country=&DateFrom=&DateTo=&Division=&DraftPick=&DraftYear=&GameScope=&GameSegment=&Height=&ISTRound=&LastNGames=0&LeagueID=00&Location=&MeasureType=Base&Month=0&OpponentTeamID=0&Outcome=&PORound=0&PaceAdjust=N&PerMode=PerGame&Period=0&PlayerExperience=&PlayerPosition=&PlusMinus=N&Rank=N&Season=2025-26&SeasonSegment=&SeasonType=Regular+Season&ShotClockRange=&StarterBench=&TeamID=0&TwoWay=0&VsConference=&VsDivision=&Weight=`
      );
      if (!data) return [];
      const headers2 = data.resultSets?.[0]?.headers || [];
      const rows = data.resultSets?.[0]?.rowSet || [];
      const ni = headers2.indexOf("PLAYER_NAME");
      const ti = headers2.indexOf("TEAM_ABBREVIATION");
      const pi = headers2.indexOf("PTS");
      const ri = headers2.indexOf("REB");
      const ai = headers2.indexOf("AST");
      const fgi = headers2.indexOf("FG3M");
      const gpi = headers2.indexOf("GP");

      return rows
        .filter(r => r[ti] === teamAbbr && r[gpi] >= 10)
        .sort((a,b) => b[pi] - a[pi])
        .slice(0, 8)
        .map(r => ({
          name: r[ni],
          pts: r[pi]?.toFixed(1),
          reb: r[ri]?.toFixed(1),
          ast: r[ai]?.toFixed(1),
          fg3m: r[fgi]?.toFixed(1),
        }));
    } catch { return []; }
  }

  // Fetch player last 10 game log from NBA Stats
  async function fetchPlayerGameLog(playerName, teamAbbr, allAverages) {
    try {
      // Find player ID from averages we already have
      const player = allAverages.find(p => p.name === playerName);
      if (!player) return null;

      // Use NBA stats game log - search by name
      const data = await safeFetch(
        `https://stats.nba.com/stats/commonallplayers?IsOnlyCurrentSeason=1&LeagueID=00&Season=2025-26`
      );
      if (!data) return null;
      const hdrs = data.resultSets?.[0]?.headers || [];
      const rows = data.resultSets?.[0]?.rowSet || [];
      const ni = hdrs.indexOf("DISPLAY_FIRST_LAST");
      const ii = hdrs.indexOf("PERSON_ID");
      const playerRow = rows.find(r => r[ni] === playerName);
      if (!playerRow) return null;
      const playerId = playerRow[ii];

      const logData = await safeFetch(
        `https://stats.nba.com/stats/playergamelog?PlayerID=${playerId}&Season=2025-26&SeasonType=Regular+Season&LastNGames=10`
      );
      if (!logData) return null;
      const lh = logData.resultSets?.[0]?.headers || [];
      const lr = logData.resultSets?.[0]?.rowSet || [];
      const ptsi = lh.indexOf("PTS");
      const rebi = lh.indexOf("REB");
      const asti = lh.indexOf("AST");
      const fg3i = lh.indexOf("FG3M");

      return lr.slice(0, 10).map(g => ({
        pts: g[ptsi], reb: g[rebi], ast: g[asti], fg3m: g[fg3i]
      }));
    } catch { return null; }
  }

  // ── SCHEDULE (GET) ─────────────────────────────────────────────────────
  if (event.httpMethod === "GET") {
    const data = await safeFetch("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard");
    if (!data) return { statusCode: 500, headers, body: JSON.stringify({ error: "Schedule fetch failed" }) };

    const games = (data.events || []).map(e => {
      const comp = e.competitions?.[0];
      const home = comp?.competitors?.find(c => c.homeAway === "home");
      const away = comp?.competitors?.find(c => c.homeAway === "away");
      const homeAbbr = home?.team?.abbreviation || "???";
      const awayAbbr = away?.team?.abbreviation || "???";
      return {
        id: e.id,
        homeTeam: home?.team?.displayName || "",
        awayTeam: away?.team?.displayName || "",
        homeAbbr, awayAbbr,
        homeRecord: home?.records?.[0]?.summary || "",
        awayRecord: away?.records?.[0]?.summary || "",
        homeSlug: SLUG_MAP[homeAbbr] || homeAbbr.toLowerCase(),
        awaySlug: SLUG_MAP[awayAbbr] || awayAbbr.toLowerCase(),
        time: new Date(e.date).toLocaleTimeString("en-US", {
          hour: "numeric", minute: "2-digit", timeZoneName: "short",
          timeZone: "America/New_York",
        }),
        status: comp?.status?.type?.description || "Scheduled",
      };
    });

    return { statusCode: 200, headers, body: JSON.stringify({ games }) };
  }

  // ── ANALYZE (POST) ─────────────────────────────────────────────────────
  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

    const game = body.game;
    if (!game?.homeTeam) return { statusCode: 400, headers, body: JSON.stringify({ error: "No game" }) };

    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing API key" }) };

    // Fetch everything in parallel
    const [
      homeRoster, awayRoster,
      injuryData,
      b2b,
      homeLast10, awayLast10,
      h2h,
      homeAvgs, awayAvgs,
    ] = await Promise.all([
      fetchRoster(game.homeAbbr),
      fetchRoster(game.awayAbbr),
      fetchInjuries(game.homeTeam, game.awayTeam),
      detectB2B(game.homeAbbr, game.awayAbbr),
      fetchTeamLast10(game.homeAbbr),
      fetchTeamLast10(game.awayAbbr),
      fetchH2H(game.homeAbbr, game.awayAbbr),
      fetchPlayerAverages(game.homeAbbr),
      fetchPlayerAverages(game.awayAbbr),
    ]);

    const allAvgs = [...homeAvgs, ...awayAvgs];

    // Format averages for prompt
    const fmtAvgs = (avgs, teamName) => avgs.length
      ? `${teamName}:\n` + avgs.map(p => `  ${p.name}: ${p.pts}pts / ${p.reb}reb / ${p.ast}ast / ${p.fg3m}3pm`).join("\n")
      : `${teamName}: stats unavailable`;

    // B2B context
    const b2bContext = [
      b2b.home ? `${game.homeTeam} ON BACK-TO-BACK (played ${b2b.homeYesterday} yesterday)` : `${game.homeTeam}: rested`,
      b2b.away ? `${game.awayTeam} ON BACK-TO-BACK (played ${b2b.awayYesterday} yesterday)` : `${game.awayTeam}: rested`,
    ].join("\n");

    const today = new Date().toDateString();
    const prompt = `You are a sharp NBA SGP analyst for FanDuel. Today: ${today}.

GAME: ${game.awayTeam} (${game.awayAbbr}) @ ${game.homeTeam} (${game.homeAbbr})
TIME: ${game.time}

━━ LIVE ROSTERS (ESPN) ━━
${game.homeTeam}: ${homeRoster.join(", ")}
${game.awayTeam}: ${awayRoster.join(", ")}

━━ OFFICIAL NBA INJURY REPORT ━━
${injuryData.lines.join("\n")}

━━ BACK-TO-BACK STATUS ━━
${b2bContext}

━━ LIVE SEASON AVERAGES (NBA Stats 2025-26) ━━
${fmtAvgs(homeAvgs, game.homeTeam)}
${fmtAvgs(awayAvgs, game.awayTeam)}

━━ LAST 10 GAMES ━━
${game.homeTeam}: ${homeLast10.join(", ") || "unavailable"}
${game.awayTeam}: ${awayLast10.join(", ") || "unavailable"}

━━ H2H LAST 5 MATCHUPS ━━
${h2h.join(", ") || "unavailable"}

━━ INSTRUCTIONS ━━
Use the LIVE DATA above — not your training data — to generate props.
Base last10 hit rates on actual season averages vs prop threshold.
For example: if Brunson averages 27.3 pts, he likely hits 20+ in 9/10 games.
If a player is on a B2B, lower their confidence by 1 star.
Exclude any OUT or Doubtful players.
Boost teammates of OUT players.

FanDuel SGP formats:
- "TO SCORE 10+ POINTS" / "TO SCORE 20+ POINTS" / "TO SCORE 5+ POINTS"
- "OVER 17.5 ALT POINTS"
- "1+ MADE THREES" / "2+ MADE THREES"  
- "TO RECORD 4+ REBOUNDS" / "TO RECORD 8+ REBOUNDS"
- "TO RECORD 2+ ASSISTS" / "TO RECORD 4+ ASSISTS"

Return ONLY raw JSON, no markdown:

{
  "bestBet": "one sentence best bet using live data",
  "trend": "specific trend based on last 10 results above",
  "edge": "B2B, rest, or injury edge based on live data",
  "risk": "one sentence risk",
  "sharpTake": "sharp SGP recommendation",
  "sgpLegs": [
    {
      "player": "Full Player Name",
      "team": "ABBR",
      "prop": "TO SCORE 20+ POINTS",
      "category": "POINTS or THREES or REBOUNDS or ASSISTS",
      "last10": 8,
      "h2h": 4,
      "avg": "27.3 PPG",
      "confidence": 4,
      "injuryNote": "Curry OUT — usage boost" or "",
      "reason": "averaging 27.3 PPG this season, hit 20+ in estimated 8 of last 10"
    }
  ],
  "suggestedSGP": "Best 4-6 leg combo with correlation reasoning"
}

Include 8-10 legs across both teams, all 4 categories.`;

    const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 2500,
        system: "You are a JSON API. Respond with ONLY a valid JSON object. No markdown, no backticks, no extra text whatsoever.",
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const aiData = await aiRes.json();
    if (aiData.error) return { statusCode: 500, headers, body: JSON.stringify({ error: "AI error: " + JSON.stringify(aiData.error) }) };

    let raw = (aiData.content || []).map(b => b.text || "").join("").trim();
    raw = raw.replace(/^```json\s*/i,"").replace(/^```\s*/i,"").replace(/\s*```$/i,"").trim();

    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      const match = raw.match(/\{[\s\S]*\}/);
      if (match) {
        try { parsed = JSON.parse(match[0]); }
        catch { return { statusCode: 500, headers, body: JSON.stringify({ error: "JSON parse failed", raw: raw.substring(0,300) }) }; }
      } else {
        return { statusCode: 500, headers, body: JSON.stringify({ error: "No JSON found", raw: raw.substring(0,300) }) };
      }
    }

    // Attach all live data to response
    parsed.injuryReport = injuryData.lines;
    parsed.injurySource = injuryData.source;
    parsed.liveRosters = { home: homeRoster, away: awayRoster };
    parsed.b2b = b2b;
    parsed.last10 = { home: homeLast10, away: awayLast10 };
    parsed.h2h = h2h;

    return { statusCode: 200, headers, body: JSON.stringify(parsed) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
};
