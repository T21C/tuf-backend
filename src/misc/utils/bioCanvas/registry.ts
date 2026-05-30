import { textBlockDescriptor } from './blocks/text.js';
import { linkBlockDescriptor } from './blocks/link.js';
import { socialBlockDescriptor } from './blocks/social.js';
import { imageBlockDescriptor } from './blocks/image.js';
import { embedBlockDescriptor } from './blocks/embed.js';
import { featuredLevelsBlockDescriptor } from './blocks/featuredLevels.js';

export const BLOCK_DESCRIPTORS = [
  textBlockDescriptor,
  linkBlockDescriptor,
  socialBlockDescriptor,
  imageBlockDescriptor,
  embedBlockDescriptor,
  featuredLevelsBlockDescriptor,
] as const;

export type BlockDescriptor = (typeof BLOCK_DESCRIPTORS)[number];
export type BlockType = BlockDescriptor['type'];

const descriptorByType = new Map<string, BlockDescriptor>(
  BLOCK_DESCRIPTORS.map((d) => [d.type, d]),
);

export function getBlockDescriptor(type: string): BlockDescriptor | undefined {
  return descriptorByType.get(type);
}

export const BLOCK_TYPES = BLOCK_DESCRIPTORS.map((d) => d.type);

export const BLOCK_TYPE_LABELS: Record<string, string> = {
  text: 'Text',
  link: 'Link',
  social: 'Social',
  image: 'Image',
  embed: 'Video',
  featuredLevels: 'Featured',
};

export function getBlockTypeLabel(type: string): string {
  return BLOCK_TYPE_LABELS[type] ?? type ?? 'Unknown';
}

export {
  textBlockDescriptor,
  linkBlockDescriptor,
  socialBlockDescriptor,
  imageBlockDescriptor,
  embedBlockDescriptor,
  featuredLevelsBlockDescriptor,
};
