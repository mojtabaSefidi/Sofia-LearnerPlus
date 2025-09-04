// .github/scripts/contributor-utils.js
// Utility functions for managing duplicate contributors

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

/**
 * Add a new duplicate contributor mapping
 * @param {string} primaryLogin - The primary GitHub login to use
 * @param {string[]} githubUsernames - Array of alternative GitHub usernames
 * @param {string[]} emails - Array of alternative emails
 * @param {string[]} names - Array of alternative names
 * @param {string} priority - Priority level ('manual', 'automatic', 'high_confidence')
 */
async function addDuplicateMapping(primaryLogin, githubUsernames = [], emails = [], names = [], priority = 'manual') {
  try {
    const { data, error } = await supabase
      .from('duplicate_contributors')
      .insert({
        primary_github_login: primaryLogin,
        github_usernames: githubUsernames,
        emails: emails,
        names: names,
        priority: priority
      })
      .select()
      .single();
    
    if (error) {
      if (error.code === '23505') {
        console.log(`⚠️ Duplicate mapping already exists for ${primaryLogin}`);
        return false;
      }
      throw error;
    }
    
    console.log(`✅ Added duplicate mapping for ${primaryLogin}`);
    return true;
    
  } catch (error) {
    console.error('Error adding duplicate mapping:', error);
    return false;
  }
}

/**
 * Update an existing duplicate contributor mapping
 * @param {string} primaryLogin - The primary GitHub login
 * @param {Object} updates - Object with fields to update
 */
async function updateDuplicateMapping(primaryLogin, updates) {
  try {
    const { data, error } = await supabase
      .from('duplicate_contributors')
      .update({
        ...updates,
        updated_at: new Date()
      })
      .eq('primary_github_login', primaryLogin)
      .select()
      .single();
    
    if (error) throw error;
    
    console.log(`✅ Updated duplicate mapping for ${primaryLogin}`);
    return true;
    
  } catch (error) {
    console.error('Error updating duplicate mapping:', error);
    return false;
  }
}

/**
 * Get all duplicate contributor mappings
 */
async function getAllDuplicateMappings() {
  try {
    const { data, error } = await supabase
      .from('duplicate_contributors')
      .select('*')
      .order('created_at');
    
    if (error) throw error;
    
    return data;
    
  } catch (error) {
    console.error('Error fetching duplicate mappings:', error);
    return [];
  }
}

/**
 * Remove a duplicate contributor mapping
 * @param {string} primaryLogin - The primary GitHub login to remove
 */
async function removeDuplicateMapping(primaryLogin) {
  try {
    const { error } = await supabase
      .from('duplicate_contributors')
      .delete()
      .eq('primary_github_login', primaryLogin);
    
    if (error) throw error;
    
    console.log(`✅ Removed duplicate mapping for ${primaryLogin}`);
    return true;
    
  } catch (error) {
    console.error('Error removing duplicate mapping:', error);
    return false;
  }
}

/**
 * Find potential duplicate contributors that might need manual review
 */
async function findPotentialDuplicates() {
  try {
    const { data: contributors, error } = await supabase
      .from('contributors')
      .select('*')
      .order('canonical_name');
    
    if (error) throw error;
    
    const potentialDuplicates = [];
    const processed = new Set();
    
    for (let i = 0; i < contributors.length; i++) {
      if (processed.has(i)) continue;
      
      const similar = [contributors[i]];
      processed.add(i);
      
      for (let j = i + 1; j < contributors.length; j++) {
        if (processed.has(j)) continue;
        
        if (areSimilarContributors(contributors[i], contributors[j])) {
          similar.push(contributors[j]);
          processed.add(j);
        }
      }
      
      if (similar.length > 1) {
        potentialDuplicates.push(similar);
      }
    }
    
    return potentialDuplicates;
    
  } catch (error) {
    console.error('Error finding potential duplicates:', error);
    return [];
  }
}

