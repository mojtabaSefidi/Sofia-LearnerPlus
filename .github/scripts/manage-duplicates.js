// .github/scripts/manage-duplicates.js
const { createClient } = require('@supabase/supabase-js');
const core = require('@actions/core');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Manual merge rules - you can add new ones here
const MANUAL_MERGE_RULES = [
  {
    primary_github_login: 'mirsaeedi',
    merge_logins: ['ehsan', 'ehsanmirsaeedi'],
    merge_emails: ['ehsan@example.com', 'mirsaeedi@example.com'],
    merge_names: ['ehsanmirsaeedi', 'ehsan'],
    priority: 'manual'
  },
  {
    primary_github_login: 'fahimeh1368',
    merge_logins: ['fahimehhajari'],
    merge_emails: ['fahimeh@example.com', 'fahimehhajari@example.com'],
    merge_names: ['fahimehhajari', 'fahimeh hajari'],
    priority: 'manual'
  },
  {
    primary_github_login: 'saman9452',
    merge_logins: ['samanemalmir73'],
    merge_emails: ['saman@example.com', 'samaneh@example.com'],
    merge_names: ['samanehmalmir', 'samaneh malmir'],
    priority: 'manual'
  },
  {
    primary_github_login: 'mojtabaSefidi',
    merge_logins: ['mohammadalisefidiesfahani'],
    merge_emails: ['mojtaba@example.com', 'mohammadali@example.com'],
    merge_names: ['mohammadalisefidiesfahani', 'mohammad ali sefidi'],
    priority: 'manual'
  }
];

async function manageDuplicateContributors() {
  console.log('🔄 Managing duplicate contributors...');
  
  const action = process.env.ACTION || 'detect'; // detect, merge, list
  
  switch (action) {
    case 'detect':
      await detectAndRecordDuplicates();
      break;
    case 'merge':
      await mergeDuplicates();
      break;
    case 'list':
      await listPendingDuplicates();
      break;
    case 'add-manual':
      await addManualMergeRules();
      break;
    default:
      console.error('❌ Invalid action. Use: detect, merge, list, or add-manual');
      return;
  }
}

async function detectAndRecordDuplicates() {
  console.log('🔍 Detecting and recording duplicate contributors...');
  
  // First, apply manual merge rules
  await applyManualMergeRules();
  
  // Then detect automatic duplicates
  await detectAutomaticDuplicates();
}

async function applyManualMergeRules() {
  console.log('📋 Applying manual merge rules...');
  
  for (const rule of MANUAL_MERGE_RULES) {
    console.log(`🔄 Processing rule for ${rule.primary_github_login}...`);
    
    // Find the primary contributor
    const { data: primaryContributor, error: primaryError } = await supabase
      .from('contributors')
      .select('*')
      .eq('github_login', rule.primary_github_login)
      .single();
      
    if (primaryError || !primaryContributor) {
      console.warn(`⚠️ Primary contributor ${rule.primary_github_login} not found`);
      continue;
    }
    
    // Find contributors that match this rule
    const matchingContributors = await findMatchingContributors(rule);
    
    if (matchingContributors.length > 0) {
      console.log(`🎯 Found ${matchingContributors.length} contributors to merge with ${rule.primary_github_login}`);
      
      // Record as duplicates with high priority
      for (const contributor of matchingContributors) {
        if (contributor.id !== primaryContributor.id) {
          await recordDuplicate(
            primaryContributor.id,
            contributor,
            1.0,
            'manual',
            `Manual merge rule for ${rule.primary_github_login}`
          );
        }
      }
    } else {
      console.log(`ℹ️ No matching contributors found for rule ${rule.primary_github_login}`);
    }
  }
}

async function findMatchingContributors(rule) {
  const { data: contributors, error } = await supabase
    .from('contributors')
    .select('*');
    
  if (error) {
    console.error('Error fetching contributors:', error);
    return [];
  }
  
  const matching = [];
  
  for (const contributor of contributors) {
    // Check GitHub login matches
    if (rule.merge_logins?.some(login => 
      contributor.github_login.toLowerCase() === login.toLowerCase())) {
      matching.push(contributor);
      continue;
    }
    
    // Check email matches
    if (contributor.email && rule.merge_emails?.some(email => 
      contributor.email.toLowerCase() === email.toLowerCase())) {
      matching.push(contributor);
      continue;
    }
    
    // Check name matches
    if (rule.merge_names?.some(name => 
      contributor.canonical_name.toLowerCase() === name.toLowerCase())) {
      matching.push(contributor);
      continue;
    }
  }
  
  return matching;
}

