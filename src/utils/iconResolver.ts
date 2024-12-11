const baseURL = 'https://github.com/T21C/T21C-assets/blob/main/';
const queryParams = '?raw=true';

// Data type constants
const pguDataType = 'pguDiff';
const inputDataType = 'miscDiff';

// Data mappings
export const pguData = {
  P1: 'P1.png',
  P2: 'P2.png',
  P3: 'P3.png',
  P4: 'P4.png',
  P5: 'P5.png',
  P6: 'P6.png',
  P7: 'P7.png',
  P8: 'P8.png',
  P9: 'P9.png',
  P10: 'P10.png',
  P11: 'P11.png',
  P12: 'P12.png',
  P13: 'P13.png',
  P14: 'P14.png',
  P15: 'P15.png',
  P16: 'P16.png',
  P17: 'P17.png',
  P18: 'P18.png',
  P19: 'P19.png',
  P20: 'P20.png',
  G1: 'G1.png',
  G2: 'G2.png',
  G3: 'G3.png',
  G4: 'G4.png',
  G5: 'G5.png',
  G6: 'G6.png',
  G7: 'G7.png',
  G8: 'G8.png',
  G9: 'G9.png',
  G10: 'G10.png',
  G11: 'G11.png',
  G12: 'G12.png',
  G13: 'G13.png',
  G14: 'G14.png',
  G15: 'G15.png',
  G16: 'G16.png',
  G17: 'G17.png',
  G18: 'G18.png',
  G19: 'G19.png',
  G20: 'G20.png',
  U1: 'U1.png',
  U2: 'U2.png',
  U3: 'U3.png',
  U4: 'U4.png',
  U5: 'U5.png',
  U6: 'U6.png',
  U7: 'U7.png',
  U8: 'U8.png',
  U9: 'U9.png',
  U10: 'U10.png',
  U11: 'U11.png',
  U12: 'U12.png',
  U13: 'U13.png',
  U14: 'U14.png',
  U15: 'U15.png',
  U16: 'U16.png',
  U17: 'U17.png',
  U18: 'U18.png',
  U19: 'U19.png',
  U20: 'U20.png',
};

export const inputData = {
  Qq: 'Qq.png',
  'Q1+': 'q1+.png',
  Q2: 'q2.png',
  'Q2+': 'q2+.png',
  Q3: 'q3.png',
  'Q3+': 'q3+.png',
  Q4: 'q4.png',
  Bus: 'Desertbus.png',
  Grande: 'Grande.png',
  MA: 'ma.png',
  MP: 'MP.png',
  '-21': '21-.png',
  '-2': '-2.png',
  '0': 'Unranked.png',
};

export function getIconUrl(key: string): string {
  // Try pguData first
  if (key in pguData) {
    return `${baseURL}${pguDataType}/${pguData[key as keyof typeof pguData]}${queryParams}`;
  }

  // Then try inputData
  if (key in inputData) {
    return `${baseURL}${inputDataType}/${inputData[key as keyof typeof inputData]}${queryParams}`;
  }

  return `${baseURL}${inputDataType}/${inputData['0']}${queryParams}`;
}
