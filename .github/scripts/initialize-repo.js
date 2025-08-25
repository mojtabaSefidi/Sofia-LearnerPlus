// .github/scripts/initialize-repo.js
const github = require('@actions/github');
const { createClient } = require('@supabase/supabase-js');
const git = require('simple-git')();
const core = require('@actions/core');
const { deduplicateContributors } = require('./deduplicate-contributors');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function initializeRepository() {
  console.log('🚀 Starting repository initialization...');
  
  try {
    // Get all commits
    const log = await git.log({ '--all': null });
    const commits = log.all;
    
    console.log(`📊 Found ${commits.length} commits to analyze`);
    
    const contributorMap = new Map();
    const fileMap = new Map();
    const contributions = [];
    
    // Process commits in chronological order (oldest first)
    for (const commit of commits.reverse()) {
      await processCommit(commit, contributorMap, fileMap, contributions);
    }
    
    // Process pull requests and their contributions
    console.log('🔄 Starting pull request processing...');
    const { prContributions, allComments } = await processPullRequests();
    
    // Add PR contributors to the contributor map
    for (const prContrib of prContributions) {
      if (!contributorMap.has(prContrib.contributor_login)) {
        contributorMap.set(prContrib.contributor_login, {
          github_login: prContrib.contributor_login,
          canonical_name: prContrib.contributor_login,
          email: null // We don't have email from PR API
        });
      }
      
      // Add file to file map if not exists
      if (!fileMap.has(prContrib.file_path)) {
        fileMap.set(prContrib.file_path, {
          canonical_path: prContrib.file_path,
          current_path: prContrib.file_path
        });
      }
    }
    
    // Combine commit and PR contributions
    contributions.push(...prContributions);

    // Insert files first
    await insertFiles(Array.from(fileMap.values()));
    
    // Insert contributors (may have duplicates)
    await insertContributors(Array.from(contributorMap.values()));
    
    // Deduplicate contributors BEFORE processing contributions
    console.log('🔧 Deduplicating contributors...');
    await deduplicateContributors();
    
    // Now insert contributions with deduplicated contributor IDs
    await insertContributionsWithDeduplicatedIds(contributions, contributorMap);

    if (allComments.length > 0) {
      console.log(`💬 Processing ${allComments.length} review comments...`);
      await insertReviewComments(allComments);
    }
    
    // Update last scan metadata
    await updateMetadata('last_scan_commit', commits[commits.length - 1].hash);
    
    console.log('✅ Repository initialization completed successfully!');
    console.log(`📈 Statistics:
    - Contributors: ${contributorMap.size}
    - Files: ${fileMap.size}  
    - Contributions: ${contributions.length}
    - PR Contributions: ${prContributions.length}`);
    
  } catch (error) {
    console.error('❌ Error during initialization:', error);
    core.setFailed(error.message);
  }
}

async function processPullRequests() {
  const token = process.env.GITHUB_TOKEN || core.getInput('github-token') || core.getInput('token');
  
  if (!token) {
    console.log('⚠️ No GITHUB_TOKEN provided, skipping PR processing');
    return { prContributions: [], allComments: [] };
  }

  console.log('🔄 Processing pull requests...');
  
  try {
    const octokit = github.getOctokit(process.env.GITHUB_TOKEN);
    const context = github.context;
    
    // Get all PRs (open, closed, merged) - same as before
    const allPRs = [];
    let page = 1;
    const perPage = 100;
    
    while (true) {
      const { data: prs } = await octokit.rest.pulls.list({
        owner: context.repo.owner,
        repo: context.repo.repo,
        state: 'all',
        per_page: perPage,
        page: page,
        sort: 'created',
        direction: 'asc'
      });
      
      if (prs.length === 0) break;
      
      allPRs.push(...prs);
      console.log(`📄 Fetched ${prs.length} PRs (page ${page})`);
      page++;
    }
    
    console.log(`📊 Found ${allPRs.length} total pull requests`);
    
    // IMPORTANT: Insert PRs into database FIRST
    await insertPullRequests(allPRs);
    
    // Then process PR contributions and comments
    const prContributions = [];
    const allComments = [];
    
    for (const pr of allPRs) {
      const contributions = await processPRContributions(pr, octokit, context);
      const comments = await processPRComments(pr, octokit, context);
      prContributions.push(...contributions);
      allComments.push(...comments);
    }
    
    return { prContributions, allComments };
    
  } catch (error) {
    console.error('❌ Error processing pull requests:', error);
    throw error;
  }
}

