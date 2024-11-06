import pkg from 'base32.js';
const { Encoder, Decoder } = pkg;

export function encodeToBase32(input) {
    const encoder = new Encoder();
    const buffer = new TextEncoder().encode(input);
    return encoder.write(buffer).finalize();
  }
  
export function decodeFromBase32(encoded) {
    const decoder = new Decoder();
    const decodedBuffer = decoder.write(encoded).finalize();
    return new TextDecoder().decode(decodedBuffer);
  }