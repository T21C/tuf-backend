import express, {Request, Response, Router} from 'express';
import {loadPfpList, readJsonFile} from '../utils/fileHandlers.js';
import {PATHS} from '../config/constants.js';
import {decodeFromBase32} from '../utils/encodingHelpers.js';
import {
  updateTimestamp,
  levelUpdateTime,
  updateTimeList,
  getPlayer,
} from '../utils/updateHelpers.js';
import fs from 'fs';
import path from 'path';
import {exec} from 'child_process';

const router: Router = express.Router();

router.get('/', async (req: Request, res: Response) => {
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

  

  try {
    //console.log(updateTimeList);

    if (
      !updateTimeList[player as string] ||
      updateTimeList[player as string] < levelUpdateTime
    ) {
      await getPlayer(player as string, plrPath);
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
