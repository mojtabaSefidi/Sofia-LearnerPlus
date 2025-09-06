// .github/scripts/manage-duplicates.js
const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Example duplicate contributors data
const SAMPLE_DUPLICATES = {
  "contributors": [
    {
      "primary_github_login": "mirsaeedi",
      "github_usernames": ["mirsaeedi", "ehsan"],
      "emails": ["emailA@test.com", "emailB@test.com"],
      "names": ["nameA"],
      "priority": "manual"
    },
    {
      "primary_github_login": "fahimeh1368",
      "github_usernames": ["fahimeh1368", "fahimehhajari"],
      "emails": ["emailC@test.com", "emailD@test.com", "emailE@test.com"],
      "names": ["nameB", "NameC"],
      "priority": "manual"
    }
  ]
};

async function loadDuplicatesFromFile() {
  const filePath = path.join(process.cwd(), '.github', 'data', 'duplicate_contributors.json');
  
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf8');
      return JSON.parse(content);
    } else {
      console.log('📄 No duplicate contributors file found, creating sample...');
      // Create directory if it doesn't exist
      const dir = path.dirname(filePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      // Write sample file
      fs.writeFileSync(filePath, JSON.stringify(SAMPLE_DUPLICATES, null, 2));
      console.log(`📄 Sample file created at: ${filePath}`);
      return SAMPLE_DUPLICATES;
    }
  } catch (error) {
    console.error('❌ Error loading duplicates file:', error);
    return { contributors: [] };
  }
}

async function syncDuplicatesToDatabase() {
  console.log('🔄 Syncing duplicate contributors to database...');
  
  try {
    const duplicatesData = await loadDuplicatesFromFile();
    
    if (!duplicatesData.contributors || duplicatesData.contributors.length === 0) {
      console.log('📭 No duplicate contributors to sync');
      return;
    }
    
    let inserted = 0;
    let updated = 0;
    let errors = 0;
    
    for (const contributor of duplicatesData.contributors) {
      try {
        const { error } = await supabase
          .from('duplicate_contributors')
          .upsert({
            primary_github_login: contributor.primary_github_login,
            github_usernames: contributor.github_usernames || [],
            emails: contributor.emails || [],
            names: contributor.names || [],
            priority: contributor.priority || 'manual'
          }, { 
            onConflict: 'primary_github_login'
          });
        
        if (error) {
          console.error(`❌ Error upserting ${contributor.primary_github_login}:`, error);
          errors++;
        } else {
          inserted++;
        }
      } catch (err) {
        console.error(`❌ Exception upserting ${contributor.primary_github_login}:`, err);
        errors++;
      }
    }
    
    console.log(`✅ Sync completed: ${inserted} processed, ${errors} errors`);
    
  } catch (error) {
    console.error('❌ Error syncing duplicates:', error);
  }
}

async function exportDuplicatesFromDatabase() {
  console.log('📤 Exporting duplicate contributors from database...');
  
  try {
    const { data: duplicates, error } = await supabase
      .from('duplicate_contributors')
      .select('*')
      .order('primary_github_login');
    
    if (error) {
      console.error('❌ Error fetching duplicates:', error);
      return;
    }
    
    const exportData = {
      contributors: duplicates.map(d => ({
        primary_github_login: d.primary_github_login,
        github_usernames: d.github_usernames || [],
        emails: d.emails || [],
        names: d.names || [],
        priority: d.priority || 'manual'
      }))
    };
    
    const filePath = path.join(process.cwd(), '.github', 'data', 'duplicate_contributors.json');
    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    
    fs.writeFileSync(filePath, JSON.stringify(exportData, null, 2));
    console.log(`✅ Exported ${duplicates.length} duplicate contributors to: ${filePath}`);
    
  } catch (error) {
    console.error('❌ Error exporting duplicates:', error);
  }
}

