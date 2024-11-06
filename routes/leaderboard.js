import express from 'express';
import { loadPfpList, readJsonFile } from '../utils/fileHandlers.js';
import { PATHS } from '../config/constants.js';
import { decodeFromBase32 } from '../utils/encodingHelpers.js';
import { updateTimestamp, levelUpdateTime } from '../utils/updateHelpers.js';
import { validSortOptions } from '../config/constants.js';

const router = express.Router();

// ... existing imports for loadPfpList, readJsonFile, playerlistJson, validSortOptions ...

router.get('/', async (req, res) => {
    const { sortBy = 'rankedScore', order = 'desc', includeAllScores = 'false' } = req.query;
  
    const pfpList = loadPfpList() 
    if (!validSortOptions.includes(sortBy)) {
      return res.status(400).json({ error: `Invalid sortBy option. Valid options are: ${validSortOptions.join(', ')}` });
    }
    // Read JSON data
    const leaderboardData = readJsonFile(PATHS.playerlistJson);
  
    if (!Array.isArray(leaderboardData)) {
      return res.status(500).json({ error: 'Invalid leaderboard data' });
    }
  
    // Sorting logic
    const sortedData = leaderboardData.sort((a, b) => {
      const valueA = a[sortBy];
      const valueB = b[sortBy];
  
      // Handle cases where fields might be missing or invalid
      if (valueA === undefined || valueB === undefined) {
        return 0;
      }
  
      if (order === 'asc') {
        return valueA > valueB ? 1 : -1;
      } else {
        return valueA < valueB ? 1 : -1;
      }
    });
  
  
  
    const responseData = sortedData.map(player => {
      player.pfp= pfpList[player.player]
  
      if (includeAllScores === 'false' && player.allScores) {
        const { allScores, ...rest } = player;
  
        return rest;
        }
      
      
      return player;
    });
  
    // Send the sorted data as response
    res.json(responseData);
  });
  
export default router;
  