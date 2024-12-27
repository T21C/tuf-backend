import path from 'path';
import { registerFont } from 'canvas';

interface FontWeight {
  name: string;
  weight: string;
}

const FONT_WEIGHTS: FontWeight[] = [
  { name: 'Thin', weight: '100' },
  { name: 'ExtraLight', weight: '200' },
  { name: 'Light', weight: '300' },
  { name: 'Regular', weight: '400' },
  { name: 'Medium', weight: '500' },
  { name: 'SemiBold', weight: '600' },
  { name: 'Bold', weight: '700' },
  { name: 'ExtraBold', weight: '800' },
  { name: 'Black', weight: '900' }
];

export function initializeFonts() {
  const fontFamilies = ['NotoSansKR', 'NotoSansJP'];
  
  fontFamilies.forEach(family => {
    FONT_WEIGHTS.forEach(({ name, weight }) => {
      const fontPath = path.join(process.cwd(), 'assets', 'fonts', `${family}-${name}.ttf`);
      registerFont(fontPath, {
        family: family.replace('Noto', 'Noto Sans'),
        weight
      });
    });
  });
  
} 