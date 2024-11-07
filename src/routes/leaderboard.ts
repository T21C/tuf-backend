import express from 'express';
import {loadPfpList, readJsonFile} from '../utils/fileHandlers.js';
import {PATHS} from '../config/constants.js';
import {validSortOptions} from '../config/constants.js';

const router = express.Router();

router.get('/', (req, res) => {
  const {
    sortBy = 'rankedScore',
    order = 'desc',
    includeAllScores = 'false',
  } = req.query;
  const pfpList = loadPfpList();
  if (!validSortOptions.includes(sortBy as string)) {
    return res.status(400).json({
      error: `Invalid sortBy option. Valid options are: ${validSortOptions.join(', ')}`,
    });
  }
  // Read JSON data
  const leaderboardData = readJsonFile(PATHS.playerlistJson);

  if (!Array.isArray(leaderboardData)) {
    return res.status(500).json({error: 'Invalid leaderboard data'});
  }

  // Sorting logic
  const sortedData = leaderboardData.sort((a, b) => {
    const valueA = a[sortBy as keyof typeof a];
    const valueB = b[sortBy as keyof typeof b];

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
    player.pfp = pfpList[player.player];

    if (includeAllScores === 'false' && player.allScores) {
      const {allScores, ...rest} = player;

      return rest;
    }

    return player;
  });

  // Send the sorted data as response
  return res.json(responseData);
});

export default router;
