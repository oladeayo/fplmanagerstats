const express = require('express');
const path = require('path');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname, '../public')));
app.use(express.json());

// Proxy FPL API requests to avoid CORS issues
app.get('/api/bootstrap-static', async (req, res) => {
  try {
    const response = await axios.get('https://fantasy.premierleague.com/api/bootstrap-static/');
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch bootstrap static data' });
  }
});

app.get('/api/entry/:managerId', async (req, res) => {
  try {
    const { managerId } = req.params;
    const managerEntryResponse = await axios.get(`https://fantasy.premierleague.com/api/entry/${managerId}/`);
    res.json(managerEntryResponse.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch manager entry data' });
  }
});

app.get('/api/entry/:managerId/history', async (req, res) => {
  try {
    const { managerId } = req.params;
    const historyResponse = await axios.get(`https://fantasy.premierleague.com/api/entry/${managerId}/history/`);
    res.json(historyResponse.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch manager history' });
  }
});

app.get('/api/entry/:managerId/event/:gameweek/picks', async (req, res) => {
  try {
    const { managerId, gameweek } = req.params;
    const picksResponse = await axios.get(`https://fantasy.premierleague.com/api/entry/${managerId}/event/${gameweek}/picks/`);
    res.json(picksResponse.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch manager picks' });
  }
});

app.get('/api/element-summary/:playerId', async (req, res) => {
  try {
    const { playerId } = req.params;
    const playerSummaryResponse = await axios.get(`https://fantasy.premierleague.com/api/element-summary/${playerId}/`);
    res.json(playerSummaryResponse.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch player summary' });
  }
});

app.get('/api/leagues-classic/:leagueId/standings', async (req, res) => {
  try {
    const { leagueId } = req.params;
    const leagueResponse = await axios.get(`https://fantasy.premierleague.com/api/leagues-classic/${leagueId}/standings/`);
    res.json(leagueResponse.data);
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch league standings' });
  }
});

app.get('/api/analyze-manager/:managerId', async (req, res) => {
  try {
    const { managerId } = req.params;
    
    // Fetch bootstrap static data
    const playerDataResponse = await axios.get('https://fantasy.premierleague.com/api/bootstrap-static/');
    const playerData = playerDataResponse.data;

    const currentGameweek = playerData.events.find(event => event.is_current).id;

    // Fetch manager entry data
    const managerEntryResponse = await axios.get(`https://fantasy.premierleague.com/api/entry/${managerId}/`);
    const managerEntryData = managerEntryResponse.data;

    // Fetch manager history
    const historyResponse = await axios.get(`https://fantasy.premierleague.com/api/entry/${managerId}/history/`);
    const historyData = historyResponse.data;

    // Prepare analysis data structure
    const analysis = {
      managerInfo: {
        name: `${managerEntryData.player_first_name} ${managerEntryData.player_last_name}`,
        teamName: managerEntryData.name,
        overallRanking: managerEntryData.summary_overall_rank || "N/A",
        managerPoints: managerEntryData.summary_overall_points,
        allChipsUsed: historyData.chips.map(chip => chip.name).join(", ") || "None",
        lastSeasonRank: historyData.past.length > 0 ? historyData.past[historyData.past.length - 1].rank : "Didn't Play",
        seasonBeforeLastRank: historyData.past.length > 1 ? historyData.past[historyData.past.length - 2].rank : "Didn't Play"
      },
      playerStats: {}
    };

    // Analyze player performance across gameweeks
    for (let gw = 1; gw <= currentGameweek; gw++) {
      const managerPicksResponse = await axios.get(`https://fantasy.premierleague.com/api/entry/${managerId}/event/${gw}/picks/`);
      const managerPicksData = managerPicksResponse.data;
      const managerPicks = managerPicksData.picks;

      const isBenchBoost = managerPicksData.active_chip === "bboost";
      const isTripleCaptain = managerPicksData.active_chip === "3xc";

      managerPicks.forEach((pick, index) => {
        const playerId = pick.element;
        const player = playerData.elements.find(p => p.id == playerId);
        if (!player) return;

        // Fetch individual player history
        const playerHistoryResponse = await axios.get(`https://fantasy.premierleague.com/api/element-summary/${playerId}/`);
        const playerHistory = playerHistoryResponse.data.history;

        const gameweekHistory = playerHistory.find(history => history.round === gw);
        const pointsThisWeek = gameweekHistory ? gameweekHistory.total_points : 0;

        // Initialize player stats if not exists
        if (!analysis.playerStats[playerId]) {
          analysis.playerStats[playerId] = {
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

        const playerStat = analysis.playerStats[playerId];
        const inStarting11 = index < 11;

        // Update player stats
        playerStat.playerPoints += pointsThisWeek;
        
        if (inStarting11 || isBenchBoost) {
          let activePoints = pointsThisWeek;
          if (pick.is_captain) {
            activePoints *= isTripleCaptain ? 3 : 2;
            playerStat.cappedPoints += activePoints;
          }

          playerStat.totalPointsActive += activePoints;
          
          if (inStarting11) playerStat.starts += 1;
          playerStat.gwInSquad += 1;
        }
      });
    }

    // Convert player stats to sorted array
    analysis.sortedPlayers = Object.values(analysis.playerStats)
      .sort((a, b) => b.totalPointsActive - a.totalPointsActive);

    res.json(analysis);
  } catch (error) {
    console.error('Error analyzing manager:', error);
    res.status(500).json({ error: 'Failed to analyze manager' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});