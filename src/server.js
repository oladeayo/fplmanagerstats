const express = require('express');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;
const LEAGUE_ID = process.env.LEAGUE_ID || 314; // Default league ID

// CORS middleware
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy' });
});

// Fetch bootstrap static data
app.get('/api/bootstrap-static', async (req, res) => {
  try {
    const response = await axios.get('https://fantasy.premierleague.com/api/bootstrap-static/');
    res.json(response.data);
  } catch (error) {
    console.error('Error fetching bootstrap static data:', error);
    res.status(500).json({ error: 'Failed to fetch bootstrap static data' });
  }
});

// Analyze manager endpoint
app.get('/api/analyze-manager/:managerId', async (req, res) => {
  const { managerId } = req.params;

  // Validate managerId
  if (!/^\d+$/.test(managerId)) {
    return res.status(400).json({ error: 'Invalid manager ID format' });
  }

  try {
    // Fetch all required data in parallel
    const [playerDataResponse, managerEntryResponse, historyResponse, leagueResponse] = await Promise.all([
      axios.get('https://fantasy.premierleague.com/api/bootstrap-static/'),
      axios.get(`https://fantasy.premierleague.com/api/entry/${managerId}/`),
      axios.get(`https://fantasy.premierleague.com/api/entry/${managerId}/history/`),
      axios.get(`https://fantasy.premierleague.com/api/leagues-classic/${LEAGUE_ID}/standings/`)
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

    for (let gw = 1; gw <= currentGameweek; gw++) {
      const managerPicksResponse = await axios.get(`https://fantasy.premierleague.com/api/entry/${managerId}/event/${gw}/picks/`);
      const managerPicksData = managerPicksResponse.data;
      const managerPicks = managerPicksData.picks;

      const isBenchBoost = managerPicksData.active_chip === "bboost";
      const isTripleCaptain = managerPicksData.active_chip === "3xc";

      let gwPoints = 0;
      
      for (const pick of managerPicks) {
        const playerId = pick.element;
        const player = playerData.elements.find(p => p.id == playerId);
        if (!player) continue;

        const playerHistoryResponse = await axios.get(`https://fantasy.premierleague.com/api/element-summary/${playerId}/`);
        const playerHistory = playerHistoryResponse.data.history;
        const gameweekHistory = playerHistory.find(history => history.round === gw);
        const pointsThisWeek = gameweekHistory ? gameweekHistory.total_points : 0;

        if (!playerStats[playerId]) {
          playerStats[playerId] = {
            name: player.web_name,
            team: playerData.teams[player.team - 1].name,
            position: ["GKP", "DEF", "MID", "FWD"][player.element_type - 1],
            totalPointsActive: 0,
            gwInSquad: 0,
            starts: 0,
            cappedPoints: 0,
            playerPoints: 0
          };
        }

        const inStarting11 = pick.position <= 11;
        const isCaptain = pick.is_captain;

        playerStats[playerId].playerPoints += pointsThisWeek;

        if (inStarting11 || isBenchBoost) {
          let activePoints = pointsThisWeek;
          if (isCaptain) {
            activePoints *= isTripleCaptain ? 3 : 2;
            totalCaptaincyPoints += activePoints;
            playerStats[playerId].cappedPoints += activePoints;
          }

          playerStats[playerId].totalPointsActive += activePoints;
          totalPointsActive += activePoints;
          gwPoints += activePoints;

          const position = playerStats[playerId].position;
          if (!positionPoints[position][playerId]) {
            positionPoints[position][playerId] = {
              name: playerStats[playerId].name,
              points: 0
            };
          }
          positionPoints[position][playerId].points += activePoints;

          if (inStarting11) playerStats[playerId].starts += 1;
          playerStats[playerId].gwInSquad += 1;
        } else {
          totalPointsLostOnBench += pointsThisWeek;
        }
      }
      
      // Update weekly stats
      weeklyPoints[gw - 1] = gwPoints;
      const gwRank = historyData.current.find(h => h.event === gw)?.overall_rank || 0;
      weeklyRanks[gw - 1] = gwRank;
      
      // Update highest/lowest tracking
      if (gwPoints > highestPoints) {
        highestPoints = gwPoints;
        highestPointsGW = gw;
      }
      if (gwPoints < lowestPoints) {
        lowestPoints = gwPoints;
        lowestPointsGW = gw;
      }
      if (gwRank < highestRank) {
        highestRank = gwRank;
        highestRankGW = gw;
      }
      if (gwRank > lowestRank) {
        lowestRank = gwRank;
        lowestRankGW = gw;
      }
    }

    // Prepare the complete analysis object
    const analysis = {
      managerInfo: {
        name: `${managerEntryData.player_first_name} ${managerEntryData.player_last_name}`,
        teamName: managerEntryData.name,
        overallRanking: managerEntryData.summary_overall_rank?.toLocaleString() || "N/A",
        managerPoints: managerEntryData.summary_overall_points,
        allChipsUsed: historyData.chips.map(chip => chip.name).join(", ") || "None",
        lastSeasonRank: historyData.past.length > 0 ? historyData.past[historyData.past.length - 1].rank.toLocaleString() : "Didn't Play",
        seasonBeforeLastRank: historyData.past.length > 1 ? historyData.past[historyData.past.length - 2].rank.toLocaleString() : "Didn't Play",
        pointDifference: managerEntryData.summary_overall_points - topManagerPoints,
        totalPointsLostOnBench,
        totalCaptaincyPoints,
        currentGameweek,
        highestPoints,
        highestPointsGW,
        lowestPoints,
        lowestPointsGW,
        highestRank: highestRank.toLocaleString(),
        highestRankGW,
        lowestRank: lowestRank.toLocaleString(),
        lowestRankGW
      },
      playerStats: Object.values(playerStats).sort((a, b) => b.totalPointsActive - a.totalPointsActive),
      positionSummary: Object.entries(positionPoints).map(([position, players]) => ({
        position,
        totalPoints: Object.values(players).reduce((sum, player) => sum + player.points, 0),
        players: Object.values(players).sort((a, b) => b.points - a.points)
      })),
      weeklyPoints,
      weeklyRanks
    };

    res.json(analysis);
  } catch (error) {
    console.error('Error analyzing manager:', error);
    res.status(500).json({ error: 'Failed to analyze manager' });
  }
});

// New endpoint for fetching player statistics by position
app.get('/api/player-stats/:position', async (req, res) => {
  const { position } = req.params;

  try {
    const response = await axios.get('https://fantasy.premierleague.com/api/bootstrap-static/');
    const playerData = response.data.elements;

    // Filter players by position
    const positionMap = {
      'gkp': 1,
      'def': 2,
      'mid': 3,
      'fwd': 4
    };

    const filteredPlayers = playerData.filter(player => player.element_type === positionMap[position.toLowerCase()]);

    res.json(filteredPlayers);
  } catch (error) {
    console.error('Error fetching player statistics:', error);
    res.status(500).json({ error: 'Failed to fetch player statistics' });
  }
});

// Only listen if running directly (not in Vercel)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
}
