// .github/scripts/initialize-repo-enhanced.js
const github = require('@actions/github');
const { createClient } = require('@supabase/supabase-js');
const git = require('simple-git')();
const core = require('@actions/core');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Configuration
const BATCH_SIZE = 100;
const MAX_RETRIES = 3;
const DELAY_BETWEEN_REQUESTS = 100; // ms
const LEVENSHTEIN_THRESHOLD = 0.80;

// Bot detection patterns
const BOT_PATTERNS = [
  /^@?\w*bot\b/i,
  /dependabot/i,
  /renovate/i,
  /^@sofiabot/i,
  /\\assign-reviewer/i,
  /assign\s+reviewer/i,
  /@sofiabot\s+assign/i
];

async function initializeRepository() {
  console.log('🚀 Starting enhanced repository initialization...');
  
  const processId = await startProcessTracking('initialization');
  
  try {
    const forceReinit = process.env.FORCE_REINIT === 'true';
    const incremental = process.env.INCREMENTAL === 'true' && !forceReinit;
    
    console.log(`📊 Configuration: Force=${forceReinit}, Incremental=${incremental}`);
    
    if (forceReinit) {
      await clearExistingData();
    }
    
    const lastProcessedCommit = incremental ? await getLastProcessedCommit() : null;
    console.log(`📍 Last processed commit: ${lastProcessedCommit || 'None (full scan)'}`);
    
    // Phase 1: Process commits
    const commitResults = await processCommits(lastProcessedCommit);
    
    // Phase 2: Process pull requests
    const prResults = await processPullRequests(incremental);
    
    // Phase 3: Handle duplicate contributors
    await processDuplicateContributors();
    
    // Phase 4: Insert all data
    await insertAllData(commitResults, prResults);
    
    // Phase 5: Update metadata
    await updateProcessingMetadata(commitResults, prResults);
    
    await completeProcessTracking(processId, {
      commits_processed: commitResults.commits.length,
      prs_processed: prResults.prs.length,
      contributors: commitResults.contributors.size + prResults.contributors.size,
      files: commitResults.files.size + prResults.files.size
    });
    
    console.log('✅ Repository initialization completed successfully!');
    
  } catch (error) {
    await failProcessTracking(processId, error.message);
    console.error('❌ Error during initialization:', error);
    core.setFailed(error.message);
    throw error;
  }
}

async function startProcessTracking(processType) {
  const { data, error } = await supabase
    .from('processing_status')
    .insert({
      process_type: processType,
      status: 'running',
      metadata: { started_by: process.env.GITHUB_ACTOR || 'system' }
    })
    .select('id')
    .single();
    
  if (error) throw error;
  return data.id;
}

async function completeProcessTracking(processId, metadata) {
  const { error } = await supabase
    .from('processing_status')
    .update({
      status: 'completed',
      completed_at: new Date().toISOString(),
      metadata
    })
    .eq('id', processId);
    
  if (error) throw error;
}

async function failProcessTracking(processId, errorMessage) {
  const { error } = await supabase
    .from('processing_status')
    .update({
      status: 'failed',
      completed_at: new Date().toISOString(),
      error_message: errorMessage
    })
    .eq('id', processId);
    
  if (error) console.error('Failed to update process tracking:', error);
}

async function clearExistingData() {
  console.log('🧹 Clearing existing data...');
  
  const tables = ['contributions', 'review_comments', 'pull_requests', 'file_history', 'files', 'duplicate_contributors', 'contributors'];
  
  for (const table of tables) {
    const { error } = await supabase.from(table).delete().neq('id', -1);
    if (error) {
      console.warn(`⚠️ Could not clear ${table}:`, error.message);
    } else {
      console.log(`🗑️ Cleared ${table}`);
    }
  }
}

async function getLastProcessedCommit() {
  const { data, error } = await supabase
    .from('repository_metadata')
    .select('value')
    .eq('key', 'last_scan_commit')
    .single();
    
  return error ? null : data?.value;
}

