import { NextFunction, Request, Response } from 'express';
import { logger } from '../services/LoggerService.js';
import { Op } from 'sequelize';
import { RateLimit } from '../models/index.js';
import { RateLimitCreationAttributes } from '../models/auth/RateLimit.js';

export interface RateLimiterConfig {
  windowMs: number;
  maxAttempts: number;
  blockDuration: number;
  type: string;
  incrementOnFailure?: boolean;
  incrementOnSuccess?: boolean;
}

export function RateLimiter(config: RateLimiterConfig) {
  const { incrementOnFailure = true, incrementOnSuccess = false } = config;

  return function (
    target: any,
    propertyKey: string,
    descriptor: PropertyDescriptor
  ) {
    const originalMethod = descriptor.value;

    descriptor.value = async function (req: Request, res: Response) {
      // Get client IP
      const forwardedFor = req.headers['x-forwarded-for'];
      const ip = typeof forwardedFor === 'string' 
        ? forwardedFor.split(',')[0].trim() 
        : req.ip || req.connection.remoteAddress || '127.0.0.1';

      try {
        // Check if IP is blocked BEFORE processing the request
        const { blocked, retryAfter } = await isBlocked(ip, config);
        if (blocked) {
          logger.debug(`Request blocked for IP ${ip} due to ${config.type} rate limiting. Retry after: ${retryAfter}ms`);
          return res.status(429).json({
            message: 'Too many attempts. Please try again later.',
            retryAfter,
          });
        }

        // Execute the original method
        const result = await originalMethod.apply(this, [req, res]);

        // Check if the response indicates success (2xx status code)
        const isSuccess = res.statusCode >= 200 && res.statusCode < 300;

        // Increment based on success/failure and configuration
        if (isSuccess && incrementOnSuccess) {
          await increment(ip, config);
          logger.debug(`Incremented rate limit for successful ${config.type} attempt from IP ${ip}`);
        } else if (!isSuccess && incrementOnFailure) {
          await increment(ip, config);
          logger.debug(`Incremented rate limit for failed ${config.type} attempt from IP ${ip}`);
        }

        return result;
      } catch (error) {
        // If incrementOnFailure is true, increment on error
        if (incrementOnFailure) {
          try {
            await increment(ip, config);
            logger.debug(`Incremented rate limit for error ${config.type} from IP ${ip}`);
          } catch (incrementError) {
            logger.error(`Failed to increment ${config.type} rate limit:`, incrementError);
          }
        }

        // Re-throw the original error
        throw error;
      }
    };

    return descriptor;
  };
}

// Helper functions
async function isBlocked(ip: string, config: RateLimiterConfig) {
  try {
    const blockedRecord = await RateLimit.findOne({
      where: {
        ip,
        type: config.type,
        blocked: true,
        blockedUntil: {
          [Op.gt]: new Date()
        }
      }
    });
    
    if (blockedRecord) {
      return {
        blocked: true,
        retryAfter: Math.ceil((blockedRecord.blockedUntil!.getTime() - Date.now()))
      };
    }
    
    return { blocked: false, retryAfter: 0 };
  } catch (error) {
    logger.error('Rate limiter isBlocked error:', error);
    return { blocked: false, retryAfter: 0 };
  }
}

// Helper function to clean up expired rate limits
async function cleanupExpiredRateLimits(ip: string, type: string) {
  try {
    const now = new Date();
    const deletedCount = await RateLimit.destroy({
      where: {
        ip,
        type,
        windowEnd: {
          [Op.lte]: now
        },
        blocked: false // Only delete non-blocked expired records
      }
    });
    
    if (deletedCount > 0) {
      logger.debug(`Cleaned up ${deletedCount} expired rate limit records for IP ${ip}, type ${type}`);
    }
  } catch (error) {
    logger.error('Error cleaning up expired rate limits:', error);
  }
}

