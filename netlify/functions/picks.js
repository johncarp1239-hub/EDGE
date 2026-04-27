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

    // ── CLAUDE ──────────────────────────────────────────────────────────────
    if (action === 'claude') {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set in Netlify env vars' }) };

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: 'claude-sonnet-4-5',
          max_tokens: 4096,
          system: body.system || 'You are a helpful assistant.',
          messages: [{ role: 'user', content: body.prompt }],
        }),
      });
      const txt = await r.text();
      if (!r.ok) return { statusCode: r.status, headers, body: JSON.stringify({ error: `Anthropic ${r.status}: ${txt.slice(0, 200)}` }) };
      const data = JSON.parse(txt);
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    // ── ODDS ─────────────────────────────────────────────────────────────────
    if (action === 'odds') {
      const key = process.env.ODDS_API_KEY;
      if (!key) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ODDS_API_KEY not set' }) };
      const books = 'draftkings,fanduel,betmgm,caesars';
      let all = [];
      for (const sp of ['basketball_nba', 'baseball_mlb', 'icehockey_nhl']) {
        try {
          const r = await fetch(`https://api.the-odds-api.com/v4/sports/${sp}/odds/?apiKey=${key}&regions=us&markets=h2h,spreads&oddsFormat=american&bookmakers=${books}`);
          if (r.ok) { const g = await r.json(); if (Array.isArray(g)) all.push(...g.slice(0, 3)); }
        } catch {}
      }
      for (const gs of ['golf_pga_championship_winner', 'golf_masters_tournament_winner']) {
        try {
          const r = await fetch(`https://api.the-odds-api.com/v4/sports/${gs}/odds/?apiKey=${key}&regions=us&markets=outrights&oddsFormat=american&bookmakers=${books}`);
          if (r.ok) { const g = await r.json(); if (Array.isArray(g) && g.length) { all.push(...g.slice(0, 1)); break; } }
        } catch {}
      }
      return { statusCode: 200, headers, body: JSON.stringify({ games: all }) };
    }

    // ── ALL DATA ──────────────────────────────────────────────────────────────
    if (action === 'alldata') {
      const results = {};
      for (const [sp, path] of [['espn_nba','basketball/nba'],['espn_mlb','baseball/mlb'],['espn_nhl','hockey/nhl']]) {
        try {
          const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`);
          if (r.ok) {
            const d = await r.json();
            results[sp] = (d.events || []).slice(0, 4).map(e => ({
              name: e.name,
              home: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'home')?.team?.displayName,
              away: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'away')?.team?.displayName,
              homeRec: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'home')?.records?.[0]?.summary,
              awayRec: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'away')?.records?.[0]?.summary,
            }));
          }
        } catch { results[sp] = []; }
      }
      try {
        const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard');
        if (r.ok) {
          const d = await r.json();
          const ev = d.events?.[0];
          results.pga = ev ? { eventName: ev.name, top10: (ev.competitions?.[0]?.competitors || []).slice(0, 10).map(c => ({ name: c.athlete?.displayName, pos: c.status?.position?.displayName, score: c.score?.displayValue })) } : null;
        }
      } catch { results.pga = null; }
      try {
        const r = await fetch('https://api.actionnetwork.com/web/v1/games?sport=nba&include=odds&period=game', { headers: { Accept: 'application/json', Origin: 'https://www.actionnetwork.com', Referer: 'https://www.actionnetwork.com/' } });
        if (r.ok) { const d = await r.json(); results.actionNetwork = (d.games || []).slice(0, 4).map(g => ({ teams: `${g.away_team?.abbr || ''}@${g.home_team?.abbr || ''}`, awayPct: g.away_bet_pct, homePct: g.home_bet_pct, sharp: g.sharp_side })); }
      } catch { results.actionNetwork = null; }
      try {
        const k = process.env.SPORTS_API_KEY;
        if (k) { const r = await fetch('https://v1.basketball.api-sports.io/injuries', { headers: { 'x-apisports-key': k } }); if (r.ok) { const d = await r.json(); results.injuries = (d.response || []).slice(0, 6).map(i => `${i.player?.name}: ${i.type}`); } }
      } catch { results.injuries = null; }
      try {
        const k = process.env.RUNDOWN_API_KEY;
        if (k) { const today = new Date().toISOString().split('T')[0]; const r = await fetch(`https://therundown-therundown-v1.p.rapidapi.com/sports/2/events/${today}`, { headers: { 'x-rapidapi-key': k, 'x-rapidapi-host': 'therundown-therundown-v1.p.rapidapi.com' } }); if (r.ok) { const d = await r.json(); results.rundown = (d.events || []).slice(0, 4).map(e => ({ teams: `${e.teams_normalized?.[0]?.name || ''} vs ${e.teams_normalized?.[1]?.name || ''}` })); } }
      } catch { results.rundown = null; }
      return { statusCode: 200, headers, body: JSON.stringify(results) };
    }

    // ── ANALYZE (server-side: fetch data + call Claude + return picks) ────────
    if (action === 'analyze') {
      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      const oddsKey = process.env.ODDS_API_KEY;
      if (!anthropicKey) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };

      // Fetch all data server-side
      let oddsData = [], espnNBA = [], espnMLB = [], pga = null, actionNet = null, injuries = null;

      if (oddsKey) {
        const books = 'draftkings,fanduel,betmgm,caesars';
        for (const sp of ['basketball_nba', 'baseball_mlb', 'icehockey_nhl']) {
          try { const r = await fetch(`https://api.the-odds-api.com/v4/sports/${sp}/odds/?apiKey=${oddsKey}&regions=us&markets=h2h,spreads&oddsFormat=american&bookmakers=${books}`); if (r.ok) { const g = await r.json(); if (Array.isArray(g)) oddsData.push(...g.slice(0, 3)); } } catch {}
        }
      }
      try { const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard'); if (r.ok) { const d = await r.json(); espnNBA = (d.events || []).slice(0, 4).map(e => ({ name: e.name, home: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'home')?.team?.displayName, away: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'away')?.team?.displayName, homeRec: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'home')?.records?.[0]?.summary, awayRec: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'away')?.records?.[0]?.summary })); } } catch {}
      try { const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard'); if (r.ok) { const d = await r.json(); espnMLB = (d.events || []).slice(0, 4).map(e => ({ name: e.name, home: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'home')?.team?.displayName, away: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'away')?.team?.displayName })); } } catch {}
      try { const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard'); if (r.ok) { const d = await r.json(); const ev = d.events?.[0]; if (ev) pga = { eventName: ev.name, top10: (ev.competitions?.[0]?.competitors || []).slice(0, 10).map(c => ({ name: c.athlete?.displayName, pos: c.status?.position?.displayName })) }; } } catch {}
      try { const r = await fetch('https://api.actionnetwork.com/web/v1/games?sport=nba&include=odds&period=game', { headers: { Accept: 'application/json', Origin: 'https://www.actionnetwork.com', Referer: 'https://www.actionnetwork.com/' } }); if (r.ok) { const d = await r.json(); actionNet = (d.games || []).slice(0, 3).map(g => ({ teams: `${g.away_team?.abbr || ''}@${g.home_team?.abbr || ''}`, awayPct: g.away_bet_pct, homePct: g.home_bet_pct, sharp: g.sharp_side })); } } catch {}
      try { const k = process.env.SPORTS_API_KEY; if (k) { const r = await fetch('https://v1.basketball.api-sports.io/injuries', { headers: { 'x-apisports-key': k } }); if (r.ok) { const d = await r.json(); injuries = (d.response || []).slice(0, 5).map(i => `${i.player?.name}: ${i.type}`); } } } catch {}

      // Format odds concisely
      const fmtOdds = oddsData.map(g => {
        const bks = {};
        (g.bookmakers || []).forEach(bk => { (bk.markets || []).forEach(m => { if (!bks[bk.key]) bks[bk.key] = {}; bks[bk.key][m.key] = (m.outcomes || []).map(o => ({ n: o.name, p: o.price })); }); });
        return { sport: g.sport_title, home: g.home_team, away: g.away_team, books: bks };
      });

      const systemPrompt = `You are EDGE v5 — elite sports betting AI.
HARD RULES: NEVER pick ML worse than -130. NEVER spread worse than -10.5.
JOHN PROFILE: Target dog ML +100 to +200, underdog ATS, Golf Top 10 +150-+350. Avoid heavy favorites.
KELLY: Quarter-Kelly sizing. Max $45. Prefer $15-$30.
Budget: $${body.budget || 300}`;

      const userPrompt = `Find 3 best value bets. Return ONLY valid JSON, nothing else.

ODDS: ${JSON.stringify(fmtOdds)}
NBA: ${JSON.stringify(espnNBA)}
MLB: ${JSON.stringify(espnMLB)}
PGA: ${JSON.stringify(pga)}
SHARP MONEY: ${JSON.stringify(actionNet)}
INJURIES: ${JSON.stringify(injuries)}

JSON format:
{"weeklyThesis":"one sentence","picks":[{"sport":"NBA","description":"Minnesota Timberwolves ML","bestBook":"FanDuel","line":"+155","allBookOdds":{"DraftKings":"+150","FanDuel":"+155","BetMGM":"+148","Caesars":"+152"},"stake":25,"toWin":37,"confidence":7,"winProbability":56,"edge":"why value","risk":"main risk","category":"dog_ml","factors":{"recentForm":{"score":7,"detail":"7-3 L10"},"h2h":{"score":6,"detail":"4-1 L5"},"restDays":{"score":7,"detail":"2 days"},"injuryImpact":{"score":5,"detail":"healthy"},"lineMovement":{"score":8,"detail":"moved up"},"sharpMoney":{"score":7,"detail":"sharp on dog"},"matchupEdge":{"score":6,"detail":"pace edge"},"motivation":{"score":5,"detail":"playoff spot"}}}],"blockedPicks":[]}`;

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 4096, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] }),
      });
      const txt = await r.text();
      if (!r.ok) return { statusCode: r.status, headers, body: JSON.stringify({ error: `Anthropic ${r.status}: ${txt.slice(0, 200)}` }) };
      const aiData = JSON.parse(txt);
      const rawText = aiData.content?.[0]?.text || '';

      // Parse Claude's response safely
      let picks;
      try {
        const clean = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        picks = JSON.parse(clean);
      } catch {
        const match = rawText.match(/\{[\s\S]*\}/);
        if (match) {
          try { picks = JSON.parse(match[0]); } catch { return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not parse AI response. Try again.' }) }; }
        } else {
          return { statusCode: 500, headers, body: JSON.stringify({ error: 'No JSON found in AI response. Try again.' }) };
        }
      }
      return { statusCode: 200, headers, body: JSON.stringify({ picks, oddsGames: fmtOdds }) };
    }

    // ── ASK (server-side analysis for specific bet) ───────────────────────────
    if (action === 'ask') {
      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      if (!anthropicKey) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };

      let espnNBA = [], pga = null, actionNet = null;
      try { const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard'); if (r.ok) { const d = await r.json(); espnNBA = (d.events || []).slice(0, 4).map(e => ({ name: e.name, home: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'home')?.team?.displayName, away: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'away')?.team?.displayName })); } } catch {}
      try { const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard'); if (r.ok) { const d = await r.json(); const ev = d.events?.[0]; if (ev) pga = { eventName: ev.name, top10: (ev.competitions?.[0]?.competitors || []).slice(0, 10).map(c => ({ name: c.athlete?.displayName, pos: c.status?.position?.displayName })) }; } } catch {}
      try { const r = await fetch('https://api.actionnetwork.com/web/v1/games?sport=nba&include=odds&period=game', { headers: { Accept: 'application/json', Origin: 'https://www.actionnetwork.com', Referer: 'https://www.actionnetwork.com/' } }); if (r.ok) { const d = await r.json(); actionNet = (d.games || []).slice(0, 3).map(g => ({ teams: `${g.away_team?.abbr || ''}@${g.home_team?.abbr || ''}`, awayPct: g.away_bet_pct, homePct: g.home_bet_pct, sharp: g.sharp_side })); } } catch {}

      const systemPrompt = `You are EDGE v5 — elite sports betting AI. Analyze bets using 8 factors: Recent Form, H2H, Rest Days, Injuries, Line Movement, Sharp Money, Matchup Edge, Motivation. Be specific and data-driven.`;

      const userPrompt = `Analyze: "${body.query}"
Today: ${new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
NBA: ${JSON.stringify(espnNBA)}
PGA: ${JSON.stringify(pga)}
Sharp Money: ${JSON.stringify(actionNet)}

Return ONLY valid JSON:
{"sport":"NBA","title":"Game name","pick":"Specific pick with line","verdict":"STRONG BET","winProbability":61,"impliedOddsProb":39,"edgePct":22,"recommendedLine":"+155","bestBook":"FanDuel","stake":25,"category":"dog_ml","factors":{"recentForm":{"score":8,"detail":"specific detail"},"h2h":{"score":7,"detail":"specific detail"},"restDays":{"score":6,"detail":"specific detail"},"injuryImpact":{"score":5,"detail":"specific detail"},"lineMovement":{"score":9,"detail":"specific detail"},"sharpMoney":{"score":8,"detail":"specific detail"},"matchupEdge":{"score":7,"detail":"specific detail"},"motivation":{"score":6,"detail":"specific detail"}},"allBookOdds":{"DraftKings":"+150","FanDuel":"+155","BetMGM":"+148","Caesars":"+152"},"summary":"2-3 sentence analysis","keyRisk":"main risk factor","alternativeBet":"alternative pick"}`;

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 4096, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] }),
      });
      const txt = await r.text();
      if (!r.ok) return { statusCode: r.status, headers, body: JSON.stringify({ error: `Anthropic ${r.status}: ${txt.slice(0, 200)}` }) };
      const aiData = JSON.parse(txt);
      const rawText = aiData.content?.[0]?.text || '';
      let result;
      try {
        const clean = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        result = JSON.parse(clean);
      } catch {
        const match = rawText.match(/\{[\s\S]*\}/);
        if (match) { try { result = JSON.parse(match[0]); } catch { return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not parse response. Try again.' }) }; } }
        else return { statusCode: 500, headers, body: JSON.stringify({ error: 'No JSON in response. Try again.' }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    // ── DAILY BETS (server-side) ───────────────────────────────────────────────
    if (action === 'daily') {
      const anthropicKey = process.env.ANTHROPIC_API_KEY;
      const oddsKey = process.env.ODDS_API_KEY;
      if (!anthropicKey) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }) };

      let espnNBA = [], espnMLB = [], espnNHL = [], pga = null, actionNet = null, oddsStr = '';
      try { const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard'); if (r.ok) { const d = await r.json(); espnNBA = (d.events || []).slice(0, 5).map(e => ({ name: e.name, home: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'home')?.team?.displayName, away: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'away')?.team?.displayName, homeRec: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'home')?.records?.[0]?.summary, awayRec: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'away')?.records?.[0]?.summary })); } } catch {}
      try { const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard'); if (r.ok) { const d = await r.json(); espnMLB = (d.events || []).slice(0, 5).map(e => ({ name: e.name, home: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'home')?.team?.displayName, away: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'away')?.team?.displayName })); } } catch {}
      try { const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard'); if (r.ok) { const d = await r.json(); espnNHL = (d.events || []).slice(0, 5).map(e => ({ name: e.name })); } } catch {}
      try { const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard'); if (r.ok) { const d = await r.json(); const ev = d.events?.[0]; if (ev) pga = { eventName: ev.name, top10: (ev.competitions?.[0]?.competitors || []).slice(0, 10).map(c => ({ name: c.athlete?.displayName, pos: c.status?.position?.displayName })) }; } } catch {}
      try { const r = await fetch('https://api.actionnetwork.com/web/v1/games?sport=nba&include=odds&period=game', { headers: { Accept: 'application/json', Origin: 'https://www.actionnetwork.com', Referer: 'https://www.actionnetwork.com/' } }); if (r.ok) { const d = await r.json(); actionNet = (d.games || []).slice(0, 3).map(g => ({ teams: `${g.away_team?.abbr || ''}@${g.home_team?.abbr || ''}`, awayPct: g.away_bet_pct, homePct: g.home_bet_pct, sharp: g.sharp_side })); } } catch {}
      if (oddsKey) { try { const r = await fetch(`https://api.the-odds-api.com/v4/sports/basketball_nba/odds/?apiKey=${oddsKey}&regions=us&markets=h2h&oddsFormat=american&bookmakers=draftkings,fanduel`); if (r.ok) { const g = await r.json(); oddsStr = JSON.stringify((g || []).slice(0, 4).map(g2 => ({ home: g2.home_team, away: g2.away_team, bks: (g2.bookmakers || []).slice(0, 2) }))); } } catch {} }

      const systemPrompt = `You are EDGE v5 — elite sports betting AI. Target dog MLs, underdog spreads, golf Top 10s. Avoid ML favorites worse than -130.`;
      const today = new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      const userPrompt = `Best bets for ${today}. Return ONLY valid JSON.
NBA: ${JSON.stringify(espnNBA)}
MLB: ${JSON.stringify(espnMLB)}
NHL: ${JSON.stringify(espnNHL)}
PGA: ${JSON.stringify(pga)}
Sharp: ${JSON.stringify(actionNet)}
Odds: ${oddsStr || 'not available'}

{"bets":[{"rank":1,"isTopPick":true,"sport":"NBA","title":"Game","pick":"Pick","line":"+155","bestBook":"FanDuel","winProbability":60,"edgePct":21,"confidence":7,"category":"dog_ml","stake":25,"edge":"specific reason","keyFactors":["factor1","factor2","factor3"]},{"rank":2,"isTopPick":true,"sport":"MLB","title":"Game","pick":"Pick","line":"+140","bestBook":"DraftKings","winProbability":57,"edgePct":17,"confidence":6,"category":"dog_ml","stake":20,"edge":"specific reason","keyFactors":["factor1","factor2","factor3"]},{"rank":3,"isTopPick":true,"sport":"Golf","title":"Event","pick":"Player Top 10","line":"+200","bestBook":"FanDuel","winProbability":40,"edgePct":15,"confidence":6,"category":"prop","stake":15,"edge":"specific reason","keyFactors":["factor1","factor2","factor3"]},{"rank":4,"isTopPick":false,"sport":"NBA","title":"Game","pick":"Pick","line":"+125","bestBook":"BetMGM","winProbability":53,"edgePct":12,"confidence":6,"category":"dog_ml","stake":20,"edge":"reason","keyFactors":["f1","f2","f3"]},{"rank":5,"isTopPick":false,"sport":"MLB","title":"Game","pick":"Pick","line":"+130","bestBook":"Caesars","winProbability":54,"edgePct":14,"confidence":6,"category":"dog_ml","stake":20,"edge":"reason","keyFactors":["f1","f2","f3"]}]}`;

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: 4096, system: systemPrompt, messages: [{ role: 'user', content: userPrompt }] }),
      });
      const txt = await r.text();
      if (!r.ok) return { statusCode: r.status, headers, body: JSON.stringify({ error: `Anthropic ${r.status}: ${txt.slice(0, 200)}` }) };
      const aiData = JSON.parse(txt);
      const rawText = aiData.content?.[0]?.text || '';
      let result;
      try {
        const clean = rawText.replace(/```json/g, '').replace(/```/g, '').trim();
        result = JSON.parse(clean);
      } catch {
        const match = rawText.match(/\{[\s\S]*\}/);
        if (match) { try { result = JSON.parse(match[0]); } catch { return { statusCode: 500, headers, body: JSON.stringify({ error: 'Could not parse response. Try again.' }) }; } }
        else return { statusCode: 500, headers, body: JSON.stringify({ error: 'No JSON in response. Try again.' }) };
      }
      return { statusCode: 200, headers, body: JSON.stringify(result) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ status: 'picks function working', action }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
