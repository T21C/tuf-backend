import fs from 'fs';
import {PATHS} from '../config/constants';

export const loadPfpList = () => {
  if (fs.existsSync(PATHS.pfpListJson)) {
    const data = fs.readFileSync(PATHS.pfpListJson, 'utf-8');
    return JSON.parse(data);
  }
  return {}; // Return an empty object if the file does not exist
};

export const savePfpList = (pfpList: Record<string, string>) => {
  fs.writeFileSync(
    PATHS.pfpListJson,
    JSON.stringify(pfpList, null, 2),
    'utf-8',
  );
};

export const readJsonFile = (path: string) => {
  try {
    const data = fs.readFileSync(path, 'utf-8');
    return JSON.parse(data);
  } catch (error) {
    console.error('Error reading JSON file:', error);
    return {}; // Return empty object on error
  }
};

export const writeJsonFile = (path: string, data: Record<string, any>) => {
  fs.writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8');
};
