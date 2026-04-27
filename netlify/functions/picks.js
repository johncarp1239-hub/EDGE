exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  try {
    const body = JSON.parse(event.body || '{}');
    const { action } = body;
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    const hasOdds = !!process.env.ODDS_API_KEY;

    if (action === 'claude') {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY is not set in Netlify environment variables' }) };
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-5', max_tokens: body.maxTokens || 1000, system: body.system || 'You are a helpful assistant.', messages: [{ role: 'user', content: body.prompt || 'Say hello' }] }),
      });
      const text = await response.text();
      if (!response.ok) return { statusCode: response.status, headers, body: JSON.stringify({ error: `Anthropic error ${response.status}: ${text.slice(0, 300)}` }) };
      const data = JSON.parse(text);
      return { statusCode: 200, headers, body: JSON.stringify(data) };
    }

    if (action === 'odds') {
      const key = process.env.ODDS_API_KEY;
      if (!key) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ODDS_API_KEY is not set' }) };
      const books = 'draftkings,fanduel,betmgm,caesars';
      let all = [];
      for (const sp of ['basketball_nba', 'baseball_mlb', 'icehockey_nhl']) {
        try {
          const r = await fetch(`https://api.the-odds-api.com/v4/sports/${sp}/odds/?apiKey=${key}&regions=us&markets=h2h,spreads&oddsFormat=american&bookmakers=${books}`);
          if (r.ok) { const g = await r.json(); if (Array.isArray(g)) all.push(...g.slice(0, 4)); }
        } catch {}
      }
      for (const gs of ['golf_pga_championship_winner', 'golf_masters_tournament_winner']) {
        try {
          const r = await fetch(`https://api.the-odds-api.com/v4/sports/${gs}/odds/?apiKey=${key}&regions=us&markets=outrights&oddsFormat=american&bookmakers=${books}`);
          if (r.ok) { const g = await r.json(); if (Array.isArray(g) && g.length) { all.push(...g.slice(0, 2)); break; } }
        } catch {}
      }
      return { statusCode: 200, headers, body: JSON.stringify({ games: all }) };
    }

    if (action === 'alldata') {
      const results = {};
      const espnSports = { nba: 'basketball/nba', mlb: 'baseball/mlb', nhl: 'hockey/nhl' };
      for (const [sport, path] of Object.entries(espnSports)) {
        try {
          const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/${path}/scoreboard`);
          if (r.ok) {
            const d = await r.json();
            results[`espn_${sport}`] = d.events?.slice(0, 5).map(e => ({
              name: e.name,
              home: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'home')?.team?.displayName,
              away: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'away')?.team?.displayName,
              homeRec: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'home')?.records?.[0]?.summary,
              awayRec: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'away')?.records?.[0]?.summary,
              status: e.status?.type?.description,
            })) || [];
          }
        } catch(e) { results[`espn_${sport}`] = []; }
      }
      try {
        const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard');
        if (r.ok) { const d = await r.json(); const ev = d.events?.[0]; results.pga = ev ? { eventName: ev.name, competitors: ev.competitions?.[0]?.competitors?.slice(0, 15).map(c => ({ name: c.athlete?.displayName, position: c.status?.position?.displayName, score: c.score?.displayValue })) || [] } : null; }
      } catch { results.pga = null; }
      try {
        const r = await fetch('https://api.actionnetwork.com/web/v1/games?sport=nba&include=odds&period=game', { headers: { 'Accept': 'application/json', 'Origin': 'https://www.actionnetwork.com', 'Referer': 'https://www.actionnetwork.com/' } });
        if (r.ok) { const d = await r.json(); results.actionNetwork = (d.games || []).slice(0, 4).map(g => ({ sport: 'NBA', teams: `${g.away_team?.abbr || ''} @ ${g.home_team?.abbr || ''}`, awayBetPct: g.away_bet_pct, homeBetPct: g.home_bet_pct, sharpSide: g.sharp_side })); }
      } catch { results.actionNetwork = null; }
      try {
        const key = process.env.SPORTS_API_KEY;
        if (key) { const r = await fetch('https://v1.basketball.api-sports.io/injuries', { headers: { 'x-apisports-key': key } }); if (r.ok) { const d = await r.json(); results.injuries = d.response?.slice(0, 8).map(i => `${i.player?.name}: ${i.type}`) || null; } }
      } catch { results.injuries = null; }
      try {
        const key = process.env.RUNDOWN_API_KEY;
        if (key) { const today = new Date().toISOString().split('T')[0]; const r = await fetch(`https://therundown-therundown-v1.p.rapidapi.com/sports/2/events/${today}`, { headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': 'therundown-therundown-v1.p.rapidapi.com' } }); if (r.ok) { const d = await r.json(); results.rundown = d.events?.slice(0, 6).map(e => ({ teams: `${e.teams_normalized?.[0]?.name || ''} vs ${e.teams_normalized?.[1]?.name || ''}` })) || null; } }
      } catch { results.rundown = null; }
      return { statusCode: 200, headers, body: JSON.stringify(results) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ status: 'picks function working', action: action || 'none', envVars: { hasAnthropic, hasOdds } }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message, stack: err.stack?.slice(0, 500) }) };
  }
};
