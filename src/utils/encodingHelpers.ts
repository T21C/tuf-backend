import {base32Encode, base32Decode} from '@ctrl/ts-base32';
import {stringToUint8Array, uint8ArrayToString} from 'uint8array-extras';

export function encodeToBase32(input: string) {
  return base32Encode(stringToUint8Array(input));
}

export function decodeFromBase32(encoded: string) {
  return uint8ArrayToString(base32Decode(encoded));
}
