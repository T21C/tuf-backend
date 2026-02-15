import express, {Request, Response, Router} from 'express';
import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { logger } from '../../services/LoggerService.js';
import multer from 'multer';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024 // 50MB limit
  }
});

const router: Router = express.Router();

const languageConfigs = {
  en: {display: 'English', countryCode: 'us', folder: 'en'},
  pl: {display: 'Polish', countryCode: 'pl', folder: 'pl'},
  kr: {display: '한국어', countryCode: 'kr', folder: 'kr'},
  cn: {display: '中文', countryCode: 'cn', folder: 'cn'},
  id: {display: 'Bahasa Indonesia', countryCode: 'id', folder: 'id'},
  jp: {display: '日本語', countryCode: 'jp', folder: 'jp'},
  ru: {display: 'Русский', countryCode: 'ru', folder: 'ru'},
  de: {display: 'Deutsch', countryCode: 'de', folder: 'de'},
  fr: {display: 'Français', countryCode: 'fr', folder: 'fr'},
  es: {display: 'Español', countryCode: 'es', folder: 'es'},
};

interface MulterRequest extends Request {
  file?: Express.Multer.File;
}

// Utility to recursively get all JSON files from a directory
function getAllJsonFiles(dir: string): string[] {
  let results: string[] = [];
  const list = fs.readdirSync(dir);

  list.forEach(file => {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      results = results.concat(getAllJsonFiles(filePath));
    } else if (path.extname(file) === '.json') {
      results.push(filePath);
    }
  });

  return results;
}

// Get object keys recursively
function getKeysRecursively(obj: any, prefix = ''): string[] {
  let keys: string[] = [];

  for (const key in obj) {
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      keys = keys.concat(
        getKeysRecursively(obj[key], prefix ? `${prefix}.${key}` : key),
      );
    } else {
      keys.push(prefix ? `${prefix}.${key}` : key);
    }
  }

  return keys;
}

// Utility to find the first directory containing JSON files
function findTranslationRoot(dir: string): string | null {
  const list = fs.readdirSync(dir);

  // If there are JSON files in the current directory, return the current directory
  if (list.some(file => path.extname(file) === '.json')) {
    return dir;
  }

  // Identify subdirectories
  const subdirs = list.filter(file => {
    try {
      return fs.statSync(path.join(dir, file)).isDirectory();
    } catch {
      return false;
    }
  });

  // If there's only one subdirectory, recurse into it
  if (subdirs.length === 1 && !subdirs[0].endsWith('.json')) {
    return findTranslationRoot(path.join(dir, subdirs[0]));
  }

  // If there are multiple subdirectories, check each for JSON files
  for (const subdir of subdirs) {
    const subList = fs.readdirSync(path.join(dir, subdir));
    if (subList.some(file => path.extname(file) === '.json')) {
      return dir;
    }
  }

  // No directory with JSON files found
  return null;
}

// Utility function to safely delete files and directories
function cleanupFiles(...paths: (string | undefined | null)[]): void {
  for (const path of paths) {
    if (!path) continue;

    try {
      if (fs.existsSync(path)) {
        const stats = fs.statSync(path);
        if (stats.isDirectory()) {
          fs.rmSync(path, {recursive: true, force: true});
        } else {
          fs.unlinkSync(path);
        }
      }
    } catch (error) {
      logger.error(`Failed to cleanup path ${path}:`, error);
    }
  }
}

// Add all files from the English translations directory
function addFilesToZip(currentPath: string, baseDir: string, zip: AdmZip) {
  const files = fs.readdirSync(currentPath);

  files.forEach(file => {
    const filePath = path.join(currentPath, file);
    const stat = fs.statSync(filePath);

    if (stat.isDirectory()) {
      addFilesToZip(filePath, baseDir, zip);
    } else if (path.extname(file) === '.json') {
      const relativePath = path.relative(baseDir, filePath);
      zip.addLocalFile(filePath, path.dirname(relativePath));
    }
  });
}

