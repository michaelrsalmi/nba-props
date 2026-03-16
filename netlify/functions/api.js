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

  // ── Live roster from Tank01 ───────────────────────────────────────────
  async function getRoster(abbr) {
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

━━ RULES (follow exactly) ━━
1. ONLY generate props for players in the VALID PLAYERS list above
2. NEVER include players not in that list — they are on different teams or inactive
3. Exclude ANY player listed as OUT or Doubtful in injury report
4. If a star is out, boost their backup who IS in the roster list
5. B2B team players: lower confidence by 1 star
6. Use your 2025-26 season knowledge for stats and hit rates
7. Return ONLY raw JSON — no text before or after

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

Include 6 legs. Mix all 4 categories. Only use players from the VALID PLAYERS list.`;

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
        max_tokens: 2500,
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

    // Post-process: remove any props for players not in roster
    if (allRosterPlayers.length && parsed.sgpLegs) {
      parsed.sgpLegs = parsed.sgpLegs.filter(leg => {
        const name = (leg.player || "").toLowerCase();
        return allRosterPlayers.some(p => p.toLowerCase().includes(name) || name.includes(p.toLowerCase().split(" ")[1] || ""));
      });
    }

    parsed.injuryReport = [...cdnInjuries, ...(webInjuries ? webInjuries.split("\n").filter(l => l.trim()) : [])];
    parsed.liveRosters = { home: homeRoster, away: awayRoster };
    parsed.b2b = b2b;

    return { statusCode: 200, headers, body: JSON.stringify(parsed) };
  }

  return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };
};