async function processCommits(lastProcessedCommit) {
  console.log('📝 Processing commits...');
  
  // Get commit log
  const logOptions = lastProcessedCommit 
    ? { from: lastProcessedCommit, to: 'HEAD' }
    : { '--all': null };
    
  const log = await git.log(logOptions);
  const commits = log.all.reverse(); // Process chronologically
  
  console.log(`📊 Found ${commits.length} commits to analyze`);
  
  const contributors = new Map();
  const files = new Map();
  const contributions = [];
  
  for (let i = 0; i < commits.length; i++) {
    const commit = commits[i];
    
    // Skip merge commits
    if (commit.message.toLowerCase().includes('merge pull request') || 
        commit.message.toLowerCase().includes('merge branch')) {
      console.log(`⏭️ Skipping merge commit: ${commit.hash.substring(0, 8)}`);
      continue;
    }
    
    try {
      await processCommit(commit, contributors, files, contributions);
      
      if ((i + 1) % 50 === 0) {
        console.log(`📈 Processed ${i + 1}/${commits.length} commits`);
      }
    } catch (error) {
      console.warn(`⚠️ Could not process commit ${commit.hash}: ${error.message}`);
    }
  }
  
  return { commits, contributors, files, contributions };
}

async function processCommit(commit, contributorMap, fileMap, contributions) {
  // Get file changes with line counts
  const nameStatus = await git.show([commit.hash, '--name-status', '--format=']);
  const numStat = await git.show([commit.hash, '--numstat', '--format=']);
  
  const files = parseGitShowOutput(nameStatus, numStat);
  
  // Process contributor
  const contributor = await getOrCreateContributor(
    commit.author_name,
    commit.author_email,
    null,
    contributorMap
  );
  
  // Process each file in the commit
  for (const fileChange of files) {
    const file = await getOrCreateFile(fileChange.file, fileMap);
    
    // Check for duplicate contribution
    const contributionKey = `${contributor.github_login}:${file.canonical_path}:${commit.hash}:${commit.date}`;
    const existingContribution = contributions.find(c => 
      c.contributor_email === contributor.email &&
      c.file_path === file.canonical_path &&
      c.activity_id === commit.hash
    );
    
    if (!existingContribution) {
      contributions.push({
        contributor_email: contributor.email,
        contributor_github_login: contributor.github_login,
        contributor_canonical_name: contributor.canonical_name,
        file_path: file.canonical_path,
        activity_type: 'commit',
        activity_id: commit.hash,
        contribution_date: new Date(commit.date),
        lines_added: fileChange.linesAdded || 0,
        lines_deleted: fileChange.linesDeleted || 0,
        lines_modified: fileChange.linesModified || 0
      });
    }
  }
}

async function processPullRequests(incremental) {
  const token = process.env.GITHUB_TOKEN;
  
  if (!token) {
    console.log('⚠️ No GITHUB_TOKEN provided, skipping PR processing');
    return { prs: [], contributors: new Map(), files: new Map(), contributions: [], comments: [] };
  }
  
  console.log('🔄 Processing pull requests...');
  
  const octokit = github.getOctokit(token);
  const context = github.context;
  
  // Get all PRs
  const allPRs = [];
  let page = 1;
  const perPage = 100;
  
  while (true) {
    await sleep(DELAY_BETWEEN_REQUESTS);
    
    const { data: prs } = await octokit.rest.pulls.list({
      owner: context.repo.owner,
      repo: context.repo.repo,
      state: 'all',
      per_page: perPage,
      page: page,
      sort: 'updated',
      direction: 'desc'
    });
    
    if (prs.length === 0) break;
    
    allPRs.push(...prs);
    console.log(`📄 Fetched ${prs.length} PRs (page ${page})`);
    
    // For incremental updates, stop when we reach PRs we've already processed
    if (incremental && prs.length < perPage) {
      break;
    }
    
    page++;
  }
  
  console.log(`📊 Found ${allPRs.length} total pull requests`);
  
  const contributors = new Map();
  const files = new Map();
  const contributions = [];
  const comments = [];
  const prData = [];
  
  for (let i = 0; i < allPRs.length; i++) {
    const pr = allPRs[i];
    
    try {
      // Skip draft PRs as per requirements
      if (pr.draft) {
        console.log(`⏭️ Skipping draft PR #${pr.number}`);
        continue;
      }
      
      const prResult = await processPullRequest(pr, octokit, context, contributors, files);
      
      contributions.push(...prResult.contributions);
      comments.push(...prResult.comments);
      prData.push(prResult.prData);
      
      if ((i + 1) % 10 === 0) {
        console.log(`📈 Processed ${i + 1}/${allPRs.length} PRs`);
      }
      
      await sleep(DELAY_BETWEEN_REQUESTS); // Rate limiting
      
    } catch (error) {
      console.warn(`⚠️ Could not process PR #${pr.number}: ${error.message}`);
    }
  }
  
  return { prs: prData, contributors, files, contributions, comments };
}

