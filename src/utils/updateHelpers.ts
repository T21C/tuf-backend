import {readJsonFile, writeJsonFile} from './fileHandlers.js';
import {PATHS, EXCLUDE_CLEARLIST} from '../config/constants.js';
import {exec} from 'child_process';
import {loadPfpList, savePfpList} from './fileHandlers.js';
import {getPfpUrl} from './pfpResolver.js';
import axios from 'axios';

export let levelUpdateTime = 0; // Initialize with 0 or another default value
export const updateTimeList: Record<string, number> = {};

export const updateRanks = () => {
  console.log('updating ranks');
  const players = readJsonFile(PATHS.playerlistJson);
  // Example list of player objects
  // Parameters to sort by
  const sortParameters = [
    'rankedScore',
    'generalScore',
    'ppScore',
    'wfScore',
    '12kScore',
    'avgXacc',
    'totalPasses',
    'universalPasses',
    'WFPasses',
  ];

  // Initialize the rank dictionary
  const rankPositions: Record<string, Record<string, number>> = {};

  // Initialize each player in the rankPositions dictionary
  players.forEach((player: any) => {
    rankPositions[player.player] = {};
  });

  // Populate the ranks for each parameter
  sortParameters.forEach(param => {
    // Sort the players based on the current parameter in descending order
    const sortedPlayers = [...players].sort((a, b) => b[param] - a[param]);

    // Assign rank positions for each player based on the sorted order
    sortedPlayers.forEach((player, index) => {
      const playerName = player.player;
      rankPositions[playerName][param] = index + 1; // Store rank (1-based)
    });
  });
  writeJsonFile(PATHS.rankListJson, rankPositions);
};

export const updateData = () => {
  //fetchRatings()
  console.log('starting execution');
  exec(
    `python ./parser_module/executable.py all_players --output=${PATHS.playerlistJson} --reverse`,
    async (error, stdout, stderr) => {
      if (error) {
        console.error(`Error executing for all_players: ${error.message}`);
        return;
      }
      if (stderr) {
        console.error(`Script stderr: ${stderr}`);
        return;
      }
      console.log(`Script output:\n${stdout}`);
      levelUpdateTime = Date.now();
      updateRanks();
      await fetchPfps();
      if (!EXCLUDE_CLEARLIST) {
        console.log('starting all_clears');
        exec(
          `python ./parser_module/executable.py all_clears --output=${PATHS.clearlistJson} --useSaved`,
          (error, stdout, stderr) => {
            if (error) {
              console.error(
                `Error executing script for all_clears: ${error.message}`,
              );
              return;
            }
            if (stderr) {
              console.error(`Script stderr: ${stderr}`);
              return;
            }
            console.log(`Script output: ${stdout}`);
          },
        );
      }
    },
  );
};
const intervalMilliseconds = 600000; // every 10 minutes
setInterval(updateData, intervalMilliseconds);

export const fetchPfps = async () => {
  const playerlist = readJsonFile(PATHS.playerlistJson);
  const pfpListTemp = loadPfpList();
  //console.log("playerlist length:" , Object.keys(playerlist).length);

  //get first 30 for testing
  //for (const player of playerlist.slice(0, 50)) {
  for (const player of playerlist) {
    if (Object.keys(pfpListTemp).includes(player.player)) {
      continue;
    }
    console.log('new player:', player.player);
    if (player.allScores) {
      for (const score of player.allScores.slice(0, 15)) {
        if (score.vidLink) {
          const videoDetails = await getPfpUrl(score.vidLink);

          // Check if the videoDetails contain the needed data
          if (videoDetails) {
            pfpListTemp[player.player] = videoDetails; // Store the name and link in the object
            //console.log(`Fetched pfp for ${player}: ${videoDetails}`);
            break; // Stop after finding the first valid video detail
          } else {
            pfpListTemp[player.player] = null;
          }
        }
      }
    }
  }
  savePfpList(pfpListTemp);
  //console.log("new list:", pfpListTemp)
};

export const fetchRatings = async () => {
  const response = await axios.get(process.env.RATING_SCRIPT_URL!);
  const ratingList = response.data;
  writeJsonFile(PATHS.ratingListJson, ratingList);
};

export const updateTimestamp = (name: string) => {
  updateTimeList[name] = Date.now();
};

export const syncJsonToSheet = async () => {
  try {
    console.log('Starting sync to Google Sheet...');

    // Read current ratings
    const ratingList = readJsonFile(PATHS.ratingListJson);

    console.log(
      'sending ',
      JSON.stringify({
        ratings: ratingList,
        timestamp: new Date().toISOString(),
      }),
    );
    const response = await axios.post(process.env.RATING_SCRIPT_URL!, {
      ratings: ratingList,
      timestamp: new Date().toISOString(),
    });

    if (response.status !== 200) {
      throw new Error('Failed to sync with spreadsheet');
    }

    const result = response.data;
    console.log('Sync completed:', result.message);
  } catch (error) {
    console.error('Error syncing to Google Sheet:', error);
  }
};
