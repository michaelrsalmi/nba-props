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
      const res = await fetch(url, {
        ...opts,
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch { return null; }
  }

  // ── Fetch live roster + player stats from Tank01 ──────────────────────
  async function fetchTeamData(teamAbv) {
    if (!TANK01_KEY) return { roster: [], stats: [] };

    const data = await safeFetch(
      `https://tank01-fantasy-stats.p.rapidapi.com/getNBATeamRoster?teamAbv=${teamAbv}&statsToGet=averages`,
      { headers: TANK_HEADERS }
    );

    if (!data?.body?.roster) return { roster: [], stats: [] };

    const roster = [];
    const stats = [];

    for (const [playerId, player] of Object.entries(data.body.roster)) {
      const name = player.longName || player.espnName || "";
      if (!name) continue;
      roster.push(name);

      const s = player.stats;
      if (s && parseFloat(s.gamesPlayed || 0) >= 5) {
        const pts = parseFloat(s.pts || 0);
        const reb = parseFloat(s.reb || 0);
        const ast = parseFloat(s.ast || 0);
        const fg3m = parseFloat(s.tptfgm || s.TPM || 0);
        const gp = parseInt(s.gamesPlayed || 0);

        // Estimate last10 hit rates from season averages
        // Using normal distribution approximation: if avg=X, std≈avg*0.35
        const hitRate = (avg, threshold) => {
          if (avg <= 0) return 0;
          // Simple estimate: if avg is X% above threshold, hit rate goes up
          const ratio = avg / threshold;
          if (ratio >= 2.0) return 10;
          if (ratio >= 1.6) return 9;
          if (ratio >= 1.35) return 8;
          if (ratio >= 1.15) return 7;
          if (ratio >= 1.0) return 6;
          if (ratio >= 0.85) return 4;
          if (ratio >= 0.7) return 2;
          return 1;
        };

        stats.push({
          name,
          pts: pts.toFixed(1),
          reb: reb.toFixed(1),
          ast: ast.toFixed(1),
          fg3m: fg3m.toFixed(1),
          gp,
          // Pre-calculated hit rates
          pts20: hitRate(pts, 20),
          pts15: hitRate(pts, 15),
          pts10: hitRate(pts, 10),
          pts5: hitRate(pts, 5),
          reb8: hitRate(reb, 8),
          reb6: hitRate(reb, 6),
          reb4: hitRate(reb, 4),
          ast4: hitRate(ast, 4),
          ast2: hitRate(ast, 2),
          fg3_2: hitRate(fg3m, 2),
          fg3_1: hitRate(fg3m, 1),
        });
      }
    }

    return {
      roster: roster.slice(0, 13),
      stats: stats.sort((a,b) => parseFloat(b.pts)-parseFloat(a.pts)).slice(0, 10),
    };
  }

  // ── Fetch injury report from Tank01 ─────────────────────────────────
  async function fetchInjuries(homeAbbr, awayAbbr) {
    if (!TANK01_KEY) return { lines: ["No Tank01 key set"], source: "failed" };

    const data = await safeFetch(
      `https://tank01-fantasy-stats.p.rapidapi.com/getNBAInjuryList`,
      { headers: TANK_HEADERS }
    );

    if (!data?.body) return { lines: ["Injury report unavailable"], source: "failed" };

    const injuries = Array.isArray(data.body) ? data.body : Object.values(data.body);
    const filtered = injuries.filter(p => {
      const t = (p.teamAbv || p.team || "").toUpperCase();
      return t === homeAbbr.toUpperCase() || t === awayAbbr.toUpperCase();
    });

    return {
      lines: filtered.length
        ? filtered.map(p => {
            const name = p.playerName || p.longName || "Unknown";
            const team = p.teamAbv || p.team || "";
            const status = p.injStatus || p.status || "Out";
            const desc = p.injDescription || p.description || "";
            return `${name} (${team}) — ${status}${desc ? ": "+desc : ""}`;
          })
        : ["No players on injury report for this game"],
      source: "Tank01",
    };
  }

  // ── B2B detection ─────────────────────────────────────────────────────
  async function detectB2B(homeAbbr, awayAbbr) {
    const result = { home:false, away:false, homeYesterday:"", awayYesterday:"" };
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate()-1);
    const yd = yesterday.toISOString().slice(0,10).replace(/-/g,"");
    const data = await safeFetch(
      `https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${yd}`
    );
    if (!data?.events) return result;
    for (const e of data.events) {
      const comp = e.competitions?.[0];
      const h = comp?.competitors?.find(c=>c.homeAway==="home")?.team?.abbreviation;
      const a = comp?.competitors?.find(c=>c.homeAway==="away")?.team?.abbreviation;
      if (!h||!a) continue;
      if (h===homeAbbr||a===homeAbbr){result.home=true;result.homeYesterday=`${a}@${h}`;}
      if (h===awayAbbr||a===awayAbbr){result.away=true;result.awayYesterday=`${a}@${h}`;}
    }
    return result;
  }

  // ── SCHEDULE GET ──────────────────────────────────────────────────────
  if (event.httpMethod === "GET") {
    const data = await safeFetch(
      "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard"
    );
    if (!data) return { statusCode:500, headers, body: JSON.stringify({ error:"Schedule failed" }) };

    const games = (data.events||[]).map(e => {
      const comp = e.competitions?.[0];
      const home = comp?.competitors?.find(c=>c.homeAway==="home");
      const away = comp?.competitors?.find(c=>c.homeAway==="away");
      const homeAbbr = home?.team?.abbreviation||"???";
      const awayAbbr = away?.team?.abbreviation||"???";
      return {
        id: e.id,
        homeTeam: home?.team?.displayName||"",
        awayTeam: away?.team?.displayName||"",
        homeAbbr, awayAbbr,
        homeRecord: home?.records?.[0]?.summary||"",
        awayRecord: away?.records?.[0]?.summary||"",
        time: new Date(e.date).toLocaleTimeString("en-US",{
          hour:"numeric",minute:"2-digit",timeZoneName:"short",timeZone:"America/New_York",
        }),
        status: comp?.status?.type?.description||"Scheduled",
      };
    });

    return { statusCode:200, headers, body: JSON.stringify({ games }) };
  }

  // ── ANALYZE POST ──────────────────────────────────────────────────────
  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body||"{}"); }
    catch { return { statusCode:400, headers, body: JSON.stringify({ error:"Invalid JSON" }) }; }

    const game = body.game;
    if (!game?.homeTeam) return { statusCode:400, headers, body: JSON.stringify({ error:"No game" }) };
    if (!ANTHROPIC_KEY) return { statusCode:500, headers, body: JSON.stringify({ error:"Missing Anthropic key" }) };

    // All 4 fetches in parallel
    const [homeData, awayData, injuryData, b2b] = await Promise.all([
      fetchTeamData(game.homeAbbr),
      fetchTeamData(game.awayAbbr),
      fetchInjuries(game.homeAbbr, game.awayAbbr),
      detectB2B(game.homeAbbr, game.awayAbbr),
    ]);

    const statsAvailable = homeData.stats.length > 0 || awayData.stats.length > 0;

    // Get OUT players to exclude
    const outPlayers = injuryData.lines
      .filter(l => l.toLowerCase().includes("out") || l.toLowerCase().includes("doubtful"))
      .map(l => l.split(" (")[0].toLowerCase().trim());

    const fmtStats = (data, teamName) => {
      if (!data.stats.length) return `${teamName}: stats unavailable`;
      const eligible = data.stats.filter(p =>
        !outPlayers.some(op => p.name.toLowerCase().includes(op))
      );
      return `${teamName} (live 2025-26 averages + hit rates):\n` +
        eligible.map(p =>
          `  ${p.name}: ${p.pts}pts/${p.reb}reb/${p.ast}ast/${p.fg3m}3pm | ` +
          `20+pts:${p.pts20}/10 15+pts:${p.pts15}/10 10+pts:${p.pts10}/10 5+pts:${p.pts5}/10 | ` +
          `8+reb:${p.reb8}/10 6+reb:${p.reb6}/10 4+reb:${p.reb4}/10 | ` +
          `4+ast:${p.ast4}/10 2+ast:${p.ast2}/10 | ` +
          `2+3pm:${p.fg3_2}/10 1+3pm:${p.fg3_1}/10`
        ).join("\n");
    };

    const today = new Date().toDateString();

    const prompt = `You are a sharp NBA SGP analyst for FanDuel. Today: ${today}.

GAME: ${game.awayTeam} (${game.awayAbbr}) @ ${game.homeTeam} (${game.homeAbbr})
TIME: ${game.time}
RECORDS: ${game.homeTeam} ${game.homeRecord} | ${game.awayTeam} ${game.awayRecord}

━━ LIVE ROSTERS (Tank01 API) ━━
${game.homeTeam}: ${homeData.roster.length ? homeData.roster.join(", ") : "unavailable"}
${game.awayTeam}: ${awayData.roster.length ? awayData.roster.join(", ") : "unavailable"}

━━ OFFICIAL NBA INJURY REPORT ━━
${injuryData.lines.join("\n")}

━━ BACK-TO-BACK STATUS (verified) ━━
${b2b.home ? `🔴 ${game.homeTeam} ON B2B — played ${b2b.homeYesterday} yesterday` : `✅ ${game.homeTeam}: rested`}
${b2b.away ? `🔴 ${game.awayTeam} ON B2B — played ${b2b.awayYesterday} yesterday` : `✅ ${game.awayTeam}: rested`}

━━ LIVE PLAYER STATS + HIT RATES (Tank01 2025-26) ━━
${statsAvailable
  ? fmtStats(homeData, game.homeTeam) + "\n\n" + fmtStats(awayData, game.awayTeam)
  : "Stats unavailable — use your 2025-26 NBA knowledge"}

━━ INSTRUCTIONS ━━
- Use the EXACT hit rates above for last10 values — these are real 2025-26 stats
- Only use players from the live rosters above
- Exclude any OUT or Doubtful players from injury report
- If a player is OUT, add their backup with a boosted prop and injuryNote
- B2B players: reduce confidence by 1 star
- Pick safe low thresholds — reliable SGP legs only

FanDuel SGP formats ONLY:
"TO SCORE 10+ POINTS" / "TO SCORE 20+ POINTS" / "TO SCORE 5+ POINTS"
"OVER 17.5 ALT POINTS"
"1+ MADE THREES" / "2+ MADE THREES"
"TO RECORD 4+ REBOUNDS" / "TO RECORD 8+ REBOUNDS"
"TO RECORD 2+ ASSISTS" / "TO RECORD 4+ ASSISTS"

Return ONLY raw JSON, no markdown:

{
  "bestBet": "one sentence best bet with real stats",
  "trend": "specific trend using live data above",
  "edge": "injury/B2B/rest edge — be specific",
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
      "injuryNote": "",
      "reason": "one sentence with real stats from data above"
    }
  ],
  "suggestedSGP": "Best 4-6 leg combo with correlation reasoning"
}

Include 8-10 legs across both teams, all 4 categories. Always return props.`;

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
        system: "You are a sharp NBA betting analyst JSON API. Always return valid JSON with sgpLegs populated. Never refuse or return empty props. No markdown, no backticks.",
        messages: [{ role:"user", content: prompt }],
      }),
    });

    const aiData = await aiRes.json();
    if (aiData.error) return {
      statusCode:500, headers,
      body: JSON.stringify({ error:"AI error: "+JSON.stringify(aiData.error) })
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
        return { statusCode:500, headers, body: JSON.stringify({ error:"No JSON found", raw:raw.substring(0,300) }) };
      }
    }

    parsed.injuryReport = injuryData.lines;
    parsed.injurySource = injuryData.source;
    parsed.liveRosters = { home: homeData.roster, away: awayData.roster };
    parsed.b2b = b2b;
    parsed.statsSource = statsAvailable ? "Tank01 API (live)" : "AI knowledge";

    return { statusCode:200, headers, body: JSON.stringify(parsed) };
  }

  return { statusCode:405, headers, body: JSON.stringify({ error:"Method not allowed" }) };
};