async function processPullRequest(pr, octokit, context, contributorMap, fileMap) {
  // Get PR author
  const author = await getOrCreateContributor(
    pr.user.name || pr.user.login,
    null, // No email from PR API
    pr.user.login,
    contributorMap
  );
  
  const contributions = [];
  const comments = [];
  
  // Get PR files for closed/merged PRs
  let files = [];
  let totalLinesModified = 0;
  
  if (pr.state !== 'open') {
    try {
      const { data: prFiles } = await octokit.rest.pulls.listFiles({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: pr.number
      });
      
      files = prFiles;
      totalLinesModified = files.reduce((total, file) => {
        return total + (file.additions || 0) + (file.deletions || 0);
      }, 0);
      
      // Add new files to files map
      for (const file of files) {
        if (file.status === 'added') {
          await getOrCreateFile(file.filename, fileMap);
        }
      }
      
    } catch (error) {
      console.warn(`⚠️ Could not fetch files for PR #${pr.number}: ${error.message}`);
    }
  } else {
    // For open PRs, try to get basic file info
    try {
      const { data: prFiles } = await octokit.rest.pulls.listFiles({
        owner: context.repo.owner,
        repo: context.repo.repo,
        pull_number: pr.number
      });
      
      totalLinesModified = prFiles.reduce((total, file) => {
        return total + (file.additions || 0) + (file.deletions || 0);
      }, 0);
      
    } catch (error) {
      console.warn(`⚠️ Could not fetch file stats for open PR #${pr.number}: ${error.message}`);
    }
  }
  
  // Get reviewers and review data
  const reviewers = [];
  let reviews = [];
  
  try {
    const { data: prReviews } = await octokit.rest.pulls.listReviews({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pr.number
    });
    
    reviews = prReviews;
    
    // Extract unique reviewers (excluding PR author)
    const uniqueReviewers = reviews
      .filter(review => review.user.login !== pr.user.login)
      .reduce((acc, review) => {
        const existing = acc.find(r => r.login === review.user.login);
        if (!existing) {
          acc.push({
            login: review.user.login,
            submitted_at: review.submitted_at
          });
        }
        return acc;
      }, []);
      
    reviewers.push(...uniqueReviewers);
    
    // Process review contributions
    for (const reviewer of uniqueReviewers) {
      const reviewerContributor = await getOrCreateContributor(
        reviewer.login,
        null,
        reviewer.login,
        contributorMap
      );
      
      // Add review contributions for each file
      for (const file of files) {
        const fileObj = await getOrCreateFile(file.filename, fileMap);
        const fileLinesModified = (file.additions || 0) + (file.deletions || 0);
        
        contributions.push({
          contributor_github_login: reviewerContributor.github_login,
          contributor_canonical_name: reviewerContributor.canonical_name,
          file_path: fileObj.canonical_path,
          activity_type: 'review',
          activity_id: pr.number.toString(),
          contribution_date: new Date(reviewer.submitted_at),
          lines_modified: fileLinesModified,
          pr_number: pr.number
        });
      }
    }
    
  } catch (error) {
    console.warn(`⚠️ Could not fetch reviews for PR #${pr.number}: ${error.message}`);
  }
  
  // Get and filter comments
  const prComments = await getPRComments(pr, octokit, context, contributorMap);
  comments.push(...prComments);
  
  // Prepare PR data
  const prData = {
    pr_number: pr.number,
    status: pr.merged_at ? 'merged' : pr.state,
    author_login: pr.user.login,
    reviewers: reviewers,
    created_date: new Date(pr.created_at),
    merged_date: pr.merged_at ? new Date(pr.merged_at) : null,
    closed_date: pr.closed_at ? new Date(pr.closed_at) : null,
    lines_modified: totalLinesModified,
    is_processed: true
  };
  
  return { prData, contributions, comments };
}