async function increment(ip: string, config: RateLimiterConfig) {
  try {
    const now = new Date();
    const windowEnd = new Date(now.getTime() + config.windowMs);
    
    let rateLimit = await RateLimit.findOne({
      where: {
        ip,
        type: config.type,
        windowEnd: {
          [Op.gt]: now
        }
      },
      order: [['windowEnd', 'DESC']]
    });

    if (!rateLimit) {
      // Clean up expired rate limits for this IP and type before creating new one
      await cleanupExpiredRateLimits(ip, config.type);
      
      rateLimit = await RateLimit.create({
        ip,
        type: config.type,
        attempts: 1,
        windowStart: now,
        windowEnd,
      } as RateLimitCreationAttributes);
    } else {
      await rateLimit.increment('attempts');
      await rateLimit.reload();
    }

    // Check if limit exceeded
    if (rateLimit.attempts > config.maxAttempts) {
      const blockedUntil = new Date(now.getTime() + config.blockDuration);
      await rateLimit.update({
        blocked: true,
        blockedUntil
      });
      
      logger.debug(`IP ${ip} blocked for exceeding ${config.type} limit`);
      return true;
    }

    return false;
  } catch (error) {
    logger.error('Rate limiter increment error:', error);
    return false;
  }
}

interface RateLimitConfig {
  windowMs: number;      // Time window in milliseconds
  maxAttempts: number;   // Maximum number of attempts allowed in the window
  blockDuration: number; // Duration to block IP if limit exceeded (in milliseconds)
  type: string;          // Type of rate limit (e.g., 'registration', 'login')
}

const defaultConfig: RateLimitConfig = {
  windowMs: 24 * 60 * 60 * 1000, // 24 hours
  maxAttempts: 3,                // 3 attempts per 24 hours
  blockDuration: 7 * 24 * 60 * 60 * 1000, // 7 days block
  type: 'default'
};