/**
 * Check if two contributors are similar
 */
function areSimilarContributors(c1, c2) {
  // Exact email match
  if (c1.email && c2.email && c1.email.toLowerCase() === c2.email.toLowerCase()) {
    return true;
  }
  
  // Similar canonical names
  const nameSimilarity = calculateStringSimilarity(
    c1.canonical_name.toLowerCase(), 
    c2.canonical_name.toLowerCase()
  );
  
  if (nameSimilarity > 0.85) {
    return true;
  }
  
  // Similar GitHub logins
  const loginSimilarity = calculateStringSimilarity(
    c1.github_login.toLowerCase(),
    c2.github_login.toLowerCase()
  );
  
  if (loginSimilarity > 0.85) {
    return true;
  }
  
  return false;
}

/**
 * Calculate string similarity using Levenshtein distance
 */
function calculateStringSimilarity(str1, str2) {
  const distance = levenshteinDistance(str1, str2);
  const maxLength = Math.max(str1.length, str2.length);
  return 1 - (distance / maxLength);
}

/**
 * Calculate Levenshtein distance between two strings
 */
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

/**
 * CLI interface for managing duplicate contributors
 */
async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  
  switch (command) {
    case 'add':
      if (args.length < 2) {
        console.log('Usage: node contributor-utils.js add <primary_login> [usernames] [emails] [names]');
        return;
      }
      
      const primaryLogin = args[1];
      const usernames = args[2] ? args[2].split(',') : [];
      const emails = args[3] ? args[3].split(',') : [];
      const names = args[4] ? args[4].split(',') : [];
      
      await addDuplicateMapping(primaryLogin, usernames, emails, names);
      break;
      
    case 'list':
      const mappings = await getAllDuplicateMappings();
      console.log('\n📋 Duplicate Contributor Mappings:');
      mappings.forEach(mapping => {
        console.log(`\n👤 ${mapping.primary_github_login} (${mapping.priority})`);
        console.log(`   GitHub usernames: ${mapping.github_usernames.join(', ')}`);
        console.log(`   Emails: ${mapping.emails.join(', ')}`);
        console.log(`   Names: ${mapping.names.join(', ')}`);
      });
      break;
      
    case 'find-duplicates':
      const potentialDuplicates = await findPotentialDuplicates();
      console.log('\n🔍 Potential Duplicate Contributors:');
      
      if (potentialDuplicates.length === 0) {
        console.log('No potential duplicates found!');
      } else {
        potentialDuplicates.forEach((group, index) => {
          console.log(`\nGroup ${index + 1}:`);
          group.forEach(contributor => {
            console.log(`  - ${contributor.github_login} (${contributor.canonical_name}) [${contributor.email || 'no email'}]`);
          });
        });
      }
      break;
      
    case 'remove':
      if (args.length < 2) {
        console.log('Usage: node contributor-utils.js remove <primary_login>');
        return;
      }
      
      await removeDuplicateMapping(args[1]);
      break;
      
    default:
      console.log(`
📖 Contributor Utils - Usage:

Commands:
  add <primary_login> [usernames] [emails] [names]  Add new duplicate mapping
  list                                              List all duplicate mappings  
  find-duplicates                                   Find potential duplicates
  remove <primary_login>                            Remove duplicate mapping

Examples:
  node contributor-utils.js add mirsaeedi "mirsaeedi,ehsan" "email1@test.com,email2@test.com" "Name A"
  node contributor-utils.js list
  node contributor-utils.js find-duplicates
  node contributor-utils.js remove mirsaeedi
      `);
  }
}

// Run if called directly
if (require.main === module) {
  main().catch(console.error);
}

module.exports = {
  addDuplicateMapping,
  updateDuplicateMapping,
  getAllDuplicateMappings,
  removeDuplicateMapping,
  findPotentialDuplicates,
  areSimilarContributors,
  calculateStringSimilarity,
  levenshteinDistance
};
