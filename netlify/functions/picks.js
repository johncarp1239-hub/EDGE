exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const body = JSON.parse(event.body || '{}');
    const { action } = body;

    // ── FETCH ALL SPORTS DATA ─────────────────────────────────────────────────
    async function fetchAllData() {
      const data = {};
      const oddsKey = process.env.ODDS_API_KEY;

      // ESPN — all sports
      const espnSports = [
        ['nba', 'basketball/nba'],
        ['mlb', 'baseball/mlb'],
        ['nhl', 'hockey/nhl'],
        ['nfl', 'football/nfl'],
        ['ncaaf', 'football/college-football'],
        ['ncaab', 'basketball/mens-college-basketball'],
        ['soccer', 'soccer/usa.1'],
        ['tennis', 'tennis/atp'],
      ];
      for (const [key, path] of espnSports) {
        try {
          const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`);
          if (r.ok) {
            const d = await r.json();
            data[key] = (d.events || []).slice(0, 6).map(e => ({
              id: e.id,
              name: e.name,
              shortName: e.shortName,
              date: e.date,
              status: e.status?.type?.description,
              home: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'home')?.team?.displayName,
              homeAbbr: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'home')?.team?.abbreviation,
              homeRec: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'home')?.records?.[0]?.summary,
              away: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'away')?.team?.displayName,
              awayAbbr: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'away')?.team?.abbreviation,
              awayRec: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'away')?.records?.[0]?.summary,
              odds: e.competitions?.[0]?.odds?.[0] || null,
              venue: e.competitions?.[0]?.venue?.fullName,
              neutralSite: e.competitions?.[0]?.neutralSite,
            }));
          }
        } catch { data[key] = []; }
      }

      // PGA Tour — current + upcoming events
      try {
        const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard');
        if (r.ok) {
          const d = await r.json();
          const ev = d.events?.[0];
          data.pga = ev ? {
            eventName: ev.name,
            eventId: ev.id,
            date: ev.date,
            status: ev.status?.type?.description,
            venue: ev.competitions?.[0]?.venue?.fullName,
            top20: (ev.competitions?.[0]?.competitors || []).slice(0, 20).map(c => ({
              name: c.athlete?.displayName,
              pos: c.status?.position?.displayName,
              score: c.score?.displayValue,
              rounds: c.linescores?.map(l => l.displayValue) || [],
            })),
          } : null;
        }
      } catch { data.pga = null; }

      // ESPN Golf schedule — upcoming events
      try {
        const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/golf/pga/news');
        if (r.ok) {
          const d = await r.json();
          data.pgaNews = (d.articles || []).slice(0, 3).map(a => ({ headline: a.headline, description: a.description }));
        }
      } catch { data.pgaNews = []; }

      // ActionNetwork — public betting %
      try {
        const results = [];
        for (const sport of ['nba', 'mlb', 'nhl', 'nfl']) {
          try {
            const r = await fetch(`https://api.actionnetwork.com/web/v1/games?sport=${sport}&include=odds&period=game`, {
              headers: { Accept: 'application/json', Origin: 'https://www.actionnetwork.com', Referer: 'https://www.actionnetwork.com/' }
            });
            if (r.ok) {
              const d = await r.json();
              (d.games || []).slice(0, 4).forEach(g => {
                results.push({
                  sport: sport.toUpperCase(),
                  teams: `${g.away_team?.full_name || g.away_team?.abbr || ''} @ ${g.home_team?.full_name || g.home_team?.abbr || ''}`,
                  awayBetPct: g.away_bet_pct,
                  homeBetPct: g.home_bet_pct,
                  awayMoneyPct: g.away_money_pct,
                  homeMoneyPct: g.home_money_pct,
                  sharpSide: g.sharp_side,
                  steamMove: g.steam_move,
                  reverseLineSide: g.reverse_line_movement,
                  openLine: g.away_ml_open,
                  currentLine: g.away_ml_current,
                });
              });
            }
          } catch {}
        }
        data.actionNetwork = results.length ? results : null;
      } catch { data.actionNetwork = null; }

      // Odds API — live lines across all sports
      if (oddsKey) {
        const sportKeys = [
          'basketball_nba', 'baseball_mlb', 'icehockey_nhl',
          'americanfootball_nfl', 'soccer_usa_mls',
          'tennis_atp_french_open', 'tennis_wta_french_open',
        ];
        const golfKeys = [
          'golf_pga_championship_winner', 'golf_masters_tournament_winner',
          'golf_the_open_championship_winner', 'golf_us_open_winner',
          'golf_fedex_cup_winner',
        ];
        const books = 'draftkings,fanduel,betmgm,caesars,pointsbet';
        data.oddsGames = [];

        for (const sp of sportKeys) {
          try {
            const r = await fetch(`https://api.the-odds-api.com/v4/sports/${sp}/odds/?apiKey=${oddsKey}&regions=us&markets=h2h,spreads,totals&oddsFormat=american&bookmakers=${books}`);
            if (r.ok) {
              const g = await r.json();
              if (Array.isArray(g)) data.oddsGames.push(...g.slice(0, 4).map(game => ({
                sport: game.sport_title,
                home: game.home_team,
                away: game.away_team,
                commence: game.commence_time,
                bookmakers: (game.bookmakers || []).map(bk => ({
                  name: bk.key,
                  markets: (bk.markets || []).map(m => ({
                    key: m.key,
                    outcomes: (m.outcomes || []).map(o => ({ name: o.name, price: o.price, point: o.point })),
                  })),
                })),
              })));
            }
          } catch {}
        }

        // Golf outrights + Top 10s
        data.golfOdds = [];
        for (const gs of golfKeys) {
          try {
            const r = await fetch(`https://api.the-odds-api.com/v4/sports/${gs}/odds/?apiKey=${oddsKey}&regions=us&markets=outrights&oddsFormat=american&bookmakers=${books}`);
            if (r.ok) {
              const g = await r.json();
              if (Array.isArray(g) && g.length) {
                data.golfOdds.push(...g.slice(0, 2).map(game => ({
                  event: game.sport_title,
                  commence: game.commence_time,
                  players: (game.bookmakers?.[0]?.markets?.[0]?.outcomes || []).slice(0, 30).map(o => ({
                    name: o.name,
                    price: o.price,
                  })),
                })));
                break;
              }
            }
          } catch {}
        }

        // Player props — NBA
        try {
          const r = await fetch(`https://api.the-odds-api.com/v4/sports/basketball_nba/odds/?apiKey=${oddsKey}&regions=us&markets=player_points,player_rebounds,player_assists,player_threes&oddsFormat=american&bookmakers=draftkings,fanduel`);
          if (r.ok) {
            const g = await r.json();
            data.nbaProps = (g || []).slice(0, 3).map(game => ({
              game: `${game.away_team} @ ${game.home_team}`,
              props: (game.bookmakers?.[0]?.markets || []).map(m => ({
                type: m.key,
                outcomes: (m.outcomes || []).slice(0, 6).map(o => ({ name: o.name, price: o.price, point: o.point })),
              })),
            }));
          }
        } catch { data.nbaProps = []; }

        // Player props — MLB
        try {
          const r = await fetch(`https://api.the-odds-api.com/v4/sports/baseball_mlb/odds/?apiKey=${oddsKey}&regions=us&markets=batter_hits,pitcher_strikeouts,batter_home_runs&oddsFormat=american&bookmakers=draftkings,fanduel`);
          if (r.ok) {
            const g = await r.json();
            data.mlbProps = (g || []).slice(0, 3).map(game => ({
              game: `${game.away_team} @ ${game.home_team}`,
              props: (game.bookmakers?.[0]?.markets || []).map(m => ({
                type: m.key,
                outcomes: (m.outcomes || []).slice(0, 4).map(o => ({ name: o.name, price: o.price, point: o.point })),
              })),
            }));
          }
        } catch { data.mlbProps = []; }
      }

      // Injuries
      try {
        const k = process.env.SPORTS_API_KEY;
        if (k) {
          const r = await fetch('https://v1.basketball.api-sports.io/injuries', { headers: { 'x-apisports-key': k } });
          if (r.ok) { const d = await r.json(); data.injuries = (d.response || []).slice(0, 10).map(i => `${i.player?.name} (${i.team?.name}): ${i.type}`); }
        }
      } catch { data.injuries = []; }

      // Rundown — line movement
      try {
        const k = process.env.RUNDOWN_API_KEY;
        if (k) {
          const today = new Date().toISOString().split('T')[0];
          for (const sportId of [2, 3, 4]) {
            try {
              const r = await fetch(`https://therundown-therundown-v1.p.rapidapi.com/sports/${sportId}/events/${today}`, {
                headers: { 'x-rapidapi-key': k, 'x-rapidapi-host': 'therundown-therundown-v1.p.rapidapi.com' }
              });
              if (r.ok) {
                const d = await r.json();
                if (!data.lineMovement) data.lineMovement = [];
                data.lineMovement.push(...(d.events || []).slice(0, 3).map(e => ({
                  teams: `${e.teams_normalized?.[0]?.name || ''} vs ${e.teams_normalized?.[1]?.name || ''}`,
                  openLine: e.lines?.draftkings?.total_open,
                  currentLine: e.lines?.draftkings?.total,
                })));
              }
            } catch {}
          }
        }
      } catch {}

      return data;
    }

    // ── CLAUDE CALL ───────────────────────────────────────────────────────────
    async function callClaude(prompt, system, maxTokens = 4096) {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) throw new Error('ANTHROPIC_API_KEY not set in Netlify environment variables');
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] }),
      });
      const txt = await r.text();
      if (!r.ok) throw new Error(`Anthropic ${r.status}: ${txt.slice(0, 200)}`);
      const d = JSON.parse(txt);
      return d.content?.[0]?.text || '';
    }

    // ── SAFE JSON PARSE ───────────────────────────────────────────────────────
    function safeJSON(text) {
      const clean = text.replace(/```json/g, '').replace(/```/g, '').trim();
      try { return JSON.parse(clean); } catch {}
      // Try fixing trailing commas
      try { return JSON.parse(clean.replace(/,(\s*[}\]])/g, '$1')); } catch {}
      // Extract first JSON object
      const m = clean.match(/\{[\s\S]*\}/);
      if (m) { try { return JSON.parse(m[0]); } catch {} }
      throw new Error('Could not parse AI response. Try again.');
    }

    // ── ANALYZE — deep single bet analysis ───────────────────────────────────
    if (action === 'ask') {
      const data = await fetchAllData();
      const query = body.query || '';

      const system = `You are EDGE v5 — world-class sports betting analyst with deep expertise across ALL sports.

ANALYSIS APPROACH:
- Use ALL 8 predictive factors: Recent Form, H2H History, Rest/Travel, Injury Impact, Line Movement, Sharp Money, Matchup Edge, Motivation
- Analyze ANY upcoming event the user asks about — not just today
- Use REAL lines from the odds data provided
- For player props, identify correlated bets (e.g. if QB throws more, WR catches more)
- For golf, use course history, strokes gained, and current form
- Consider weather, travel, altitude, surface for outdoor/tennis/golf
- Sharp money and reverse line movement are strong signals
- Line movement direction tells you who is betting

BET TYPES TO CONSIDER:
- Moneyline, Spread, Total (Over/Under)
- Player props (points, yards, receptions, strikeouts, etc.)
- Golf Top 10 / Top 20 / Outright winner
- Tennis set betting, game totals
- Parlay correlations (same-game parlays where outcomes are linked)
- Live betting angles if game is in progress

CORRELATED PARLAY LOGIC:
- QB completion % correlates with WR reception props
- High total games correlate with QB passing yards going over
- Team that wins ML likely covers spread in blowouts
- Starting pitcher K rate correlates with game total going under
- Golf: player making cut correlates with Top 20 finish`;

      const prompt = `Analyze this bet request: "${query}"

TODAY'S DATE: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}

LIVE ODDS DATA:
${JSON.stringify(data.oddsGames?.slice(0, 8))}

GOLF ODDS:
${JSON.stringify(data.golfOdds)}

NBA GAMES:
${JSON.stringify(data.nba)}

MLB GAMES:
${JSON.stringify(data.mlb)}

NHL GAMES:
${JSON.stringify(data.nhl)}

PGA EVENT:
${JSON.stringify(data.pga)}

NBA PLAYER PROPS:
${JSON.stringify(data.nbaProps)}

MLB PLAYER PROPS:
${JSON.stringify(data.mlbProps)}

SHARP MONEY (ActionNetwork):
${JSON.stringify(data.actionNetwork)}

LINE MOVEMENT:
${JSON.stringify(data.lineMovement)}

INJURIES:
${JSON.stringify(data.injuries)}

Provide a DEEP analysis. Use real lines from the data. If asking about a future event, analyze it based on current available info.

Return ONLY valid JSON:
{
  "sport": "NBA",
  "title": "Real game or event name",
  "pick": "Specific pick with real line",
  "verdict": "STRONG BET",
  "winProbability": 61,
  "impliedOddsProb": 39,
  "edgePct": 22,
  "recommendedLine": "+155",
  "bestBook": "FanDuel",
  "stake": 25,
  "category": "dog_ml",
  "factors": {
    "recentForm": {"score": 8, "detail": "specific recent form data"},
    "h2h": {"score": 7, "detail": "specific h2h history"},
    "restDays": {"score": 6, "detail": "days of rest situation"},
    "injuryImpact": {"score": 5, "detail": "specific injury context"},
    "lineMovement": {"score": 9, "detail": "how line moved and why"},
    "sharpMoney": {"score": 8, "detail": "public vs sharp breakdown"},
    "matchupEdge": {"score": 7, "detail": "specific matchup advantage"},
    "motivation": {"score": 6, "detail": "stakes and motivation factors"}
  },
  "allBookOdds": {"DraftKings": "+150", "FanDuel": "+155", "BetMGM": "+148", "Caesars": "+152"},
  "summary": "3-4 sentence deep analysis with specific stats and reasoning",
  "keyRisk": "most important risk factor",
  "alternativeBet": "best alternative pick if passing",
  "correlatedParlay": {
    "available": true,
    "legs": [
      {"pick": "First correlated pick", "line": "+150", "book": "FanDuel", "reason": "why correlated"},
      {"pick": "Second correlated pick", "line": "-115", "book": "DraftKings", "reason": "why correlated"}
    ],
    "combinedOdds": "+280",
    "parlayReason": "Why these picks correlate and strengthen each other"
  }
}`;

      const raw = await callClaude(prompt, system);
      const result = safeJSON(raw);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // ── ANALYZE — auto run picks ──────────────────────────────────────────────
    if (action === 'analyze') {
      const data = await fetchAllData();

      const system = `You are EDGE v5 — elite sports betting AI covering ALL sports.

STRATEGY (no restrictions — use whatever gives edge):
- Moneylines, spreads, totals, props, futures, parlays — all valid
- Look across NBA, MLB, NHL, Golf, Tennis, NFL, Soccer
- Identify correlated same-game parlays for maximum value
- Sharp money + reverse line movement = strongest signal
- Line movement direction reveals where books and sharps are betting
- Consider rest, travel, altitude, weather for all picks
- Player prop correlations: linked stats that move together
- Golf: strokes gained approach, course fit, recent form on similar tracks

CORRELATED PARLAY EXAMPLES:
- High game total + QB passing yards over (QB must throw more)
- Team ML + their QB passing yards over (must throw when winning)
- WR receptions over + QB completions over (same plays)
- Golf player Top 10 + make cut (if making cut, likely in contention)
- Starting pitcher strikeouts over + game total under (dominant SP = low scoring)`;

      const prompt = `Find the 5 best value bets RIGHT NOW across ALL sports. Include at least one parlay if correlated picks exist. Use ONLY real lines from data.

NBA: ${JSON.stringify(data.nba)}
MLB: ${JSON.stringify(data.mlb)}
NHL: ${JSON.stringify(data.nhl)}
PGA: ${JSON.stringify(data.pga)}
GOLF ODDS: ${JSON.stringify(data.golfOdds)}
LIVE ODDS: ${JSON.stringify(data.oddsGames?.slice(0, 10))}
NBA PROPS: ${JSON.stringify(data.nbaProps)}
MLB PROPS: ${JSON.stringify(data.mlbProps)}
SHARP MONEY: ${JSON.stringify(data.actionNetwork)}
LINE MOVEMENT: ${JSON.stringify(data.lineMovement)}
INJURIES: ${JSON.stringify(data.injuries)}
BUDGET: $${body.budget || 300}

Return ONLY valid JSON:
{
  "weeklyThesis": "2 sentence overall market thesis",
  "picks": [
    {
      "sport": "NBA",
      "description": "Real Team ML",
      "bestBook": "FanDuel",
      "line": "+155",
      "allBookOdds": {"DraftKings": "+150", "FanDuel": "+155", "BetMGM": "+148", "Caesars": "+152"},
      "stake": 25,
      "toWin": 37,
      "confidence": 7,
      "winProbability": 56,
      "edge": "specific reason with data",
      "risk": "main risk",
      "category": "dog_ml",
      "lineMovement": "opened +140 moved to +155 — sharp action",
      "publicPct": "34% public, 68% sharp money on dog",
      "factors": {
        "recentForm": {"score": 7, "detail": "specific"},
        "h2h": {"score": 6, "detail": "specific"},
        "restDays": {"score": 7, "detail": "specific"},
        "injuryImpact": {"score": 5, "detail": "specific"},
        "lineMovement": {"score": 8, "detail": "specific"},
        "sharpMoney": {"score": 7, "detail": "specific"},
        "matchupEdge": {"score": 6, "detail": "specific"},
        "motivation": {"score": 5, "detail": "specific"}
      }
    }
  ],
  "parlays": [
    {
      "name": "Correlated Same-Game Parlay",
      "sport": "NBA",
      "game": "Real game name",
      "legs": [
        {"pick": "Real pick 1", "line": "+150", "book": "FanDuel"},
        {"pick": "Real pick 2", "line": "-115", "book": "FanDuel"}
      ],
      "combinedOdds": "+280",
      "stake": 10,
      "toWin": 38,
      "reason": "Why these correlate — specific statistical logic"
    }
  ],
  "blockedPicks": ["any picks blocked and why"]
}`;

      const raw = await callClaude(prompt, system);
      const picks = safeJSON(raw);
      return { statusCode: 200, headers, body: JSON.stringify({ picks, oddsGames: data.oddsGames }) };
    }

    // ── DAILY BETS ────────────────────────────────────────────────────────────
    if (action === 'daily') {
      const data = await fetchAllData();
      const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

      const system = `You are EDGE v5 — elite sports betting analyst. Cover ALL sports. Use real games and real lines. Include props and parlays where correlated. No sport restrictions.`;

      const prompt = `Best bets for ${today} across ALL sports. Use ONLY real data below. Return ONLY valid JSON.

NBA: ${JSON.stringify(data.nba)}
MLB: ${JSON.stringify(data.mlb)}
NHL: ${JSON.stringify(data.nhl)}
PGA: ${JSON.stringify(data.pga)}
GOLF ODDS: ${JSON.stringify(data.golfOdds)}
NBA PROPS: ${JSON.stringify(data.nbaProps)}
MLB PROPS: ${JSON.stringify(data.mlbProps)}
LIVE ODDS: ${JSON.stringify(data.oddsGames?.slice(0, 10))}
SHARP MONEY: ${JSON.stringify(data.actionNetwork)}
LINE MOVEMENT: ${JSON.stringify(data.lineMovement)}
INJURIES: ${JSON.stringify(data.injuries)}

RULES:
- 6-8 picks minimum
- Cover at least 3 different sports
- Include Golf Top 10 if PGA event active
- Include NHL puck line if NHL games today
- Include at least 1 player prop if props data available
- Include 1-2 correlated parlays if strong correlations exist
- Mark top 3 value plays as isTopPick: true
- Use REAL team and player names from data

Return ONLY valid JSON:
{"bets":[{"rank":1,"isTopPick":true,"sport":"NBA","title":"Real Game","pick":"Real Pick","line":"+155","bestBook":"FanDuel","winProbability":60,"edgePct":21,"confidence":7,"category":"dog_ml","stake":25,"edge":"specific data-driven reason","keyFactors":["real factor 1","real factor 2","real factor 3"],"isParlay":false},{"rank":2,"isTopPick":true,"sport":"Golf","title":"Real PGA Event","pick":"Real Player Top 10","line":"+250","bestBook":"FanDuel","winProbability":40,"edgePct":15,"confidence":6,"category":"prop","stake":15,"edge":"course fit and strokes gained","keyFactors":["strokes gained","course history","recent form"],"isParlay":false},{"rank":3,"isTopPick":true,"sport":"MLB","title":"Real Game","pick":"Real Pick","line":"+140","bestBook":"DraftKings","winProbability":55,"edgePct":15,"confidence":6,"category":"dog_ml","stake":20,"edge":"pitching matchup","keyFactors":["starter ERA","bullpen","park factor"],"isParlay":false},{"rank":4,"isTopPick":false,"sport":"NBA","title":"Correlated SGP","pick":"Player A Over + Team ML","line":"+310","bestBook":"FanDuel","winProbability":38,"edgePct":18,"confidence":6,"category":"parlay","stake":10,"edge":"correlated same-game parlay — player performance tied to team win","keyFactors":["same game correlation","sharp value","prop line soft"],"isParlay":true}]}`;

      const raw = await callClaude(prompt, system);
      const result = safeJSON(raw);
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // ── RAW CLAUDE CALL ───────────────────────────────────────────────────────
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
      let all = [];
      for (const sp of ['basketball_nba', 'baseball_mlb', 'icehockey_nhl']) {
        try {
          const r = await fetch(`https://api.the-odds-api.com/v4/sports/${sp}/odds/?apiKey=${key}&regions=us&markets=h2h,spreads,totals&oddsFormat=american&bookmakers=${books}`);
          if (r.ok) { const g = await r.json(); if (Array.isArray(g)) all.push(...g.slice(0, 3)); }
        } catch {}
      }
      return { statusCode: 200, headers, body: JSON.stringify({ games: all }) };
    }

    // ── ALL DATA ──────────────────────────────────────────────────────────────
    if (action === 'alldata') {
      const data = await fetchAllData();
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ status: 'picks function working', action }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
