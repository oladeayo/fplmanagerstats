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

// Cache for bootstrap-static data to reduce API calls
let bootstrapCache = null;
let bootstrapCacheTime = null;
const CACHE_DURATION = 3600000; // 1 hour

async function getBootstrapData() {
  const now = Date.now();
  if (bootstrapCache && bootstrapCacheTime && (now - bootstrapCacheTime < CACHE_DURATION)) {
    return bootstrapCache;
  }

  const response = await axios.get('https://fantasy.premierleague.com/api/bootstrap-static/', {
    timeout: 10000 // 10 seconds timeout
  });
  bootstrapCache = response.data;
  bootstrapCacheTime = now;
  return bootstrapCache;
}

app.get('/api/analyze-manager/:managerId', async (req, res) => {
  try {
    const { managerId } = req.params;
    if (!managerId || isNaN(managerId)) {
      return res.status(400).json({ error: 'Invalid manager ID' });
    }

    const BATCH_SIZE = 5; // Process players in batches

    // Fetch initial data
    const [playerData, managerEntry, history] = await Promise.all([
      getBootstrapData(),
      axios.get(`https://fantasy.premierleague.com/api/entry/${managerId}/`),
      axios.get(`https://fantasy.premierleague.com/api/entry/${managerId}/history/`)
    ]);

    const managerEntryData = managerEntry.data;
    const historyData = history.data;
    const currentEvent = playerData.events.find(event => event.is_current);
    const currentGameweek = currentEvent ? currentEvent.id : Math.max(...historyData.current.map(h => h.event));

    // Initialize analysis data
    let analysis = {
      managerInfo: {
        name: `${managerEntryData.player_first_name} ${managerEntryData.player_last_name}`,
        teamName: managerEntryData.name,
        overallRanking: managerEntryData.summary_overall_rank?.toLocaleString() || "N/A",
        managerPoints: managerEntryData.summary_overall_points,
        allChipsUsed: historyData.chips.map(chip => chip.name).join(", ") || "None",
        lastSeasonRank: historyData.past.length > 0 ? historyData.past[historyData.past.length - 1].rank.toLocaleString() : "Didn't Play",
        seasonBeforeLastRank: historyData.past.length > 1 ? historyData.past[historyData.past.length - 2].rank.toLocaleString() : "Didn't Play",
        currentGameweek
      },
      playerStats: [],
      weeklyPoints: new Array(currentGameweek).fill(0),
      weeklyRanks: new Array(currentGameweek).fill(0),
      last5GWPerformance: [],
      upcomingFixtures: []
    };

    // Process gameweeks in reverse order (most recent first)
    const gameweeks = Array.from({ length: currentGameweek }, (_, i) => currentGameweek - i);
    const playerDataMap = new Map();

    // Process only last 5 gameweeks for detailed analysis
    const recentGameweeks = gameweeks.slice(0, 5);

    for (const gw of recentGameweeks) {
      const pickResponse = await axios.get(`https://fantasy.premierleague.com/api/entry/${managerId}/event/${gw}/picks/`);
      const picks = pickResponse.data.picks;

      // Process picks in batches
      for (let i = 0; i < picks.length; i += BATCH_SIZE) {
        const batchPicks = picks.slice(i, i + BATCH_SIZE);
        await Promise.all(batchPicks.map(async pick => {
          const playerId = pick.element;

          if (!playerDataMap.has(playerId)) {
            const player = playerData.elements.find(p => p.id === playerId);
            if (!player) return;

            try {
              const playerHistoryResponse = await axios.get(`https://fantasy.premierleague.com/api/element-summary/${playerId}/`, {
                timeout: 10000 // 10 seconds timeout
              });
              const playerHistory = playerHistoryResponse.data;

              playerDataMap.set(playerId, {
                player,
                history: playerHistory.history,
                fixtures: playerHistory.fixtures.slice(0, 5).map(fixture => ({
                  opponent: playerData.teams.find(t => t.id === (fixture.is_home ? fixture.team_a : fixture.team_h)).short_name,
                  difficulty: fixture.difficulty
                }))
              });
            } catch (error) {
              console.error(`Error fetching player ${playerId} data:`, error.message);
            }
          }

          const playerData = playerDataMap.get(playerId);
          if (!playerData) return;

          // Update player stats
          const existingStats = analysis.playerStats.find(p => p.id === playerId);
          if (!existingStats) {
            analysis.playerStats.push({
              id: playerId,
              name: playerData.player.web_name,
              team: playerData.player.team,
              position: ["GKP", "DEF", "MID", "FWD"][playerData.player.element_type - 1],
              totalPoints: 0,
              gamesPlayed: 0,
              last5Points: []
            });
          }
        }));
      }
    }

    // Calculate last 5 GW performance and upcoming fixtures
    for (const [playerId, data] of playerDataMap) {
      const last5Points = data.history
        .filter(h => h.round > currentGameweek - 5 && h.round <= currentGameweek)
        .map(h => h.total_points);

      analysis.last5GWPerformance.push({
        name: data.player.web_name,
        gamesPlayed: last5Points.length,
        totalPoints: last5Points.reduce((a, b) => a + b, 0)
      });

      analysis.upcomingFixtures.push({
        id: playerId,
        name: data.player.web_name,
        fixtures: data.fixtures
      });
    }

    // Sort players by total points
    analysis.playerStats.sort((a, b) => b.totalPoints - a.totalPoints);

    res.json(analysis);
  } catch (error) {
    console.error('Error analyzing manager:', error.message);
    res.status(500).json({ 
      error: 'Failed to analyze manager', 
      details: error.response?.data || error.message 
    });
  }
});

// Add endpoint for player images with error handling
app.get('/api/player-image/:playerId', async (req, res) => {
  try {
    const { playerId } = req.params;
    const response = await axios.get(
      `https://resources.premierleague.com/premierleague/photos/players/110x140/p${playerId}.png`,
      { 
        responseType: 'stream',
        timeout: 5000 // 5 seconds timeout
      }
    );
    response.data.pipe(res);
  } catch (error) {
    console.error(`Error fetching player image for ${playerId}:`, error.message);
    res.status(404).sendFile(path.join(__dirname, '../public/player-placeholder.png'));
  }
});

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'healthy' });
});

module.exports = app;

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
  });
});