async function detectAutomaticDuplicates() {
  console.log('🤖 Detecting automatic duplicates...');
  
  const { data: contributors, error } = await supabase
    .from('contributors')
    .select('*')
    .eq('is_primary', true);
    
  if (error) {
    console.error('Error fetching contributors:', error);
    return;
  }
  
  console.log(`📊 Analyzing ${contributors.length} contributors...`);
  
  const processed = new Set();
  let duplicateGroupsFound = 0;
  
  for (let i = 0; i < contributors.length; i++) {
    if (processed.has(contributors[i].id)) continue;
    
    const similar = [contributors[i]];
    processed.add(contributors[i].id);
    
    // Find similar contributors
    for (let j = i + 1; j < contributors.length; j++) {
      if (processed.has(contributors[j].id)) continue;
      
      const similarity = calculateContributorSimilarity(contributors[i], contributors[j]);
      if (similarity >= 0.80) { // High similarity threshold
        similar.push(contributors[j]);
        processed.add(contributors[j].id);
      }
    }
    
    // If we found potential duplicates, record them
    if (similar.length > 1) {
      const primary = chooseBestPrimaryContributor(similar);
      const duplicates = similar.filter(c => c.id !== primary.id);
      
      console.log(`🔍 Found duplicate group: ${primary.github_login} + ${duplicates.map(d => d.github_login).join(', ')}`);
      
      for (const duplicate of duplicates) {
        const similarity = calculateContributorSimilarity(primary, duplicate);
        await recordDuplicate(
          primary.id,
          duplicate,
          similarity,
          similarity >= 0.90 ? 'auto-high' : 'auto-medium',
          `Auto-detected similarity: ${(similarity * 100).toFixed(1)}%`
        );
      }
      
      duplicateGroupsFound++;
    }
  }
  
  console.log(`🔍 Detection complete: ${duplicateGroupsFound} duplicate groups found`);
}

function calculateContributorSimilarity(c1, c2) {
  let maxSimilarity = 0;
  
  // Email exact match gets highest score
  if (c1.email && c2.email && c1.email.toLowerCase() === c2.email.toLowerCase()) {
    return 1.0;
  }
  
  // GitHub login similarity
  if (c1.github_login && c2.github_login) {
    const loginSim = stringSimilarity(c1.github_login, c2.github_login);
    maxSimilarity = Math.max(maxSimilarity, loginSim);
  }
  
  // Canonical name similarity
  if (c1.canonical_name && c2.canonical_name) {
    const nameSim = stringSimilarity(c1.canonical_name, c2.canonical_name);
    maxSimilarity = Math.max(maxSimilarity, nameSim);
  }
  
  // Cross-field similarities (login vs name, etc.)
  if (c1.github_login && c2.canonical_name) {
    const crossSim = stringSimilarity(c1.github_login, c2.canonical_name);
    maxSimilarity = Math.max(maxSimilarity, crossSim);
  }
  
  if (c1.canonical_name && c2.github_login) {
    const crossSim = stringSimilarity(c1.canonical_name, c2.github_login);
    maxSimilarity = Math.max(maxSimilarity, crossSim);
  }
  
  return maxSimilarity;
}

