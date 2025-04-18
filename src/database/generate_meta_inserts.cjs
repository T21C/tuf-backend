const fs = require('fs');
const path = require('path');

// Get all migration files from the migrations directory
const migrationsDir = path.join(__dirname, 'migrations');
const files = fs.readdirSync(migrationsDir)
  .filter(file => file.endsWith('.cjs') || file.endsWith('.js'))
  .sort((a, b) => {
    // Extract timestamps from filenames for proper ordering
    const timestampA = parseInt(a.split('_')[0]);
    const timestampB = parseInt(b.split('_')[0]);
    return timestampA - timestampB;
  });

// Generate SQL query
let sql = `-- Run this query to insert missing migrations into SequelizeMeta\n`;

sql += "USE tuf_website;\n";
sql += "SET SQL_SAFE_UPDATES = 0;\n";
sql += "DELETE FROM `SequelizeMeta`;\n";
sql += "SET SQL_SAFE_UPDATES = 1;\n";
sql += `INSERT INTO \`SequelizeMeta\` (\`name\`)\n`;
sql += `SELECT t.name FROM (\n`;

// Generate values for each migration file
const values = files.map(file => `  SELECT '${file}' as name`).join('\nUNION ALL\n');
sql += values;

sql += `\n) t\n`;
sql += `WHERE t.name NOT IN (SELECT name FROM \`SequelizeMeta\`);\n\n`;

// Add a list of all found migrations as a comment
sql += `/*\nFound migrations:\n${files.map(f => '- ' + f).join('\n')}\n*/\n`;

// Write to output file
const outputPath = path.join(__dirname, 'meta_inserts.sql');
fs.writeFileSync(outputPath, sql);

console.log(`Generated SQL file at: ${outputPath}`);
console.log(`Found ${files.length} migration files`);
console.log('You can now run the generated SQL query to insert missing migrations.'); 