async function getPRComments(pr, octokit, context, contributorMap) {
  const comments = [];
  
  try {
    // Get regular PR comments
    const { data: prComments } = await octokit.rest.issues.listComments({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: pr.number
    });
    
    // Get review comments (inline comments on code)
    const { data: reviewComments } = await octokit.rest.pulls.listReviewComments({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pr.number
    });
    
    // Get PR reviews (which can also contain comments)
    const { data: reviews } = await octokit.rest.pulls.listReviews({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pr.number
    });
    
    // Process all comment types
    const allComments = [
      ...prComments.map(c => ({ ...c, type: 'pr_comment' })),
      ...reviewComments.map(c => ({ ...c, type: 'inline_comment' })),
      ...reviews.filter(r => r.body && r.body.trim()).map(r => ({ 
        ...r, 
        type: 'review_comment',
        user: r.user,
        body: r.body,
        created_at: r.submitted_at
      }))
    ];
    
    // Filter out bot comments and commands
    for (const comment of allComments) {
      if (isBotComment(comment)) {
        continue;
      }
      
      const commenter = await getOrCreateContributor(
        comment.user.login,
        null,
        comment.user.login,
        contributorMap
      );
      
      comments.push({
        contributor_github_login: commenter.github_login,
        pr_number: pr.number,
        comment_date: new Date(comment.created_at),
        comment_text: comment.body,
        comment_type: comment.type,
        is_bot_comment: false
      });
    }
    
  } catch (error) {
    console.warn(`⚠️ Could not process comments for PR #${pr.number}: ${error.message}`);
  }
  
  return comments;
}

function isBotComment(comment) {
  // Check if user is a bot
  if (comment.user.type && comment.user.type.toLowerCase() === 'bot') {
    return true;
  }
  
  // Check comment body for bot patterns
  if (comment.body) {
    return BOT_PATTERNS.some(pattern => pattern.test(comment.body));
  }
  
  return false;
}

async function getOrCreateContributor(name, email, githubLogin, contributorMap) {
  // Create a unique key for lookup
  const lookupKey = email || githubLogin || name;
  
  let contributor = contributorMap.get(lookupKey);
  
  if (!contributor) {
    // Check if this contributor might be a duplicate
    const primaryId = await checkDuplicateContributor(githubLogin, email, name);
    
    if (primaryId) {
      // Get the primary contributor info
      const { data: primaryContributor, error } = await supabase
        .from('contributors')
        .select('*')
        .eq('id', primaryId)
        .single();
        
      if (!error && primaryContributor) {
        contributor = {
          id: primaryContributor.id,
          github_login: primaryContributor.github_login,
          canonical_name: primaryContributor.canonical_name,
          email: primaryContributor.email || email
        };
        contributorMap.set(lookupKey, contributor);
        return contributor;
      }
    }
    
    // Create new contributor
    const normalizedName = normalizeName(name);
    const finalGithubLogin = githubLogin || extractUsernameFromEmail(email) || normalizedName;
    
    contributor = {
      github_login: finalGithubLogin,
      canonical_name: normalizedName,
      email: email,
      is_primary: true
    };
    
    contributorMap.set(lookupKey, contributor);
    
    console.log(`👤 New contributor: ${name} -> ${finalGithubLogin}`);
  }
  
  return contributor;
}

async function checkDuplicateContributor(githubLogin, email, name) {
  try {
    // Use the database function to check for duplicates
    const { data, error } = await supabase
      .rpc('get_primary_contributor_id', {
        input_login: githubLogin,
        input_email: email,
        input_name: normalizeName(name)
      });
      
    if (error) {
      console.warn('⚠️ Error checking duplicate contributor:', error.message);
      return null;
    }
    
    return data;
  } catch (error) {
    console.warn('⚠️ Error in duplicate check:', error.message);
    return null;
  }
}

