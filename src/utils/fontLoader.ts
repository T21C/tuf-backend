import path from 'path';
import { fileURLToPath } from 'url';
import {registerFont} from 'canvas';
import sharp from 'sharp';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define font families with their language coverage
const FONT_FAMILIES = [
  { name: 'NotoSans', primary: 'en' },      // Latin characters
  { name: 'NotoSansKR', primary: 'ko' },    // Korean
  { name: 'NotoSansJP', primary: 'ja' },    // Japanese
  { name: 'NotoSansSC', primary: 'zh-CN' }, // Simplified Chinese
  { name: 'NotoSansTC', primary: 'zh-TW' }  // Traditional Chinese
];

// Register all fonts
export function initializeFonts() {
  FONT_FAMILIES.forEach(family => {
    try {
      registerFont(path.join(__dirname, '../../assets/fonts', `${family.name}-Regular.ttf`), {
        family: family.name,
        weight: '400'
      });
    } catch (error) {
      console.error(`Failed to load font ${family.name}:`, error);
    }
  });
}

// Create a font fallback string for Sharp
const getFontFallbackString = (size: number) => {
  return FONT_FAMILIES.map(family => 
    `${family.name}-Regular ${size}px`
  ).join(', ');
};

// Function to create text with proper font fallback
export async function createText(text: string, options: {
  width: number;
  height: number;
  fontSize: number;
  color?: string;
}) {
  const {
    width,
    height,
    fontSize,
    color = '#000000'
  } = options;

  const fontString = getFontFallbackString(fontSize);

  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 0, g: 0, b: 0, alpha: 0 }
    }
  })
  .composite([
    {
      input: {
        text: {
          text,
          font: fontString,
          dpi: 72,
          rgba: true,
          background: color
        } as any
      },
      gravity: 'center'
    }
  ]);
}

// Example usage:
export async function renderText(text: string) {
  try {
    const image = await createText(text, {
      width: 800,
      height: 200,
      fontSize: 48,
      color: '#FFFFFF'
    });
    
    // Save or process the image further
    await image.toFile('output.png');
  } catch (error) {
    console.error('Error rendering text:', error);
  }
}

// Initialize fonts when module loads
try {
  initializeFonts();
  console.log('Fonts initialized successfully');
} catch (error) {
  console.error('Error initializing fonts:', error);
}
