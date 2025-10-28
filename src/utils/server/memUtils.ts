import { logger } from '../../services/LoggerService.js';

export function checkMemoryUsage(){
    const used = process.memoryUsage();
    const heapUsedMB = Math.round(used.heapUsed / 1024 / 1024);
    const heapTotalMB = Math.round(used.heapTotal / 1024 / 1024);
    const rssMB = Math.round(used.rss / 1024 / 1024);

    logger.debug(`Memory usage: ${heapUsedMB}MB / ${heapTotalMB}MB (${rssMB}MB RSS)`);
}
