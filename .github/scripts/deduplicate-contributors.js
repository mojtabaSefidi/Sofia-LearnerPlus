// .github/scripts/deduplicate-contributors.js
const { createClient } = require('@supabase/supabase-js');
const core = require('@actions/core');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Define contributor merge rules
const CONTRIBUTOR_MERGE_RULES = [
  // Ehsan - merge by similar names and email domains
  {
    primaryId: null, // Will be determined
    identifiers: [
      { github_login: 'ehsanmirsaeedi' },
      { github_login: 'ehsan' },
      { email: 'mirsaeedi@outlook.com' },
      { email: 'ehsan@dacunha.encs.concordia.ca' }
    ],
    preferredProfile: {
      github_login: 'ehsanmirsaeedi',
      canonical_name: 'ehsanmirsaeedi',
      email: 'mirsaeedi@outlook.com'
    }
  },
  // Fahimeh - merge by similar names
  {
    primaryId: null,
    identifiers: [
      { github_login: 'fahimehhajari' },
      { github_login: 'fahimeh' },
      { email: 'fahime.hajari@gmail.com' },
      { email: '54951311+fahimeh1368@users.noreply.github.com' }
    ],
    preferredProfile: {
      github_login: 'fahimehhajari',
      canonical_name: 'fahimehhajari',
      email: 'fahime.hajari@gmail.com'
    }
  },
  // Samane/Saman - merge by similar emails (case insensitive)
  {
    primaryId: null,
    identifiers: [
      { github_login: 'saman9452' },
      { github_login: 'samanehmalmir' },
      { email: 'Samanemalmir73@gmail.com' },
      { email: 'samanemalmir73@gmail.com' }
    ],
    preferredProfile: {
      github_login: 'samanehmalmir',
      canonical_name: 'samanehmalmir',
      email: 'samanemalmir73@gmail.com'
    }
  }
];

async function deduplicateContributors() {
  console.log('🔍 Starting contributor deduplication...');
  
  try {
    // Get all contributors
    const { data: allContributors, error } = await supabase
      .from('contributors')
      .select('*')
      .order('id');
    
    if (error) throw error;
    
    console.log(`📊 Found ${allContributors.length} contributors to analyze`);
    
    let mergedCount = 0;
    
    for (const mergeRule of CONTRIBUTOR_MERGE_RULES) {
      const result = await processMergeRule(mergeRule, allContributors);
      if (result.merged) {
        mergedCount++;
        console.log(`✅ Merged contributors for: ${result.preferredProfile.canonical_name}`);
      }
    }
    
    // Auto-detect additional duplicates
    const autoDetectedMerges = await autoDetectDuplicates(allContributors);
    
    console.log(`🎉 Deduplication completed!`);
    console.log(`📈 Statistics:
    - Manual merge rules processed: ${CONTRIBUTOR_MERGE_RULES.length}
    - Contributors merged: ${mergedCount}
    - Auto-detected potential duplicates: ${autoDetectedMerges.length}`);
    
    if (autoDetectedMerges.length > 0) {
      console.log('\n🤖 Auto-detected potential duplicates (review manually):');
      autoDetectedMerges.forEach(group => {
        console.log(`- Similar: ${group.map(c => c.github_login).join(', ')}`);
      });
    }
    
  } catch (error) {
    console.error('❌ Error during deduplication:', error);
    core.setFailed(error.message);
  }
}

