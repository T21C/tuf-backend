import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// Get the directory name of the current module
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Define source and destination directories
const srcDir = path.join(__dirname, '..', '..', 'src');
const distDir = path.join(__dirname, '..', '..', 'dist');

// Function to copy HTML files
function copyHtmlFiles() {
  
  // Read all files in the src directory
  const files = fs.readdirSync(srcDir);
  
  // Filter for HTML files
  const htmlFiles = files.filter(file => file.endsWith('.html'));
  // Create dist directory if it doesn't exist
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }
  
  // Copy each HTML file to the dist directory
  let count = 0;
  htmlFiles.forEach(file => {
    const srcPath = path.join(srcDir, file);
    const destPath = path.join(distDir, file);
    
    fs.copyFileSync(srcPath, destPath);
    count++;
  });

  console.log(`Copied ${count} HTML files to dist directory`);
  return;
}

// Execute the function
copyHtmlFiles(); 