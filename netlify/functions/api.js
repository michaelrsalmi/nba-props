exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json",
  };
  if (event.httpMethod === "OPTIONS") return { statusCode: 200, headers, body: "" };

  const TANK01_KEY    = process.env.TANK01_KEY;
  const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
  const ODDS_KEY      = process.env.ODDS_API_KEY;

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

  // ── Players confirmed out ─────────────────────────────────────────────
  const OUT_FOR_SEASON = [
    "bradley beal","anthony davis","jimmy butler","tyrese haliburton",
    "kyrie irving","ja morant","stephen curry","draymond green",
    "bogdan bogdanovic","kelly olynyk","nicolas batum","cameron payne",
    "jordan mclaughlin","reggie bullock","darius bazley","jaylen nowell",
    "franz wagner","buddy hield",
  ];

  // ── Live roster from Tank01 box score history ─────────────────────────
  async function getRoster(abbr) {
    const ESPN_IDS = {
      ATL:"1",BOS:"2",BKN:"17",CHA:"30",CHI:"4",CLE:"5",DAL:"6",DEN:"7",
      DET:"8",GSW:"9",GS:"9",HOU:"10",IND:"11",LAC:"12",LAL:"13",MEM:"29",
      MIA:"14",MIL:"15",MIN:"16",NOP:"3",NO:"3",NYK:"18",NY:"18",OKC:"25",
      ORL:"19",PHI:"20",PHX:"21",PHO:"21",POR:"22",SAC:"23",SAS:"24",SA:"24",
      TOR:"28",UTA:"26",UTAH:"26",WAS:"27",
    };
    const espnId = ESPN_IDS[abbr];
    if (!espnId) return [];
    try {
      const sched = await get(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/teams/${espnId}/schedule`);
      if (!sched?.events) return [];
      const recent = sched.events.filter(e => e.competitions?.[0]?.status?.type?.completed).slice(-8);
      if (!recent.length) return [];
      const playerCount = {};
      const playerMins = {};
      const boxes = await Promise.all(recent.map(e =>
        get(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/summary?event=${e.id}`)
      ));
      for (const box of boxes) {
        if (!box?.boxscore?.players) continue;
        for (const team of box.boxscore.players) {
          const ta = (team.team?.abbreviation || "").toUpperCase();
          const norm = {GS:"GSW",SA:"SAS",NO:"NOP",NY:"NYK",PHO:"PHX"}[ta] || ta;
          if (norm !== abbr && ta !== abbr) continue;
          for (const stat of (team.statistics || [])) {
            for (const ath of (stat.athletes || [])) {
              const name = ath.athlete?.displayName || "";
              const mins = parseFloat(ath.stats?.[0]) || 0;
              if (name && mins >= 15) {
                playerCount[name] = (playerCount[name] || 0) + 1;
                playerMins[name] = (playerMins[name] || 0) + mins;
              }
            }
          }
        }
      }
      return Object.entries(playerCount)
        .filter(([,c]) => c >= 5)
        .sort((a,b) => (playerMins[b[0]]||0) - (playerMins[a[0]]||0))
        .map(([n]) => n)
        .filter(n => !OUT_FOR_SEASON.includes(n.toLowerCase()));
    } catch { return []; }
  }

  // ── Official NBA injury report ─────────────────────────────────────────
  async function getInjuries(homeAbbr, awayAbbr) {
    const d = await get("https://cdn.nba.com/static/json/liveData/injuryreport/injuryreport.json");
    if (!d?.injuryReport) return [];
    const hL = homeAbbr.toLowerCase(), aL = awayAbbr.toLowerCase();
    return d.injuryReport
      .filter(p => {
        const t = (p.teamTricode || p.teamAbv || "").toLowerCase();
        const n = (p.teamName || "").toLowerCase();
        return t === hL || t === aL || n.includes(hL) || n.includes(aL);
      })
      .map(p => `${p.playerName} (${p.teamTricode||""}) — ${p.currentStatus}${p.reason ? ": "+p.reason : ""}`);
  }

  // ── Web search for tonight's injuries ────────────────────────────────
  async function searchInjuries(homeTeam, awayTeam) {
    if (!ANTHROPIC_KEY) return "";
    const today = new Date().toLocaleDateString("en-US", { timeZone:"America/New_York", month:"long", day:"numeric", year:"numeric" });
    try {
      const r = await fetch("https://api.anthropic.com/v1/messages", {
        method:"POST",
        headers:{"Content-Type":"application/json","x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01","anthropic-beta":"web-search-2025-03-05"},
        body: JSON.stringify({
          model:"claude-haiku-4-5-20251001", max_tokens:600,
          tools:[{type:"web_search_20250305",name:"web_search"}],
          system:"Search for NBA injury info and return ONLY a bullet list of OUT/Doubtful/Questionable players. No other text.",
          messages:[{role:"user",content:`Search "${homeTeam} ${awayTeam} injury report ${today}" and list every OUT/Doubtful/Questionable player tonight. Format: "- Name (TEAM) — Status" only.`}],
        }),
        signal: AbortSignal.timeout(15000),
      });
      const data = await r.json();
      return (data.content||[]).filter(b=>b.type==="text").map(b=>b.text).join("").trim();
    } catch { return ""; }
  }

  // ── B2B detection ─────────────────────────────────────────────────────
  async function getB2B(homeAbbr, awayAbbr) {
    const result = { home:false, away:false, homeYesterday:"", awayYesterday:"" };
    const yd = yesterdayET();
    const d = await get(`https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard?dates=${yd}`);
    if (!d?.events) return result;
    for (const e of d.events) {
      const comp = e.competitions?.[0];
      const h = comp?.competitors?.find(c=>c.homeAway==="home")?.team?.abbreviation;
      const a = comp?.competitors?.find(c=>c.homeAway==="away")?.team?.abbreviation;
      if (!h||!a) continue;
      if (h===homeAbbr||a===homeAbbr){result.home=true;result.homeYesterday=`${a}@${h}`;}
      if (h===awayAbbr||a===awayAbbr){result.away=true;result.awayYesterday=`${a}@${h}`;}
    }
    return result;
  }

  // ── FanDuel alt lines ─────────────────────────────────────────────────
  async function getFDLines(homeTeam, awayTeam) {
    if (!ODDS_KEY) return {};
    const markets = ["player_points_alternate","player_rebounds_alternate","player_assists_alternate","player_threes_alternate"];
    try {
      const events = await get(`https://api.the-odds-api.com/v4/sports/basketball_nba/events?apiKey=${ODDS_KEY}&dateFormat=iso`);
      if (!events?.length) return {};
      const event = events.find(e => {
        const h = (e.home_team||"").toLowerCase(), a = (e.away_team||"").toLowerCase();
        const hL = homeTeam.toLowerCase(), aL = awayTeam.toLowerCase();
        return (h.includes(hL.split(" ").pop())||hL.includes(h.split(" ").pop())) &&
               (a.includes(aL.split(" ").pop())||aL.includes(a.split(" ").pop()));
      });
      if (!event) return {};
      const odds = await get(`https://api.the-odds-api.com/v4/sports/basketball_nba/events/${event.id}/odds?apiKey=${ODDS_KEY}&regions=us&markets=${markets.join(",")}&bookmakers=fanduel&oddsFormat=american`);
      if (!odds?.bookmakers?.length) return {};
      const lines = {};
      for (const market of (odds.bookmakers[0].markets||[])) {
        for (const o of (market.outcomes||[])) {
          const player = o.description||o.name||"";
          if (!player||o.name!=="Over") continue;
          if (o.price < -150 || o.price > 400) continue;
          if (!lines[player]) lines[player] = {};
          if (!lines[player][market.key]) lines[player][market.key] = [];
          lines[player][market.key].push({line:o.point, odds:o.price});
        }
      }
      for (const p of Object.keys(lines))
        for (const c of Object.keys(lines[p]))
          lines[p][c].sort((a,b) => a.line-b.line);
      return lines;
    } catch { return {}; }
  }

  // ── MLB/WBC HR props ──────────────────────────────────────────────────
  async function getMLBHRProps(homeTeam, awayTeam, isWBC) {
    if (!ODDS_KEY) return {};
    const sportKey = isWBC ? "baseball_wbc" : "baseball_mlb";
    try {
      const events = await get(`https://api.the-odds-api.com/v4/sports/${sportKey}/events?apiKey=${ODDS_KEY}&dateFormat=iso`);
      if (!events?.length) return {};
      const event = events.find(e => {
        const h=(e.home_team||"").toLowerCase(), a=(e.away_team||"").toLowerCase();
        return (h.includes(homeTeam.toLowerCase().split(" ").pop())||homeTeam.toLowerCase().includes(h.split(" ").pop())) &&
               (a.includes(awayTeam.toLowerCase().split(" ").pop())||awayTeam.toLowerCase().includes(a.split(" ").pop()));
      });
      if (!event) return {};
      const odds = await get(`https://api.the-odds-api.com/v4/sports/${sportKey}/events/${event.id}/odds?apiKey=${ODDS_KEY}&regions=us&markets=batter_home_runs&bookmakers=fanduel&oddsFormat=american`);
      if (!odds?.bookmakers?.length) return {};
      const props = {};
      for (const market of (odds.bookmakers[0].markets||[])) {
        for (const o of (market.outcomes||[])) {
          const player = o.description||o.name||"";
          if (!player||o.name!=="Over") continue;
          if (!props[player]) props[player] = [];
          props[player].push({line:o.point, odds:o.price});
        }
      }
      return props;
    } catch { return {}; }
  }

  function aiCall(system, prompt, maxTokens=2000) {
    return fetch("https://api.anthropic.com/v1/messages", {
      method:"POST",
      headers:{"Content-Type":"application/json","x-api-key":ANTHROPIC_KEY,"anthropic-version":"2023-06-01"},
      body: JSON.stringify({model:"claude-haiku-4-5-20251001", max_tokens:maxTokens,
        system, messages:[{role:"user",content:prompt}]}),
    }).then(r=>r.json()).catch(()=>null);
  }

  function parseAIJson(data) {
    if (!data||data.error) return null;
    let raw = (data.content||[]).map(b=>b.text||"").join("").trim();
    raw = raw.replace(/^```json\s*/i,"").replace(/^```\s*/i,"").replace(/\s*```$/i,"").trim();
    try { return JSON.parse(raw); } catch {
      const m = raw.match(/\{[\s\S]*\}/);
      if (m) try { return JSON.parse(m[0]); } catch {}
      return null;
    }
  }

  // ── GET: NBA schedule ─────────────────────────────────────────────────
  if (event.httpMethod === "GET" && !event.queryStringParameters?.type) {
    const d = await get("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard");
    if (!d?.events) return { statusCode:500, headers, body: JSON.stringify({error:"Schedule failed"}) };
    const games = d.events.map(e => {
      const comp = e.competitions?.[0];
      const home = comp?.competitors?.find(c=>c.homeAway==="home");
      const away = comp?.competitors?.find(c=>c.homeAway==="away");
      return {
        id: e.id,
        homeTeam: home?.team?.displayName||"",
        awayTeam: away?.team?.displayName||"",
        homeAbbr: home?.team?.abbreviation||"???",
        awayAbbr: away?.team?.abbreviation||"???",
        homeRecord: home?.records?.[0]?.summary||"",
        awayRecord: away?.records?.[0]?.summary||"",
        time: new Date(e.date).toLocaleTimeString("en-US",{hour:"numeric",minute:"2-digit",timeZoneName:"short",timeZone:"America/New_York"}),
        status: comp?.status?.type?.description||"Scheduled",
      };
    });
    return { statusCode:200, headers, body: JSON.stringify({games}) };
  }

  // ── GET: SGP of the day ───────────────────────────────────────────────
  if (event.httpMethod === "GET" && event.queryStringParameters?.type === "sgp-of-day") {
    if (!ANTHROPIC_KEY) return { statusCode:500, headers, body: JSON.stringify({error:"Missing key"}) };
    const espn = await get("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard");
    if (!espn?.events) return { statusCode:500, headers, body: JSON.stringify({error:"No schedule"}) };
    const gameList = espn.events.map(e => {
      const comp = e.competitions?.[0];
      const home = comp?.competitors?.find(c=>c.homeAway==="home");
      const away = comp?.competitors?.find(c=>c.homeAway==="away");
      return `${away?.team?.displayName} @ ${home?.team?.displayName}`;
    }).join(", ");
    const allLines = {};
    for (const e of espn.events.slice(0,4)) {
      const comp = e.competitions?.[0];
      const home = comp?.competitors?.find(c=>c.homeAway==="home");
      const away = comp?.competitors?.find(c=>c.homeAway==="away");
      if (home&&away) Object.assign(allLines, await getFDLines(home.team.displayName, away.team.displayName));
    }
    const fdStr = Object.keys(allLines).length
      ? Object.entries(allLines).map(([p,cats]) =>
          `${p}: `+Object.entries(cats).map(([c,ls]) =>
            c.replace("player_","").replace("_alternate","").toUpperCase()+": "+ls.map(l=>`${l.line}(${l.odds>0?"+"+l.odds:l.odds})`).join(",")
          ).join(" | ")
        ).join("\n")
      : "No FD lines";
    const today = new Date().toDateString();
    const result = parseAIJson(await aiCall(
      "Sharp NBA SGP analyst. Return ONLY valid JSON. No markdown.",
      `Today: ${today}. Games: ${gameList}\n\nFANDUEL ALT LINES (-150 to +400):\n${fdStr}\n\nBuild the BEST 4-5 leg SGP across any games. Only use players/lines from FD data.\n\nReturn ONLY:\n{"title":"SGP OF THE DAY","subtitle":"...","legs":[{"player":"Name","team":"ABV","game":"AWAY @ HOME","prop":"OVER 22.5 PTS (+105)","reason":"..."}],"totalLegs":4,"estimatedOdds":"+380","correlation":"...","confidence":4}`,
      1000
    ));
    return { statusCode:200, headers, body: JSON.stringify(result||{error:"AI failed"}) };
  }

  // ── GET: Best single props ────────────────────────────────────────────
  if (event.httpMethod === "GET" && event.queryStringParameters?.type === "best-props") {
    if (!ANTHROPIC_KEY) return { statusCode:500, headers, body: JSON.stringify({error:"Missing key"}) };
    const espn = await get("https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard");
    if (!espn?.events) return { statusCode:500, headers, body: JSON.stringify({error:"No schedule"}) };
    const gameList = espn.events.map(e => {
      const comp = e.competitions?.[0];
      const home = comp?.competitors?.find(c=>c.homeAway==="home");
      const away = comp?.competitors?.find(c=>c.homeAway==="away");
      return `${away?.team?.displayName} @ ${home?.team?.displayName}`;
    }).join(", ");
    const allLines = {};
    for (const e of espn.events.slice(0,6)) {
      const comp = e.competitions?.[0];
      const home = comp?.competitors?.find(c=>c.homeAway==="home");
      const away = comp?.competitors?.find(c=>c.homeAway==="away");
      if (home&&away) Object.assign(allLines, await getFDLines(home.team.displayName, away.team.displayName));
    }
    const fdStr = Object.keys(allLines).length
      ? Object.entries(allLines).map(([p,cats]) =>
          `${p}: `+Object.entries(cats).map(([c,ls]) =>
            c.replace("player_","").replace("_alternate","").toUpperCase()+": "+ls.map(l=>`${l.line}(${l.odds>0?"+"+l.odds:l.odds})`).join(",")
          ).join(" | ")
        ).join("\n")
      : "No FD lines";
    const today = new Date().toDateString();
    const result = parseAIJson(await aiCall(
      "Sharp NBA prop analyst. Return ONLY valid JSON. No markdown.",
      `Today: ${today}. Games: ${gameList}\n\nFANDUEL LINES (-150 to +400):\n${fdStr}\n\nFind 8 best single props from tonight's slate. Focus on value and edge.\n\nReturn ONLY:\n{"props":[{"player":"Name","team":"ABV","game":"AWAY @ HOME","prop":"OVER 22.5 PTS (+105)","category":"POINTS","impliedProb":49,"modelProb":67,"edge":18,"confidence":4,"edge_reason":"one sentence"}]}`,
      1500
    ));
    return { statusCode:200, headers, body: JSON.stringify(result||{error:"AI failed"}) };
  }

  // ── POST: Analyze game ────────────────────────────────────────────────
  if (event.httpMethod === "POST") {
    let body;
    try { body = JSON.parse(event.body||"{}"); } catch { return {statusCode:400,headers,body:JSON.stringify({error:"Invalid JSON"})}; }

    // Non-NBA sports (NCAAB, MLB, NFL)
    if (body.sport && body.sport !== "nba") {
      const game = body.game;
      const sport = body.sport;
      if (!game?.homeTeam) return {statusCode:400,headers,body:JSON.stringify({error:"No game"})};
      if (!ANTHROPIC_KEY) return {statusCode:500,headers,body:JSON.stringify({error:"Missing key"})};

      const sportLabel = {ncaa:"COLLEGE BASKETBALL",mlb:"MLB/WBC BASEBALL",nfl:"NFL FOOTBALL"}[sport]||sport.toUpperCase();
      const today = new Date().toDateString();
      const isMLB = sport==="mlb";
      let hrProps = {};
      if (isMLB) {
        const wbcTeams = ["Italy","Venezuela","United States","Dominican Republic","Japan","Mexico","Cuba","Puerto Rico","Korea","Australia","Netherlands","Israel","Colombia","Panama"];
        const isWBC = wbcTeams.some(t => game.homeTeam.includes(t)||game.awayTeam.includes(t));
        hrProps = await getMLBHRProps(game.homeTeam, game.awayTeam, isWBC);
      }
      const hrStr = Object.keys(hrProps).length
        ? "FANDUEL HR PROPS:\n"+Object.entries(hrProps).map(([p,ls])=>`  ${p}: `+ls.map(l=>`${l.line}+ HR (${l.odds>0?"+"+l.odds:l.odds})`).join(", ")).join("\n")
        : "";

      const prompt = `You are a sharp ${sportLabel} betting analyst. Today: ${today}.
GAME: ${game.awayTeam} (${game.awayAbbr} ${game.awayRecord||""}) @ ${game.homeTeam} (${game.homeAbbr} ${game.homeRecord||""})
TIME: ${game.time}
${game.spread?"SPREAD: "+game.spread:""}
${game.overUnder?"TOTAL: "+game.overUnder:""}
${hrStr?"\n"+hrStr:""}

Return ONLY raw JSON:
{"bestBet":"...","trend":"...","edge":"...","risk":"...","sharpTake":"...","spreadAnalysis":"...","totalAnalysis":"...","hrProps":${isMLB?'[{"player":"Name","prop":"OVER 0.5 HR (+280)","confidence":3,"reason":"..."}]':'[]'},"keyFactors":["...","...","..."]}`;

      const result = parseAIJson(await aiCall("Sharp betting analyst. Return ONLY valid JSON starting with {. No markdown.", prompt, 1000));
      if (!result) return {statusCode:500,headers,body:JSON.stringify({error:"AI failed"})};
      return {statusCode:200,headers,body:JSON.stringify(result)};
    }

    // NBA game analysis
    const game = body.game;
    if (!game?.homeTeam) return {statusCode:400,headers,body:JSON.stringify({error:"No game"})};
    if (!ANTHROPIC_KEY) return {statusCode:500,headers,body:JSON.stringify({error:"Missing key"})};

    const [homeRoster, awayRoster, cdnInjuries, b2b, webInjuries, fdLines] = await Promise.all([
      getRoster(game.homeAbbr),
      getRoster(game.awayAbbr),
      getInjuries(game.homeAbbr, game.awayAbbr),
      getB2B(game.homeAbbr, game.awayAbbr),
      searchInjuries(game.homeTeam, game.awayTeam),
      getFDLines(game.homeTeam, game.awayTeam),
    ]);

    const allRosterPlayers = [...homeRoster, ...awayRoster];
    const fdPlayers = Object.keys(fdLines);
    const CAT_MAP = {player_points_alternate:"POINTS",player_rebounds_alternate:"REBOUNDS",player_assists_alternate:"ASSISTS",player_threes_alternate:"THREES"};

    const rosterStr = allRosterPlayers.length
      ? `VALID PLAYERS (live box score — use ONLY these names):\n${game.homeTeam}: ${homeRoster.join(", ")}\n${game.awayTeam}: ${awayRoster.join(", ")}`
      : "Roster unavailable — use 2025-26 knowledge";

    const fdStr = fdPlayers.length
      ? `FANDUEL ALT LINES (-150 to +400) — ONLY use these players and lines:\n`+
        fdPlayers.map(p => `  ${p}: `+Object.entries(fdLines[p]).map(([c,ls]) =>
          (CAT_MAP[c]||c)+": "+ls.map(l=>`${l.line}(${l.odds>0?"+"+l.odds:l.odds})`).join(",")
        ).join(" | ")).join("\n")
      : null;

    const injStr = [
      cdnInjuries.length ? "NBA CDN:\n"+cdnInjuries.join("\n") : "",
      webInjuries ? "Web Search:\n"+webInjuries : "",
    ].filter(Boolean).join("\n\n") || "No injuries reported";

    const b2bStr = [
      b2b.home?`🔴 ${game.homeTeam} ON B2B`:`✅ ${game.homeTeam}: rested`,
      b2b.away?`🔴 ${game.awayTeam} ON B2B`:`✅ ${game.awayTeam}: rested`,
    ].join("\n");

    const today = new Date().toDateString();

    const prompt = `Sharp NBA SGP analyst. Today: ${today}.
GAME: ${game.awayTeam} (${game.awayAbbr} ${game.awayRecord}) @ ${game.homeTeam} (${game.homeAbbr} ${game.homeRecord})
TIME: ${game.time}

${fdStr || rosterStr}

━━ INJURIES ━━
${injStr}

━━ BACK-TO-BACK ━━
${b2bStr}

━━ NEVER INCLUDE: Bradley Beal, Anthony Davis, Jimmy Butler, Tyrese Haliburton, Kyrie Irving, Ja Morant, Stephen Curry, Draymond Green ━━

━━ RULES ━━
1. ONLY use players from FanDuel lines above (or roster if no FD lines)
2. Exclude anyone OUT/Doubtful in injury report
3. Only suggest props where YOUR model probability beats market by 8%+
4. For each leg: calculate impliedProb from fdOdds, estimate modelProb from matchup/form, edge = modelProb - impliedProb
5. B2B teams: -1 confidence
6. Return ONLY raw JSON

{"bestBet":"...","trend":"...","edge":"...","risk":"...","sharpTake":"...","sgpLegs":[{"player":"Full Name","team":"ABV","prop":"OVER 22.5 PTS (+105)","category":"POINTS","fdOdds":105,"impliedProb":49,"modelProb":67,"edge":18,"confidence":4,"usageBoost":"","injuryNote":"","reason":"..."}],"suggestedSGP":"..."}

Include 8 legs. Mix all 4 categories.`;

    const aiData = parseAIJson(await aiCall(
      "NBA SGP analyst. Return ONLY valid JSON starting with {. No markdown.",
      prompt, 3000
    ));
    if (!aiData) return {statusCode:500,headers,body:JSON.stringify({error:"AI failed"})};

    // Filter out banned players
    if (aiData.sgpLegs) {
      aiData.sgpLegs = aiData.sgpLegs.filter(leg => {
        const n = (leg.player||"").toLowerCase();
        if (OUT_FOR_SEASON.some(o => n.includes(o.split(" ")[1]||o))) return false;
        if (fdPlayers.length) return fdPlayers.some(p => p.toLowerCase().includes(n.split(" ").pop())||n.includes(p.toLowerCase().split(" ").pop()));
        if (allRosterPlayers.length) return allRosterPlayers.some(p => p.toLowerCase().includes(n.split(" ").pop())||n.includes(p.toLowerCase().split(" ").pop()));
        return true;
      });
    }

    aiData.injuryReport = [...cdnInjuries, ...(webInjuries?webInjuries.split("\n").filter(l=>l.trim()):[])];
    aiData.liveRosters = {home:homeRoster, away:awayRoster};
    aiData.b2b = b2b;
    aiData.fdLinesAvailable = fdPlayers.length > 0;

    return {statusCode:200,headers,body:JSON.stringify(aiData)};
  }

  return {statusCode:405,headers,body:JSON.stringify({error:"Method not allowed"})};
};