async function processDuplicateContributors() {
  console.log('🔍 Processing duplicate contributors...');
  
  // Get all contributors that might have duplicates
  const { data: contributors, error } = await supabase
    .from('contributors')
    .select('*')
    .eq('is_primary', true);
    
  if (error) {
    console.error('Error fetching contributors for duplicate processing:', error);
    return;
  }
  
  console.log(`📊 Analyzing ${contributors.length} contributors for duplicates`);
  
  const processed = new Set();
  let duplicatesFound = 0;
  
  for (let i = 0; i < contributors.length; i++) {
    if (processed.has(contributors[i].id)) continue;
    
    const similar = [contributors[i]];
    processed.add(contributors[i].id);
    
    // Find similar contributors
    for (let j = i + 1; j < contributors.length; j++) {
      if (processed.has(contributors[j].id)) continue;
      
      if (areSimilarContributors(contributors[i], contributors[j])) {
        similar.push(contributors[j]);
        processed.add(contributors[j].id);
      }
    }
    
    // If we found potential duplicates, record them
    if (similar.length > 1) {
      await recordPotentialDuplicates(similar);
      duplicatesFound++;
    }
  }
  
  console.log(`🔍 Found ${duplicatesFound} groups of potential duplicate contributors`);
}

function areSimilarContributors(c1, c2) {
  // Exact email match
  if (c1.email && c2.email && c1.email.toLowerCase() === c2.email.toLowerCase()) {
    return true;
  }
  
  // GitHub login similarity
  if (c1.github_login && c2.github_login) {
    const loginSimilarity = calculateSimilarity(c1.github_login, c2.github_login);
    if (loginSimilarity >= LEVENSHTEIN_THRESHOLD) {
      return true;
    }
  }
  
  // Name similarity
  if (c1.canonical_name && c2.canonical_name) {
    const nameSimilarity = calculateSimilarity(c1.canonical_name, c2.canonical_name);
    if (nameSimilarity >= LEVENSHTEIN_THRESHOLD) {
      return true;
    }
  }
  
  return false;
}

