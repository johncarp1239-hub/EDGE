const fetch = (...args) => import('node-fetch').then(({default: f}) => f(...args));

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

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { action, prompt, system, maxTokens, query } = JSON.parse(event.body || '{}');

    // ── ANTHROPIC ────────────────────────────────────────────────────────────
    if (action === 'claude') {
      const key = process.env.ANTHROPIC_API_KEY;
      if (!key) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ANTHROPIC_API_KEY not set in Netlify environment variables' }) };

      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: 'claude-sonnet-4-20250514', max_tokens: maxTokens || 1000, system, messages: [{ role: 'user', content: prompt }] }),
      });
      const data = await r.json();
      return { statusCode: r.status, headers, body: JSON.stringify(data) };
    }

    // ── ODDS API ─────────────────────────────────────────────────────────────
    if (action === 'odds') {
      const key = process.env.ODDS_API_KEY;
      if (!key) return { statusCode: 500, headers, body: JSON.stringify({ error: 'ODDS_API_KEY not set' }) };

      const books = 'draftkings,fanduel,betmgm,caesars';
      const sports = ['basketball_nba', 'baseball_mlb', 'icehockey_nhl'];
      const golfSports = ['golf_pga_championship_winner', 'golf_masters_tournament_winner', 'golf_the_open_championship_winner'];
      let all = [];

      for (const sp of sports) {
        try {
          const r = await fetch(`https://api.the-odds-api.com/v4/sports/${sp}/odds/?apiKey=${key}&regions=us&markets=h2h,spreads,totals&oddsFormat=american&bookmakers=${books}`);
          if (r.ok) { const g = await r.json(); if (Array.isArray(g)) all.push(...g.slice(0, 4)); }
        } catch {}
      }
      for (const gs of golfSports) {
        try {
          const r = await fetch(`https://api.the-odds-api.com/v4/sports/${gs}/odds/?apiKey=${key}&regions=us&markets=outrights&oddsFormat=american&bookmakers=${books}`);
          if (r.ok) { const g = await r.json(); if (Array.isArray(g) && g.length) { all.push(...g.slice(0, 2)); break; } }
        } catch {}
      }
      return { statusCode: 200, headers, body: JSON.stringify({ games: all }) };
    }

    // ── ESPN (free, no key) ───────────────────────────────────────────────────
    if (action === 'espn') {
      const urls = {
        nba: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard',
        mlb: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard',
        nhl: 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard',
      };
      const results = {};
      for (const [sport, url] of Object.entries(urls)) {
        try {
          const r = await fetch(url);
          if (r.ok) {
            const d = await r.json();
            results[sport] = d.events?.slice(0, 6).map(e => ({
              name: e.name, shortName: e.shortName,
              home: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'home')?.team?.displayName,
              away: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'away')?.team?.displayName,
              homeRec: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'home')?.records?.[0]?.summary,
              awayRec: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'away')?.records?.[0]?.summary,
              status: e.status?.type?.description,
              odds: e.competitions?.[0]?.odds?.[0],
            })) || [];
          }
        } catch {}
      }
      return { statusCode: 200, headers, body: JSON.stringify(results) };
    }

    // ── PGA TOUR (free, no key) ───────────────────────────────────────────────
    if (action === 'pga') {
      try {
        const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard');
        if (!r.ok) return { statusCode: 200, headers, body: JSON.stringify({ pga: null }) };
        const d = await r.json();
        const ev = d.events?.[0];
        const pga = ev ? {
          eventName: ev.name,
          competitors: ev.competitions?.[0]?.competitors?.slice(0, 30).map(c => ({
            name: c.athlete?.displayName,
            position: c.status?.position?.displayName,
            score: c.score?.displayValue,
          })) || [],
        } : null;
        return { statusCode: 200, headers, body: JSON.stringify({ pga }) };
      } catch {
        return { statusCode: 200, headers, body: JSON.stringify({ pga: null }) };
      }
    }

    // ── API-SPORTS INJURIES ───────────────────────────────────────────────────
    if (action === 'injuries') {
      const key = process.env.SPORTS_API_KEY;
      if (!key) return { statusCode: 200, headers, body: JSON.stringify({ injuries: null }) };
      try {
        const r = await fetch('https://v1.basketball.api-sports.io/injuries', { headers: { 'x-apisports-key': key } });
        if (!r.ok) return { statusCode: 200, headers, body: JSON.stringify({ injuries: null }) };
        const d = await r.json();
        const injuries = d.response?.slice(0, 10).map(i => `${i.player?.name}: ${i.type}`) || null;
        return { statusCode: 200, headers, body: JSON.stringify({ injuries }) };
      } catch {
        return { statusCode: 200, headers, body: JSON.stringify({ injuries: null }) };
      }
    }

    // ── WEATHER ───────────────────────────────────────────────────────────────
    if (action === 'weather') {
      const key = process.env.WEATHER_API_KEY;
      if (!key) return { statusCode: 200, headers, body: JSON.stringify({ weather: null }) };
      try {
        const r = await fetch(`https://api.openweathermap.org/data/2.5/weather?q=New York&appid=${key}&units=imperial`);
        if (!r.ok) return { statusCode: 200, headers, body: JSON.stringify({ weather: null }) };
        const d = await r.json();
        return { statusCode: 200, headers, body: JSON.stringify({ weather: { temp: Math.round(d.main?.temp), wind: Math.round(d.wind?.speed), desc: d.weather?.[0]?.description } }) };
      } catch {
        return { statusCode: 200, headers, body: JSON.stringify({ weather: null }) };
      }
    }

    // ── THE RUNDOWN ───────────────────────────────────────────────────────────
    if (action === 'rundown') {
      const key = process.env.RUNDOWN_API_KEY;
      if (!key) return { statusCode: 200, headers, body: JSON.stringify({ rundown: null }) };
      try {
        const today = new Date().toISOString().split('T')[0];
        const r = await fetch(`https://therundown-therundown-v1.p.rapidapi.com/sports/2/events/${today}`, {
          headers: { 'x-rapidapi-key': key, 'x-rapidapi-host': 'therundown-therundown-v1.p.rapidapi.com' }
        });
        if (!r.ok) return { statusCode: 200, headers, body: JSON.stringify({ rundown: null }) };
        const d = await r.json();
        const rundown = d.events?.slice(0, 8).map(e => ({ teams: `${e.teams_normalized?.[0]?.name || ''} vs ${e.teams_normalized?.[1]?.name || ''}`, lines: e.lines })) || null;
        return { statusCode: 200, headers, body: JSON.stringify({ rundown }) };
      } catch {
        return { statusCode: 200, headers, body: JSON.stringify({ rundown: null }) };
      }
    }

    // ── ACTION NETWORK (public scrape) ────────────────────────────────────────
    if (action === 'actionnetwork') {
      try {
        const results = [];
        for (const sport of ['nba', 'mlb', 'nhl']) {
          try {
            const r = await fetch(`https://api.actionnetwork.com/web/v1/games?sport=${sport}&include=odds&period=game`, {
              headers: { 'Accept': 'application/json', 'Origin': 'https://www.actionnetwork.com', 'Referer': 'https://www.actionnetwork.com/' }
            });
            if (!r.ok) continue;
            const d = await r.json();
            (d.games || []).slice(0, 4).forEach(g => {
              results.push({
                sport: sport.toUpperCase(),
                teams: `${g.away_team?.abbr || ''} @ ${g.home_team?.abbr || ''}`,
                awayBetPct: g.away_bet_pct,
                homeBetPct: g.home_bet_pct,
                awayMoneyPct: g.away_money_pct,
                homeMoneyPct: g.home_money_pct,
                sharpSide: g.sharp_side,
                steamMove: g.steam_move,
              });
            });
          } catch {}
        }
        return { statusCode: 200, headers, body: JSON.stringify({ actionNetwork: results.length ? results : null }) };
      } catch {
        return { statusCode: 200, headers, body: JSON.stringify({ actionNetwork: null }) };
      }
    }

    // ── SPORTSDATA.IO ─────────────────────────────────────────────────────────
    if (action === 'sportsdata') {
      const key = process.env.SPORTSDATA_API_KEY;
      if (!key) return { statusCode: 200, headers, body: JSON.stringify({ sportsdata: null }) };
      try {
        const r = await fetch(`https://api.sportsdata.io/v3/nba/scores/json/PlayerSeasonStats/2025?key=${key}`);
        if (!r.ok) return { statusCode: 200, headers, body: JSON.stringify({ sportsdata: null }) };
        const d = await r.json();
        const sportsdata = d?.slice(0, 20).map(p => ({ name: p.Name, team: p.Team, points: p.Points, assists: p.Assists, rebounds: p.Rebounds, minutes: p.Minutes })) || null;
        return { statusCode: 200, headers, body: JSON.stringify({ sportsdata }) };
      } catch {
        return { statusCode: 200, headers, body: JSON.stringify({ sportsdata: null }) };
      }
    }

    // ── ALL DATA (batch fetch for efficiency) ─────────────────────────────────
    if (action === 'alldata') {
      const results = {};
      // ESPN
      const espnUrls = { nba: 'https://site.api.espn.com/apis/site/v2/sports/basketball/nba/scoreboard', mlb: 'https://site.api.espn.com/apis/site/v2/sports/baseball/mlb/scoreboard', nhl: 'https://site.api.espn.com/apis/site/v2/sports/hockey/nhl/scoreboard' };
      for (const [sport, url] of Object.entries(espnUrls)) {
        try { const r = await fetch(url); if (r.ok) { const d = await r.json(); results[`espn_${sport}`] = d.events?.slice(0, 5).map(e => ({ name: e.name, home: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'home')?.team?.displayName, away: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'away')?.team?.displayName, homeRec: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'home')?.records?.[0]?.summary, awayRec: e.competitions?.[0]?.competitors?.find(c => c.homeAway === 'away')?.records?.[0]?.summary, status: e.status?.type?.description, odds: e.competitions?.[0]?.odds?.[0] })) || []; } } catch {}
      }
      // PGA
      try { const r = await fetch('https://site.api.espn.com/apis/site/v2/sports/golf/pga/scoreboard'); if (r.ok) { const d = await r.json(); const ev = d.events?.[0]; results.pga = ev ? { eventName: ev.name, competitors: ev.competitions?.[0]?.competitors?.slice(0, 20).map(c => ({ name: c.athlete?.displayName, position: c.status?.position?.displayName, score: c.score?.displayValue })) || [] } : null; } } catch {}
      // ActionNetwork
      try {
        const anResults = [];
        for (const sport of ['nba', 'mlb', 'nhl']) { try { const r = await fetch(`https://api.actionnetwork.com/web/v1/games?sport=${sport}&include=odds&period=game`, { headers: { 'Accept': 'application/json', 'Origin': 'https://www.actionnetwork.com', 'Referer': 'https://www.actionnetwork.com/' } }); if (r.ok) { const d = await r.json(); (d.games || []).slice(0, 4).forEach(g => anResults.push({ sport: sport.toUpperCase(), teams: `${g.away_team?.abbr || ''} @ ${g.home_team?.abbr || ''}`, awayBetPct: g.away_bet_pct, homeBetPct: g.home_bet_pct, sharpSide: g.sharp_side, steamMove: g.steam_move })); } } catch {} }
        results.actionNetwork = anResults.length ? anResults : null;
      } catch {}
      // Injuries
      const sportsKey = process.env.SPORTS_API_KEY;
      if (sportsKey) { try { const r = await fetch('https://v1.basketball.api-sports.io/injuries', { headers: { 'x-apisports-key': sportsKey } }); if (r.ok) { const d = await r.json(); results.injuries = d.response?.slice(0, 10).map(i => `${i.player?.name}: ${i.type}`) || null; } } catch {} }
      // Rundown
      const rundownKey = process.env.RUNDOWN_API_KEY;
      if (rundownKey) { try { const today = new Date().toISOString().split('T')[0]; const r = await fetch(`https://therundown-therundown-v1.p.rapidapi.com/sports/2/events/${today}`, { headers: { 'x-rapidapi-key': rundownKey, 'x-rapidapi-host': 'therundown-therundown-v1.p.rapidapi.com' } }); if (r.ok) { const d = await r.json(); results.rundown = d.events?.slice(0, 6).map(e => ({ teams: `${e.teams_normalized?.[0]?.name || ''} vs ${e.teams_normalized?.[1]?.name || ''}`, lines: e.lines })) || null; } } catch {} }
      return { statusCode: 200, headers, body: JSON.stringify(results) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action: ' + action }) };

  } catch (err) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: err.message }) };
  }
};