// Updated processMergeRule
async function processMergeRule(mergeRule, allContributors) {
  console.log(`🔄 Processing merge rule for ${mergeRule.preferredProfile.canonical_name}...`);
  
  const matchingContributors = [];
  
  for (const contributor of allContributors) {
    const matches = mergeRule.identifiers.some(identifier => {
      if (identifier.github_login && contributor.github_login === identifier.github_login) return true;
      if (identifier.email && contributor.email && 
          contributor.email.toLowerCase() === identifier.email.toLowerCase()) return true;
      if (identifier.canonical_name && contributor.canonical_name === identifier.canonical_name) return true;
      return false;
    });
    if (matches) matchingContributors.push(contributor);
  }
  
  if (matchingContributors.length <= 1) {
    console.log(`ℹ️ Only ${matchingContributors.length} contributor found for this rule, skipping`);
    return { merged: false };
  }
  
  console.log(`🎯 Found ${matchingContributors.length} contributors to merge:`, 
    matchingContributors.map(c => c.github_login));
  
  matchingContributors.sort((a, b) => a.id - b.id);
  const primaryContributor = matchingContributors[0];
  const duplicateContributors = matchingContributors.slice(1);
  
  try {
    await updatePrimaryContributorSafely(primaryContributor, mergeRule.preferredProfile);
  } catch (error) {
    console.warn(`⚠️ Could not update primary contributor profile: ${error.message}`);
  }
  
  for (const duplicate of duplicateContributors) {
    await mergeContributions(duplicate.id, primaryContributor.id);
    await deleteContributor(duplicate.id);
  }
  
  return { merged: true, primaryId: primaryContributor.id, preferredProfile: mergeRule.preferredProfile };
}

async function updatePrimaryContributorSafely(primaryContributor, preferredProfile) {
  const { data: existingWithLogin } = await supabase
    .from('contributors')
    .select('id')
    .eq('github_login', preferredProfile.github_login)
    .neq('id', primaryContributor.id)
    .single();
  
  const updateData = {
    canonical_name: preferredProfile.canonical_name,
    email: preferredProfile.email
  };
  
  if (!existingWithLogin) {
    updateData.github_login = preferredProfile.github_login;
  } else {
    console.log(`⚠️ GitHub login '${preferredProfile.github_login}' already exists, keeping original: '${primaryContributor.github_login}'`);
  }
  
  const { error } = await supabase
    .from('contributors')
    .update(updateData)
    .eq('id', primaryContributor.id);
  
  if (error) {
    console.error('Error updating primary contributor:', error);
    throw error;
  }
  
  console.log(`📝 Updated primary contributor (ID: ${primaryContributor.id}) with preferred profile`);
}

async function mergeContributions(duplicateId, primaryId) {
  const { data, error } = await supabase
    .from('contributions')
    .update({ contributor_id: primaryId })
    .eq('contributor_id', duplicateId)
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
    console.error('Error deleting duplicate contributor:', error);
    throw error;
  }
  
  console.log(`🗑️ Deleted duplicate contributor (ID: ${contributorId})`);
}

// Enhanced auto-detection
async function autoDetectDuplicates(contributors) {
  console.log('🤖 Auto-detecting potential duplicates...');
  
  const potentialGroups = [];
  const processed = new Set();
  
  for (let i = 0; i < contributors.length; i++) {
    if (processed.has(i)) continue;
    const current = contributors[i];
    const similarContributors = [current];
    processed.add(i);
    
    for (let j = i + 1; j < contributors.length; j++) {
      if (processed.has(j)) continue;
      const other = contributors[j];
      if (areSimilarEnhanced(current, other)) {
        similarContributors.push(other);
        processed.add(j);
      }
    }
    if (similarContributors.length > 1) potentialGroups.push(similarContributors);
  }
  
  let autoMergedCount = 0;
  const manualReviewGroups = [];
  
  for (const group of potentialGroups) {
    const confidence = calculateMergeConfidence(group);
    if (confidence > 0.9) {
      console.log(`🤖 Auto-merging high confidence group: ${group.map(c => c.github_login).join(', ')}`);
      await autoMergeGroup(group);
      autoMergedCount++;
    } else {
      manualReviewGroups.push(group);
    }
  }
  
  if (autoMergedCount > 0) {
    console.log(`🎯 Auto-merged ${autoMergedCount} high-confidence duplicate groups`);
  }
  
  return manualReviewGroups;
}

