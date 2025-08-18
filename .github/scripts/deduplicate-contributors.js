// .github/scripts/deduplicate-contributors.js
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Predefined merge rules for known contributors
const MERGE_RULES = [
  {
    canonical_name: 'ehsanmirsaeedi',
    preferred_github_login: 'mirsaeedi',
    merge_with: ['ehsan', 'ehsanmirsaeedi']
  },
  {
    canonical_name: 'fahimehhajari',
    preferred_github_login: 'fahimeh1368',  // Use the actual GitHub username
    merge_with: ['fahimehhajari', 'fahimeh1368']
  },
  {
    canonical_name: 'samanehmalmir',
    preferred_github_login: 'saman9452',  // Use the correct GitHub username
    merge_with: ['samanemalmir73', 'saman9452']
  },
  {
    canonical_name: 'mohammadalisefidiesfahani',
    preferred_github_login: 'mojtabaSefidi',  // Use the correct GitHub username
    merge_with: ['mohammadalisefidiesfahani', 'mojtabasefidi']
  }
];

async function deduplicateContributors() {
  console.log('🔍 Starting contributor deduplication...');
  
  try {
    const { data: contributors, error } = await supabase
      .from('contributors')
      .select('*')
      .order('id');
    
    if (error) throw error;
    
    console.log(`📊 Found ${contributors.length} contributors to analyze`);
    
    let mergeCount = 0;
    let autoDetectedCount = 0;
    const processedContributors = new Set();
    
    // Process predefined merge rules first
    for (const rule of MERGE_RULES) {
      console.log(`🔄 Processing merge rule for ${rule.canonical_name}...`);
      
      // Find contributors that match this merge rule
      const matchingContributors = contributors.filter(c => 
        rule.merge_with.some(name => 
          c.github_login.toLowerCase() === name.toLowerCase() ||
          c.canonical_name.toLowerCase() === name.toLowerCase()
        ) && !processedContributors.has(c.id)
      );
      
      if (matchingContributors.length > 1) {
        console.log(`🎯 Found ${matchingContributors.length} contributors to merge:`, matchingContributors.map(c => c.github_login));
        
        // Choose the primary contributor using enhanced logic
        const primary = choosePrimaryContributor(matchingContributors, rule);
        const duplicates = matchingContributors.filter(c => c.id !== primary.id);
        
        console.log(`👑 Primary contributor selected: ${primary.github_login} (ID: ${primary.id})`);
        console.log(`🔄 Duplicates to merge: ${duplicates.map(d => `${d.github_login} (ID: ${d.id})`).join(', ')}`);
        
        // Update the primary contributor with preferred information
        await updatePrimaryContributor(primary, rule);
        
        // Merge contributions and delete duplicates
        for (const duplicate of duplicates) {
          await mergeContributions(duplicate.id, primary.id);
          await deleteContributor(duplicate.id);
          processedContributors.add(duplicate.id);
        }
        
        processedContributors.add(primary.id);
        mergeCount++;
        
        console.log(`✅ Merged contributors for: ${rule.canonical_name}`);
      } else {
        console.log(`ℹ️ No duplicates found for: ${rule.canonical_name}`);
      }
    }
    
    // Auto-detect potential duplicates for manual review
    const remainingContributors = contributors.filter(c => !processedContributors.has(c.id));
    const potentialDuplicates = await detectPotentialDuplicates(remainingContributors);
    
    if (potentialDuplicates.length > 0) {
      console.log('🤖 Auto-detecting potential duplicates...');
      autoDetectedCount = potentialDuplicates.length;
    }
    
    console.log('🎉 Deduplication completed!');
    console.log(`📈 Statistics:
    - Manual merge rules processed: ${MERGE_RULES.length}
    - Contributors merged: ${mergeCount}
    - Auto-detected potential duplicates: ${autoDetectedCount}`);
    
    if (potentialDuplicates.length > 0) {
      console.log('\n🤖 Auto-detected potential duplicates (review manually):');
      potentialDuplicates.forEach(group => {
        console.log(`- Similar: ${group.map(c => c.github_login).join(', ')}`);
      });
    }
    
  } catch (error) {
    console.error('❌ Error during deduplication:', error);
    throw error;
  }
}

function choosePrimaryContributor(contributors, rule) {
  // Priority 1: Use the preferred GitHub login from the rule
  if (rule.preferred_github_login) {
    const preferred = contributors.find(c => 
      c.github_login.toLowerCase() === rule.preferred_github_login.toLowerCase()
    );
    if (preferred) {
      console.log(`🎯 Using rule-specified preferred contributor: ${preferred.github_login}`);
      return preferred;
    }
  }
  
  // Priority 2: Choose based on GitHub username quality
  const scored = contributors.map(c => ({
    contributor: c,
    score: calculateContributorScore(c)
  })).sort((a, b) => b.score - a.score);
  
  console.log('🔍 Contributor scores:', scored.map(s => `${s.contributor.github_login}: ${s.score}`));
  
  return scored[0].contributor;
}

