import express from 'express';
import {loadPfpList, readJsonFile} from '../utils/fileHandlers.js';
import {PATHS} from '../config/constants.js';
import {decodeFromBase32} from '../utils/encodingHelpers.js';
import {
  updateTimestamp,
  levelUpdateTime,
  updateTimeList,
} from '../utils/updateHelpers.js';
import fs from 'fs';
import path from 'path';
import {exec} from 'child_process';

const router = express.Router();

router.get('/', async (req, res) => {
  const {player = 'V0W4N'} = req.query;
  const plrPath = path.join(PATHS.playerFolder, `${player}.json`);
  const pfpList = loadPfpList();
  const rankList = readJsonFile(PATHS.rankListJson);
  console.log(plrPath);

  await new Promise((resolve, reject) => {
    fs.mkdir(PATHS.playerFolder, {recursive: true}, err => {
      if (err) {
        console.error('Error creating directory:', err);
        reject(err);
      } else {
        resolve(void 0);
      }
    });
  });

  const getPlayer = () => {
    console.log('decoded', decodeFromBase32(player as string));
    return new Promise((resolve, reject) => {
      exec(
        `python ./parser_module/executable.py player "${decodeFromBase32(player as string)}" --output="${plrPath}" --showCharts --useSaved`,
        (error, stdout, stderr) => {
          if (error) {
            console.error(`Error executing for all_players: ${error.message}`);
            reject(error);
            return;
          }
          if (stderr) {
            console.error(`Script stderr: ${stderr}`);
            reject(new Error(stderr));
            return;
          }
          console.log(`Script output: ${stdout}`);
          resolve(stdout);
        },
      );
    });
  };

  try {
    //console.log(updateTimeList);

    if (
      !updateTimeList[player as string] ||
      updateTimeList[player as string] < levelUpdateTime
    ) {
      await getPlayer();
      updateTimestamp(player as string);
      console.log(
        'updating',
        player,
        'with timestamp',
        updateTimeList[player as string],
      );
    } else {
      //console.log("using recent save for player", player);
    }

    const result = readJsonFile(plrPath); // Ensure this function is handled correctly

    result.pfp = pfpList[result.player];
    result.ranks = rankList[result.player];
    res.json(result);
  } catch (err) {
    console.error('Error retrieving player data:', err);
    res.status(500).json({error: 'Error retrieving player data'});
  }
});

export default router;
