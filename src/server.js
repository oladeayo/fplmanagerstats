const express = require('express');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// CORS middleware for Vercel
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

// Health check endpoint for Vercel
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Your existing endpoints remain the same
app.get('/api/bootstrap-static', async (req, res) => {
  try {
    const response = await axios.get('https://fantasy.premierleague.com/api/bootstrap-static/');
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch bootstrap static data' });
  }
});

app.get('/api/analyze-manager/:managerId', async (req, res) => {
  try {
    const { managerId } = req.params;
    const leagueId = 314; // Your league ID
    
    // Fetch all required data in parallel
    const [playerDataResponse, managerEntryResponse, historyResponse, leagueResponse] = await Promise.all([
      axios.get('https://fantasy.premierleague.com/api/bootstrap-static/'),
      axios.get(`https://fantasy.premierleague.com/api/entry/${managerId}/`),
      axios.get(`https://fantasy.premierleague.com/api/entry/${managerId}/history/`),
      axios.get(`https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/`)
    ]);

    const playerData = playerDataResponse.data;
    const managerEntryData = managerEntryResponse.data;
    const historyData = historyResponse.data;
    const leagueData = leagueResponse.data;

    const currentGameweek = playerData.events.find(event => event.is_current).id;
    const topManagerPoints = leagueData.standings.results[0].total;
    
    // Initialize analysis data structure
    let totalCaptaincyPoints = 0;
    let totalPointsActive = 0;
    let totalPointsLostOnBench = 0;
    const playerStats = {};
    const positionPoints = { GKP: {}, DEF: {}, MID: {}, FWD: {} };

    // Process each gameweek
    const weeklyPoints = new Array(currentGameweek).fill(0);
    const weeklyRanks = new Array(currentGameweek).fill(0);
    
    // Track highest and lowest stats
    let highestPoints = 0;
    let highestPointsGW = 0;
    let lowestPoints = Infinity;
    let lowestPointsGW = 0;
    let highestRank = Infinity;
    let highestRankGW = 0;
    let lowestRank = 0;
    let lowestRankGW = 0;

    // Get current team and fixtures
    const currentTeam = [];
    const managerPicksResponse = await axios.get(`https://fantasy.premierleague.com/api/entry/${managerId}/event/${currentGameweek}/picks/`);
    const managerPicks = managerPicksResponse.data.picks;

    for (const pick of managerPicks) {
      const player = playerData.elements.find(p => p.id === pick.element);
      if (!player) continue;

      const fixturesResponse = await axios.get(`https://fantasy.premierleague.com/api/element-summary/${player.id}/`);
      const nextFixtures = fixturesResponse.data.fixtures.slice(0, 5).map(fixture => {
        const isHome = fixture.is_home;
        const opponent = playerData.teams.find(t => t.id === (isHome ? fixture.team_a : fixture.team_h)).short_name;
        return {
          opponent,
          isHome,
          difficulty: fixture.difficulty
        };
      });

      currentTeam.push({
        name: player.web_name,
        nextFixtures
      });
    }

     // Get last 5 GWs data with improved structure
     const last5GWs = Array.from({ length: 5 }, (_, i) => currentGameweek - i)
     .filter(gw => gw > 0)
     .reverse(); // Reverse to get chronological order

   const playerHistoryPromises = managerPicks.map(async (pick) => {
     const player = playerData.elements.find(p => p.id === pick.element);
     if (!player) return null;

     const historyResponse = await axios.get(`https://fantasy.premierleague.com/api/element-summary/${player.id}/`);
     const playerHistory = historyResponse.data.history;

     // Get points for each of the last 5 GWs
     const last5GWPoints = last5GWs.map(gw => {
       const gwHistory = playerHistory.find(h => h.round === gw);
       return gwHistory ? gwHistory.total_points : 0;
     });

     return {
       name: player.web_name,
       position: ["GKP", "DEF", "MID", "FWD"][player.element_type - 1],
       team: playerData.teams[player.team - 1].short_name,
       last5GWPoints,
       totalLast5Points: last5GWPoints.reduce((sum, points) => sum + points, 0)
     };
   });

   const last5GWsData = (await Promise.all(playerHistoryPromises))
     .filter(data => data !== null)
     .sort((a, b) => b.totalLast5Points - a.totalLast5Points);

   // Add gameweek labels
   const last5GWLabels = last5GWs.map(gw => `GW${gw}`);

   // Prepare the complete analysis object
   const analysis = {
     managerInfo: {
       // ... (previous managerInfo remains the same)
     },
     playerStats: Object.values(playerStats).sort((a, b) => b.totalPointsActive - a.totalPointsActive),
     positionSummary: Object.entries(positionPoints).map(([position, players]) => ({
       position,
       totalPoints: Object.values(players).reduce((sum, player) => sum + player.points, 0),
       players: Object.values(players).sort((a, b) => b.points - a.points)
     })),
     weeklyPoints,
     weeklyRanks,
     currentTeam,
     last5GWsData: {
       players: last5GWsData,
       gameweeks: last5GWLabels
     }
   };

   res.json(analysis);
 } catch (error) {
   console.error('Error analyzing manager:', error);
   res.status(500).json({ error: 'Failed to analyze manager' });
 }
});

// Only listen if running directly (not in Vercel)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}