function calculateSimilarity(str1, str2) {
  const distance = levenshteinDistance(str1.toLowerCase(), str2.toLowerCase());
  const maxLength = Math.max(str1.length, str2.length);
  return 1 - (distance / maxLength);
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

async function recordPotentialDuplicates(similarContributors) {
  // Choose the primary contributor (most complete profile)
  const primary = choosePrimaryContributor(similarContributors);
  const duplicates = similarContributors.filter(c => c.id !== primary.id);
  
  console.log(`🔄 Recording ${duplicates.length} potential duplicates for ${primary.github_login}`);
  
  // Insert duplicate records
  const duplicateRecords = duplicates.map(duplicate => ({
    primary_contributor_id: primary.id,
    github_login: duplicate.github_login,
    email: duplicate.email,
    canonical_name: duplicate.canonical_name,
    similarity_score: calculateSimilarity(primary.canonical_name, duplicate.canonical_name),
    merge_priority: 'auto-medium',
    notes: `Auto-detected similarity with ${primary.github_login}`
  }));
  
  if (duplicateRecords.length > 0) {
    const { error } = await supabase
      .from('duplicate_contributors')
      .upsert(duplicateRecords, { onConflict: 'github_login,primary_contributor_id' });
      
    if (error) {
      console.error('Error recording duplicate contributors:', error);
    }
  }
}

function choosePrimaryContributor(contributors) {
  // Score contributors based on completeness and reliability
  const scored = contributors.map(c => ({
    contributor: c,
    score: calculateContributorScore(c)
  })).sort((a, b) => b.score - a.score);
  
  return scored[0].contributor;
}

function calculateContributorScore(contributor) {
  let score = 0;
  
  // Higher score for valid GitHub username patterns
  if (isValidGitHubUsername(contributor.github_login)) {
    score += 50;
  }
  
  // Higher score for GitHub noreply emails
  if (contributor.email && contributor.email.includes('@users.noreply.github.com')) {
    score += 100;
  }
  
  // Higher score for having email
  if (contributor.email) {
    score += 30;
  }
  
  // Lower score for obviously generated names
  if (contributor.github_login === contributor.canonical_name) {
    score -= 20;
  }
  
  // Higher score for shorter, username-like strings
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

async function insertAllData(commitResults, prResults) {
  console.log('💾 Inserting all collected data...');
  
  // Combine data from both sources
  const allContributors = new Map([...commitResults.contributors, ...prResults.contributors]);
  const allFiles = new Map([...commitResults.files, ...prResults.files]);
  const allContributions = [...commitResults.contributions, ...prResults.contributions];
  const allComments = prResults.comments || [];
  
  console.log(`📊 Data summary:
  - Contributors: ${allContributors.size}
  - Files: ${allFiles.size}
  - Contributions: ${allContributions.length}
  - Comments: ${allComments.length}
  - PRs: ${prResults.prs.length}`);
  
  // Insert files first (they have no dependencies)
  await insertFiles(Array.from(allFiles.values()));
  
  // Insert contributors
  await insertContributors(Array.from(allContributors.values()));
  
  // Insert pull requests
  if (prResults.prs.length > 0) {
    await insertPullRequests(prResults.prs);
  }
  
  // Insert contributions (depends on contributors and files)
  if (allContributions.length > 0) {
    await insertContributions(allContributions);
  }
  
  // Insert comments (depends on contributors and PRs)
  if (allComments.length > 0) {
    await insertReviewComments(allComments);
  }
}

async function insertContributors(contributors) {
  if (contributors.length === 0) return;
  
  console.log(`👥 Inserting ${contributors.length} contributors...`);
  
  let inserted = 0;
  let skipped = 0;
  
  for (const contributor of contributors) {
    try {
      const { error } = await supabase
        .from('contributors')
        .upsert({
          github_login: contributor.github_login,
          canonical_name: contributor.canonical_name,
          email: contributor.email,
          is_primary: contributor.is_primary !== false
        }, { onConflict: 'github_login' });
        
      if (error) {
        console.warn(`⚠️ Could not insert contributor ${contributor.github_login}:`, error.message);
        skipped++;
      } else {
        inserted++;
      }
    } catch (error) {
      console.warn(`⚠️ Error inserting contributor ${contributor.github_login}:`, error.message);
      skipped++;
    }
  }
  
  console.log(`👥 Contributors: ${inserted} inserted, ${skipped} skipped`);
}

async function insertFiles(files) {
  if (files.length === 0) return;
  
  console.log(`📁 Inserting ${files.length} files...`);
  
  const batches = createBatches(files, BATCH_SIZE);
  let totalInserted = 0;
  
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    
    try {
      const { error } = await supabase
        .from('files')
        .upsert(batch.map(f => ({
          canonical_path: f.canonical_path,
          current_path: f.current_path,
          file_type: getFileType(f.canonical_path),
          is_active: true
        })), { onConflict: 'canonical_path' });
        
      if (error) {
        console.error(`Error inserting files batch ${i + 1}:`, error);
      } else {
        totalInserted += batch.length;
        console.log(`📁 Inserted files batch ${i + 1}/${batches.length} (${totalInserted} total)`);
      }
    } catch (error) {
      console.error(`Error in files batch ${i + 1}:`, error);
    }
  }
}

async function insertPullRequests(prs) {
  if (prs.length === 0) return;
  
  console.log(`🔀 Inserting ${prs.length} pull requests...`);
  
  const batches = createBatches(prs, 50);
  let totalInserted = 0;
  
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    
    try {
      const { error } = await supabase
        .from('pull_requests')
        .upsert(batch, { onConflict: 'pr_number' });
        
      if (error) {
        console.error(`Error inserting PRs batch ${i + 1}:`, error);
      } else {
        totalInserted += batch.length;
        console.log(`🔀 Inserted PRs batch ${i + 1}/${batches.length} (${totalInserted} total)`);
      }
    } catch (error) {
      console.error(`Error in PRs batch ${i + 1}:`, error);
    }
  }
}