function calculateContributorScore(contributor) {
  let score = 0;
  
  // Higher score for GitHub noreply emails (most reliable)
  if (contributor.email && contributor.email.includes('@users.noreply.github.com')) {
    score += 100;
  }
  
  // Higher score for valid GitHub username patterns
  if (isValidGitHubUsername(contributor.github_login)) {
    score += 50;
  }
  
  // Lower score for obviously normalized names (all lowercase, no separators)
  if (contributor.github_login === contributor.canonical_name) {
    score -= 20;
  }
  
  // Higher score for usernames that aren't just normalized full names
  if (!looksLikeNormalizedName(contributor.github_login)) {
    score += 30;
  }
  
  // Higher score for shorter, more username-like strings
  if (contributor.github_login.length <= 20) {
    score += 10;
  }
  
  // Higher score if it contains numbers (common in usernames)
  if (/\d/.test(contributor.github_login)) {
    score += 20;
  }
  
  return score;
}

function isValidGitHubUsername(username) {
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/.test(username);
}

function looksLikeNormalizedName(username) {
  // Check if it looks like a normalized full name (e.g., "johndoesmith")
  // This is heuristic - long strings with no numbers or special chars
  return username.length > 15 && !/\d/.test(username) && !/[-_]/.test(username);
}

async function updatePrimaryContributor(primary, rule) {
  const updates = {
    canonical_name: rule.canonical_name
  };
  
  // Update github_login if specified in rule
  if (rule.preferred_github_login && 
      primary.github_login.toLowerCase() !== rule.preferred_github_login.toLowerCase()) {
    updates.github_login = rule.preferred_github_login;
    console.log(`🔄 Updating GitHub login from '${primary.github_login}' to '${rule.preferred_github_login}'`);
  }
  
  const { error } = await supabase
    .from('contributors')
    .update(updates)
    .eq('id', primary.id);
  
  if (error) {
    console.error('Error updating primary contributor:', error);
    throw error;
  }
  
  console.log(`📝 Updated primary contributor (ID: ${primary.id}) with preferred profile`);
}

async function mergeContributions(fromContributorId, toContributorId) {
  // Update all contributions from duplicate to primary
  const { data, error } = await supabase
    .from('contributions')
    .update({ contributor_id: toContributorId })
    .eq('contributor_id', fromContributorId)
    .select('id');
  
  if (error) {
    console.error('Error merging contributions:', error);
    throw error;
  }
  
  const mergedCount = data ? data.length : 0;
  console.log(`🔗 Merged ${mergedCount} contributions from duplicate to primary`);
}

async function deleteContributor(contributorId) {
  const { error } = await supabase
    .from('contributors')
    .delete()
    .eq('id', contributorId);
  
  if (error) {
    console.error('Error deleting contributor:', error);
    throw error;
  }
  
  console.log(`🗑️ Deleted duplicate contributor (ID: ${contributorId})`);
}

async function detectPotentialDuplicates(contributors) {
  const groups = [];
  const processed = new Set();
  
  for (let i = 0; i < contributors.length; i++) {
    if (processed.has(i)) continue;
    
    const similar = [contributors[i]];
    processed.add(i);
    
    for (let j = i + 1; j < contributors.length; j++) {
      if (processed.has(j)) continue;
      
      if (areSimilar(contributors[i], contributors[j])) {
        similar.push(contributors[j]);
        processed.add(j);
      }
    }
    
    if (similar.length > 1) {
      groups.push(similar);
    }
  }
  
  return groups;
}

function areSimilar(c1, c2) {
  // Check email similarity
  if (c1.email && c2.email && c1.email.toLowerCase() === c2.email.toLowerCase()) {
    return true;
  }
  
  // Check name similarity (Levenshtein distance)
  const nameDistance = levenshteinDistance(
    c1.canonical_name.toLowerCase(), 
    c2.canonical_name.toLowerCase()
  );
  
  const maxLen = Math.max(c1.canonical_name.length, c2.canonical_name.length);
  const similarity = 1 - (nameDistance / maxLen);
  
  return similarity > 0.8; // 80% similarity threshold
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

// Run if called directly
if (require.main === module) {
  deduplicateContributors();
}

module.exports = { deduplicateContributors };