async function findPotentialDuplicates() {
  console.log('🔍 Finding potential duplicate contributors...');
  
  try {
    const { data: contributors, error } = await supabase
      .from('contributors')
      .select('*')
      .order('github_login');
    
    if (error) {
      console.error('❌ Error fetching contributors:', error);
      return;
    }
    
    const potentialDuplicates = [];
    const processed = new Set();
    
    for (let i = 0; i < contributors.length; i++) {
      const contributor1 = contributors[i];
      if (processed.has(contributor1.id)) continue;
      
      const similarContributors = [contributor1];
      
      for (let j = i + 1; j < contributors.length; j++) {
        const contributor2 = contributors[j];
        if (processed.has(contributor2.id)) continue;
        
        if (areSimilar(contributor1, contributor2)) {
          similarContributors.push(contributor2);
          processed.add(contributor2.id);
        }
      }
      
      if (similarContributors.length > 1) {
        potentialDuplicates.push({
          primary_candidate: contributor1.github_login,
          similar_contributors: similarContributors.map(c => ({
            github_login: c.github_login,
            email: c.email,
            canonical_name: c.canonical_name
          })),
          suggestion: {
            primary_github_login: contributor1.github_login,
            github_usernames: similarContributors.map(c => c.github_login),
            emails: similarContributors.map(c => c.email).filter(e => e),
            names: similarContributors.map(c => c.canonical_name),
            priority: "automatic"
          }
        });
      }
      
      processed.add(contributor1.id);
    }
    
    if (potentialDuplicates.length > 0) {
      const reportPath = path.join(process.cwd(), '.github', 'data', 'potential_duplicates_report.json');
      const dir = path.dirname(reportPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      
      fs.writeFileSync(reportPath, JSON.stringify({ potential_duplicates: potentialDuplicates }, null, 2));
      console.log(`📊 Found ${potentialDuplicates.length} potential duplicate groups`);
      console.log(`📄 Report saved to: ${reportPath}`);
    } else {
      console.log('✅ No potential duplicates found');
    }
    
  } catch (error) {
    console.error('❌ Error finding duplicates:', error);
  }
}

function areSimilar(contributor1, contributor2) {
  // Check email similarity
  if (contributor1.email && contributor2.email) {
    const email1Clean = contributor1.email.replace(/@(gmail|yahoo|hotmail|outlook)\.com$/, '@email.com');
    const email2Clean = contributor2.email.replace(/@(gmail|yahoo|hotmail|outlook)\.com$/, '@email.com');
    
    if (calculateSimilarity(email1Clean, email2Clean) >= 0.80) {
      return true;
    }
  }
  
  // Check username similarity
  if (calculateSimilarity(contributor1.github_login, contributor2.github_login) >= 0.80) {
    return true;
  }
  
  // Check canonical name similarity
  if (contributor1.canonical_name && contributor2.canonical_name) {
    if (calculateSimilarity(contributor1.canonical_name, contributor2.canonical_name) >= 0.80) {
      return true;
    }
  }
  
  return false;
}

function calculateSimilarity(str1, str2) {
  const distance = levenshteinDistance(str1.toLowerCase(), str2.toLowerCase());
  const maxLength = Math.max(str1.length, str2.length);
  return maxLength === 0 ? 1 : 1 - (distance / maxLength);
}

function levenshteinDistance(str1, str2) {
  const matrix = Array(str2.length + 1).fill().map(() => Array(str1.length + 1).fill(0));
  
  for (let i = 0; i <= str1.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= str2.length; j++) matrix[j][0] = j;
  
  for (let j = 1; j <= str2.length; j++) {
    for (let i = 1; i <= str1.length; i++) {
      const cost = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,
        matrix[j - 1][i] + 1,
        matrix[j - 1][i - 1] + cost
      );
    }
  }
  
  return matrix[str2.length][str1.length];
}

// Command line interface
async function main() {
  const command = process.argv[2];
  
  switch (command) {
    case 'sync':
      await syncDuplicatesToDatabase();
      break;
    case 'export':
      await exportDuplicatesFromDatabase();
      break;
    case 'find':
      await findPotentialDuplicates();
      break;
    case 'init':
      await loadDuplicatesFromFile();
      await syncDuplicatesToDatabase();
      break;
    default:
      console.log(`
📋 Duplicate Contributors Manager

Usage: node manage-duplicates.js <command>

Commands:
  init    - Initialize with sample data and sync to database
  sync    - Sync duplicate_contributors.json to database
  export  - Export database duplicates to JSON file
  find    - Find potential duplicates and generate report

Files:
  .github/data/duplicate_contributors.json - Manual duplicate mappings
  .github/data/potential_duplicates_report.json - Auto-generated report
      `);
  }
}

if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  syncDuplicatesToDatabase,
  exportDuplicatesFromDatabase,
  findPotentialDuplicates
};