function areSimilarEnhanced(contributor1, contributor2) {
  if (contributor1.email && contributor2.email) {
    if (contributor1.email.toLowerCase() === contributor2.email.toLowerCase()) return true;
  }
  
  const name1 = contributor1.canonical_name.toLowerCase();
  const name2 = contributor2.canonical_name.toLowerCase();
  const login1 = contributor1.github_login.toLowerCase();
  const login2 = contributor2.github_login.toLowerCase();
  
  if (removeNumbersAndSpecialChars(name1) === removeNumbersAndSpecialChars(name2) && removeNumbersAndSpecialChars(name1).length > 3) return true;
  if (removeNumbersAndSpecialChars(login1) === removeNumbersAndSpecialChars(login2) && removeNumbersAndSpecialChars(login1).length > 3) return true;
  
  if (contributor1.email && contributor2.email) {
    const [local1, domain1] = contributor1.email.toLowerCase().split('@');
    const [local2, domain2] = contributor2.email.toLowerCase().split('@');
    if (domain1 === domain2 && calculateSimilarity(local1, local2) > 0.8) return true;
  }
  
  return false;
}

function removeNumbersAndSpecialChars(str) {
  return str.replace(/[0-9\-_\.]/g, '');
}

function calculateMergeConfidence(group) {
  let confidence = 0;
  const [first, ...rest] = group;
  
  for (const contributor of rest) {
    if (first.email && contributor.email && first.email.toLowerCase() === contributor.email.toLowerCase()) {
      confidence += 0.5;
    }
    confidence += calculateSimilarity(first.canonical_name.toLowerCase(), contributor.canonical_name.toLowerCase()) * 0.3;
    confidence += calculateSimilarity(first.github_login.toLowerCase(), contributor.github_login.toLowerCase()) * 0.2;
  }
  
  return Math.min(confidence / rest.length, 1.0);
}

async function autoMergeGroup(group) {
  group.sort((a, b) => a.id - b.id);
  const primary = group[0];
  const duplicates = group.slice(1);
  const bestProfile = chooseBestProfile(group);
  
  try {
    await updatePrimaryContributorSafely(primary, bestProfile);
  } catch (error) {
    console.warn(`⚠️ Could not update auto-merged contributor profile: ${error.message}`);
  }
  
  for (const duplicate of duplicates) {
    await mergeContributions(duplicate.id, primary.id);
    await deleteContributor(duplicate.id);
  }
}

function chooseBestProfile(group) {
  const withRealEmail = group.filter(c => c.email && !c.email.includes('noreply.github.com'));
  const preferredContributor = withRealEmail.length > 0 ? withRealEmail[0] : group[0];
  
  const bestLogin = group.reduce((best, current) => {
    if (!best.github_login) return current;
    if (!current.github_login) return best;
    if (current.github_login.length > best.github_login.length) return current;
    if (current.github_login.length === best.github_login.length && !current.github_login.match(/\d+$/)) return current;
    return best;
  }, group[0]);
  
  return {
    github_login: bestLogin.github_login,
    canonical_name: preferredContributor.canonical_name,
    email: preferredContributor.email
  };
}

function calculateSimilarity(str1, str2) {
  const longer = str1.length > str2.length ? str1 : str2;
  const shorter = str1.length > str2.length ? str2 : str1;
  if (longer.length === 0) return 1.0;
  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

function levenshteinDistance(str1, str2) {
  const matrix = [];
  for (let i = 0; i <= str2.length; i++) matrix[i] = [i];
  for (let j = 0; j <= str1.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= str2.length; i++) {
    for (let j = 1; j <= str1.length; j++) {
      if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1,
          matrix[i][j - 1] + 1,
          matrix[i - 1][j] + 1
        );
      }
    }
  }
  return matrix[str2.length][str1.length];
}

if (require.main === module) {
  deduplicateContributors();
}

module.exports = { deduplicateContributors, CONTRIBUTOR_MERGE_RULES };
