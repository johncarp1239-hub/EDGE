exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  // Fetch with 4 second timeout
  async function ft(url, opts = {}) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);
    try {
      const r = await fetch(url, { ...opts, signal: ctrl.signal });
      clearTimeout(t);
      return r;
    } catch { clearTimeout(t); return null; }
  }

  // Fetch JSON safely
  async function fj(url, opts = {}) {
    try { const r = await ft(url, opts); if (r && r.ok) return await r.json(); } catch {}
    return null;
  }

  // Call Claude
  async function claude(prompt, system) {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error('ANTHROPIC_API_KEY not set in Netlify environment variables');
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 4096, system, messages: [{ role: 'user', content: prompt }] }),
    });
    const txt = await r.text();
    if (!r.ok) throw new Error(`Anthropic ${r.status}: ${txt.slice(0, 200)}`);
    const d = JSON.parse(txt);
    return d.content?.[0]?.text || '';
  }

  // Parse JSON from Claude safely
  function safeJSON(txt) {
    const c = txt.replace(/```json/g, '').replace(/```/g, '').trim();
    try { return JSON.parse(c); } catch {}
    try { return JSON.parse(c.replace(/,(\s*[}\]])/g, '$1')); } catch {}
    const m = c.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch {} }
    throw new Error('Could not parse AI response — try again');
  }

  // Fetch all data sources in parallel
  async function getData() {
    const oddsKey = process.env.ODDS_API_KEY;
    const books = 'draftkings,fanduel,betmgm,caesars';

    const [nba, mlb, nhl, pga, an_nba, an_mlb] = await Promise.all([
      fj('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard'),
      fj('https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard'),
      fj('https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard'),
      fj('https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard'),
      fj('https://api.actionnetwork.com/web/v1/games?sport=nba&include=odds&period=game', { headers: { Accept: 'application/json', Origin: 'https://www.actionnetwork.com', Referer: 'https://www.actionnetwork.com/' } }),
      fj('https://api.actionnetwork.com/web/v1/games?sport=mlb&include=odds&period=game', { headers: { Accept: 'application/json', Origin: 'https://www.actionnetwork.com', Referer: 'https://www.actionnetwork.com/' } }),
    ]);

    const mapGame = e => ({
      name: e.name,
      date: e.date,
      status: e.status?.type?.description,
      home: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'home')?.team?.displayName,
      homeRec: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'home')?.records?.[0]?.summary,
      away: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'away')?.team?.displayName,
      awayRec: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'away')?.records?.[0]?.summary,
      venue: e.competitions?.[0]?.venue?.fullName,
      espnOdds: e.competitions?.[0]?.odds?.[0] || null,
    });

    const mapAN = g => ({
      teams: `${g.away_team?.full_name || ''} @ ${g.home_team?.full_name || ''}`,
      awayBetPct: g.away_bet_pct,
      homeBetPct: g.home_bet_pct,
      awayMoneyPct: g.away_money_pct,
      homeMoneyPct: g.home_money_pct,
      sharpSide: g.sharp_side,
      steamMove: g.steam_move,
      lineMove: `${g.away_ml_open || ''} → ${g.away_ml_current || ''}`,
    });

    const d = {
      nba: (nba?.events || []).slice(0, 6).map(mapGame),
      mlb: (mlb?.events || []).slice(0, 8).map(mapGame),
      nhl: (nhl?.events || []).slice(0, 6).map(mapGame),
      pga: pga?.events?.[0] ? {
        eventName: pga.events[0].name,
        venue: pga.events[0].competitions?.[0]?.venue?.fullName,
        status: pga.events[0].status?.type?.description,
        leaderboard: (pga.events[0].competitions?.[0]?.competitors || []).slice(0, 20).map(c => ({
          name: c.athlete?.displayName,
          pos: c.status?.position?.displayName,
          score: c.score?.displayValue,
          rounds: c.linescores?.map(l => l.displayValue) || [],
        })),
      } : null,
      actionNetworkNBA: (an_nba?.games || []).slice(0, 5).map(mapAN),
      actionNetworkMLB: (an_mlb?.games || []).slice(0, 5).map(mapAN),
    };

    // Odds API — run in parallel for speed
    if (oddsKey) {
      const [nbaOdds, mlbOdds, nhlOdds, golfOdds, nbaProps, mlbProps] = await Promise.all([
        fj(`https://api.the-odds-api.com/v4/sports/basketball_nba/odds/?apiKey=${oddsKey}&regions=us&markets=h2h,spreads,totals&oddsFormat=american&bookmakers=${books}`),
        fj(`https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${oddsKey}&regions=us&markets=h2h,spreads,totals&oddsFormat=american&bookmakers=${books}`),
        fj(`https://api.the-odds-api.com/v4/sports/icehockey_nhl/odds/?apiKey=${oddsKey}&regions=us&markets=h2h,spreads&oddsFormat=american&bookmakers=${books}`),
        fj(`https://api.the-odds-api.com/v4/sports/golf_pga_championship_winner/odds/?apiKey=${oddsKey}&regions=us&markets=outrights&oddsFormat=american&bookmakers=${books}`),
        fj(`https://api.the-odds-api.com/v4/sports/basketball_nba/odds/?apiKey=${oddsKey}&regions=us&markets=player_points,player_rebounds,player_assists&oddsFormat=american&bookmakers=draftkings,fanduel`),
        fj(`https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${oddsKey}&regions=us&markets=batter_hits,pitcher_strikeouts&oddsFormat=american&bookmakers=draftkings,fanduel`),
      ]);

      const fmtGame = g => {
        if (!g) return null;
        const bks = {};
        (g.bookmakers || []).forEach(bk => {
          (bk.markets || []).forEach(m => {
            if (!bks[bk.key]) bks[bk.key] = {};
            bks[bk.key][m.key] = (m.outcomes || []).map(o => ({ n: o.name, p: o.price, pt: o.point }));
          });
        });
        return { sport: g.sport_title, home: g.home_team, away: g.away_team, commence: g.commence_time, books: bks };
      };

      d.nbaOdds = (nbaOdds || []).slice(0, 6).map(fmtGame).filter(Boolean);
      d.mlbOdds = (mlbOdds || []).slice(0, 6).map(fmtGame).filter(Boolean);
      d.nhlOdds = (nhlOdds || []).slice(0, 6).map(fmtGame).filter(Boolean);

      // Golf outrights — try multiple event keys
      if (!golfOdds || !golfOdds.length) {
        for (const gs of ['golf_masters_tournament_winner', 'golf_the_open_championship_winner', 'golf_us_open_winner']) {
          const g = await fj(`https://api.the-odds-api.com/v4/sports/${gs}/odds/?apiKey=${oddsKey}&regions=us&markets=outrights&oddsFormat=american&bookmakers=${books}`);
          if (g && g.length) { d.golfOdds = g.slice(0, 2).map(ev => ({ event: ev.sport_title, players: (ev.bookmakers?.[0]?.markets?.[0]?.outcomes || []).slice(0, 25).map(o => ({ name: o.name, price: o.price })) })); break; }
        }
      } else {
        d.golfOdds = golfOdds.slice(0, 2).map(ev => ({ event: ev.sport_title, players: (ev.bookmakers?.[0]?.markets?.[0]?.outcomes || []).slice(0, 25).map(o => ({ name: o.name, price: o.price })) }));
      }

      // Props
      d.nbaProps = (nbaProps || []).slice(0, 4).map(g => ({
        game: `${g.away_team} @ ${g.home_team}`,
        props: (g.bookmakers?.[0]?.markets || []).map(m => ({ type: m.key, lines: (m.outcomes || []).slice(0, 6).map(o => ({ name: o.name, price: o.price, point: o.point })) })),
      }));
      d.mlbProps = (mlbProps || []).slice(0, 4).map(g => ({
        game: `${g.away_team} @ ${g.home_team}`,
        props: (g.bookmakers?.[0]?.markets || []).map(m => ({ type: m.key, lines: (m.outcomes || []).slice(0, 4).map(o => ({ name: o.name, price: o.price, point: o.point })) })),
      }));
    }

    // Injuries + Rundown in parallel
    const [inj, rund] = await Promise.all([
      process.env.SPORTS_API_KEY ? fj('https://v1.basketball.api-sports.io/injuries', { headers: { 'x-apisports-key': process.env.SPORTS_API_KEY } }) : Promise.resolve(null),
      process.env.RUNDOWN_API_KEY ? fj(`https://therundown-therundown-v1.p.rapidapi.com/sports/2/events/${new Date().toISOString().split('T')[0]}`, { headers: { 'x-rapidapi-key': process.env.RUNDOWN_API_KEY, 'x-rapidapi-host': 'therundown-therundown-v1.p.rapidapi.com' } }) : Promise.resolve(null),
    ]);

    d.injuries = (inj?.response || []).slice(0, 8).map(i => `${i.player?.name} (${i.team?.name}): ${i.type}`);
    d.lineMovement = (rund?.events || []).slice(0, 5).map(e => ({ teams: `${e.teams_normalized?.[0]?.name || ''} vs ${e.teams_normalized?.[1]?.name || ''}`, open: e.lines?.draftkings?.total_open, current: e.lines?.draftkings?.total }));

    return d;
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { action } = body;

    const SYSTEM_DEEP = `You are EDGE v5 — world-class sports betting analyst.

ANALYSIS DEPTH: Score all 8 factors for every pick. Be specific with data.
1. Recent Form — last 5-10 results, ATS and ML trends
2. H2H History — last 5 matchups, home/away splits  
3. Rest/Travel — days rest, back-to-backs, road trips
4. Injury Impact — key player status and lineup news
5. Line Movement — opening vs current, sharp vs public direction
6. Sharp Money — public bet % vs sharp money %, steam moves
7. Matchup Edge — pace, style, surface, course fit, pitcher matchup
8. Motivation — playoff implications, revenge spots, rivalry games

BET TYPES: ML, spread, totals, player props, golf Top 10/20/outright, tennis sets, parlays
PARLAY LOGIC — correlate these:
- QB completions over + WR receptions over (same plays)  
- High game total + QB passing yards over (must throw more)
- Team ML + their RB rushing yards over (run when winning)
- Starting pitcher Ks over + game total under (dominant SP = low scoring)
- Golf player Top 10 + make cut (if making cut, likely finishing well)
- Batter hits over + team total over (hot batter in high scoring game)

Use ANY strategy that gives edge. No restrictions. Cover all sports.`;

    // ── ASK — deep single analysis ────────────────────────────────────────────
    if (action === 'ask') {
      const d = await getData();
      const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

      const prompt = `Analyze: "${body.query}"
Today: ${today}

NBA GAMES + ODDS: ${JSON.stringify(d.nbaOdds || d.nba)}
MLB GAMES + ODDS: ${JSON.stringify(d.mlbOdds || d.mlb)}
NHL GAMES + ODDS: ${JSON.stringify(d.nhlOdds || d.nhl)}
PGA LEADERBOARD: ${JSON.stringify(d.pga)}
GOLF ODDS (outrights): ${JSON.stringify(d.golfOdds)}
NBA PROPS: ${JSON.stringify(d.nbaProps)}
MLB PROPS: ${JSON.stringify(d.mlbProps)}
SHARP MONEY NBA: ${JSON.stringify(d.actionNetworkNBA)}
SHARP MONEY MLB: ${JSON.stringify(d.actionNetworkMLB)}
LINE MOVEMENT: ${JSON.stringify(d.lineMovement)}
INJURIES: ${JSON.stringify(d.injuries)}

Provide deep analysis. Use REAL lines from data above. For any upcoming event (not just today) use available info.

Return ONLY valid JSON:
{"sport":"NBA","title":"Real game/event name","pick":"Specific pick with real line","verdict":"STRONG BET","winProbability":61,"impliedOddsProb":39,"edgePct":22,"recommendedLine":"+155","bestBook":"FanDuel","stake":25,"category":"dog_ml","factors":{"recentForm":{"score":8,"detail":"specific data"},"h2h":{"score":7,"detail":"specific data"},"restDays":{"score":6,"detail":"specific data"},"injuryImpact":{"score":5,"detail":"specific data"},"lineMovement":{"score":9,"detail":"specific data"},"sharpMoney":{"score":8,"detail":"specific data"},"matchupEdge":{"score":7,"detail":"specific data"},"motivation":{"score":6,"detail":"specific data"}},"allBookOdds":{"DraftKings":"+150","FanDuel":"+155","BetMGM":"+148","Caesars":"+152"},"summary":"3-4 sentence deep analysis with specific reasoning","keyRisk":"biggest risk factor","alternativeBet":"best alternative if passing","correlatedParlay":{"available":true,"legs":[{"pick":"correlated pick 1","line":"+150","book":"FanDuel","reason":"why correlated"},{"pick":"correlated pick 2","line":"-115","book":"DraftKings","reason":"why correlated"}],"combinedOdds":"+280","parlayReason":"why these correlate and strengthen each other"}}`;

      const raw = await claude(prompt, SYSTEM_DEEP);
      const result = safeJSON(raw);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // ── ANALYZE — auto run picks ──────────────────────────────────────────────
    if (action === 'analyze') {
      const d = await getData();

      const prompt = `Find the 5 best value bets RIGHT NOW across ALL sports. Use ONLY real lines from data. Include correlated parlays where strong correlations exist.

NBA + ODDS: ${JSON.stringify(d.nbaOdds || d.nba)}
MLB + ODDS: ${JSON.stringify(d.mlbOdds || d.mlb)}
NHL + ODDS: ${JSON.stringify(d.nhlOdds || d.nhl)}
PGA: ${JSON.stringify(d.pga)}
GOLF ODDS: ${JSON.stringify(d.golfOdds)}
NBA PROPS: ${JSON.stringify(d.nbaProps)}
MLB PROPS: ${JSON.stringify(d.mlbProps)}
SHARP MONEY: ${JSON.stringify({ nba: d.actionNetworkNBA, mlb: d.actionNetworkMLB })}
LINE MOVEMENT: ${JSON.stringify(d.lineMovement)}
INJURIES: ${JSON.stringify(d.injuries)}
BUDGET: $${body.budget || 300}

Return ONLY valid JSON:
{"weeklyThesis":"2 sentence market thesis","picks":[{"sport":"NBA","description":"Real Team ML","bestBook":"FanDuel","line":"+155","allBookOdds":{"DraftKings":"+150","FanDuel":"+155","BetMGM":"+148","Caesars":"+152"},"stake":25,"toWin":37,"confidence":7,"winProbability":56,"edge":"specific reason","risk":"main risk","category":"dog_ml","lineMovement":"opened +140 moved to +155","publicPct":"34% public 68% sharp","factors":{"recentForm":{"score":7,"detail":"specific"},"h2h":{"score":6,"detail":"specific"},"restDays":{"score":7,"detail":"specific"},"injuryImpact":{"score":5,"detail":"specific"},"lineMovement":{"score":8,"detail":"specific"},"sharpMoney":{"score":7,"detail":"specific"},"matchupEdge":{"score":6,"detail":"specific"},"motivation":{"score":5,"detail":"specific"}}}],"parlays":[{"name":"Correlated SGP","sport":"NBA","game":"Real game","legs":[{"pick":"pick 1","line":"+150","book":"FanDuel"},{"pick":"pick 2","line":"-115","book":"FanDuel"}],"combinedOdds":"+280","stake":10,"toWin":38,"reason":"specific correlation logic"}],"blockedPicks":[]}`;

      const raw = await claude(prompt, SYSTEM_DEEP);
      const picks = safeJSON(raw);
      return { statusCode: 200, headers, body: JSON.stringify({ picks, oddsGames: d.nbaOdds }) };
    }

    // ── DAILY BETS ────────────────────────────────────────────────────────────
    if (action === 'daily') {
      const d = await getData();
      const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

      const prompt = `Best bets for ${today} across ALL sports. Use ONLY real games and lines from data. Return ONLY valid JSON.

NBA + ODDS: ${JSON.stringify(d.nbaOdds || d.nba)}
MLB + ODDS: ${JSON.stringify(d.mlbOdds || d.mlb)}
NHL + ODDS: ${JSON.stringify(d.nhlOdds || d.nhl)}
PGA: ${JSON.stringify(d.pga)}
GOLF ODDS: ${JSON.stringify(d.golfOdds)}
NBA PROPS: ${JSON.stringify(d.nbaProps)}
MLB PROPS: ${JSON.stringify(d.mlbProps)}
SHARP MONEY: ${JSON.stringify({ nba: d.actionNetworkNBA, mlb: d.actionNetworkMLB })}
INJURIES: ${JSON.stringify(d.injuries)}

REQUIREMENTS:
- 6-8 bets minimum
- At least 3 different sports
- Include Golf Top 10 if PGA event active
- Include NHL puck line if NHL games today
- Include at least 1 player prop if props available
- Include 1 correlated parlay if strong correlation exists
- Mark top 3 as isTopPick true
- Use REAL team and player names

Return ONLY valid JSON:
{"bets":[{"rank":1,"isTopPick":true,"sport":"NBA","title":"Real Game","pick":"Real Pick","line":"+155","bestBook":"FanDuel","winProbability":60,"edgePct":21,"confidence":7,"category":"dog_ml","stake":25,"edge":"specific reason with data","keyFactors":["factor1","factor2","factor3"],"isParlay":false},{"rank":2,"isTopPick":true,"sport":"Golf","title":"Real PGA Event","pick":"Real Player Top 10","line":"+250","bestBook":"FanDuel","winProbability":40,"edgePct":15,"confidence":6,"category":"prop","stake":15,"edge":"course fit and strokes gained data","keyFactors":["strokes gained","course history","recent form"],"isParlay":false},{"rank":3,"isTopPick":true,"sport":"MLB","title":"Real Game","pick":"Real Pick","line":"+140","bestBook":"DraftKings","winProbability":55,"edgePct":15,"confidence":6,"category":"dog_ml","stake":20,"edge":"pitching matchup value","keyFactors":["starter stats","bullpen depth","park factor"],"isParlay":false},{"rank":4,"isTopPick":false,"sport":"NHL","title":"Real Game","pick":"Real Team +1.5","line":"+140","bestBook":"BetMGM","winProbability":54,"edgePct":14,"confidence":6,"category":"spread","stake":20,"edge":"puck line value","keyFactors":["goalie matchup","rest","home ice"],"isParlay":false},{"rank":5,"isTopPick":false,"sport":"NBA","title":"Correlated SGP","pick":"Player Over + Team ML","line":"+310","bestBook":"FanDuel","winProbability":37,"edgePct":17,"confidence":6,"category":"parlay","stake":10,"edge":"correlated same-game parlay","keyFactors":["prop correlation","sharp value","soft line"],"isParlay":true}]}`;

      const raw = await claude(prompt, SYSTEM_DEEP);
      const result = safeJSON(raw);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // ── RAW CLAUDE ────────────────────────────────────────────────────────────
    if (action === 'claude') {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: body.maxTokens || 4096, system: body.system, messages: [{ role: 'user', content: body.prompt }] }),
      });
      const txt = await r.text();
      if (!r.ok) return { statusCode: r.status, headers, body: JSON.stringify({ error: `Anthropic ${r.status}: ${txt.slice(0, 200)}` }) };
      return { statusCode: 200, headers, body: txt };
    }

    // ── ODDS ──────────────────────────────────────────────────────────────────
    if (action === 'odds') {
      const key = process.env.ODDS_API_KEY;
      if (!key) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ODDS_API_KEY not set' }) };
      const books = 'draftkings,fanduel,betmgm,caesars';
      const [nba, mlb, nhl] = await Promise.all([
        fj(`https://api.the-odds-api.com/v4/sports/basketball_nba/odds/?apiKey=${key}&regions=us&markets=h2h,spreads,totals&oddsFormat=american&bookmakers=${books}`),
        fj(`https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${key}&regions=us&markets=h2h,spreads,totals&oddsFormat=american&bookmakers=${books}`),
        fj(`https://api.the-odds-api.com/v4/sports/icehockey_nhl/odds/?apiKey=${key}&regions=us&markets=h2h,spreads&oddsFormat=american&bookmakers=${books}`),
      ]);
      return { statusCode: 200, headers, body: JSON.stringify({ games: [...(nba||[]).slice(0,4), ...(mlb||[]).slice(0,4), ...(nhl||[]).slice(0,4)] }) };
    }

    // ── ALL DATA ──────────────────────────────────────────────────────────────
    if (action === 'alldata') {
      const d = await getData();
      return { statusCode: 200, headers, body: JSON.stringify(d) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ status: 'picks function working', action }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, stack: err.stack?.slice(0, 300) }) };
  }
};
