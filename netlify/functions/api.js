exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const NBA_FETCH = {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      "Referer": "https://www.nba.com/",
      "Origin": "https://www.nba.com",
      "Accept": "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      "x-nba-stats-origin": "stats",
      "x-nba-stats-token": "true",
      "Cache-Control": "no-cache",
    },
    signal: AbortSignal.timeout(10000),
  };

  const SLUG_MAP = {
    ATL:"atlanta-hawks",BOS:"boston-celtics",BKN:"brooklyn-nets",
    CHA:"charlotte-hornets",CHI:"chicago-bulls",CLE:"cleveland-cavaliers",
    DAL:"dallas-mavericks",DEN:"denver-nuggets",DET:"detroit-pistons",
    GSW:"golden-state-warriors",GS:"golden-state-warriors",
    HOU:"houston-rockets",IND:"indiana-pacers",LAC:"la-clippers",
    LAL:"los-angeles-lakers",MEM:"memphis-grizzlies",MIA:"miami-heat",
    MIL:"milwaukee-bucks",MIN:"minnesota-timberwolves",
    NOP:"new-orleans-pelicans",NO:"new-orleans-pelicans",
    NYK:"new-york-knicks",NY:"new-york-knicks",
    OKC:"oklahoma-city-thunder",ORL:"orlando-magic",
    PHI:"philadelphia-76ers",PHX:"phoenix-suns",PHO:"phoenix-suns",
    POR:"portland-trail-blazers",SAC:"sacramento-kings",
    SAS:"san-antonio-spurs",SA:"san-antonio-spurs",
    TOR:"toronto-raptors",UTA:"utah-jazz",UTAH:"utah-jazz",
    WAS:"washington-wizards",
  };

  // NBA Stats team IDs
  const NBA_TEAM_IDS = {
    ATL:"1610612737",BOS:"1610612738",BKN:"1610612751",CHA:"1610612766",
    CHI:"1610612741",CLE:"1610612739",DAL:"1610612742",DEN:"1610612743",
    DET:"1610612765",GSW:"1610612744",GS:"1610612744",HOU:"1610612745",
    IND:"1610612754",LAC:"1610612746",LAL:"1610612747",MEM:"1610612763",
    MIA:"1610612748",MIL:"1610612749",MIN:"1610612750",NOP:"1610612740",
    NO:"1610612740",NYK:"1610612752",NY:"1610612752",OKC:"1610612760",
    ORL:"1610612753",PHI:"1610612755",PHX:"1610612756",PHO:"1610612756",
    POR:"1610612757",SAC:"1610612758",SAS:"1610612759",SA:"1610612759",
    TOR:"1610612761",UTA:"1610612762",UTAH:"1610612762",WAS:"1610612764",
  };

  async function safeFetch(url, opts = {}) {
    try {
      const res = await fetch(url, { ...NBA_FETCH, ...opts });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  // Get live roster from NBA Stats API - most authoritative source
  async function fetchNBARoster(teamAbbr) {
    const teamId = NBA_TEAM_IDS[teamAbbr];
    if (!teamId) return [];
    const data = await safeFetch(
      `https://stats.nba.com/stats/commonteamroster?TeamID=${teamId}&Season=2025-26`
    );
    if (!data) return [];
    try {
      const hdrs = data.resultSets[0].headers;
      const rows = data.resultSets[0].rowSet;
      const ni = hdrs.indexOf("PLAYER");
      return rows.map(r => r[ni]).filter(Boolean);
    } catch { return []; }
  }

  // Fallback: ESPN roster
  async function fetchESPNRoster(abbr) {
    const slug = SLUG_MAP[abbr];
    if (!slug) return [];
    const data = await safeFetch(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${slug}/roster`
    );
    if (!data) return [];
    const players = [];
    for (const group of (data.athletes || [])) {
      for (const p of (group.items || [])) {
        players.push(p.displayName || p.fullName || "");
      }
    }
    return players.filter(Boolean).slice(0, 12);
  }

  // Get roster with fallback
  async function fetchRoster(abbr) {
    const nba = await fetchNBARoster(abbr);
    if (nba.length > 0) return { players: nba, source: "NBA Stats" };
    const espn = await fetchESPNRoster(abbr);
    return { players: espn, source: "ESPN" };
  }

  // Official NBA injury report
  async function fetchInjuries(homeTeam, awayTeam) {
    const data = await safeFetch(
      "https://cdn.nba.com/static/json/liveData/injuryreport/injuryreport.json"
    );
    if (!data?.injuryReport) {
      return { lines: ["Injury report unavailable — check nba.com/players/injury-report"], source: "failed" };
    }
    const homeLast = homeTeam.split(" ").pop().toLowerCase();
    const awayLast = awayTeam.split(" ").pop().toLowerCase();
    const filtered = data.injuryReport.filter(p => {
      const t = (p.teamName || "").toLowerCase();
      return t.includes(homeLast) || t.includes(awayLast);
    });
    return {
      lines: filtered.length
        ? filtered.map(p => `${p.playerName} (${p.teamName}) — ${p.currentStatus}${p.reason ? ": " + p.reason : ""}`)
        : ["No players on injury report for this game"],
      source: "NBA Official",
    };
  }

  // B2B detection via yesterday's ESPN scoreboard
  async function detectB2B(homeAbbr, awayAbbr) {
    const result = { home: false, away: false, homeYesterday: "", awayYesterday: "" };
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const yd = yesterday.toISOString().slice(0, 10).replace(/-/g, "");
    const data = await safeFetch(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${yd}`
    );
    if (!data?.events) return result;
    for (const e of data.events) {
      const comp = e.competitions?.[0];
      const h = comp?.competitors?.find(c => c.homeAway === "home")?.team?.abbreviation;
      const a = comp?.competitors?.find(c => c.homeAway === "away")?.team?.abbreviation;
      if (!h || !a) continue;
      if (h === homeAbbr || a === homeAbbr) { result.home = true; result.homeYesterday = `${a}@${h}`; }
      if (h === awayAbbr || a === awayAbbr) { result.away = true; result.awayYesterday = `${a}@${h}`; }
    }
    return result;
  }

  // ── SCHEDULE GET ────────────────────────────────────────────────────────
  if (event.httpMethod === "GET") {
    const data = await safeFetch(
      "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard"
    );
    if (!data) return { statusCode: 500, headers, body: JSON.stringify({ error: "Schedule failed" }) };

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
        time: new Date(e.date).toLocaleTimeString("en-US", {
          hour: "numeric", minute: "2-digit", timeZoneName: "short",
          timeZone: "America/New_York",
        }),
        status: comp?.status?.type?.description || "Scheduled",
      };
    });

    return { statusCode: 200, headers, body: JSON.stringify({ games }) };
  }

  // ── ANALYZE POST ────────────────────────────────────────────────────────
  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

    const game = body.game;
    if (!game?.homeTeam) return { statusCode: 400, headers, body: JSON.stringify({ error: "No game" }) };

    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing API key" }) };

    // Run 4 fetches in parallel with individual timeouts
    const [homeResult, awayResult, injuryData, b2b] = await Promise.all([
      fetchRoster(game.homeAbbr),
      fetchRoster(game.awayAbbr),
      fetchInjuries(game.homeTeam, game.awayTeam),
      detectB2B(game.homeAbbr, game.awayAbbr),
    ]);

    const homeRoster = homeResult.players;
    const awayRoster = awayResult.players;
    const rosterSource = homeResult.source;

    const today = new Date().toDateString();

    const prompt = `You are a sharp NBA SGP analyst for FanDuel. Today: ${today}.

GAME: ${game.awayTeam} (${game.awayAbbr}) @ ${game.homeTeam} (${game.homeAbbr})
TIME: ${game.time}
RECORDS: ${game.homeTeam} ${game.homeRecord}, ${game.awayTeam} ${game.awayRecord}

━━ LIVE ROSTERS — ${rosterSource} ━━
${game.homeTeam}: ${homeRoster.length ? homeRoster.join(", ") : "fetch failed"}
${game.awayTeam}: ${awayRoster.length ? awayRoster.join(", ") : "fetch failed"}

━━ OFFICIAL NBA INJURY REPORT ━━
${injuryData.lines.join("\n")}

━━ BACK-TO-BACK STATUS ━━
${b2b.home ? `🔴 ${game.homeTeam} ON B2B — played ${b2b.homeYesterday} yesterday` : `✅ ${game.homeTeam}: rested`}
${b2b.away ? `🔴 ${game.awayTeam} ON B2B — played ${b2b.awayYesterday} yesterday` : `✅ ${game.awayTeam}: rested`}

━━ INSTRUCTIONS ━━
- ONLY use players from the live rosters above — do not add players not listed
- Exclude any player listed as OUT or Doubtful in the injury report
- Boost teammates who absorb usage from injured stars
- B2B teams: reduce confidence by 1 star for high-usage players
- Use your 2025-26 season knowledge for stats and hit rates
- Be specific with numbers: "averaging 24.3 PPG, hits 20+ in ~8 of last 10"

FanDuel SGP formats ONLY:
"TO SCORE 10+ POINTS" / "TO SCORE 20+ POINTS" / "TO SCORE 5+ POINTS"
"OVER 17.5 ALT POINTS"
"1+ MADE THREES" / "2+ MADE THREES"
"TO RECORD 4+ REBOUNDS" / "TO RECORD 8+ REBOUNDS"
"TO RECORD 2+ ASSISTS" / "TO RECORD 4+ ASSISTS"

Return ONLY raw JSON — no markdown, no backticks:

{
  "bestBet": "one sentence best bet",
  "trend": "specific trend with numbers",
  "edge": "injury/B2B/rest edge",
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
      "reason": "one sentence with stats"
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
        max_tokens: 2000,
        system: "You are a JSON API. Respond with ONLY a valid JSON object. No markdown, no backticks, no extra text.",
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const aiData = await aiRes.json();
    if (aiData.error) return {
      statusCode: 500, headers,
      body: JSON.stringify({ error: "AI error: " + JSON.stringify(aiData.error) })
    };

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

    parsed.injuryReport = injuryData.lines;
    parsed.injurySource = injuryData.source;
    parsed.liveRosters = {
      home: homeRoster,
      away: awayRoster,
      source: rosterSource,
    };
    parsed.b2b = b2b;

    return { statusCode: 200, headers, body: JSON.stringify(parsed) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
};