async function insertReviewComments(comments) {
  if (comments.length === 0) return;
  
  console.log(`💬 Inserting ${comments.length} review comments...`);
  
  // Get contributors to map logins to IDs
  const { data: dbContributors, error: contributorError } = await supabase
    .from('contributors')
    .select('id, github_login');
    
  if (contributorError) {
    console.error('Error fetching contributors for comments:', contributorError);
    throw contributorError;
  }
  
  const contributorLookup = new Map();
  dbContributors.forEach(c => {
    contributorLookup.set(c.github_login.toLowerCase(), c.id);
  });
  
  // Map comments to database format
  const mappedComments = [];
  let skippedCount = 0;
  
  for (const comment of comments) {
    const contributorId = contributorLookup.get(comment.contributor_login.toLowerCase());
    
    if (contributorId) {
      mappedComments.push({
        contributor_id: contributorId,
        pr_number: comment.pr_number,
        comment_date: comment.comment_date,
        comment_text: comment.comment_text
      });
    } else {
      skippedCount++;
      if (skippedCount <= 5) {
        console.warn(`⚠️ Skipping comment from unknown contributor: ${comment.contributor_login}`);
      }
    }
  }
  
  console.log(`💬 Mapped ${mappedComments.length} comments (skipped ${skippedCount})`);
  
  if (mappedComments.length === 0) {
    console.warn('⚠️ No comments to insert after mapping!');
    return;
  }
  
  // Insert in batches
  const batchSize = 100;
  let totalInserted = 0;
  
  for (let i = 0; i < mappedComments.length; i += batchSize) {
    const batch = mappedComments.slice(i, i + batchSize);
    
    const { error } = await supabase
      .from('review_comments')
      .insert(batch);
    
    if (error) {
      console.error('Error inserting review comments batch:', error);
      // Continue with other batches instead of throwing
    } else {
      totalInserted += batch.length;
      console.log(`💬 Inserted comments batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(mappedComments.length/batchSize)} (${totalInserted} total)`);
    }
  }
  
  console.log(`✅ Successfully inserted ${totalInserted} review comments`);
}


async function insertPullRequests(prs) {
  if (prs.length === 0) return;
  
  console.log(`📝 Inserting ${prs.length} pull requests...`);
  
  // We need to get reviewers for each PR
  const octokit = process.env.GITHUB_TOKEN ? github.getOctokit(process.env.GITHUB_TOKEN) : null;
  const context = github.context;
  
  const prData = [];
  
  for (const pr of prs) {
    let reviewers = [];
    
    // Get reviewers if we have GitHub token
    if (octokit) {
      try {
        const { data: reviews } = await octokit.rest.pulls.listReviews({
          owner: context.repo.owner,
          repo: context.repo.repo,
          pull_number: pr.number
        });
        
        // Extract unique reviewers (excluding PR author)
        reviewers = reviews
          .filter(review => review.user.login !== pr.user.login)
          .map(review => ({
            login: review.user.login,
            submitted_at: review.submitted_at
          }))
          .filter((reviewer, index, self) => 
            index === self.findIndex(r => r.login === reviewer.login)
          );
        
      } catch (error) {
        console.warn(`⚠️ Could not fetch reviews for PR #${pr.number}: ${error.message}`);
      }
    }
    
    // Calculate total lines modified
    let totalLinesModified = 0;
    if (octokit) {
      try {
        const { data: files } = await octokit.rest.pulls.listFiles({
          owner: context.repo.owner,
          repo: context.repo.repo,
          pull_number: pr.number
        });
        
        totalLinesModified = files.reduce((total, file) => {
          return total + (file.additions || 0) + (file.deletions || 0);
        }, 0);
      } catch (error) {
        console.warn(`⚠️ Could not fetch files for PR #${pr.number}: ${error.message}`);
      }
    }
    
    prData.push({
      pr_number: pr.number,
      status: pr.merged_at ? 'merged' : pr.state,
      author_login: pr.user.login,
      reviewers: reviewers,
      created_date: new Date(pr.created_at),
      merged_date: pr.merged_at ? new Date(pr.merged_at) : null,
      closed_date: pr.closed_at ? new Date(pr.closed_at) : null,
      lines_modified: totalLinesModified
    });
  }
  
  const batchSize = 50;
  let totalInserted = 0;
  
  for (let i = 0; i < prData.length; i += batchSize) {
    const batch = prData.slice(i, i + batchSize);
    
    const { error } = await supabase
      .from('pull_requests')
      .upsert(batch, { onConflict: 'pr_number' });
    
    if (error) {
      console.error('Error inserting PRs batch:', error);
      throw error;
    }
    
    totalInserted += batch.length;
    console.log(`📝 Inserted PR batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(prData.length/batchSize)} (${totalInserted} total)`);
  }
  
  console.log(`✅ Successfully inserted ${totalInserted} pull requests`);
}