function stringSimilarity(str1, str2) {
  const distance = levenshteinDistance(str1.toLowerCase(), str2.toLowerCase());
  const maxLength = Math.max(str1.length, str2.length);
  return maxLength === 0 ? 1.0 : 1 - (distance / maxLength);
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

function chooseBestPrimaryContributor(contributors) {
  const scored = contributors.map(c => ({
    contributor: c,
    score: calculatePrimaryScore(c)
  })).sort((a, b) => b.score - a.score);
  
  return scored[0].contributor;
}

function calculatePrimaryScore(contributor) {
  let score = 0;
  
  // Prefer contributors with GitHub noreply emails (most reliable)
  if (contributor.email && contributor.email.includes('@users.noreply.github.com')) {
    score += 100;
  }
  
  // Prefer valid GitHub usernames
  if (isValidGitHubUsername(contributor.github_login)) {
    score += 50;
  }
  
  // Prefer contributors with email addresses
  if (contributor.email) {
    score += 30;
  }
  
  // Prefer shorter, more username-like identifiers
  if (contributor.github_login.length <= 20) {
    score += 20;
  }
  
  // Prefer usernames with numbers (common pattern)
  if (/\d/.test(contributor.github_login)) {
    score += 15;
  }
  
  // Penalize obvious name normalizations
  if (contributor.github_login === contributor.canonical_name) {
    score -= 25;
  }
  
  return score;
}

function isValidGitHubUsername(username) {
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/.test(username);
}

async function recordDuplicate(primaryId, duplicate, similarity, priority, notes) {
  const { error } = await supabase
    .from('duplicate_contributors')
    .upsert({
      primary_contributor_id: primaryId,
      github_login: duplicate.github_login,
      email: duplicate.email,
      canonical_name: duplicate.canonical_name,
      similarity_score: similarity,
      merge_priority: priority,
      is_merged: false,
      notes: notes
    }, { onConflict: 'primary_contributor_id,github_login' });
    
  if (error) {
    console.error(`Error recording duplicate for ${duplicate.github_login}:`, error);
  } else {
    console.log(`📝 Recorded duplicate: ${duplicate.github_login} -> primary ID ${primaryId} (${priority}, ${(similarity * 100).toFixed(1)}%)`);
  }
}

async function mergeDuplicates() {
  console.log('🔀 Merging approved duplicates...');
  
  const mergeAll = process.env.MERGE_ALL === 'true';
  const mergePriority = process.env.MERGE_PRIORITY || 'manual';
  
  // Get pending duplicates to merge
  let query = supabase
    .from('duplicate_contributors')
    .select(`
      *,
      primary_contributor:contributors!primary_contributor_id(*)
    `)
    .eq('is_merged', false);
    
  if (!mergeAll) {
    query = query.eq('merge_priority', mergePriority);
  }
  
  const { data: duplicates, error } = await query;
  
  if (error) {
    console.error('Error fetching duplicates to merge:', error);
    return;
  }
  
  console.log(`🔀 Found ${duplicates.length} duplicates to merge`);
  
  let mergedCount = 0;
  let errorCount = 0;
  
  for (const duplicate of duplicates) {
    try {
      // Find the duplicate contributor
      const { data: duplicateContributor, error: findError } = await supabase
        .from('contributors')
        .select('*')
        .eq('github_login', duplicate.github_login)
        .single();
        
      if (findError || !duplicateContributor) {
        console.warn(`⚠️ Could not find duplicate contributor: ${duplicate.github_login}`);
        continue;
      }
      
      console.log(`🔀 Merging ${duplicateContributor.github_login} (ID: ${duplicateContributor.id}) -> ${duplicate.primary_contributor.github_login} (ID: ${duplicate.primary_contributor_id})`);
      
      // Merge contributions
      await mergeContributions(duplicateContributor.id, duplicate.primary_contributor_id);
      
      // Merge review comments
      await mergeReviewComments(duplicateContributor.id, duplicate.primary_contributor_id);
      
      // Mark duplicate as merged
      const { error: markError } = await supabase
        .from('duplicate_contributors')
        .update({ is_merged: true })
        .eq('id', duplicate.id);
        
      if (markError) {
        console.error(`Error marking duplicate as merged:`, markError);
      }
      
      // Delete the duplicate contributor
      const { error: deleteError } = await supabase
        .from('contributors')
        .delete()
        .eq('id', duplicateContributor.id);
        
      if (deleteError) {
        console.error(`Error deleting duplicate contributor:`, deleteError);
        errorCount++;
      } else {
        mergedCount++;
        console.log(`✅ Successfully merged ${duplicateContributor.github_login}`);
      }
      
    } catch (error) {
      console.error(`Error merging duplicate ${duplicate.github_login}:`, error);
      errorCount++;
    }
  }
  
  console.log(`🔀 Merge complete: ${mergedCount} merged, ${errorCount} errors`);
}

async function mergeContributions(fromContributorId, toContributorId) {
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
  if (mergedCount > 0) {
    console.log(`  🔗 Merged ${mergedCount} contributions`);
  }
}

async function mergeReviewComments(fromContributorId, toContributorId) {
  const { data, error } = await supabase
    .from('review_comments')
    .update({ contributor_id: toContributorId })
    .eq('contributor_id', fromContributorId)
    .select('id');
    
  if (error) {
    console.error('Error merging review comments:', error);
    throw error;
  }
  
  const mergedCount = data ? data.length : 0;
  if (mergedCount > 0) {
    console.log(`  💬 Merged ${mergedCount} review comments`);
  }
}

async function listPendingDuplicates() {
  console.log('📋 Listing pending duplicates...');
  
  const { data: duplicates, error } = await supabase
    .from('duplicate_contributors')
    .select(`
      *,
      primary_contributor:contributors!primary_contributor_id(github_login, email)
    `)
    .eq('is_merged', false)
    .order('similarity_score', { ascending: false });
    
  if (error) {
    console.error('Error fetching pending duplicates:', error);
    return;
  }
  
  console.log(`📊 Found ${duplicates.length} pending duplicates:\n`);
  
  // Group by priority
  const grouped = duplicates.reduce((acc, dup) => {
    if (!acc[dup.merge_priority]) {
      acc[dup.merge_priority] = [];
    }
    acc[dup.merge_priority].push(dup);
    return acc;
  }, {});
  
  for (const [priority, dups] of Object.entries(grouped)) {
    console.log(`🔸 ${priority.toUpperCase()} PRIORITY (${dups.length} items):`);
    
    dups.forEach(dup => {
      console.log(`  ${dup.github_login} -> ${dup.primary_contributor.github_login}`);
      console.log(`    Similarity: ${(dup.similarity_score * 100).toFixed(1)}%`);
      if (dup.notes) console.log(`    Notes: ${dup.notes}`);
      console.log('');
    });
  }
  
  // Summary by priority
  console.log('📈 Summary:');
  for (const [priority, dups] of Object.entries(grouped)) {
    console.log(`  ${priority}: ${dups.length} duplicates`);
  }
}

async function addManualMergeRules() {
  console.log('📝 Adding manual merge rules to database...');
  
  for (const rule of MANUAL_MERGE_RULES) {
    // Find primary contributor
    const { data: primary, error: primaryError } = await supabase
      .from('contributors')
      .select('*')
      .eq('github_login', rule.primary_github_login)
      .single();
      
    if (primaryError || !primary) {
      console.warn(`⚠️ Primary contributor ${rule.primary_github_login} not found, skipping rule`);
      continue;
    }
    
    console.log(`📋 Processing rule for ${rule.primary_github_login}...`);
    
    // Find and record all matching contributors as duplicates
    const allIdentifiers = [
      ...(rule.merge_logins || []),
      ...(rule.merge_emails || []),
      ...(rule.merge_names || [])
    ];
    
    for (const identifier of allIdentifiers) {
      // Try to find contributor by login, email, or name
      const { data: contributors, error } = await supabase
        .from('contributors')
        .select('*')
        .or(`github_login.ilike.${identifier},email.ilike.${identifier},canonical_name.ilike.${identifier}`)
        .neq('id', primary.id);
        
      if (!error && contributors && contributors.length > 0) {
        for (const contributor of contributors) {
          await recordDuplicate(
            primary.id,
            contributor,
            1.0,
            rule.priority,
            `Manual rule for ${rule.primary_github_login}: ${identifier}`
          );
        }
      }
    }
  }
  
  console.log('✅ Manual merge rules processing complete');
}

// Run if called directly
if (require.main === module) {
  manageDuplicateContributors().catch(error => {
    console.error('❌ Error in duplicate management:', error);
    core.setFailed(error.message);
  });
}

module.exports = { manageDuplicateContributors };
