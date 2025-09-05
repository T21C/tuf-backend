export const decodeFilename = (encodedFilename: string) => {
    const hex = encodedFilename.match(/.{1,2}/g) || [];
    const bytes = new Uint8Array(hex.map((byte: string) => parseInt(byte, 16)));
    return new TextDecoder().decode(bytes);
  };