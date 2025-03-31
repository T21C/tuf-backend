/**
 * Utility functions for seeded random number generation
 */

/**
 * Generates a 128-bit hash from a string using the cyrb128 algorithm
 * This is used to generate high-quality seeds from strings
 */
export function cyrb128(str: string): [number, number, number, number] {
  let h1 = 1779033703, h2 = 3144134277,
      h3 = 1013904242, h4 = 2773480762;
  
  for (let i = 0, k; i < str.length; i++) {
    k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  
  h1 ^= (h2 ^ h3 ^ h4), h2 ^= h1, h3 ^= h1, h4 ^= h1;
  
  return [h1>>>0, h2>>>0, h3>>>0, h4>>>0];
}

/**
 * Creates a seeded random number generator using the sfc32 algorithm
 * This is a fast, high-quality PRNG that can be seeded with 4 32-bit numbers
 */
export function sfc32(a: number, b: number, c: number, d: number) {
  return function() {
    a >>>= 0; b >>>= 0; c >>>= 0; d >>>= 0; 
    let t = (a + b) | 0;
    a = b ^ b >>> 9;
    b = c + (c << 3) | 0;
    c = (c << 21 | c >>> 11) | 0;
    d = d + 1 | 0;
    t = t + d | 0;
    c = c + t | 0;
    return (t >>> 0) / 4294967296;
  };
}

/**
 * Creates a seeded random number generator using the splitmix32 algorithm
 * This is a simpler PRNG that can be seeded with a single 32-bit number
 */
export function splitmix32(a: number) {
  return function() {
    a = a + 0x9e3779b9 | 0;
    let t = a ^ a >>> 16;
    t = Math.imul(t, 0x21f0aaad);
    t = t ^ t >>> 15;
    t = Math.imul(t, 0x735a2d97);
    return ((t = t ^ t >>> 15) >>> 0) / 4294967296;
  };
}

/**
 * Creates a seeded random number generator from a string seed
 * This combines cyrb128 for seed generation with sfc32 for number generation
 */
export function createSeededRandom(seed: string) {
  const [h1, h2, h3, h4] = cyrb128(seed);
  return sfc32(h1, h2, h3, h4);
}

/**
 * Creates a seeded random number generator from a numeric seed
 * This uses splitmix32 for simpler cases where only one seed number is needed
 */
export function createNumericSeededRandom(seed: number) {
  return splitmix32(seed);
}

/**
 * Shuffles an array using a seeded random number generator
 * This ensures consistent shuffling for the same seed
 */
export function seededShuffle<T>(array: T[], seed: number): T[] {
  const rand = createNumericSeededRandom(seed);
  const result = [...array];
  
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  
  return result;
}

/**
 * Generates a random number between min and max (inclusive) using a seeded generator
 */
export function seededRandomRange(min: number, max: number, seed: number): number {
  const rand = createNumericSeededRandom(seed);
  return Math.floor(rand() * (max - min + 1)) + min;
}

/**
 * Generates a daily seed based on the current date
 * This ensures the same seed is used for all operations on the same day
 */
export function getDailySeed(): number {
  const today = new Date();
  return today.getFullYear() * 10000 + 
         (today.getMonth() + 1) * 100 + 
         today.getDate();
}

/**
 * Generates a seed based on a specific date
 * Useful for testing or generating historical seeds
 */
export function getDateSeed(date: Date): number {
  return date.getFullYear() * 10000 + 
         (date.getMonth() + 1) * 100 + 
         date.getDate();
} 


export function getRandomSeed() {
  return Math.floor(Math.random() * 100000);
}



export function gaussianRandom(mean=0, stdev=1) {
  const u = 1 - Math.random(); // Converting [0,1) to (0,1]
  const v = Math.random();
  const z = Math.sqrt( -2.0 * Math.log( u ) ) * Math.cos( 2.0 * Math.PI * v );
  // Transform to the desired mean and standard deviation:
  return z * stdev + mean;
}

/**
* Creates a probability-based event system
* @param {Object} events - Object containing event names and their probabilities (0-100)
* @returns {string|null} - Returns the triggered event name or null if no event triggered
* @example
* const events = {
*   'eventA': 5,  // 5% chance
*   'eventB': 10, // 10% chance
*   'eventC': 15  // 15% chance
* };
* const result = triggerEvent(events);
*/
export function triggerEvent(events: Record<string, number>) {
// Generate random number between 0 and 100
const roll = Math.random() * 100;
let cumulativeProbability = 0;

// Check each event in order
for (const [eventName, probability] of Object.entries(events)) {
  cumulativeProbability += probability;
  if (roll < cumulativeProbability) {
    return eventName;
  }
}

// No event triggered
return null;
}

/**
* Creates a reusable event system with predefined events
* @param {Object} events - Object containing event names and their probabilities
* @returns {Function} - Function that can be called to trigger events
* @example
* const eventSystem = createEventSystem({
*   'eventA': 5,
*   'eventB': 10
* });
* const result = eventSystem(); // Returns triggered event or null
*/
export function createEventSystem(events: Record<string, number>) {
// Validate probabilities sum to 100 or less
const totalProbability = Object.values(events).reduce((sum, prob) => sum + prob, 0);
if (totalProbability > 100) {
  throw new Error('Total probability cannot exceed 100%');
}

return () => triggerEvent(events);
}