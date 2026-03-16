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
    ATL:["Trae Young","Jalen Johnson","Dyson Daniels","De'Andre Hunter","Clint Capela"],
    BOS:["Jayson Tatum","Jaylen Brown","Derrick White","Jrue Holiday","Al Horford"],
    BKN:["Cam Thomas","Dennis Schroder","Day'Ron Sharpe","Ziaire Williams","Ben Simmons"],
    CHA:["LaMelo Ball","Miles Bridges","Brandon Miller","Grant Williams","Mark Williams"],
    CHI:["Zach LaVine","Nikola Vucevic","Coby White","Patrick Williams","Ayo Dosunmu"],
    CLE:["Donovan Mitchell","Darius Garland","Evan Mobley","Jarrett Allen","Max Strus"],
    DAL:["Luka Doncic","Kyrie Irving","P.J. Washington","Dereck Lively II","Dante Exum"],
    DEN:["Nikola Jokic","Jamal Murray","Michael Porter Jr.","Aaron Gordon","Kentavious Caldwell-Pope"],
    DET:["Cade Cunningham","Jalen Duren","Malik Beasley","Ausar Thompson","Alec Burks"],
    GSW:["Stephen Curry","Draymond Green","Jonathan Kuminga","Brandin Podziemski","Andrew Wiggins"],
    GS:["Stephen Curry","Draymond Green","Jonathan Kuminga","Brandin Podziemski","Andrew Wiggins"],
    HOU:["Alperen Sengun","Jalen Green","Fred VanVleet","Dillon Brooks","Amen Thompson"],
    IND:["Tyrese Haliburton","Pascal Siakam","Bennedict Mathurin","Myles Turner","Andrew Nembhard"],
    LAC:["James Harden","Kawhi Leonard","Ivica Zubac","Norman Powell","Paul George"],
    LAL:["LeBron James","Anthony Davis","Austin Reaves","D'Angelo Russell","Rui Hachimura"],
    MEM:["Ja Morant","Jaren Jackson Jr.","Desmond Bane","Vince Williams Jr.","Santi Aldama"],
    MIA:["Bam Adebayo","Tyler Herro","Terry Rozier","Jimmy Butler","Caleb Martin"],
    MIL:["Giannis Antetokounmpo","Damian Lillard","Brook Lopez","Khris Middleton","Bobby Portis"],
    MIN:["Anthony Edwards","Julius Randle","Rudy Gobert","Jaden McDaniels","Donte DiVincenzo"],
    NOP:["Brandon Ingram","Trey Murphy III","CJ McCollum","Zion Williamson","Herb Jones"],
    NO:["Brandon Ingram","Trey Murphy III","CJ McCollum","Zion Williamson","Herb Jones"],
    NY:["Jalen Brunson","Karl-Anthony Towns","Mikal Bridges","Josh Hart","Mitchell Robinson"],
    NYK:["Jalen Brunson","Karl-Anthony Towns","Mikal Bridges","Josh Hart","Mitchell Robinson"],
    OKC:["Shai Gilgeous-Alexander","Jalen Williams","Isaiah Hartenstein","Luguentz Dort","Chet Holmgren"],
    ORL:["Paolo Banchero","Franz Wagner","Wendell Carter Jr.","Jalen Suggs","Gary Harris"],
    PHI:["Joel Embiid","Tyrese Maxey","Paul George","Kelly Oubre Jr.","Tobias Harris"],
    PHX:["Kevin Durant","Devin Booker","Bradley Beal","Jusuf Nurkic","Grayson Allen"],
    PHO:["Kevin Durant","Devin Booker","Bradley Beal","Jusuf Nurkic","Grayson Allen"],
    POR:["Anfernee Simons","Jerami Grant","Deni Avdija","Deandre Ayton","Shaedon Sharpe"],
    SAC:["Domantas Sabonis","De'Aaron Fox","Kevin Huerter","Malik Monk","Harrison Barnes"],
    SAS:["Victor Wembanyama","Devin Vassell","Chris Paul","Keldon Johnson","Jeremy Sochan"],
    SA:["Victor Wembanyama","Devin Vassell","Chris Paul","Keldon Johnson","Jeremy Sochan"],
    TOR:["Scottie Barnes","RJ Barrett","Immanuel Quickley","Jakob Poeltl","Gradey Dick"],
    UTA:["Lauri Markkanen","Jordan Clarkson","John Collins","Keyonte George","Walker Kessler"],
    UTAH:["Lauri Markkanen","Jordan Clarkson","John Collins","Keyonte George","Walker Kessler"],
    WAS:["Kyle Kuzma","Jordan Poole","Alexandre Sarr","Corey Kispert","Jonas Valanciunas"],
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

      // ── FETCH INJURY REPORT from ESPN ─────────────────────────────
      let injuryContext = "";
      try {
        const homeSlug = game.homeTeam.toLowerCase().replace(/\s+/g, "-");
        const awaySlug = game.awayTeam.toLowerCase().replace(/\s+/g, "-");

        const [homeInjRes, awayInjRes] = await Promise.all([
          fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${game.homeAbbr.toLowerCase()}/injuries`),
          fetch(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${game.awayAbbr.toLowerCase()}/injuries`),
        ]);

        const parseInjuries = async (res, teamName) => {
          if (!res.ok) return "";
          const data = await res.json();
          const items = data.injuries || [];
          if (!items.length) return `${teamName}: No injuries reported.`;
          const list = items.map(i => {
            const name = i.athlete?.displayName || "Unknown";
            const status = i.status || "Out";
            const detail = i.details?.detail || i.longComment || "";
            return `${name} (${status}${detail ? " - " + detail : ""})`;
          }).join(", ");
          return `${teamName}: ${list}`;
        };

        const [homeInj, awayInj] = await Promise.all([
          parseInjuries(homeInjRes, game.homeTeam),
          parseInjuries(awayInjRes, game.awayTeam),
        ]);

        injuryContext = [homeInj, awayInj].filter(Boolean).join("\n");
      } catch(e) {
        injuryContext = "Injury data unavailable - use your knowledge of recent injuries.";
      }

      const today = new Date().toDateString();
      const prompt = `You are a sharp NBA Same Game Parlay analyst for FanDuel. Today: ${today}.

GAME: ${game.awayTeam} (${game.awayAbbr}) @ ${game.homeTeam} (${game.homeAbbr})
TIME: ${game.time}
HOME PLAYERS: ${(game.homePlayers||[]).join(", ")}
AWAY PLAYERS: ${(game.awayPlayers||[]).join(", ")}

TODAY'S INJURY REPORT:
${injuryContext}

CRITICAL INJURY RULES:
- If a key player is OUT, do NOT include them as a prop leg
- If a key player is OUT, boost props for their replacement/teammates who absorb usage
- Flag any injury-boosted props clearly in the reason (e.g. "Curry OUT boosts Podziemski usage — hit 2+ assists in 10/10 games with Curry out")
- If a player is QUESTIONABLE, note it but include a backup leg

Generate SGP legs exactly how FanDuel phrases them:
- "TO SCORE 10+ POINTS" or "TO SCORE 20+ POINTS"  
- "OVER 17.5 ALT POINTS" for alt point lines
- "1+ MADE THREES" or "2+ MADE THREES"
- "TO RECORD 4+ REBOUNDS" or "TO RECORD 8+ REBOUNDS"
- "TO RECORD 2+ ASSISTS"
- "TO SCORE 5+ POINTS"

Pick LOW, SAFE thresholds for SGP legs. These need to be reliable hits.
Prioritize injury-adjusted props where a player's role expands due to absences.

Return ONLY a raw JSON object, no markdown, no backticks:

{
  "bestBet": "one sentence game best bet",
  "trend": "specific 10-game trend with real numbers",
  "edge": "key situational or injury edge in one sentence",
  "risk": "one sentence risk factor",
  "sharpTake": "sharp SGP recommendation in one sentence",
  "injuries": ["short injury note 1", "short injury note 2"],
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
      "injuryNote": "Curry OUT — boosts usage" or "",
      "reason": "punchy one sentence — e.g. hit 20+ in 8 of last 10, averaging 24.1 PPG"
    }
  ],
  "suggestedSGP": "Describe the best 4-6 leg SGP combo from these legs and why they correlate well together"
}

Include 8-10 SGP legs. Mix all categories. Prioritize injury-boosted props.`;

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
