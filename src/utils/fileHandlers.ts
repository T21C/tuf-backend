import fs from 'fs';
import {PATHS} from '../config/constants';

export const loadPfpList = () => {
  try{
    if (fs.existsSync(PATHS.pfpListJson)) {
      const data = fs.readFileSync(PATHS.pfpListJson, 'utf-8');
    return JSON.parse(data);
    }
    return {}; // Return an empty object if the file does not exist
  } catch (error) {
    console.error(`[FILE HANDLER] Error loading pfp list: ${error}`);
    return {}; // Return an empty object on error
  }
};

export const savePfpList = (pfpList: Record<string, string>) => {
  try{
    fs.writeFileSync(
      PATHS.pfpListJson,
    JSON.stringify(pfpList, null, 2),
    'utf-8',
    );
  } catch (error) {
    console.error(`[FILE HANDLER] Error saving pfp list: ${error}`);
  }
};

export const readJsonFile = (path: string) => {
  try {
    const data = fs.readFileSync(path, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`[FILE HANDLER] Error reading JSON file: ${error}`);
    return {}; // Return empty object on error
  }
};

export const writeJsonFile = (path: string, data: Record<string, any>) => {
  try{
    fs.writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
  } catch (error) {
    console.error(`[FILE HANDLER] Error writing JSON file: ${error}`);
  }
};
