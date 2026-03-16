exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  // ── 2025-26 ROSTERS (current as of Mar 2026 w/ trades) ────────────────
  const TEAM_PLAYERS = {
    ATL:["Trae Young","Jalen Johnson","Dyson Daniels","De'Andre Hunter","Clint Capela","Larry Nance Jr."],
    BOS:["Jayson Tatum","Jaylen Brown","Derrick White","Jrue Holiday","Al Horford","Kristaps Porzingis"],
    BKN:["Cam Thomas","Dennis Schroder","Day'Ron Sharpe","Ziaire Williams","Noah Clowney"],
    CHA:["LaMelo Ball","Brandon Miller","Grant Williams","Mark Williams","Josh Green","Tidjane Salaun"],
    CHI:["Josh Giddey","Nikola Vucevic","Coby White","Patrick Williams","Ayo Dosunmu","Zach LaVine"],
    CLE:["Donovan Mitchell","Darius Garland","Evan Mobley","Jarrett Allen","De'Andre Hunter","Max Strus"],
    DAL:["Luka Doncic","Kyrie Irving","Klay Thompson","P.J. Washington","Dereck Lively II","Quentin Grimes"],
    DEN:["Nikola Jokic","Jamal Murray","Michael Porter Jr.","Aaron Gordon","Peyton Watson","Julian Strawther"],
    DET:["Cade Cunningham","Jalen Duren","Malik Beasley","Ausar Thompson","Tim Hardaway Jr.","Tobias Harris"],
    GSW:["Stephen Curry","Draymond Green","Jonathan Kuminga","Brandin Podziemski","Andrew Wiggins","Buddy Hield"],
    GS:["Stephen Curry","Draymond Green","Jonathan Kuminga","Brandin Podziemski","Andrew Wiggins","Buddy Hield"],
    HOU:["Alperen Sengun","Jalen Green","Fred VanVleet","Dillon Brooks","Amen Thompson","Jabari Smith Jr."],
    IND:["Tyrese Haliburton","Pascal Siakam","Bennedict Mathurin","Myles Turner","Andrew Nembhard","Aaron Nesmith"],
    LAC:["James Harden","Ivica Zubac","Norman Powell","Derrick Jones Jr.","Kris Dunn","Isaiah Jackson"],
    LAL:["LeBron James","Anthony Davis","Austin Reaves","Rui Hachimura","Gabe Vincent","Dorian Finney-Smith"],
    MEM:["Ja Morant","Jaren Jackson Jr.","Desmond Bane","Vince Williams Jr.","Santi Aldama","Marcus Smart"],
    MIA:["Bam Adebayo","Tyler Herro","Terry Rozier","Jimmy Butler","Nikola Jovic","Thomas Bryant"],
    MIL:["Giannis Antetokounmpo","Damian Lillard","Brook Lopez","Bobby Portis","Ryan Rollins","AJ Green"],
    MIN:["Anthony Edwards","Julius Randle","Rudy Gobert","Jaden McDaniels","Donte DiVincenzo","Naz Reid"],
    NOP:["Brandon Ingram","Trey Murphy III","CJ McCollum","Zion Williamson","Herb Jones","Jordan Hawkins"],
    NO:["Brandon Ingram","Trey Murphy III","CJ McCollum","Zion Williamson","Herb Jones","Jordan Hawkins"],
    NY:["Jalen Brunson","Karl-Anthony Towns","Mikal Bridges","Josh Hart","Mitchell Robinson","OG Anunoby"],
    NYK:["Jalen Brunson","Karl-Anthony Towns","Mikal Bridges","Josh Hart","Mitchell Robinson","OG Anunoby"],
    OKC:["Shai Gilgeous-Alexander","Jalen Williams","Chet Holmgren","Luguentz Dort","Isaiah Hartenstein","Isaiah Joe"],
    ORL:["Paolo Banchero","Franz Wagner","Wendell Carter Jr.","Jalen Suggs","Gary Harris","Anthony Black"],
    PHI:["Joel Embiid","Tyrese Maxey","Paul George","Kelly Oubre Jr.","Andre Drummond","Kyle Lowry"],
    PHX:["Kevin Durant","Devin Booker","Bradley Beal","Jusuf Nurkic","Grayson Allen","Monte Morris"],
    PHO:["Kevin Durant","Devin Booker","Bradley Beal","Jusuf Nurkic","Grayson Allen","Monte Morris"],
    POR:["Anfernee Simons","Jerami Grant","Deni Avdija","Deandre Ayton","Shaedon Sharpe","Toumani Camara"],
    SAC:["Domantas Sabonis","DeMar DeRozan","Malik Monk","Kevin Huerter","Daeqwon Plowden","Maxime Raynaud","Nique Clifford"],
    SAS:["Victor Wembanyama","De'Aaron Fox","Devin Vassell","Keldon Johnson","Jeremy Sochan","Stephon Castle","Harrison Barnes"],
    SA:["Victor Wembanyama","De'Aaron Fox","Devin Vassell","Keldon Johnson","Jeremy Sochan","Stephon Castle","Harrison Barnes"],
    TOR:["Scottie Barnes","RJ Barrett","Immanuel Quickley","Jakob Poeltl","Gradey Dick","Kelly Olynyk"],
    UTA:["Lauri Markkanen","Jordan Clarkson","John Collins","Keyonte George","Walker Kessler","Isaiah Collier"],
    UTAH:["Lauri Markkanen","Jordan Clarkson","John Collins","Keyonte George","Walker Kessler","Isaiah Collier"],
    WAS:["Kyle Kuzma","Jordan Poole","Alexandre Sarr","Corey Kispert","Jonas Valanciunas","Bilal Coulibaly"],
  };

  // ── NBA TEAM NAME → TRICODE MAP (for injury report matching) ─────────
  const NBA_NAME_TO_ABBR = {
    "Atlanta Hawks":"ATL","Boston Celtics":"BOS","Brooklyn Nets":"BKN",
    "Charlotte Hornets":"CHA","Chicago Bulls":"CHI","Cleveland Cavaliers":"CLE",
    "Dallas Mavericks":"DAL","Denver Nuggets":"DEN","Detroit Pistons":"DET",
    "Golden State Warriors":"GSW","Houston Rockets":"HOU","Indiana Pacers":"IND",
    "LA Clippers":"LAC","Los Angeles Clippers":"LAC","Los Angeles Lakers":"LAL",
    "Memphis Grizzlies":"MEM","Miami Heat":"MIA","Milwaukee Bucks":"MIL",
    "Minnesota Timberwolves":"MIN","New Orleans Pelicans":"NOP",
    "New York Knicks":"NYK","Oklahoma City Thunder":"OKC","Orlando Magic":"ORL",
    "Philadelphia 76ers":"PHI","Phoenix Suns":"PHX","Portland Trail Blazers":"POR",
    "Sacramento Kings":"SAC","San Antonio Spurs":"SAS","Toronto Raptors":"TOR",
    "Utah Jazz":"UTA","Washington Wizards":"WAS",
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
        return { statusCode: 500, headers, body: JSON.stringify({ error: "Missing ANTHROPIC_API_KEY" }) };
      }

      // ── FETCH NBA OFFICIAL INJURY REPORT ──────────────────────────
      // This is the same data source the NBA app uses — updated every 5 min
      let injuryReport = [];
      let injurySource = "none";
      try {
        const injRes = await fetch(
          "https://cdn.nba.com/static/json/liveData/injuryreport/injuryreport.json",
          {
            headers: {
              "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15",
              "Referer": "https://www.nba.com/",
              "Origin": "https://www.nba.com",
            }
          }
        );

        if (injRes.ok) {
          const injData = await injRes.json();
          injurySource = "NBA Official";
          const report = injData.injuryReport || [];

          // Filter to only the two teams in this game
          const homeAbbr = game.homeAbbr;
          const awayAbbr = game.awayAbbr;

          const relevantInjuries = report.filter(entry => {
            const teamAbbr = NBA_NAME_TO_ABBR[entry.teamName] || entry.teamTricode || "";
            return teamAbbr === homeAbbr || teamAbbr === awayAbbr ||
                   entry.teamName?.includes(game.homeTeam.split(" ").pop()) ||
                   entry.teamName?.includes(game.awayTeam.split(" ").pop());
          });

          if (relevantInjuries.length > 0) {
            injuryReport = relevantInjuries.map(p =>
              `${p.playerName} (${p.teamName}) — ${p.currentStatus}${p.reason ? ": " + p.reason : ""}`
            );
          } else {
            injuryReport = ["No players listed on injury report for this game"];
          }
        }
      } catch(e) {
        // Fallback: try NBA stats API
        try {
          const fallbackRes = await fetch(
            "https://stats.nba.com/stats/injuryreport",
            {
              headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
                "Referer": "https://www.nba.com/",
                "x-nba-stats-origin": "stats",
                "x-nba-stats-token": "true",
              }
            }
          );
          if (fallbackRes.ok) {
            const fbData = await fallbackRes.json();
            injurySource = "NBA Stats";
            const rows = fbData.resultSets?.[0]?.rowSet || [];
            const headers2 = fbData.resultSets?.[0]?.headers || [];
            const nameIdx = headers2.indexOf("PLAYER_NAME");
            const teamIdx = headers2.indexOf("TEAM_ABBREVIATION");
            const statIdx = headers2.indexOf("RETURN_DATE");
            const noteIdx = headers2.indexOf("NOTE");

            injuryReport = rows
              .filter(r => r[teamIdx] === game.homeAbbr || r[teamIdx] === game.awayAbbr)
              .map(r => `${r[nameIdx]} (${r[teamIdx]}) — ${r[noteIdx] || "Out"}`);

            if (!injuryReport.length) injuryReport = ["No players listed on injury report for this game"];
          }
        } catch(e2) {
          injuryReport = ["Could not fetch injury report — check nba.com/players/injury-report"];
          injurySource = "failed";
        }
      }

      const today = new Date().toDateString();
      const prompt = `You are a sharp NBA Same Game Parlay analyst for FanDuel. Today: ${today}.

GAME: ${game.awayTeam} (${game.awayAbbr}) @ ${game.homeTeam} (${game.homeAbbr})
TIME: ${game.time}
HOME ROSTER: ${(game.homePlayers||[]).join(", ")}
AWAY ROSTER: ${(game.awayPlayers||[]).join(", ")}

OFFICIAL NBA INJURY REPORT (source: ${injurySource}):
${injuryReport.join("\n")}

INJURY RULES — FOLLOW STRICTLY:
- Any player listed as OUT or Doubtful: EXCLUDE from all props
- Any player listed as OUT: ADD their primary replacement/backup with boosted props
- Any player QUESTIONABLE: include but add injuryNote warning
- Injury-boosted props must explain the usage boost in reason field

FanDuel SGP prop formats to use:
- "TO SCORE 10+ POINTS" / "TO SCORE 20+ POINTS" / "TO SCORE 5+ POINTS"
- "OVER 17.5 ALT POINTS" for specific alt lines
- "1+ MADE THREES" / "2+ MADE THREES" / "3+ MADE THREES"
- "TO RECORD 4+ REBOUNDS" / "TO RECORD 8+ REBOUNDS" / "TO RECORD 6+ REBOUNDS"
- "TO RECORD 2+ ASSISTS" / "TO RECORD 4+ ASSISTS"

Use LOW, SAFE thresholds. SGP legs must be reliable hitters.

Return ONLY a raw JSON object, no markdown, no backticks:

{
  "bestBet": "one sentence game best bet",
  "trend": "specific 10-game trend with real numbers",
  "edge": "key injury or situational edge",
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
      "reason": "hit 20+ in 8 of last 10, avg 24.1 PPG this season"
    }
  ],
  "suggestedSGP": "Best 4-6 leg SGP combo and why these legs correlate"
}

Include 8-10 SGP legs across both teams. Mix all 4 categories.`;

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

      // Attach the raw official injury data to the response
      parsed.injuryReport = injuryReport;
      parsed.injurySource = injurySource;

      return { statusCode: 200, headers, body: JSON.stringify(parsed) };
    }

    return { statusCode: 405, headers, body: JSON.stringify({ error: "Method not allowed" }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
