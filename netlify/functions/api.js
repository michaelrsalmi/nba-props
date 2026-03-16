exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const FETCH_OPTS = {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
      "Referer": "https://www.nba.com/",
      "Origin": "https://www.nba.com",
      "Accept": "application/json",
      "x-nba-stats-origin": "stats",
      "x-nba-stats-token": "true",
    }
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

  const ESPN_ID = {
    ATL:"1",BOS:"2",BKN:"17",CHA:"30",CHI:"4",CLE:"5",DAL:"6",DEN:"7",
    DET:"8",GSW:"9",GS:"9",HOU:"10",IND:"11",LAC:"12",LAL:"13",MEM:"29",
    MIA:"14",MIL:"15",MIN:"16",NOP:"3",NO:"3",NYK:"18",NY:"18",OKC:"25",
    ORL:"19",PHI:"20",PHX:"21",PHO:"21",POR:"22",SAC:"23",SAS:"24",SA:"24",
    TOR:"28",UTA:"26",UTAH:"26",WAS:"27",
  };

  async function safeFetch(url) {
    try {
      const res = await fetch(url, { ...FETCH_OPTS, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  // ── SCHEDULE (GET) ──────────────────────────────────────────────────────
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

  // ── ANALYZE (POST) ──────────────────────────────────────────────────────
  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body || "{}"); }
    catch { return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) }; }

    const game = body.game;
    if (!game?.homeTeam) return { statusCode: 400, headers, body: JSON.stringify({ error: "No game" }) };

    const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
    if (!ANTHROPIC_KEY) return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing API key" }) };

    // ── 3 focused fetches only: roster, injuries, B2B ──────────────────
    const homeSlug = SLUG_MAP[game.homeAbbr] || game.homeAbbr.toLowerCase();
    const awaySlug = SLUG_MAP[game.awayAbbr] || game.awayAbbr.toLowerCase();

    const yesterday = new Date(); yesterday.setDate(yesterday.getDate() - 1);
    const yd = yesterday.toISOString().slice(0,10).replace(/-/g,"");

    const [homeRosterData, awayRosterData, injuryData, yesterdayData] = await Promise.all([
      safeFetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${homeSlug}/roster`),
      safeFetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${awaySlug}/roster`),
      safeFetch("https://cdn.nba.com/static/json/liveData/injuryreport/injuryreport.json"),
      safeFetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${yd}`),
    ]);

    // Parse rosters
    const parseRoster = (data) => {
      if (!data) return [];
      const players = [];
      for (const group of (data.athletes || [])) {
        for (const p of (group.items || [])) {
          players.push(p.displayName || p.fullName || "");
        }
      }
      return players.filter(Boolean).slice(0, 10);
    };
    const homeRoster = parseRoster(homeRosterData);
    const awayRoster = parseRoster(awayRosterData);

    // Parse injuries - filter to these two teams
    let injuryLines = ["No players on injury report for this game"];
    let injurySource = "NBA Official";
    if (injuryData?.injuryReport) {
      const homeLast = game.homeTeam.split(" ").pop().toLowerCase();
      const awayLast = game.awayTeam.split(" ").pop().toLowerCase();
      const filtered = injuryData.injuryReport.filter(p => {
        const t = (p.teamName || "").toLowerCase();
        return t.includes(homeLast) || t.includes(awayLast);
      });
      if (filtered.length) {
        injuryLines = filtered.map(p =>
          `${p.playerName} (${p.teamName}) — ${p.currentStatus}${p.reason ? ": "+p.reason : ""}`
        );
      }
    } else {
      injuryLines = ["Injury report unavailable — check nba.com/players/injury-report"];
      injurySource = "failed";
    }

    // Parse B2B
    const b2b = { home: false, away: false, homeYesterday: "", awayYesterday: "" };
    if (yesterdayData?.events) {
      for (const e of yesterdayData.events) {
        const comp = e.competitions?.[0];
        const h = comp?.competitors?.find(c => c.homeAway === "home")?.team?.abbreviation;
        const a = comp?.competitors?.find(c => c.homeAway === "away")?.team?.abbreviation;
        if (h === game.homeAbbr || a === game.homeAbbr) { b2b.home = true; b2b.homeYesterday = `${a} @ ${h}`; }
        if (h === game.awayAbbr || a === game.awayAbbr) { b2b.away = true; b2b.awayYesterday = `${a} @ ${h}`; }
      }
    }

    const today = new Date().toDateString();
    const prompt = `You are a sharp NBA SGP analyst for FanDuel. Today: ${today}.

GAME: ${game.awayTeam} (${game.awayAbbr}) @ ${game.homeTeam} (${game.homeAbbr})
TIME: ${game.time}
RECORDS: ${game.homeTeam} ${game.homeRecord}, ${game.awayTeam} ${game.awayRecord}

━━ LIVE ROSTERS (ESPN) ━━
${game.homeTeam}: ${homeRoster.length ? homeRoster.join(", ") : "unavailable"}
${game.awayTeam}: ${awayRoster.length ? awayRoster.join(", ") : "unavailable"}

━━ OFFICIAL NBA INJURY REPORT ━━
${injuryLines.join("\n")}

━━ BACK-TO-BACK STATUS ━━
${b2b.home ? `${game.homeTeam} ON B2B — played ${b2b.homeYesterday} yesterday` : `${game.homeTeam}: rested`}
${b2b.away ? `${game.awayTeam} ON B2B — played ${b2b.awayYesterday} yesterday` : `${game.awayTeam}: rested`}

━━ INSTRUCTIONS ━━
- Use live roster above for player names — these are accurate
- Exclude any OUT/Doubtful players from props
- Boost teammates of OUT players and note why
- If a team is on B2B, lower star players confidence by 1
- Use your knowledge of 2025-26 season stats for averages and hit rates
- Be specific: "averaging 27.3 PPG, hits 20+ in ~8 of 10 games"

FanDuel SGP formats only:
"TO SCORE 10+ POINTS" / "TO SCORE 20+ POINTS" / "TO SCORE 5+ POINTS"
"OVER 17.5 ALT POINTS"
"1+ MADE THREES" / "2+ MADE THREES"
"TO RECORD 4+ REBOUNDS" / "TO RECORD 8+ REBOUNDS"
"TO RECORD 2+ ASSISTS" / "TO RECORD 4+ ASSISTS"

Return ONLY raw JSON, no markdown, no backticks:

{
  "bestBet": "one sentence best bet",
  "trend": "specific trend with numbers from this season",
  "edge": "B2B, rest, or injury edge",
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

    parsed.injuryReport = injuryLines;
    parsed.injurySource = injurySource;
    parsed.liveRosters = { home: homeRoster, away: awayRoster };
    parsed.b2b = b2b;

    return { statusCode: 200, headers, body: JSON.stringify(parsed) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
};
