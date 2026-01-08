export const formatColor = (color: string | number | null | undefined) => {
  if (typeof color === 'string' && color.startsWith('#')) {
    const rawHex = color.split('#')[1];

    return parseInt(rawHex, 16);
  } else if (color) {
    return Number(color);
  }
  return 0; // default color value
};
