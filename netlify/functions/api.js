exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 200, headers, body: "" };
  }

  // Determine route from path — handle all possible path formats
  const rawPath = event.path || "";
  const isSchedule = rawPath.includes("schedule");
  const isAnalyze  = rawPath.includes("analyze");

  try {
    // ── SCHEDULE ────────────────────────────────────────────────────────
    if (isSchedule) {
      const res = await fetch(
        "https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard"
      );
      const json = await res.json();

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

    // ── ANALYZE ─────────────────────────────────────────────────────────
    if (isAnalyze) {
      if (event.httpMethod !== "POST") {
        return { statusCode: 405, headers, body: JSON.stringify({ error: "POST required" }) };
      }

      let body;
      try {
        body = JSON.parse(event.body || "{}");
      } catch {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "Invalid JSON body" }) };
      }

      const game = body.game;
      if (!game || !game.homeTeam) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: "No game data received", received: body }) };
      }

      const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
      if (!ANTHROPIC_KEY) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: "ANTHROPIC_API_KEY not set" }) };
      }

      const today = new Date().toDateString();
      const prompt = `You are a sharp NBA prop analyst for FanDuel. Today: ${today}.

GAME: ${game.awayTeam} (${game.awayAbbr}) @ ${game.homeTeam} (${game.homeAbbr})
TIME: ${game.time}
HOME PLAYERS: ${(game.homePlayers||[]).join(", ")}
AWAY PLAYERS: ${(game.awayPlayers||[]).join(", ")}

Use your knowledge of the 2025-26 NBA season.

Return ONLY a raw JSON object — no markdown, no backticks, no explanation:

{
  "bestBet": "one sentence best bet with reasoning",
  "trend": "specific 10-game ATS or total trend with real numbers",
  "edge": "situational edge in one sentence",
  "risk": "one sentence risk factor",
  "sharpTake": "final sharp one-liner",
  "props": [
    {
      "player": "Full Player Name",
      "team": "ABBR",
      "matchup": "vs OPP or @ OPP",
      "category": "POINTS or REBOUNDS or ASSISTS or 3-POINTERS",
      "direction": "OVER or UNDER",
      "line": "alt line number e.g. 24.5",
      "last10": 8,
      "h2h": 4,
      "avg": "27.3",
      "confidence": 4,
      "reason": "punchy one sentence with specific stat context"
    }
  ]
}

Include 6-8 props covering both teams. Mix all 4 categories. Return ONLY the JSON object.`;

      const aiRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          system: "You are a JSON API. Respond with ONLY a valid JSON object. No markdown, no backticks, no extra text. Your entire response must be parseable by JSON.parse().",
          max_tokens: 2000,
          messages: [{ role: "user", content: prompt }],
        }),
      });

      const aiData = await aiRes.json();
      let raw = (aiData.content || []).map((b) => b.text || "").join("").trim();
      raw = raw.replace(/```json|```/g, "").trim();

      let parsed;
      try {
        parsed = JSON.parse(raw);
      } catch {
        const match = raw.match(/\{[\s\S]*\}/);
        if (match) {
          parsed = JSON.parse(match[0]);
        } else {
          throw new Error("Parse failed. Raw: " + raw.substring(0, 200));
        }
      }

      return { statusCode: 200, headers, body: JSON.stringify(parsed) };
    }

    // ── NOT FOUND ───────────────────────────────────────────────────────
    return {
      statusCode: 404,
      headers,
      body: JSON.stringify({ error: "Route not found", path: rawPath })
    };

  } catch (err) {
    console.error("Function error:", err);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: err.message })
    };
  }
};