async function insertContributions(contributions) {
  if (contributions.length === 0) return;
  
  console.log(`🤝 Processing ${contributions.length} contributions...`);
  
  // Get contributor and file mappings
  const { data: dbContributors } = await supabase
    .from('contributors')
    .select('id, github_login, email, canonical_name');
    
  const { data: dbFiles } = await supabase
    .from('files')
    .select('id, canonical_path');
    
  if (!dbContributors || !dbFiles) {
    throw new Error('Failed to fetch contributor or file mappings');
  }
  
  // Create lookup maps
  const contributorLookup = new Map();
  dbContributors.forEach(c => {
    contributorLookup.set(c.github_login.toLowerCase(), c.id);
    if (c.email) contributorLookup.set(c.email.toLowerCase(), c.id);
    contributorLookup.set(c.canonical_name.toLowerCase(), c.id);
  });
  
  const fileLookup = new Map();
  dbFiles.forEach(f => {
    fileLookup.set(f.canonical_path, f.id);
  });
  
  // Map contributions to database format
  const mappedContributions = [];
  let skipped = 0;
  
  for (const contribution of contributions) {
    let contributorId = null;
    
    if (contribution.contributor_github_login) {
      contributorId = contributorLookup.get(contribution.contributor_github_login.toLowerCase());
    }
    if (!contributorId && contribution.contributor_email) {
      contributorId = contributorLookup.get(contribution.contributor_email.toLowerCase());
    }
    if (!contributorId && contribution.contributor_canonical_name) {
      contributorId = contributorLookup.get(contribution.contributor_canonical_name.toLowerCase());
    }
    
    const fileId = fileLookup.get(contribution.file_path);
    
    if (contributorId && fileId) {
      mappedContributions.push({
        contributor_id: contributorId,
        file_id: fileId,
        activity_type: contribution.activity_type,
        activity_id: contribution.activity_id,
        contribution_date: contribution.contribution_date,
        lines_added: contribution.lines_added || 0,
        lines_deleted: contribution.lines_deleted || 0,
        lines_modified: contribution.lines_modified || 0,
        pr_number: contribution.pr_number || null
      });
    } else {
      skipped++;
    }
  }
  
  console.log(`🤝 Mapped ${mappedContributions.length} contributions (${skipped} skipped)`);
  
  if (mappedContributions.length === 0) return;
  
  // Insert in batches
  const batches = createBatches(mappedContributions, BATCH_SIZE);
  let totalInserted = 0;
  
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    
    try {
      const { error } = await supabase
        .from('contributions')
        .upsert(batch, { 
          onConflict: 'contributor_id,file_id,activity_type,activity_id,contribution_date'
        });
        
      if (error) {
        console.error(`Error inserting contributions batch ${i + 1}:`, error);
      } else {
        totalInserted += batch.length;
        console.log(`🤝 Inserted contributions batch ${i + 1}/${batches.length} (${totalInserted} total)`);
      }
    } catch (error) {
      console.error(`Error in contributions batch ${i + 1}:`, error);
    }
  }
}

async function insertReviewComments(comments) {
  if (comments.length === 0) return;
  
  console.log(`💬 Processing ${comments.length} review comments...`);
  
  // Get contributor mappings
  const { data: dbContributors } = await supabase
    .from('contributors')
    .select('id, github_login');
    
  if (!dbContributors) {
    throw new Error('Failed to fetch contributor mappings for comments');
  }
  
  const contributorLookup = new Map();
  dbContributors.forEach(c => {
    contributorLookup.set(c.github_login.toLowerCase(), c.id);
  });
  
  // Map comments to database format
  const mappedComments = [];
  let skipped = 0;
  
  for (const comment of comments) {
    const contributorId = contributorLookup.get(comment.contributor_github_login.toLowerCase());
    
    if (contributorId) {
      mappedComments.push({
        contributor_id: contributorId,
        pr_number: comment.pr_number,
        comment_date: comment.comment_date,
        comment_text: comment.comment_text,
        comment_type: comment.comment_type,
        is_bot_comment: comment.is_bot_comment || false
      });
    } else {
      skipped++;
    }
  }
  
  console.log(`💬 Mapped ${mappedComments.length} comments (${skipped} skipped)`);
  
  if (mappedComments.length === 0) return;
  
  // Insert in batches
  const batches = createBatches(mappedComments, BATCH_SIZE);
  let totalInserted = 0;
  
  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    
    try {
      const { error } = await supabase
        .from('review_comments')
        .upsert(batch, { 
          onConflict: 'contributor_id,pr_number,comment_date,comment_text'
        });
        
      if (error) {
        console.error(`Error inserting comments batch ${i + 1}:`, error);
      } else {
        totalInserted += batch.length;
        console.log(`💬 Inserted comments batch ${i + 1}/${batches.length} (${totalInserted} total)`);
      }
    } catch (error) {
      console.error(`Error in comments batch ${i + 1}:`, error);
    }
  }
}