export const createRateLimiter = (config: Partial<RateLimitConfig> = {}) => {
  const { windowMs, maxAttempts, blockDuration, type = 'default' } = { ...defaultConfig, ...config };

  return {
    // Middleware version for general rate limiting
    middleware: async (req: Request, res: Response, next: NextFunction) => {
      const forwardedFor = req.headers['x-forwarded-for'];
      const ip = typeof forwardedFor === 'string' 
        ? forwardedFor.split(',')[0].trim() 
        : req.ip || req.connection.remoteAddress || '127.0.0.1';
      
      logger.debug(`Rate limiter IP: ${ip}`);
      try {
        // Check if IP is blocked
        const blockedRecord = await RateLimit.findOne({
          where: {
            ip,
            type,
            blocked: true,
            blockedUntil: {
              [Op.gt]: new Date()
            }
          }
        });

        if (blockedRecord) {
          const remainingBlockTime = Math.ceil((blockedRecord.blockedUntil!.getTime() - Date.now()));
          return res.status(429).json({
            message: 'Too many attempts. Please try again later.',
            retryAfter: remainingBlockTime,
          });
        }

        // Find or create rate limit record
        const now = new Date();
        const windowEnd = new Date(now.getTime() + windowMs);
        
        // Find active record for this IP and type
        let rateLimit = await RateLimit.findOne({
          where: {
            ip,
            type,
            windowEnd: {
              [Op.gt]: now
            }
          },
          order: [['windowEnd', 'DESC']] // Get the most recent one if multiple exist
        });

        // If no active record exists, create a new one
        if (!rateLimit) {
          // Clean up expired rate limits for this IP and type before creating new one
          await cleanupExpiredRateLimits(ip, type);
          
          try {
            rateLimit = await RateLimit.create({
              ip,
              type,
              attempts: 1,
              windowStart: now,
              windowEnd,
            } as RateLimitCreationAttributes);
          } catch (error) {
            // If creation fails due to race condition, try to find the record again
            logger.warn(`Race condition in rate limiter creation for IP ${ip}, retrying find`);
            rateLimit = await RateLimit.findOne({
              where: {
                ip,
                type,
                windowEnd: {
                  [Op.gt]: now
                }
              },
              order: [['windowEnd', 'DESC']]
            });
            
            // If still no record, increment attempts on the most recent record
            if (!rateLimit) {
              const mostRecent = await RateLimit.findOne({
                where: { ip, type },
                order: [['windowEnd', 'DESC']]
              });
              
              if (mostRecent) {
                await mostRecent.increment('attempts');
                await mostRecent.reload();
                rateLimit = mostRecent;
              } else {
                // Last resort - create with a slightly different window end to avoid conflicts
                const adjustedWindowEnd = new Date(now.getTime() + windowMs + 1000);
                rateLimit = await RateLimit.create({
                  ip,
                  type,
                  attempts: 1,
                  windowStart: now,
                  windowEnd: adjustedWindowEnd,
                } as RateLimitCreationAttributes);
              }
            }
          }
        } else {
          // Increment attempts for existing record
          await rateLimit.increment('attempts');
          await rateLimit.reload();
        }

        // Check if limit exceeded
        if (rateLimit.attempts > maxAttempts) {
          // Block the IP
          const blockedUntil = new Date(now.getTime() + blockDuration);
          await rateLimit.update({
            blocked: true,
            blockedUntil
          });
          
          logger.debug(`IP ${ip} blocked for exceeding ${type} limit`);
          logger.debug(`Body: ${JSON.stringify(req.body)}`);
          
          return res.status(429).json({
            message: 'Rate limit exceeded. IP address blocked.',
            retryAfter: blockDuration,
          });
        }

        // Add rate limit info to response headers
        res.setHeader('X-RateLimit-Limit', maxAttempts);
        res.setHeader('X-RateLimit-Remaining', Math.max(0, maxAttempts - rateLimit.attempts));
        
        return next();
      } catch (error) {
        logger.error('Rate limiter error:', error);
        // On error, allow the request but log the error
        return next();
      }
    },

    // Function to increment rate limit for an IP
    increment: async (ip: string) => {
      try {
        const now = new Date();
        const windowEnd = new Date(now.getTime() + windowMs);
        // Find active record for this IP and type
        let rateLimit = await RateLimit.findOne({
          where: {
            ip,
            type,
            windowEnd: {
              [Op.gt]: now
            }
          },
          order: [['windowEnd', 'DESC']]
        });

        if (!rateLimit) {
          // Clean up expired rate limits for this IP and type before creating new one
          await cleanupExpiredRateLimits(ip, type);
          
          rateLimit = await RateLimit.create({
            ip,
            type,
            attempts: 1,
            windowStart: now,
            windowEnd,
          } as RateLimitCreationAttributes);
        } else {
          await rateLimit.increment('attempts');
          await rateLimit.reload();
        }

        // Check if limit exceeded
        if (rateLimit.attempts > maxAttempts) {
          const blockedUntil = new Date(now.getTime() + blockDuration);
          await rateLimit.update({
            blocked: true,
            blockedUntil
          });
          
          logger.debug(`IP ${ip} blocked for exceeding ${type} limit`);
          return true; // IP is now blocked
        }

        return false; // IP is not blocked
      } catch (error) {
        logger.error('Rate limiter increment error:', error);
        return false; // On error, don't block
      }
    },

    isLimited: async (ip: string) => {
      const rateLimit = await RateLimit.findOne({
        where: { ip, type,  },
        order: [['windowEnd', 'DESC']]
      });
      return rateLimit?.attempts && rateLimit.attempts > maxAttempts;
    },

    // Function to check if an IP is currently blocked
    isBlocked: async (ip: string) => {
      try {
        const blockedRecord = await RateLimit.findOne({
          where: {
            ip,
            type,
            blocked: true,
            blockedUntil: {
              [Op.gt]: new Date()
            }
          }
        });
        
        if (blockedRecord) {
          return {
            blocked: true,
            retryAfter: Math.ceil((blockedRecord.blockedUntil!.getTime() - Date.now()))
          };
        }
        
        return { blocked: false, retryAfter: 0 };
      } catch (error) {
        logger.error('Rate limiter isBlocked error:', error);
        return { blocked: false, retryAfter: 0 }; // On error, assume not blocked
      }
    }
  };
}; 