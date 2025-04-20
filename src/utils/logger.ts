// Simple logger utility
console.log("current mode", process.env.MODE) 
const logger = {
  info: (message: string, ...args: any[]) => {
    console.log(`[INFO] ${message}`, ...args);
  },
  warn: (message: string, ...args: any[]) => {
    console.warn(`[WARN] ${message}`, ...args);
  },
  error: (message: string, ...args: any[]) => {
    console.error(`[ERROR] ${message}`, ...args);
  },
  debug: (message: string, ...args: any[]) => {
    if (process.env.NODE_ENV !== 'production' || process.env.MODE === 'debug') {
      console.debug(`[DEBUG] ${message}`, ...args);
    }
  }
};

export { logger }; 