// Verify translations endpoint
router.post(
  '/verify-translations',
  upload.single('translationZip'),
  async (req: MulterRequest, res: Response) => {
    let tempDir: string | null = null;

    try {
      if (!req.file || !req.file.buffer) {
        return res.status(400).json({error: 'No file uploaded'});
      }

      // Create temporary directory with timestamp to avoid collisions
      tempDir = path.join(
        'uploads',
        'temp_' + Date.now() + '_' + Math.random().toString(36).substring(7),
      );
      fs.mkdirSync(tempDir, {recursive: true});

      try {
        // Use buffer directly instead of file path
        const zip = new AdmZip(req.file.buffer);
        zip.extractAllTo(tempDir, true);
      } catch (zipError) {
        throw {
          code: 400,
          error:
            'Failed to extract archive with zip. Please check the archive format.',
        };
      }

      // Find the actual translation root directory
      const translationRoot = findTranslationRoot(tempDir);
      logger.debug('translationRoot', translationRoot);
      if (!translationRoot) {
        throw {
          code: 400,
          error:
            'No translation files found in the archive. Make sure the archive contains JSON files either directly or in an immediate subdirectory',
        };
      }

      // Get base English translations with correct path resolution
      const enTranslationsDir = process.env.TRANSLATIONS_PATH + '/languages/en';

      // Get all JSON files from both directories
      const enFiles = getAllJsonFiles(enTranslationsDir);

      const missingFiles: string[] = [];
      const missingKeys: {[file: string]: string[]} = {};
      const extraKeys: {[file: string]: string[]} = {};

      // Compare files
      enFiles.forEach(enFile => {
        const relativePath = path.relative(enTranslationsDir, enFile);
        const uploadedFile = path.join(translationRoot, relativePath);

        if (!fs.existsSync(uploadedFile)) {
          missingFiles.push(relativePath);
          return;
        }

        // Compare keys in each file
        const enContent = JSON.parse(fs.readFileSync(enFile, 'utf8'));
        const uploadedContent = JSON.parse(
          fs.readFileSync(uploadedFile, 'utf8'),
        );

        const enKeys = getKeysRecursively(enContent);
        const uploadedKeys = getKeysRecursively(uploadedContent);


        const missing = enKeys.filter(key => !uploadedKeys.includes(key));
        const extra = uploadedKeys.filter(key => !enKeys.includes(key));

        if (missing.length > 0) {
          missingKeys[relativePath] = missing;
        }
        if (extra.length > 0) {
          extraKeys[relativePath] = extra;
        }
      });

      const result = {
        missingFiles,
        missingKeys,
        extraKeys,
        isValid:
          missingFiles.length === 0 && Object.keys(missingKeys).length === 0,
      };

      // Clean up before sending response
      cleanupFiles(tempDir);

      return res.json(result);
    } catch (error: any) {
      cleanupFiles(tempDir);

      // Consistently handle custom thrown errors with code property
      if (typeof error === 'object' && error !== null && 'code' in error) {
        return res.status(error.code || 400).json({
          error: error.error || 'Bad Request',
          details: error.details || undefined,
        });
      }
      logger.error('Error verifying translations:', error);
      return res.status(500).json({
        error: 'Failed to verify translations',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

// Download English translations endpoint
router.get('/download-translations', async (req: Request, res: Response) => {
  let tempZipPath: string | null = null;

  try {
    // Update path resolution for English translations
    const enTranslationsDir = process.env.TRANSLATIONS_PATH + '/languages/en';
    tempZipPath = path.join(
      'uploads',
      'en-translations-' +
        Date.now() +
        '_' +
        Math.random().toString(36).substring(7) +
        '.zip',
    );

    const zip = new AdmZip();

    addFilesToZip(enTranslationsDir, enTranslationsDir, zip);

    // Write the zip file
    zip.writeZip(tempZipPath);

    // Send the file and ensure cleanup
    res.download(tempZipPath, 'en-translations.zip', err => {
      cleanupFiles(tempZipPath);
      if (err) {
        logger.error('Error sending translations zip:', err);
      }
    });
  } catch (error) {
    cleanupFiles(tempZipPath);
    logger.error('Error creating translations zip:', error);
    res.status(500).json({
      error: 'Failed to create translations zip',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

// Language configuration - now dynamic based on directory check
const languages: {[key: string]: {display: string; countryCode: string; folder: string; status: number}} = {};

// Function to check if a language is implemented
async function checkLanguageImplementation(langCode: string): Promise<number> {
  try {
    const langDir = process.env.TRANSLATIONS_PATH + '/languages/' + langCode;

    // Check if directory exists
    if (!fs.existsSync(langDir)) {
      return 0;
    }

    // Get all JSON files in the language directory
    const langFiles = getAllJsonFiles(langDir);
    if (langFiles.length === 0) {
      return 0;
    }

    // Get English translations for comparison
    const enDir = process.env.TRANSLATIONS_PATH + '/languages/en';
    const enFiles = getAllJsonFiles(enDir);

    let missingFiles = 0;
    let missingKeys = 0;
    let totalKeys = 0;

    // Check if all English files exist in the language directory
    for (const enFile of enFiles) {
      const relativePath = path.relative(enDir, enFile);
      const langFile = path.join(langDir, relativePath);

      if (!fs.existsSync(langFile)) {
        missingFiles++;
        continue;
      }

      // Compare keys in each file
      const enContent = JSON.parse(fs.readFileSync(enFile, 'utf8'));
      const langContent = JSON.parse(fs.readFileSync(langFile, 'utf8'));

      const enKeys = getKeysRecursively(enContent);
      const langKeys = getKeysRecursively(langContent);

      totalKeys += enKeys.length;
      missingKeys += enKeys.filter(key => !langKeys.includes(key)).length;
    }

    // Calculate implementation percentage
    const fileCompletion = ((enFiles.length - missingFiles) / enFiles.length) * 100;
    const keyCompletion = ((totalKeys - missingKeys) / totalKeys) * 100;
    const overallCompletion = (fileCompletion + keyCompletion) / 2;

    logger.debug(`language: ${langCode} completion: ${overallCompletion}`);
    return overallCompletion;
  } catch (error) {
    logger.error(`Error checking implementation for ${langCode}:`, error);
    return 0;
  }
}

// Initialize languages configuration
async function initializeLanguages() {
  const baseDir = process.env.TRANSLATIONS_PATH + '/languages';
  if (!fs.existsSync(baseDir)) {
    logger.error('Translations path does not exist:', baseDir);
    return;
  }

  // Check each language's implementation
  for (const [code, config] of Object.entries(languageConfigs)) {
    const status = await checkLanguageImplementation(code);
    languages[code] = {
      ...config,
      status,
    };
  }
}

// Initialize languages on server start
initializeLanguages().catch(error => {
  logger.error('Error initializing languages:', error);
});

// Get list of available languages
router.get('/languages', async (req: Request, res: Response) => {
  try {
    res.json(languages);
  } catch (error) {
    logger.error('Error getting languages list:', error);
    res.status(500).json({
      error: 'Failed to get languages list',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

// Type for languages
type LanguageCode = keyof typeof languages;

// Download translations for a specific language
router.get(
  '/download-translations/:lang',
  async (req: Request, res: Response) => {
    const {lang} = req.params;
    let tempZipPath: string | null = null;

    try {
      if (!languages[lang as LanguageCode]) {
        return res.status(404).json({error: 'Language not found'});
      }

      // Update path resolution for translations
      const translationsDir = process.env.TRANSLATIONS_PATH + '/languages/' + lang;

      // Check if directory exists
      if (!fs.existsSync(translationsDir)) {
        return res
          .status(404)
          .json({error: 'Translations not found for this language'});
      }

      tempZipPath = path.join(
        'uploads',
        `${lang}-translations-${Date.now()}_${Math.random().toString(36).substring(7)}.zip`,
      );

      const zip = new AdmZip();

      addFilesToZip(translationsDir, translationsDir, zip);

      // Write the zip file
      zip.writeZip(tempZipPath);

      // Send the file and ensure cleanup
      return res.download(tempZipPath, `${lang}-translations.zip`, err => {
        cleanupFiles(tempZipPath);
        if (err) {
          logger.error(`Error sending ${lang} translations zip:`, err);
        }
      });
    } catch (error) {
      cleanupFiles(tempZipPath);
      logger.error(`Error creating ${lang} translations zip:`, error);
      res.status(500).json({
        error: 'Failed to create translations zip',
        details: error instanceof Error ? error.message : String(error),
      });
    }
  },
);

router.get('/languages', async (req: Request, res: Response) => {
  try {
    const languagesInfo = Object.entries(languages).map(([code, info]) => ({
      code,
      display: info.display,
      countryCode: info.countryCode,
      folder: info.folder,
      status: info.status,
    }));

    res.json(languagesInfo);
  } catch (error) {
    logger.error('Error getting languages list:', error);
    res.status(500).json({
      error: 'Failed to get languages list',
      details: error instanceof Error ? error.message : String(error),
    });
  }
});


// Serve the utility navigation page
router.get('/', (req: Request, res: Response) => {
  res.send(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>TUF Utilities</title>
      <link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;600;700;800;900&family=Noto+Sans+KR:wght@400;500;600;700;800;900&display=swap" rel="stylesheet">
      <style>
        body {
          font-family: 'Noto Sans JP', 'Noto Sans KR', sans-serif;
          max-width: 800px;
          margin: 0 auto;
          padding: 20px;
          background: #1a1a1a;
          color: #fff;
          line-height: 1.6;
        }
        h1 {
          color: #8f7dea;
          text-align: center;
          font-weight: 800;
          font-size: 2.5em;
          margin-bottom: 1.5em;
        }
        .utility-section {
          background: #2a2a2a;
          padding: 30px;
          border-radius: 12px;
          margin-bottom: 30px;
          box-shadow: 0 4px 6px rgba(0, 0, 0, 0.2);
        }
        .utility-section h2 {
          margin-top: 0;
          color: #8f7dea;
          font-weight: 700;
          font-size: 1.8em;
          margin-bottom: 0.8em;
        }
        .utility-section p {
          margin: 0.5em 0;
          color: #cccccc;
          font-size: 1.1em;
        }
        .upload-form {
          display: flex;
          flex-direction: column;
          gap: 15px;
          margin-top: 20px;
        }
        input[type="file"] {
          background: #333;
          padding: 10px;
          border-radius: 6px;
          border: 2px solid #444;
          color: #fff;
          cursor: pointer;
        }
        input[type="file"]::-webkit-file-upload-button {
          background: #8f7dea;
          color: white;
          padding: 8px 16px;
          border: none;
          border-radius: 4px;
          cursor: pointer;
          font-family: inherit;
          margin-right: 10px;
        }
        input[type="file"]::-webkit-file-upload-button:hover {
          background: #7763c2;
        }
        .button-group {
          display: flex;
          gap: 15px;
          align-items: center;
        }
        button {
          background: #8f7dea;
          color: white;
          border: none;
          padding: 12px 24px;
          border-radius: 6px;
          cursor: pointer;
          font-family: inherit;
          font-weight: 700;
          font-size: 1.1em;
          text-shadow: 0 0 8px #0008;
          transition: background 0.2s ease;
        }
        button:hover {
          background: #7763c2;
        }
        button:disabled {
          background: #555;
          cursor: not-allowed;
        }
        #result {
          white-space: pre-wrap;
          background: #333;
          padding: 20px;
          border-radius: 8px;
          display: none;
          margin-top: 20px;
          font-family: monospace;
          line-height: 1.4;
        }
        .error {
          color: #ff6b6b;
          font-weight: 500;
        }
        .success {
          color: #69db7c;
          font-weight: 500;
        }
        .format-note {
          background: #3a3a3a;
          padding: 15px 20px;
          border-radius: 8px;
          margin: 15px 0;
          border-left: 4px solid #8f7dea;
        }
        .guide-section {
          margin-top: 2rem;
          padding-top: 2rem;
          border-top: 1px solid rgba(255, 255, 255, 0.1);
        }
        
        .guide-section h3 {
          color: #8f7dea;
          font-size: 1.4em;
          margin-bottom: 1.5rem;
        }
        
        .guide-steps {
          display: flex;
          flex-direction: column;
          gap: 1.5rem;
        }
        
        .step {
          background: rgba(0, 0, 0, 0.2);
          padding: 1.2rem;
          border-radius: 8px;
          position: relative;
          padding-left: 3.5rem;
        }
        
        .step-number {
          position: absolute;
          left: -1rem;
          top: 50%;
          transform: translateY(-50%);
          background: #8f7dea;
          width: 2.5rem;
          height: 2.5rem;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          font-weight: bold;
          font-size: 1.2em;
          box-shadow: 0 2px 4px rgba(0, 0, 0, 0.2);
        }
        
        .step h4 {
          color: #8f7dea;
          margin: 0 0 0.5rem 0;
          font-size: 1.1em;
        }
        
        .step p {
          margin: 0;
          color: #cccccc;
          line-height: 1.4;
        }
        
        .example-box {
          margin-top: 0.8rem;
          background: rgba(0, 0, 0, 0.3);
          padding: 0.8rem;
          border-radius: 6px;
          border-left: 3px solid #8f7dea;
        }
        
        .example-box + .example-box {
          margin-top: 1rem;
        }
        
        .example-box p {
          margin: 0 0 0.5rem 0;
          color: #8f7dea;
          font-weight: 500;
        }
        
        .example-box p.note {
          color: #ff9800;
          font-size: 0.9em;
          margin-top: 0.5rem;
          margin-bottom: 0;
        }
        
        .example-box pre {
          margin: 0;
          white-space: pre-wrap;
          word-break: break-word;
          color: #fff;
          font-family: monospace;
          font-size: 0.9em;
          line-height: 1.4;
        }
        
        code {
          background: rgba(143, 125, 234, 0.2);
          padding: 0.1em 0.3em;
          border-radius: 3px;
          font-family: monospace;
          color: #fff;
        }
        
        .language-list {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
          gap: 1rem;
          margin-top: 2rem;
        }
        
        .language-card {
          background: #2a2a2a;
          padding: 1rem 1.2rem;
          border-radius: 8px;
          display: flex;
          flex-direction: column;
          gap: 0.8rem;
        }
        
        .language-header {
          display: flex;
          align-items: center;
          gap: 0.8rem;
        }
        
        .language-name {
          font-size: 1.2em;
          font-weight: 600;
          color: #fff;
        }
        
        .language-status {
          font-size: 0.9em;
          padding: 0.3em 0.6em;
          border-radius: 4px;
          font-weight: 500;
        }
        
        .status-implemented {
          background: #2b825b;
          color: #fff;
        }
        
        .status-pending {
          background: #825b2b;
          color: #fff;
        }
        
        .language-download {
          margin-top: 0.5rem;
        }
        
        .language-download button {
          width: 100%;
          padding: 0.8em;
          background: #8f7dea;
          color: white;
          border: none;
          border-radius: 6px;
          cursor: pointer;
          font-family: inherit;
          font-weight: 600;
          font-size: 0.9em;
          transition: background 0.2s;
        }
        
        .language-download button:hover {
          background: #7763c2;
        }
        
        .language-download button:disabled {
          background: #555;
          cursor: not-allowed;
        }
      </style>
    </head>
    <body>
      <h1>TUF Utilities</h1>
      
      <div class="utility-section">
        <h2>Translation Verifier</h2>
        <p>Upload a ZIP file containing translations to verify against the English base translations.</p>
        
        <div class="format-note">
          <p><strong>Supported formats:</strong> .zip, .7z, .rar, .tar, .gz</p>
          <p><strong>Expected structure:</strong> Archive containing translation files matching the English structure</p>
        </div>
        
        <form class="upload-form" id="translationForm">
          <input type="file" name="translationZip" accept=".zip,.7z,.rar,.tar,.gz" required>
          <div class="button-group">
            <button type="submit">Verify Translations</button>
          </div>
        </form>
        
        <div id="result"></div>

        <div class="guide-section">
          <h3>How to Use the Translation Tool</h3>
          <div class="guide-steps">
            <div class="step">
              <span class="step-number">1</span>
              <h4>Download Base Translations</h4>
              <p>Select a language below to download its translation files. These will serve as your template.</p>
            </div>
            
            <div class="step">
              <span class="step-number">2</span>
              <h4>Extract & Translate</h4>
              <p>Extract the archive and locate the JSON files. For each translation entry, replace the text while keeping the keys unchanged.</p>
              <div class="example-box">
                <p>Basic Translation Example:</p>
                <pre>"noLevels": "No new levels to announce" → "noLevels": "Your translated text here"</pre>
              </div>
              <div class="example-box">
                <p>Dynamic Values (Important!):</p>
                <p>Some translations contain <code>{{value}}</code> placeholders. These must be kept but can be repositioned:</p>
                <pre>"welcome": "Welcome back, {{username}}!"
→ "welcome": "{{username}}, willkommen zurück!"

"progress": "{{count}} of {{total}} levels completed"
→ "progress": "{{count}} von {{total}} Level abgeschlossen"</pre>
                <p class="note">⚠️ Never translate the placeholders themselves (e.g., {{username}}, {{count}}, etc.)</p>
              </div>
            </div>
            
            <div class="step">
              <span class="step-number">3</span>
              <h4>Pack & Verify</h4>
              <p>Pack your translated files into a new archive (.zip, .7z, .rar, etc.) and use the verifier above to check for any missing or incorrect translations.</p>
            </div>
            
            <div class="step">
              <span class="step-number">4</span>
              <h4>Review & Submit</h4>
              <p>Check the verification results. If everything is marked as valid, your translation is ready to be submitted!</p>
            </div>
          </div>
        </div>

        <div class="language-section">
          <h3>Available Languages</h3>
          <div class="language-list" id="languageList">
            <!-- Languages will be populated here -->
          </div>
        </div>
      </div>

      <script>
        // Fetch and display languages
        async function fetchLanguages() {
          try {
            const languages = Object.values(${JSON.stringify(languages)}).sort((a, b) => b.status - a.status);
            const languageList = document.getElementById('languageList');
            
            languages.forEach(lang => {
              const card = document.createElement('div');
              card.className = 'language-card';
              
              card.innerHTML = \`
                <div class="language-header">
                  <span class="language-name">\${lang.display}</span>
                  <span class="language-status \${lang.status === 100 ? 'status-implemented' : lang.status > 0 ? 'status-pending' : ''}">
                    \${lang.status === 100 ? 'Implemented' : lang.status > 0 ? \`\${lang.status.toFixed(2)}% Implemented\` : 'Not Implemented'}
                  </span>
                </div>
                <div class="language-download">
                  <button onclick="downloadTranslation('\${lang.folder}')" \${lang.status === 0 ? 'disabled' : ''}>
                    Download \${lang.display} Translations
                  </button>
                </div>
              \`;
              
              languageList.appendChild(card);
            });
          } catch (error) {
            logger.error('Error fetching languages:', error);
          }
        }

        async function downloadTranslation(langCode) {
          const button = event.target;
          const originalText = button.textContent;
          button.disabled = true;
          button.textContent = 'Preparing download...';
          
          try {
            const response = await fetch(\`/v2/utils/download-translations/\${langCode}\`);
            if (!response.ok) throw new Error('Failed to download translations');
            
            const blob = await response.blob();
            const url = window.URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = \`\${langCode}-translations.zip\`;
            document.body.appendChild(a);
            a.click();
            window.URL.revokeObjectURL(url);
            document.body.removeChild(a);
          } catch (error) {
            alert('Error downloading translations: ' + error.message);
          } finally {
            button.disabled = false;
            button.textContent = originalText;
          }
        }

        // Handle form submission
        document.getElementById('translationForm').addEventListener('submit', async (e) => {
          e.preventDefault();
          const form = e.target;
          const resultDiv = document.getElementById('result');
          resultDiv.style.display = 'block';
          resultDiv.textContent = 'Verifying translations...';
          resultDiv.className = '';
          
          try {
            const formData = new FormData(form);
            const response = await fetch('/v2/utils/verify-translations', {
              method: 'POST',
              body: formData
            });
            
            const data = await response.json();
            
            if (response.ok) {
              let result = "";
              
              if (data.isValid) {
                result += "✅ All translations are valid!\\n";
              } else {
                if (data.missingFiles.length > 0) {
                  result += "❌ Missing Files:\\n" + data.missingFiles.join("\\n") + "\\n\\n";
                }
                
                if (Object.keys(data.missingKeys).length > 0) {
                  result += "❌ Missing Keys:\\n";
                  for (const [file, keys] of Object.entries(data.missingKeys)) {
                    result += "\\n" + file + ":\\n" + keys.join("\\n") + "\\n";
                  }
                }
                
                if (Object.keys(data.extraKeys).length > 0) {
                  result += "\\n⚠️ Extra Keys:\\n";
                  for (const [file, keys] of Object.entries(data.extraKeys)) {
                    result += "\\n" + file + ":\\n" + keys.join("\\n") + "\\n";
                  }
                }
              }
              
              resultDiv.textContent = result;
              resultDiv.className = data.isValid ? 'success' : 'error';
            } else {
              throw new Error(data.details || data.error || 'Failed to verify translations');
            }
          } catch (error) {
            resultDiv.textContent = "Error: " + error.message;
            resultDiv.className = 'error';
          }
        });

        // Initialize
        fetchLanguages();
      </script>
    </body>
    </html>
  `);
});

export default router;