async function processPRContributions(pr, octokit, context) {
  const contributions = [];
  
  try {
    // Get PR files
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pr.number
    });
    
    // Get PR reviews
    const { data: reviews } = await octokit.rest.pulls.listReviews({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pr.number
    });
    
    // Calculate total lines modified in PR
    const totalLinesModified = files.reduce((total, file) => {
      return total + (file.additions || 0) + (file.deletions || 0);
    }, 0);
    
    // Collect unique reviewers (excluding PR author)
    const reviewers = reviews
      .filter(review => review.user.login !== pr.user.login)
      .map(review => ({
        login: review.user.login,
        submitted_at: review.submitted_at
      }))
      .filter((reviewer, index, self) => 
        index === self.findIndex(r => r.login === reviewer.login)
      );
    
    // Process each file for each reviewer
    for (const reviewer of reviewers) {
      for (const file of files) {
        const fileLinesModified = (file.additions || 0) + (file.deletions || 0);
        
        contributions.push({
          contributor_login: reviewer.login,
          file_path: file.filename,
          activity_type: 'review',
          activity_id: pr.number.toString(),
          contribution_date: new Date(reviewer.submitted_at),
          lines_modified: fileLinesModified,
          pr_number: pr.number
        });
      }
    }
    
  } catch (error) {
    console.warn(`⚠️ Could not process PR #${pr.number} contributions: ${error.message}`);
  }
  
  return contributions;
}

async function processPRComments(pr, octokit, context) {
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
    
    // Process regular PR comments (exclude bot comments)
    for (const comment of prComments) {
      if (!comment.user.type || comment.user.type.toLowerCase() !== 'bot') {
        comments.push({
          contributor_login: comment.user.login,
          pr_number: pr.number,
          comment_date: new Date(comment.created_at),
          comment_text: comment.body
        });
      }
    }
    
    // Process review comments (inline comments)
    for (const comment of reviewComments) {
      if (!comment.user.type || comment.user.type.toLowerCase() !== 'bot') {
        comments.push({
          contributor_login: comment.user.login,
          pr_number: pr.number,
          comment_date: new Date(comment.created_at),
          comment_text: comment.body
        });
      }
    }
    
    // Process review comments from reviews (general review comments)
    for (const review of reviews) {
      if (review.body && review.body.trim() && (!review.user.type || review.user.type.toLowerCase() !== 'bot')) {
        comments.push({
          contributor_login: review.user.login,
          pr_number: pr.number,
          comment_date: new Date(review.submitted_at),
          comment_text: review.body
        });
      }
    }
    
  } catch (error) {
    console.warn(`⚠️ Could not process PR #${pr.number} comments: ${error.message}`);
  }
  
  return comments;
}




