import { readJsonFile, writeJsonFile } from './fileHandlers';
import { PATHS } from '../config/constants';

interface CacheStore {
  passes: any[];
  players: any[];
  clearList: any[];
  pfpList: { [key: string]: string };
  charts: any[];
  fullPlayerList: any[];
  rankList: { [key: string]: any };
}

class CacheManager {
  private static instance: CacheManager;
  private cache: CacheStore = {
    passes: [],
    players: [],
    clearList: [],
    pfpList: {},
    charts: [],
    fullPlayerList: [],
    rankList: {}
  };

  private constructor() {
    this.reloadAll();
  }

  public static getInstance(): CacheManager {
    if (!CacheManager.instance) {
      CacheManager.instance = new CacheManager();
    }
    return CacheManager.instance;
  }

  public get(key: keyof CacheStore): any {
    return this.cache[key];
  }

  public async set(key: keyof CacheStore, data: any): Promise<void> {
    this.cache[key] = data;
    // If there's a corresponding path in PATHS, write to file
    const pathKey = `${key}Json` as keyof typeof PATHS;
    if (PATHS[pathKey]) {
      await writeJsonFile(PATHS[pathKey], data);
    }
  }

  public async reloadAll(): Promise<void> {
    this.cache = {
      passes: readJsonFile(PATHS.passesJson),
      players: readJsonFile(PATHS.playersJson),
      clearList: readJsonFile(PATHS.clearlistJson),
      pfpList: readJsonFile(PATHS.pfpListJson),
      charts: readJsonFile(PATHS.chartsJson),
      fullPlayerList: readJsonFile(PATHS.playerlistJson),
      rankList: readJsonFile(PATHS.rankListJson)
    };
    console.log('[Cache] All caches reloaded');
  }

  public async reloadSpecific(key: keyof CacheStore): Promise<void> {
    const pathKey = `${key}Json` as keyof typeof PATHS;
    if (PATHS[pathKey]) {
      this.cache[key] = readJsonFile(PATHS[pathKey]);
      console.log(`[Cache] ${key} cache reloaded`);
    }
  }
}

export const Cache = CacheManager.getInstance(); 