async function updateProcessingMetadata(commitResults, prResults) {
  console.log('📊 Updating processing metadata...');
  
  const metadata = [
    {
      key: 'last_scan_commit',
      value: commitResults.commits.length > 0 ? commitResults.commits[commitResults.commits.length - 1].hash : '',
      metadata_type: 'string'
    },
    {
      key: 'last_scan_date',
      value: new Date().toISOString(),
      metadata_type: 'datetime'
    },
    {
      key: 'total_commits_processed',
      value: commitResults.commits.length.toString(),
      metadata_type: 'number'
    },
    {
      key: 'total_prs_processed',
      value: prResults.prs.length.toString(),
      metadata_type: 'number'
    }
  ];
  
  for (const meta of metadata) {
    const { error } = await supabase
      .from('repository_metadata')
      .upsert(meta, { onConflict: 'key' });
      
    if (error) {
      console.warn(`⚠️ Could not update metadata ${meta.key}:`, error.message);
    }
  }
}

// Helper functions
function parseGitShowOutput(nameStatus, numStat) {
  const nameStatusLines = nameStatus.split('\n').filter(line => line.trim());
  const numStatLines = numStat.split('\n').filter(line => line.trim());
  
  const numStatMap = new Map();
  numStatLines.forEach(line => {
    const parts = line.split('\t');
    if (parts.length >= 3) {
      const filename = parts[2];
      const linesAdded = parts[0] === '-' ? 0 : parseInt(parts[0]) || 0;
      const linesDeleted = parts[1] === '-' ? 0 : parseInt(parts[1]) || 0;
      numStatMap.set(filename, { linesAdded, linesDeleted });
    }
  });
  
  const files = [];
  nameStatusLines.forEach(line => {
    const parts = line.split('\t');
    const status = parts[0];
    let file, oldFile = null;
    
    if (status.startsWith('R') || status.startsWith('C')) {
      oldFile = parts[1];
      file = parts[2];
    } else {
      file = parts[1];
    }
    
    const numStat = numStatMap.get(file) || { linesAdded: 0, linesDeleted: 0 };
    
    files.push({
      status: status[0],
      file: file,
      oldFile: oldFile,
      linesAdded: numStat.linesAdded,
      linesDeleted: numStat.linesDeleted,
      linesModified: numStat.linesAdded + numStat.linesDeleted
    });
  });
  
  return files;
}

async function getOrCreateFile(filePath, fileMap) {
  let file = fileMap.get(filePath);
  
  if (!file) {
    file = {
      canonical_path: filePath,
      current_path: filePath
    };
    fileMap.set(filePath, file);
  }
  
  return file;
}

function normalizeName(name) {
  if (!name) return 'unknown';
  
  return name
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '');
}

function extractUsernameFromEmail(email) {
  if (!email) return null;
  
  // GitHub noreply emails
  if (email.includes('@users.noreply.github.com')) {
    const match = email.match(/(?:\d+\+)?([^@+]+)@users\.noreply\.github\.com/);
    if (match && match[1]) {
      return match[1];
    }
  }
  
  // Try email prefix for common domains
  const personalDomains = ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com'];
  const emailParts = email.toLowerCase().split('@');
  
  if (emailParts.length === 2) {
    const [localPart, domain] = emailParts;
    
    if (personalDomains.includes(domain) && isValidGitHubUsername(localPart)) {
      return localPart;
    }
  }
  
  return null;
}

function getFileType(filePath) {
  const extension = filePath.split('.').pop().toLowerCase();
  const typeMap = {
    'js': 'javascript',
    'ts': 'typescript',
    'py': 'python',
    'java': 'java',
    'cpp': 'cpp',
    'c': 'c',
    'rb': 'ruby',
    'go': 'go',
    'rs': 'rust',
    'php': 'php',
    'md': 'markdown',
    'yml': 'yaml',
    'yaml': 'yaml',
    'json': 'json',
    'xml': 'xml',
    'html': 'html',
    'css': 'css',
    'sql': 'sql'
  };
  
  return typeMap[extension] || 'other';
}

function createBatches(array, batchSize) {
  const batches = [];
  for (let i = 0; i < array.length; i += batchSize) {
    batches.push(array.slice(i, i + batchSize));
  }
  return batches;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Run if called directly
if (require.main === module) {
  initializeRepository();
}

module.exports = { initializeRepository };
