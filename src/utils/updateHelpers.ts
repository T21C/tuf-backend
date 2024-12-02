import {readJsonFile, writeJsonFile} from './fileHandlers.js';
import {PATHS} from '../config/constants.js';
import {exec} from 'child_process';
import {loadPfpList, savePfpList} from './fileHandlers.js';
import {getPfpUrl} from './pfpResolver.js';
import axios from 'axios';
import { decodeFromBase32 } from './encodingHelpers.js';
import Level from '../models/Level.js';
import Player from '../models/Player.js';
import Pass from '../models/Pass.js';

export let levelUpdateTime = 0; // Initialize with 0 or another default value
export const updateTimeList: Record<string, number> = {};

const parserPath = './src/parser_module/executable.py';

const RELOAD_COOLDOWN = 3000; // 30 seconds in milliseconds
let lastPassesReloadTime = 0;

export const getPlayer = (player: string, plrPath: string) => {
  return new Promise((resolve, reject) => {
    exec(
      `python ${parserPath} player "${decodeFromBase32(player)}" --output="${plrPath}" --showCharts --useSaved`,
      (error, stdout, stderr) => {
        if (error) {
          console.error(`[UPDATE] Error executing for player: ${error.message}`);
          reject(error);
          return;
        }
        if (stderr) {
          console.error(`[UPDATE] Script stderr: ${stderr}`);
          reject(new Error(stderr));
          return;
        }
        console.log(`[UPDATE] Script output: ${stdout}`);
        resolve(stdout);
      },
    );
  });
};


export const updateRanks = () => {
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
  console.log("[UPDATE] Ranks updated");
};


export const reloadPasses = async () => {
  const currentTime = Date.now();
  
  // Check if enough time has passed since last reload
  if (currentTime - lastPassesReloadTime < RELOAD_COOLDOWN) {
    console.log(`[UPDATE] Skipping passes reload - cooldown active. Please wait ${Math.ceil((RELOAD_COOLDOWN - (currentTime - lastPassesReloadTime)) / 1000)} seconds.`);
    return;
  }

  lastPassesReloadTime = currentTime;

  exec(
    `python ${parserPath} all_clears --output=${PATHS.clearlistJson} --useSaved --reverse`,
    (error, stdout, stderr) => {
      if (error) {
        console.error(
          `[UPDATE] Error executing script for all_clears: ${error.message}`,
        );
        return;
      }
      if (stderr) {
        console.error(`[UPDATE] Clear list stderr: ${stderr}`);
        return;
      }
      console.log("[UPDATE] Passes updated");
    },
  );
  updateTimeList['passes'] = currentTime;
};

export const getPassesReloadCooldown = (): number => {
  const timeLeft = RELOAD_COOLDOWN - (Date.now() - lastPassesReloadTime);
  return Math.max(0, timeLeft);
};

export const updateData = async (cacheUpdate: boolean = true) => {
  if (cacheUpdate) {
    await updateCache()
  }

  await exec(
    `python ${parserPath} all_players --output=${PATHS.playerlistJson} --reverse --useSaved`,
    async (error, stdout, stderr) => {
      if (error) {
        console.error(`Error executing for all_players: ${error.message}`);
        return;
      }
      if (stderr) {
        console.error(`Script stderr: ${stderr}`);
        return;
      }
      console.log("[UPDATE] Leaderboard updated");
      
      reloadPasses();
      updateRanks(),
      fetchPfps()
        
    },
  );

};

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
  console.log("[UPDATE] Pfp list updated");
  //console.log("new list:", pfpListTemp)
};


export const updateTimestamp = (name: string) => {
  updateTimeList[name] = Date.now();
};

export const updateCache = async () => {
  try {
    
    // Fetch data from MongoDB
    const chartsData = await Level.find({}).lean();
    const playersData = await Player.find({}).lean();
    const passesData = await Pass.find({}).lean();

    // Save to cache files
    writeJsonFile(PATHS.chartsJson, chartsData);
    writeJsonFile(PATHS.playersJson, playersData);
    writeJsonFile(PATHS.passesJson, passesData);
    
    levelUpdateTime = Date.now();
    updateTimeList['cache'] = Date.now();
    
    console.log("[UPDATE] Cache updated successfully");
  } catch (error) {
    console.error('Error updating cache:', error);
  }
};
