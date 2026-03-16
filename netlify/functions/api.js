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

  // ── Fetch injuries from Tank01 ────────────────────────────────────────
  async function fetchInjuries(homeAbv, awayAbv) {
    if (!TANK01_KEY) return { lines: ["No Tank01 key"], source: "failed" };
    const data = await safeFetch(
      `https://tank01-fantasy-stats.p.rapidapi.com/getNBAInjuryList`,
      { headers: TANK_HEADERS }
    );
    if (!data?.body) return { lines: ["Injury report unavailable"], source: "failed" };

    const injuries = Array.isArray(data.body) ? data.body : Object.values(data.body);
    const filtered = injuries.filter(p => {
      const t = (p.teamAbv || p.team || "").toUpperCase();
      return t === homeAbv.toUpperCase() || t === awayAbv.toUpperCase();
    });

    return {
      lines: filtered.length
        ? filtered.map(p => {
            const name   = p.playerName || p.longName || "Unknown";
            const team   = p.teamAbv || p.team || "";
            const status = p.injStatus || p.status || "Out";
            const desc   = p.injDescription || p.description || "";
            return `${name} (${team}) — ${status}${desc ? ": "+desc : ""}`;
          })
        : ["No players on injury report for this game"],
      source: "Tank01",
    };
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

    const games = gameList.map((g, i) => {
      // Tank01 field names
      const homeAbv = (g.homeTeam || g.home || "???").toUpperCase();
      const awayAbv = (g.awayTeam || g.away || "???").toUpperCase();
      const homeTeam = g.homePts !== undefined ? g.home : (g.homeTeamName || g.homeTeam || homeAbv);
      const awayTeam = g.awayPts !== undefined ? g.away : (g.awayTeamName || g.awayTeam || awayAbv);

      // Parse game time
      let timeStr = "TBD";
      if (g.gameTime || g.startTime) {
        try {
          const t = g.gameTime || g.startTime;
          // Tank01 returns time like "7:30p" or epoch
          if (typeof t === "string" && t.includes(":")) {
            timeStr = t.replace("p"," PM").replace("a"," AM") + " ET";
          } else {
            const d = new Date(parseInt(t)*1000);
            timeStr = d.toLocaleTimeString("en-US",{
              hour:"numeric", minute:"2-digit", timeZoneName:"short", timeZone:"America/New_York"
            });
          }
        } catch { timeStr = "TBD"; }
      }

      return {
        id: g.gameID || g.id || `game-${i}`,
        homeTeam: g.homeTeamName || g.homeLongName || homeAbv,
        awayTeam: g.awayTeamName || g.awayLongName || awayAbv,
        homeAbbr: homeAbv,
        awayAbbr: awayAbv,
        homeRecord: g.homeTeamWins && g.homeTeamLosses ? `${g.homeTeamWins}-${g.homeTeamLosses}` : "",
        awayRecord: g.awayTeamWins && g.awayTeamLosses ? `${g.awayTeamWins}-${g.awayTeamLosses}` : "",
        time: timeStr,
        status: g.gameStatus || g.status || "Scheduled",
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

    const [homeData, awayData, injuryData, b2b] = await Promise.all([
      fetchTeamData(game.homeAbbr),
      fetchTeamData(game.awayAbbr),
      fetchInjuries(game.homeAbbr, game.awayAbbr),
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

━━ INSTRUCTIONS ━━
- Use EXACT hit rates above for last10 values
- Only use players from live rosters above
- Exclude OUT/Doubtful players
- Boost teammates of injured stars with injuryNote
- B2B teams: reduce confidence by 1 star
- Pick SAFE low thresholds for reliable SGP legs
- ALWAYS return 8-10 props

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
