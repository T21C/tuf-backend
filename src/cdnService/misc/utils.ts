export const decodeFilename = (encodedFilename: string) => {
    // Check if the string looks like hex encoding (only contains hex characters and is even length)
    const hexPattern = /^[0-9a-fA-F]+$/;
    if (encodedFilename.length % 2 === 0 && hexPattern.test(encodedFilename)) {
        // It's hex-encoded, decode it
        const hex = encodedFilename.match(/.{1,2}/g) || [];
        const bytes = new Uint8Array(hex.map((byte: string) => parseInt(byte, 16)));
        return new TextDecoder().decode(bytes);
    } else {
        // It's not hex-encoded, return as-is
        return encodedFilename;
    }
};