async function insertContributionsWithDeduplicatedIds(contributions, originalContributorMap) {
  if (contributions.length === 0) return;
  
  console.log(`🔗 Processing ${contributions.length} contributions with deduplicated IDs...`);
  
  // Get the deduplicated contributors from database
  const { data: dbContributors, error: contributorError } = await supabase
    .from('contributors')
    .select('id, canonical_name, github_login, email');
    
  if (contributorError) {
    console.error('Error fetching contributors:', contributorError);
    throw contributorError;
  }
    
  const { data: dbFiles, error: filesError } = await supabase
    .from('files')
    .select('id, canonical_path');
  
  if (filesError) {
    console.error('Error fetching files:', filesError);
    throw filesError;
  }
  
  console.log(`📊 Found ${dbContributors.length} contributors and ${dbFiles.length} files in database`);
  
  // Create enhanced lookup maps for contributors
  const contributorLookup = new Map();
  dbContributors.forEach(c => {
    if (c.email) {
      contributorLookup.set(c.email.toLowerCase(), c.id);
    }
    contributorLookup.set(c.canonical_name.toLowerCase(), c.id);
    contributorLookup.set(c.github_login.toLowerCase(), c.id);
  });
  
  const fileLookup = new Map();
  dbFiles.forEach(f => {
    fileLookup.set(f.canonical_path, f.id);
  });
  
  // Map contributions to database IDs
  const mappedContributions = [];
  let skippedCount = 0;
  
  for (const contribution of contributions) {
    const fileId = fileLookup.get(contribution.file_path);
    
    let contributorId = null;
    
    // Handle PR contributions (which use contributor_login instead of email)
    if (contribution.contributor_login) {
      contributorId = contributorLookup.get(contribution.contributor_login.toLowerCase());
    }
    // Handle commit contributions
    else if (contribution.contributor_email) {
      contributorId = contributorLookup.get(contribution.contributor_email.toLowerCase());
    }
    
    if (!contributorId && contribution.contributor_canonical_name) {
      contributorId = contributorLookup.get(contribution.contributor_canonical_name.toLowerCase());
    }
    
    if (!contributorId) {
      const originalContributor = Array.from(originalContributorMap.values())
        .find(c => c.email === contribution.contributor_email || c.github_login === contribution.contributor_login);
      if (originalContributor && originalContributor.github_login) {
        contributorId = contributorLookup.get(originalContributor.github_login.toLowerCase());
      }
    }
    
    if (contributorId && fileId) {
      // Calculate lines_added and lines_deleted properly
      let linesAdded = contribution.lines_added || 0;
      let linesDeleted = contribution.lines_deleted || 0;
      let totalLinesModified = contribution.lines_modified || 0;
    
      mappedContributions.push({
        contributor_id: contributorId,
        file_id: fileId,
        activity_type: contribution.activity_type,
        activity_id: contribution.activity_id,
        contribution_date: contribution.contribution_date,
        lines_added: linesAdded,
        lines_deleted: linesDeleted,
        lines_modified: totalLinesModified,
        pr_number: contribution.pr_number || null
      });
    } 
    else {
      skippedCount++;
      if (skippedCount <= 10) {
        const identifier = contribution.contributor_email || contribution.contributor_login || 'unknown';
        console.warn(`⚠️ Skipping contribution - Contributor: ${identifier} (ID: ${contributorId}), File: ${contribution.file_path} (ID: ${fileId})`);
      }
    }
  }
  
  console.log(`🔗 Mapped ${mappedContributions.length} contributions (skipped ${skippedCount})`);
  
  if (mappedContributions.length === 0) {
    console.warn('⚠️ No contributions to insert after mapping!');
    return;
  }
  
  // Insert in batches
  const batchSize = 500;
  let totalInserted = 0;
  
  for (let i = 0; i < mappedContributions.length; i += batchSize) {
    const batch = mappedContributions.slice(i, i + batchSize);
    const { data, error } = await supabase
      .from('contributions')
      .insert(batch)
      .select('id');
    
    if (error) {
      console.error('Error inserting contributions batch:', error);
    } else {
      totalInserted += batch.length;
      console.log(`🔗 Inserted contributions batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(mappedContributions.length/batchSize)} (${totalInserted} total)`);
    }
  }
  
  console.log(`✅ Successfully inserted ${totalInserted} contributions`);
}

