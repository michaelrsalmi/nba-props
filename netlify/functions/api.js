exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  const TEAM_PLAYERS = {
    ATL:["Trae Young","Jalen Johnson","Dyson Daniels"],
    BOS:["Jayson Tatum","Jaylen Brown","Derrick White"],
    BKN:["Cam Thomas","Dennis Schroder","Day'Ron Sharpe"],
    CHA:["LaMelo Ball","Miles Bridges","Brandon Miller"],
    CHI:["Zach LaVine","Nikola Vucevic","Coby White"],
    CLE:["Donovan Mitchell","Darius Garland","Evan Mobley"],
    DAL:["Luka Doncic","Kyrie Irving","P.J. Washington"],
    DEN:["Nikola Jokic","Jamal Murray","Michael Porter Jr."],
    DET:["Cade Cunningham","Jalen Duren","Malik Beasley"],
    GSW:["Stephen Curry","Draymond Green","Jonathan Kuminga"],
    GS:["Stephen Curry","Draymond Green","Jonathan Kuminga"],
    HOU:["Alperen Sengun","Jalen Green","Fred VanVleet"],
    IND:["Tyrese Haliburton","Pascal Siakam","Bennedict Mathurin"],
    LAC:["James Harden","Kawhi Leonard","Ivica Zubac"],
    LAL:["LeBron James","Anthony Davis","Austin Reaves"],
    MEM:["Ja Morant","Jaren Jackson Jr.","Desmond Bane"],
    MIA:["Bam Adebayo","Tyler Herro","Terry Rozier"],
    MIL:["Giannis Antetokounmpo","Damian Lillard","Brook Lopez"],
    MIN:["Anthony Edwards","Julius Randle","Rudy Gobert"],
    NOP:["Brandon Ingram","Trey Murphy III","CJ McCollum"],
    NO:["Brandon Ingram","Trey Murphy III","CJ McCollum"],
    NY:["Jalen Brunson","Karl-Anthony Towns","Mikal Bridges"],
    NYK:["Jalen Brunson","Karl-Anthony Towns","Mikal Bridges"],
    OKC:["Shai Gilgeous-Alexander","Jalen Williams","Isaiah Hartenstein"],
    ORL:["Paolo Banchero","Franz Wagner","Wendell Carter Jr."],
    PHI:["Joel Embiid","Tyrese Maxey","Paul George"],
    PHX:["Kevin Durant","Devin Booker","Bradley Beal"],
    PHO:["Kevin Durant","Devin Booker","Bradley Beal"],
    POR:["Anfernee Simons","Jerami Grant","Deni Avdija"],
    SAC:["Domantas Sabonis","De'Aaron Fox","Kevin Huerter"],
    SAS:["Victor Wembanyama","Devin Vassell","Chris Paul"],
    SA:["Victor Wembanyama","Devin Vassell","Chris Paul"],
    TOR:["Scottie Barnes","RJ Barrett","Immanuel Quickley"],
    UTA:["Lauri Markkanen","Jordan Clarkson","John Collins"],
    UTAH:["Lauri Markkanen","Jordan Clarkson","John Collins"],
    WAS:["Kyle Kuzma","Jordan Poole","Alexandre Sarr"],
  };

  try {
    // ── SCHEDULE (GET) ─────────────────────────────────────────────────
    if (event.httpMethod === "GET") {
      const res = await fetch(
        "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard"
      );
      const json = await res.json();

      const games = (json.events || []).map((e) => {
        const comp = e.competitions?.[0];
        const home = comp?.competitors?.find((c) => c.homeAway === "home");
        const away = comp?.competitors?.find((c) => c.homeAway === "away");
        const homeAbbr = home?.team?.abbreviation || "???";
        const awayAbbr = away?.team?.abbreviation || "???";
        return {
          id: e.id,
          homeTeam: home?.team?.displayName || "",
          awayTeam: away?.team?.displayName || "",
          homeAbbr,
          awayAbbr,
          homeRecord: home?.records?.[0]?.summary || "",
          awayRecord: away?.records?.[0]?.summary || "",
          time: new Date(e.date).toLocaleTimeString("en-US", {
            hour: "numeric", minute: "2-digit", timeZoneName: "short",
            timeZone: "America/New_York",
          }),
          status: comp?.status?.type?.description || "Scheduled",
          homePlayers: TEAM_PLAYERS[homeAbbr] || [],
          awayPlayers: TEAM_PLAYERS[awayAbbr] || [],
        };
      });

      return { statusCode: 200, headers, body: JSON.stringify({ games }) };
    }

    // ── ANALYZE (POST) ─────────────────────────────────────────────────
    if (event.httpMethod === "POST") {
      let body;
      try {
        body = JSON.parse(event.body || "{}");
      } catch {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON" }) };
      }

      const game = body.game;
      if (!game || !game.homeTeam) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "No game data" }) };
      }

      const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
      if (!ANTHROPIC_KEY) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing ANTHROPIC_API_KEY env var" }) };
      }

      const today = new Date().toDateString();
      const prompt = `You are a sharp NBA Same Game Parlay analyst for FanDuel. Today: ${today}.

GAME: ${game.awayTeam} (${game.awayAbbr}) @ ${game.homeTeam} (${game.homeAbbr})
TIME: ${game.time}
HOME PLAYERS: ${(game.homePlayers||[]).join(", ")}
AWAY PLAYERS: ${(game.awayPlayers||[]).join(", ")}

Use your knowledge of the 2025-26 NBA season.

Generate SGP-style alt props exactly like FanDuel phrases them:
- "TO SCORE 10+ POINTS" (not "over 10.5 points")
- "1+ MADE THREES" or "2+ MADE THREES"
- "TO RECORD 6+ REBOUNDS"
- "TO RECORD 2+ ASSISTS"

Pick LOW, SAFE thresholds that hit consistently — like 10+ points for a starter, 1+ three for a shooter, 4+ rebounds for a big. These are SGP legs so they need to be reliable.

Return ONLY a raw JSON object, no markdown, no backticks:

{
  "bestBet": "one sentence best bet for the game",
  "trend": "specific 10-game trend with real numbers",
  "edge": "situational edge: rest/revenge/B2B in one sentence",
  "risk": "one sentence risk factor",
  "sharpTake": "sharp one-liner SGP recommendation",
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
      "reason": "one punchy sentence — e.g. averaging 28.4 PPG, hit 20+ in 8 of last 10"
    }
  ],
  "suggestedSGP": "3-4 sentence description of the best SGP combo from these legs and why they correlate"
}

Include 8-10 SGP legs covering both teams. Mix point thresholds, threes, rebounds, assists.
Focus on legs that CORRELATE well for SGPs — e.g. if a team wins big, their star scores more AND gets more assists.`;

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
          system: "You are a JSON API. Your entire response must be a single valid JSON object. No markdown, no backticks, no text before or after the JSON.",
          messages: [{ role: "user", content: prompt }],
        }),
      });

      const aiData = await aiRes.json();

      if (aiData.error) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: "Anthropic API error: " + JSON.stringify(aiData.error) }) };
      }

      let raw = (aiData.content || []).map((b) => b.text || "").join("").trim();
      raw = raw.replace(/^```json\s*/i, "").replace(/^```\s*/i, "").replace(/\s*```$/i, "").trim();

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          try { parsed = JSON.parse(match[0]); }
          catch { return { statusCode: 500, headers, body: JSON.stringify({ error: "JSON parse failed", raw: raw.substring(0, 300) }) }; }
        } else {
          return { statusCode: 500, headers, body: JSON.stringify({ error: "No JSON found", raw: raw.substring(0, 300) }) };
        }
      }

      return { statusCode: 200, headers, body: JSON.stringify(parsed) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