async function processCommit(commit, contributorMap, fileMap, contributions) {
  try {
    // Use separate git commands for name-status and numstat (Method 2 - the one that works)
    const nameStatus = await git.show([commit.hash, '--name-status', '--format=']);
    const numStat = await git.show([commit.hash, '--numstat', '--format=']);
    
    // Combine the outputs
    const combinedOutput = numStat + '\n' + nameStatus;
    const files = parseGitShowOutputWithLines(combinedOutput);
    
    // Process contributor
    const contributor = await getOrCreateContributor(commit, contributorMap);
    
    // Process each file in the commit
    for (const fileChange of files) {
      const file = await getOrCreateFile(fileChange, fileMap);
      
      contributions.push({
        contributor_email: contributor.email,
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
  } catch (error) {
    console.warn(`⚠️ Could not process commit ${commit.hash}: ${error.message}`);
  }
}

function parseGitShowOutputWithLines(output) {
  const lines = output.split('\n').filter(line => line.trim());
  const files = [];
  
  // Parse numstat lines (additions deletions filename)
  const numstatLines = lines.filter(line => line.match(/^\d+\t\d+\t/) || line.match(/^-\t-\t/));
  const namestatLines = lines.filter(line => line.match(/^[AMDRT]/));
  
  // Create maps to properly match files by filename
  const numstatMap = new Map();
  const namestatMap = new Map();
  
  // Process numstat lines
  numstatLines.forEach((line) => {
    const parts = line.split('\t');
    if (parts.length >= 3) {
      const filename = parts[2];
      const linesAdded = parts[0] === '-' ? 0 : parseInt(parts[0]) || 0;
      const linesDeleted = parts[1] === '-' ? 0 : parseInt(parts[1]) || 0;
      numstatMap.set(filename, { linesAdded, linesDeleted });
    }
  });
  
  // Process name-status lines
  namestatLines.forEach((line) => {
    const parts = line.split('\t');
    const status = parts[0];
    let file, oldFile = null;
    
    if (status.startsWith('R') || status.startsWith('C')) {
      oldFile = parts[1];
      file = parts[2];
    } else {
      file = parts[1];
    }
    
    namestatMap.set(file, { status: status[0], oldFile });
  });
  
  // Combine the data by matching filenames
  const allFiles = new Set([...numstatMap.keys(), ...namestatMap.keys()]);
  
  allFiles.forEach(filename => {
    const numstat = numstatMap.get(filename) || { linesAdded: 0, linesDeleted: 0 };
    const namestat = namestatMap.get(filename) || { status: 'M', oldFile: null };
    
    files.push({
      status: namestat.status,
      file: filename,
      oldFile: namestat.oldFile,
      linesAdded: numstat.linesAdded,
      linesDeleted: numstat.linesDeleted,
      linesModified: numstat.linesAdded + numstat.linesDeleted
    });
  });
  
  return files;
}


async function getOrCreateContributor(commit, contributorMap) {
  const email = commit.author_email;
  const name = commit.author_name;
  
  // Primary key should be email for initial grouping
  let contributor = contributorMap.get(email);
  
  if (!contributor) {
    // Check known mappings first
    let githubLogin = checkKnownMappings(email, name);
    
    if (!githubLogin) {
      // Try to get GitHub login from various sources
      githubLogin = await getGitHubLoginFromCommit(commit);
    }
    
    // If we still don't have a GitHub login, try GitHub API
    if (!githubLogin && process.env.GITHUB_TOKEN) {
      githubLogin = await getGitHubLoginFromAPI(email, name);
    }
    
    // Enhanced fallback logic - be more conservative
    if (!githubLogin) {
      githubLogin = extractUsernameFromEmail(email);
    }
    
    // If still no GitHub login, create a temporary one that deduplication can handle
    if (!githubLogin) {
      githubLogin = createTemporaryGitHubLogin(name, email);
    }
    
    contributor = {
      github_login: githubLogin,
      canonical_name: normalizeName(name), // Use normalized name as canonical name
      email: email
    };
    
    contributorMap.set(email, contributor); // Use email as primary key
    
    console.log(`👤 New contributor: ${name} -> github_login: ${githubLogin}, canonical_name: ${contributor.canonical_name}`);
  }
  
  return contributor;
}

// Check known contributor mappings
function checkKnownMappings(email, name) {
  if (!email || !name) return null;
  
  // Check email mapping
  const emailLower = email.toLowerCase();
  if (KNOWN_CONTRIBUTOR_MAPPINGS[emailLower]) {
    console.log(`🎯 Found known mapping for email ${email}: ${KNOWN_CONTRIBUTOR_MAPPINGS[emailLower]}`);
    return KNOWN_CONTRIBUTOR_MAPPINGS[emailLower];
  }
  
  // Check name mapping
  const nameLower = name.toLowerCase();
  if (KNOWN_CONTRIBUTOR_MAPPINGS[nameLower]) {
    console.log(`🎯 Found known mapping for name "${name}": ${KNOWN_CONTRIBUTOR_MAPPINGS[nameLower]}`);
    return KNOWN_CONTRIBUTOR_MAPPINGS[nameLower];
  }
  
  return null;
}

// Enhanced function to get GitHub login from commit
async function getGitHubLoginFromCommit(commit) {
  try {
    // Method 1: Extract from GitHub noreply email
    if (commit.author_email && commit.author_email.includes('@users.noreply.github.com')) {
      const match = commit.author_email.match(/(?:\d+\+)?([^@+]+)@users\.noreply\.github\.com/);
      if (match && match[1]) {
        console.log(`📧 Found GitHub username from noreply email: ${match[1]}`);
        return match[1];
      }
    }
    
    // Method 2: Check commit message for GitHub mentions or signatures
    if (commit.message) {
      // Look for "Signed-off-by" with GitHub username
      const signedOffMatch = commit.message.match(/Signed-off-by:.*<([^@]+)@users\.noreply\.github\.com>/i);
      if (signedOffMatch && signedOffMatch[1]) {
        console.log(`📝 Found GitHub username from signed-off: ${signedOffMatch[1]}`);
        return signedOffMatch[1];
      }
      
      // Look for GitHub username mentions
      const mentionMatch = commit.message.match(/(?:by|from|@)([a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38})\b/);
      if (mentionMatch && mentionMatch[1] && isValidGitHubUsername(mentionMatch[1])) {
        console.log(`💬 Found potential GitHub username from commit message: ${mentionMatch[1]}`);
        return mentionMatch[1];
      }
    }
    
    return null;
  } catch (error) {
    return null;
  }
}

// Enhanced GitHub API lookup
async function getGitHubLoginFromAPI(email, name) {
  if (!process.env.GITHUB_TOKEN) return null;
  
  try {
    const octokit = github.getOctokit(process.env.GITHUB_TOKEN);
    
    // Search for users by email (this requires special permissions)
    try {
      const { data } = await octokit.rest.search.users({
        q: `${email} in:email`,
        per_page: 1
      });
      
      if (data.items && data.items.length > 0) {
        console.log(`🔍 Found GitHub user via email search: ${data.items[0].login}`);
        return data.items[0].login;
      }
    } catch (emailSearchError) {
      console.log('📧 Email search not available, trying name search...');
    }
    
    // Fallback: Search by name (less reliable)
    try {
      const normalizedName = name.replace(/[^\w\s]/g, '').trim();
      if (normalizedName.length > 2) {
        const { data } = await octokit.rest.search.users({
          q: `${normalizedName} in:fullname`,
          per_page: 3
        });
        
        if (data.items && data.items.length > 0) {
          // Return the most likely match (you might want to add more validation)
          console.log(`🔍 Found potential GitHub user via name search: ${data.items[0].login} for ${name}`);
          return data.items[0].login;
        }
      }
    } catch (nameSearchError) {
      console.log('👤 Name search also failed');
    }
    
  } catch (error) {
    console.log(`❌ Could not resolve GitHub username for ${email}: ${error.message}`);
  }
  
  return null;
}

// Known contributor mappings for difficult cases
const KNOWN_CONTRIBUTOR_MAPPINGS = {
  // Email -> GitHub username mappings
  'mohammadali.sefidi@gmail.com': 'mojtabaSefidi',
  'sefidi.mohammadali@gmail.com': 'mojtabaSefidi',
  // Name -> GitHub username mappings
  'mohammadali sefidi esfahani': 'mojtabaSefidi',
  'mohammadali sefidi': 'mojtabaSefidi',
  'saman9452': 'saman9452',
  'samaneh malmir': 'saman9452',
  'fahimeh hajari': 'fahimeh1368',
  'fahimeh': 'fahimeh1368'
};

// Enhanced username extraction from email
function extractUsernameFromEmail(email) {
  if (!email) return null;
  
  // GitHub noreply emails
  if (email.includes('@users.noreply.github.com')) {
    const match = email.match(/(?:\d+\+)?([^@+]+)@users\.noreply\.github\.com/);
    if (match && match[1]) {
      return match[1];
    }
  }
  
  // Common patterns where email prefix might be GitHub username
  const personalDomains = ['gmail.com', 'outlook.com', 'hotmail.com', 'yahoo.com'];
  const emailParts = email.toLowerCase().split('@');
  
  if (emailParts.length === 2) {
    const [localPart, domain] = emailParts;
    
    // If it's a personal email domain and local part looks like a username
    if (personalDomains.includes(domain) && isValidGitHubUsername(localPart)) {
      console.log(`📧 Extracted potential GitHub username from email: ${localPart}`);
      return localPart;
    }
  }
  
  return null;
}

// Check if a string could be a valid GitHub username
function isValidGitHubUsername(username) {
  // GitHub username rules: 1-39 characters, alphanumeric or hyphens, can't start/end with hyphen
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/.test(username);
}

// Create a temporary GitHub login for deduplication to handle
function createTemporaryGitHubLogin(name, email) {
  // First try email prefix
  if (email) {
    const emailPrefix = email.split('@')[0];
    if (isValidGitHubUsername(emailPrefix)) {
      return emailPrefix;
    }
  }
  
  // Then try normalized name
  const normalized = normalizeName(name);
  if (normalized && normalized.length >= 3 && normalized.length <= 39) {
    return normalized;
  }
  
  // Last resort: create a safe temporary identifier
  const safe = name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase().substring(0, 20);
  return safe || 'unknown';
}

async function getOrCreateFile(fileChange, fileMap) {
  const path = fileChange.file;
  let file = fileMap.get(path);
  
  if (!file) {
    file = {
      canonical_path: path,
      current_path: path
    };
    fileMap.set(path, file);
  }
  
  return file;
}

function normalizeName(name) {
  return name
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '');
}

// Replace the insertContributors function with this updated version:
async function insertContributors(contributors) {
  if (contributors.length === 0) return;
  
  console.log(`📝 Inserting ${contributors.length} contributors...`);
  
  // Insert in batches to avoid overwhelming the database
  const batchSize = 50;
  let totalInserted = 0;
  let totalSkipped = 0;
  
  for (let i = 0; i < contributors.length; i += batchSize) {
    const batch = contributors.slice(i, i + batchSize);
    
    // Insert contributors one by one to handle duplicates gracefully
    for (const contributor of batch) {
      try {
        const { error } = await supabase
          .from('contributors')
          .insert({
            github_login: contributor.github_login || contributor.canonical_name,
            canonical_name: contributor.canonical_name,
            email: contributor.email
          });
        
        if (error) {
          if (error.code === '23505') {
            // Duplicate key error - this is expected, skip silently
            totalSkipped++;
          } else {
            throw error;
          }
        } else {
          totalInserted++;
        }
      } catch (error) {
        console.error(`Error inserting contributor ${contributor.github_login}:`, error);
        totalSkipped++;
      }
    }
    
    console.log(`📝 Processed contributors batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(contributors.length/batchSize)} (inserted: ${totalInserted}, skipped: ${totalSkipped})`);
  }
  
  console.log(`📊 Contributors insertion completed: ${totalInserted} inserted, ${totalSkipped} skipped duplicates`);
}

async function insertFiles(files) {
  if (files.length === 0) return;
  
  console.log(`📁 Inserting ${files.length} files...`);
  
  const batchSize = 100;
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const { error } = await supabase
      .from('files')
      .insert(batch.map(f => ({
        canonical_path: f.canonical_path,
        current_path: f.current_path
      })));
    
    if (error) {
      console.error('Error inserting files batch:', error);
      throw error;
    }
    
    console.log(`📁 Inserted files batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(files.length/batchSize)}`);
  }
}

async function updateMetadata(key, value) {
  const { error } = await supabase
    .from('repository_metadata')
    .upsert({ key, value }, { onConflict: 'key' });
    
  if (error) throw error;
}

// Run if called directly
if (require.main === module) {
  initializeRepository();
}

module.exports = { initializeRepository };
