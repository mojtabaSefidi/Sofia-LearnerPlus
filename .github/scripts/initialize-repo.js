// .github/scripts/initialize-repo.js
const github = require('@actions/github');
const { createClient } = require('@supabase/supabase-js');
const git = require('simple-git')();
const core = require('@actions/core');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function initializeRepository() {
  console.log('🚀 Starting repository initialization...');
  
  try {
    // Step 1: Process Pull Requests first (as they define the main workflow)
    console.log('📋 Processing pull requests...');
    const prData = await processPullRequests();
    
    // Step 2: Process Commits (outside PRs)
    console.log('📊 Processing commits...');
    const commitData = await processCommits();
    
    // Step 3: Combine all contributor data and handle duplicates
    // console.log('👥 Handling contributors and duplicates...');
    // await handleContributorsWithDuplicates([...prData.contributors, ...commitData.contributors]);
    
    // Step 4: Insert files
    console.log('📁 Inserting files...');
    await insertFiles([...prData.files, ...commitData.files]);
    
    // Step 5: Insert contributions with proper contributor mapping
    console.log('🔗 Inserting contributions...');
    await insertContributions([...prData.contributions, ...commitData.contributions]);
    
    // Step 6: Insert review comments
    if (prData.reviewComments.length > 0) {
      console.log('💬 Inserting review comments...');
      await insertReviewComments(prData.reviewComments);
    }
    
    console.log('✅ Repository initialization completed successfully!');
    console.log(`📈 Summary:
    - Pull Requests: ${prData.pullRequests.length}
    - Review Comments: ${prData.reviewComments.length}
    - Contributors: ${new Set([...prData.contributors.map(c => c.email || c.github_login), ...commitData.contributors.map(c => c.email || c.github_login)]).size}
    - Files: ${new Set([...prData.files.map(f => f.canonical_path), ...commitData.files.map(f => f.canonical_path)]).size}
    - Contributions: ${prData.contributions.length + commitData.contributions.length}`);
    
  } catch (error) {
    console.error('❌ Error during initialization:', error);
    core.setFailed(error.message);
  }
}

async function processPullRequests() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.log('⚠️ No GITHUB_TOKEN provided, skipping PR processing');
    return { pullRequests: [], contributions: [], contributors: [], files: [], reviewComments: [] };
  }

  const octokit = github.getOctokit(token);
  const context = github.context;
  
  // Get all PRs
  const allPRs = await fetchAllPRs(octokit, context);
  
  const pullRequests = [];
  const contributions = [];
  const contributors = new Map();
  const files = new Map();
  const reviewComments = [];
  
  for (const pr of allPRs) {
    try {
      const prResult = await processSinglePR(pr, octokit, context);
      
      // Collect PR data
      pullRequests.push(prResult.prData);
      
      // Skip draft PRs for contributions
      if (pr.draft) {
        console.log(`⏭️ Skipping draft PR #${pr.number}`);
        continue;
      }
      
      // Handle PR based on status
      if (pr.state === 'open') {
        // For open PRs: only add PR data and basic contributor info
        if (!contributors.has(prResult.prData.author_login)) {
          contributors.set(prResult.prData.author_login, {
            github_login: prResult.prData.author_login,
            canonical_name: prResult.prData.author_login,
            email: null // No email available from PR API
          });
        }
      } else {
        // For closed/merged PRs: full processing
        // Add contributors
        prResult.contributors.forEach(contributor => {
          const key = contributor.email || contributor.github_login;
          if (!contributors.has(key)) {
            contributors.set(key, contributor);
          }
        });
        
        // Add files
        prResult.files.forEach(file => {
          if (!files.has(file.canonical_path)) {
            files.set(file.canonical_path, file);
          }
        });
        
        // Add contributions (commits and reviews)
        contributions.push(...prResult.contributions);
        
        // Add review comments
        reviewComments.push(...prResult.reviewComments);
      }
      
    } catch (error) {
      console.warn(`⚠️ Error processing PR #${pr.number}: ${error.message}`);
    }
  }
  
  // Insert PRs into database
  await insertPullRequests(pullRequests);
  
  return {
    pullRequests,
    contributions,
    contributors: Array.from(contributors.values()),
    files: Array.from(files.values()),
    reviewComments
  };
}

async function processSinglePR(pr, octokit, context) {
  const prNumber = pr.number;
  
  // Get PR files
  const { data: prFiles } = await octokit.rest.pulls.listFiles({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: prNumber
  });
  
  // Get PR reviews
  const { data: reviews } = await octokit.rest.pulls.listReviews({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: prNumber
  });
  
  // Get PR commits (excluding merge commits)
  const { data: prCommits } = await octokit.rest.pulls.listCommits({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: prNumber
  });
  
  const nonMergeCommits = prCommits.filter(commit => 
    !commit.commit.message.toLowerCase().startsWith('merge') &&
    commit.parents.length === 1
  );
  
  // Calculate total lines modified
  const totalLinesModified = prFiles.reduce((total, file) => 
    total + (file.additions || 0) + (file.deletions || 0), 0
  );
  
  // Get unique reviewers (excluding PR author)
  const uniqueReviewers = reviews
    .filter(review => review.user.login !== pr.user.login)
    .reduce((acc, review) => {
      if (!acc.find(r => r.login === review.user.login)) {
        acc.push({
          login: review.user.login,
          submitted_at: review.submitted_at
        });
      }
      return acc;
    }, []);
  
  // Prepare PR data
  const prData = {
    pr_number: prNumber,
    status: pr.merged_at ? 'merged' : pr.state,
    author_login: pr.user.login,
    reviewers: uniqueReviewers,
    created_date: new Date(pr.created_at),
    merged_date: pr.merged_at ? new Date(pr.merged_at) : null,
    closed_date: pr.closed_at ? new Date(pr.closed_at) : null,
    lines_modified: totalLinesModified
  };
  
  // For open PRs, return early
  if (pr.state === 'open') {
    return {
      prData,
      contributors: [],
      files: [],
      contributions: [],
      reviewComments: []
    };
  }
  
  // For closed/merged PRs, process contributions
  const contributors = [];
  const files = [];
  const contributions = [];
  
  // Add PR author
  contributors.push({
    github_login: pr.user.login,
    canonical_name: pr.user.login,
    email: null
  });
  
  // Add new files created by the PR author
  const newFiles = prFiles.filter(file => file.status === 'added');
  newFiles.forEach(file => {
    files.push({
      canonical_path: file.filename,
      current_path: file.filename
    });
  });
  
  // Add commit contributions (excluding merge commits)
  for (const commit of nonMergeCommits) {
    // Add commit author if different from PR author
    if (commit.author && commit.author.login !== pr.user.login) {
      contributors.push({
        github_login: commit.author.login,
        canonical_name: commit.author.login,
        email: null
      });
    }
    
    // For each file in each commit
    for (const file of prFiles) {
      const fileLinesModified = (file.additions || 0) + (file.deletions || 0);
      
      contributions.push({
        contributor_login: commit.author ? commit.author.login : pr.user.login,
        file_path: file.filename,
        activity_type: 'commit',
        activity_id: commit.sha,
        contribution_date: new Date(commit.commit.author.date),
        lines_added: file.additions || 0,
        lines_deleted: file.deletions || 0,
        lines_modified: fileLinesModified,
        pr_number: prNumber
      });
    }
  }
  
  // Add review contributions
  for (const reviewer of uniqueReviewers) {
    // Add reviewer as contributor
    contributors.push({
      github_login: reviewer.login,
      canonical_name: reviewer.login,
      email: null
    });
    
    // Add review contribution for each file
    for (const file of prFiles) {
      const fileLinesModified = (file.additions || 0) + (file.deletions || 0);
      
      contributions.push({
        contributor_login: reviewer.login,
        file_path: file.filename,
        activity_type: 'review',
        activity_id: prNumber.toString(),
        contribution_date: new Date(reviewer.submitted_at),
        lines_added: 0,
        lines_deleted: 0,
        lines_modified: fileLinesModified,
        pr_number: prNumber
      });
    }
  }
  
  // Get review comments
  const reviewComments = await getPRComments(pr, octokit, context);
  
  return {
    prData,
    contributors,
    files,
    contributions,
    reviewComments
  };
}

async function getPRComments(pr, octokit, context) {
  const comments = [];
  
  try {
    // Get regular PR comments
    const { data: issueComments } = await octokit.rest.issues.listComments({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: pr.number
    });
    
    // Get review comments
    const { data: reviewComments } = await octokit.rest.pulls.listReviewComments({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pr.number
    });
    
    // Get review comments from reviews
    const { data: reviews } = await octokit.rest.pulls.listReviews({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pr.number
    });
    
    // Filter and collect non-bot, non-command comments
    const allComments = [
      ...issueComments.map(c => ({ ...c, type: 'issue' })),
      ...reviewComments.map(c => ({ ...c, type: 'review' })),
      ...reviews.filter(r => r.body).map(r => ({ 
        user: r.user, 
        body: r.body, 
        created_at: r.submitted_at, 
        type: 'review_summary' 
      }))
    ];
    
    for (const comment of allComments) {
      if (isValidComment(comment)) {
        comments.push({
          contributor_login: comment.user.login,
          pr_number: pr.number,
          comment_date: new Date(comment.created_at),
          comment_text: comment.body
        });
      }
    }
    
  } catch (error) {
    console.warn(`⚠️ Error getting comments for PR #${pr.number}: ${error.message}`);
  }
  
  return comments;
}

function isValidComment(comment) {
  // Skip bot comments
  if (comment.user.type === 'Bot') return false;
  
  // Skip empty comments
  if (!comment.body || !comment.body.trim()) return false;
  
  const body = comment.body.toLowerCase();
  
  // Skip GitHub Action bot comments
  if (comment.user.login === 'github-actions[bot]') return false;
  
  // Skip command-like comments
  if (body.includes('@sofiabot') || 
      body.includes('assign-reviewer') || 
      body.startsWith('/') || 
      body.startsWith('@bot')) {
    return false;
  }
  
  return true;
}

async function processCommits() {
  console.log('📊 Processing commits outside PRs...');
  
  try {
    // Get all commits
    const log = await git.log({ '--all': null });
    const commits = log.all;
    
    console.log(`Found ${commits.length} total commits`);
    
    // Get commits that are in PRs to exclude them
    const prCommits = await getPRCommitHashes();
    
    // Filter out merge commits and PR commits
    // const standaloneCommits = commits.filter(commit => 
    //   !commit.message.toLowerCase().startsWith('merge') &&
    //   commit.parents.length === 1 &&
    //   !prCommits.has(commit.hash)
    // );
    
    console.log(`Processing ${standaloneCommits.length} standalone commits`);
    
    const contributors = new Map();
    const files = new Map();
    const contributions = [];
    
    for (const commit of standaloneCommits) {
      try {
        await processStandaloneCommit(commit, contributors, files, contributions);
      } catch (error) {
        console.warn(`⚠️ Error processing commit ${commit.hash}: ${error.message}`);
      }
    }
    
    return {
      contributors: Array.from(contributors.values()),
      files: Array.from(files.values()),
      contributions
    };
    
  } catch (error) {
    console.error('Error processing commits:', error);
    return { contributors: [], files: [], contributions: [] };
  }
}

async function getPRCommitHashes() {
  const prCommits = new Set();
  
  try {
    const token = process.env.GITHUB_TOKEN;
    if (!token) return prCommits;
    
    const octokit = github.getOctokit(token);
    const context = github.context;
    
    // Get all PRs
    const allPRs = await fetchAllPRs(octokit, context);
    
    // Get commits for each PR
    for (const pr of allPRs) {
      try {
        const { data: commits } = await octokit.rest.pulls.listCommits({
          owner: context.repo.owner,
          repo: context.repo.repo,
          pull_number: pr.number
        });
        
        commits.forEach(commit => prCommits.add(commit.sha));
      } catch (error) {
        console.warn(`⚠️ Error getting commits for PR #${pr.number}`);
      }
    }
    
  } catch (error) {
    console.warn('⚠️ Error getting PR commits, processing all commits');
  }
  
  return prCommits;
}

async function processStandaloneCommit(commit, contributors, files, contributions) {
  // Get commit file changes
  const fileChanges = await getCommitFileChanges(commit.hash);
  
  // Process contributor
  const contributor = await resolveContributor(
    commit.author_name,
    commit.author_email,
    null // No GitHub login from git commit
  );
  
  const contributorKey = contributor.email || contributor.github_login;
  if (!contributors.has(contributorKey)) {
    contributors.set(contributorKey, contributor);
  }
  
  // Process each file
  for (const fileChange of fileChanges) {
    // Add new files to files map
    if (fileChange.status === 'A' && !files.has(fileChange.file)) {
      files.set(fileChange.file, {
        canonical_path: fileChange.file,
        current_path: fileChange.file
      });
    }
    
    // Check for duplicate contribution
    const isDuplicate = await checkDuplicateContribution(
      contributorKey,
      fileChange.file,
      new Date(commit.date),
      commit.hash,
      fileChange.linesModified
    );
    
    if (!isDuplicate) {
      contributions.push({
        contributor_email: contributor.email,
        contributor_login: contributor.github_login,
        file_path: fileChange.file,
        activity_type: 'commit',
        activity_id: commit.hash,
        contribution_date: new Date(commit.date),
        lines_added: fileChange.linesAdded || 0,
        lines_deleted: fileChange.linesDeleted || 0,
        lines_modified: fileChange.linesModified || 0,
        pr_number: null
      });
    }
  }
}

async function getCommitFileChanges(commitHash) {
  try {
    const nameStatus = await git.show([commitHash, '--name-status', '--format=']);
    const numStat = await git.show([commitHash, '--numstat', '--format=']);
    
    const files = [];
    const numStatLines = numStat.split('\n').filter(line => line.trim());
    const nameStatusLines = nameStatus.split('\n').filter(line => line.trim());
    
    // Parse numstat for line changes
    const numStatMap = new Map();
    numStatLines.forEach(line => {
      const parts = line.split('\t');
      if (parts.length >= 3) {
        const filename = parts[2];
        const added = parts[0] === '-' ? 0 : parseInt(parts[0]) || 0;
        const deleted = parts[1] === '-' ? 0 : parseInt(parts[1]) || 0;
        numStatMap.set(filename, { added, deleted });
      }
    });
    
    // Parse name-status for file status
    nameStatusLines.forEach(line => {
      const parts = line.split('\t');
      const status = parts[0];
      const filename = parts[1];
      
      const numStat = numStatMap.get(filename) || { added: 0, deleted: 0 };
      
      files.push({
        status: status[0],
        file: filename,
        linesAdded: numStat.added,
        linesDeleted: numStat.deleted,
        linesModified: numStat.added + numStat.deleted
      });
    });
    
    return files;
  } catch (error) {
    console.warn(`⚠️ Error getting file changes for commit ${commitHash}`);
    return [];
  }
}

async function handleContributorsWithDuplicates(allContributors) {
  console.log(`👥 Processing ${allContributors.length} contributors with duplicate detection...`);
  
  // Step 1: Insert all contributors first (with duplicates)
  const uniqueContributors = new Map();
  allContributors.forEach(contributor => {
    const key = contributor.email || contributor.github_login;
    if (!uniqueContributors.has(key)) {
      uniqueContributors.set(key, contributor);
    }
  });
  
  await insertContributorsWithDuplicates(Array.from(uniqueContributors.values()));
  
  // Step 2: Run deduplication process
  await deduplicateContributors();
}

async function resolveContributor(name, email, githubLogin) {
  // First check duplicate contributors table
  const primaryLogin = await findPrimaryContributor(name, email, githubLogin);
  
  if (primaryLogin) {
    return {
      github_login: primaryLogin,
      canonical_name: normalizeName(name),
      email: email
    };
  }
  
  // If no duplicate found, create new contributor
  const resolvedLogin = githubLogin || extractUsernameFromEmail(email) || normalizeName(name);
  
  return {
    github_login: resolvedLogin,
    canonical_name: normalizeName(name),
    email: email
  };
}

async function findPrimaryContributor(name, email, githubLogin) {
  try {
    const { data: duplicates, error } = await supabase
      .from('duplicate_contributors')
      .select('*');
    
    if (error) {
      console.warn('⚠️ Error fetching duplicate contributors:', error);
      return null;
    }
    
    for (const duplicate of duplicates) {
      // Check exact matches first
      if (githubLogin && duplicate.github_usernames.includes(githubLogin)) {
        return duplicate.primary_github_login;
      }
      
      if (email && duplicate.emails.includes(email)) {
        return duplicate.primary_github_login;
      }
      
      if (name && duplicate.names.includes(name)) {
        return duplicate.primary_github_login;
      }
      
      // Check similarity for automatic detection
      if (email) {
        const emailSimilarity = findBestMatch(email, duplicate.emails);
        if (emailSimilarity >= 0.80) {
          console.log(`🎯 High similarity match for email ${email} -> ${duplicate.primary_github_login}`);
          return duplicate.primary_github_login;
        }
      }
      
      if (githubLogin) {
        const usernameSimilarity = findBestMatch(githubLogin, duplicate.github_usernames);
        if (usernameSimilarity >= 0.80) {
          console.log(`🎯 High similarity match for username ${githubLogin} -> ${duplicate.primary_github_login}`);
          return duplicate.primary_github_login;
        }
      }
    }
    
    return null;
  } catch (error) {
    console.warn('⚠️ Error in findPrimaryContributor:', error);
    return null;
  }
}

function findBestMatch(input, candidates) {
  if (!input || !candidates || candidates.length === 0) return 0;
  
  let bestMatch = 0;
  
  for (const candidate of candidates) {
    const similarity = calculateSimilarity(input.toLowerCase(), candidate.toLowerCase());
    bestMatch = Math.max(bestMatch, similarity);
  }
  
  return bestMatch;
}

function calculateSimilarity(str1, str2) {
  // Remove common email domain differences for email similarity
  const cleanStr1 = str1.replace(/@(gmail|yahoo|hotmail|outlook)\.com$/, '@email.com');
  const cleanStr2 = str2.replace(/@(gmail|yahoo|hotmail|outlook)\.com$/, '@email.com');
  
  const distance = levenshteinDistance(cleanStr1, cleanStr2);
  const maxLength = Math.max(cleanStr1.length, cleanStr2.length);
  
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

async function checkDuplicateContribution(contributorKey, filePath, date, activityId, linesModified) {
  try {
    // This would need to be implemented with proper database lookup
    // For now, return false to allow all contributions
    return false;
  } catch (error) {
    return false;
  }
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
  
  // Try email prefix
  const prefix = email.split('@')[0];
  if (isValidGitHubUsername(prefix)) {
    return prefix;
  }
  
  return null;
}

function isValidGitHubUsername(username) {
  return /^[a-zA-Z0-9](?:[a-zA-Z0-9]|-(?=[a-zA-Z0-9])){0,38}$/.test(username);
}

function normalizeName(name) {
  if (!name) return 'unknown';
  return name
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '');
}

async function fetchAllPRs(octokit, context) {
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
  return allPRs;
}

async function insertPullRequests(pullRequests) {
  if (pullRequests.length === 0) return;
  
  console.log(`📝 Inserting ${pullRequests.length} pull requests...`);
  
  const batchSize = 50;
  let totalInserted = 0;
  
  for (let i = 0; i < pullRequests.length; i += batchSize) {
    const batch = pullRequests.slice(i, i + batchSize);
    
    const { error } = await supabase
      .from('pull_requests')
      .upsert(batch, { onConflict: 'pr_number' });
    
    if (error) {
      console.error('Error inserting PRs batch:', error);
      throw error;
    }
    
    totalInserted += batch.length;
    console.log(`📝 Inserted PR batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(pullRequests.length/batchSize)} (${totalInserted} total)`);
  }
  
  console.log(`✅ Successfully inserted ${totalInserted} pull requests`);
}

async function insertContributorsWithDuplicates(contributors) {
  if (contributors.length === 0) return;
  
  console.log(`👥 Inserting ${contributors.length} contributors (with potential duplicates)...`);
  
  let totalInserted = 0;
  let totalSkipped = 0;
  
  for (const contributor of contributors) {
    try {
      const { error } = await supabase
        .from('contributors')
        .insert({
          github_login: contributor.github_login,
          canonical_name: contributor.canonical_name,
          email: contributor.email
        });
      
      if (error) {
        if (error.code === '23505') {
          // Duplicate key error - expected
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
  
  console.log(`👥 Contributors: ${totalInserted} inserted, ${totalSkipped} skipped duplicates`);
}

async function deduplicateContributors() {
  console.log('🔧 Running contributor deduplication...');
  
  try {
    // Get all contributors
    const { data: contributors, error } = await supabase
      .from('contributors')
      .select('*')
      .order('id');
    
    if (error) throw error;
    
    // Get duplicate mappings
    const { data: duplicateMappings, error: dupError } = await supabase
      .from('duplicate_contributors')
      .select('*');
    
    if (dupError) throw dupError;
    
    let mergeCount = 0;
    const processedContributors = new Set();
    
    // Process each duplicate mapping
    for (const mapping of duplicateMappings) {
      const matchingContributors = contributors.filter(c => 
        !processedContributors.has(c.id) && (
          mapping.github_usernames.includes(c.github_login) ||
          mapping.emails.includes(c.email) ||
          mapping.names.includes(c.canonical_name) ||
          findBestMatch(c.github_login, mapping.github_usernames) >= 0.80 ||
          findBestMatch(c.email, mapping.emails) >= 0.80
        )
      );
      
      if (matchingContributors.length > 1) {
        console.log(`🔄 Merging ${matchingContributors.length} contributors for ${mapping.primary_github_login}`);
        
        // Find or create primary contributor
        let primary = matchingContributors.find(c => c.github_login === mapping.primary_github_login);
        
        if (!primary) {
          // Create primary contributor if doesn't exist
          const { data: newPrimary, error: createError } = await supabase
            .from('contributors')
            .insert({
              github_login: mapping.primary_github_login,
              canonical_name: mapping.primary_github_login,
              email: matchingContributors[0].email
            })
            .select()
            .single();
          
          if (createError) throw createError;
          primary = newPrimary;
        }
        
        // Merge all others into primary
        const duplicates = matchingContributors.filter(c => c.id !== primary.id);
        
        for (const duplicate of duplicates) {
          await mergeContributorData(duplicate.id, primary.id);
          processedContributors.add(duplicate.id);
        }
        
        processedContributors.add(primary.id);
        mergeCount++;
      }
    }
    
    console.log(`✅ Deduplication completed: ${mergeCount} merge operations`);
    
  } catch (error) {
    console.error('❌ Error during deduplication:', error);
    // Don't throw - continue with workflow
  }
}

async function mergeContributorData(fromId, toId) {
  try {
    // Update contributions
    await supabase
      .from('contributions')
      .update({ contributor_id: toId })
      .eq('contributor_id', fromId);
    
    // Update review comments
    await supabase
      .from('review_comments')
      .update({ contributor_id: toId })
      .eq('contributor_id', fromId);
    
    // Delete duplicate contributor
    await supabase
      .from('contributors')
      .delete()
      .eq('id', fromId);
    
    console.log(`🔗 Merged contributor ${fromId} -> ${toId}`);
  } catch (error) {
    console.error(`Error merging contributor ${fromId} to ${toId}:`, error);
  }
}

async function insertFiles(files) {
  if (files.length === 0) return;
  
  console.log(`📁 Inserting ${files.length} files...`);
  
  // Remove duplicates
  const uniqueFiles = Array.from(
    new Map(files.map(f => [f.canonical_path, f])).values()
  );
  
  const batchSize = 100;
  let totalInserted = 0;
  let totalSkipped = 0;
  
  for (let i = 0; i < uniqueFiles.length; i += batchSize) {
    const batch = uniqueFiles.slice(i, i + batchSize);
    
    // Insert files one by one to handle duplicates
    for (const file of batch) {
      try {
        const { error } = await supabase
          .from('files')
          .insert({
            canonical_path: file.canonical_path,
            current_path: file.current_path
          });
        
        if (error) {
          if (error.code === '23505') {
            totalSkipped++;
          } else {
            throw error;
          }
        } else {
          totalInserted++;
        }
      } catch (error) {
        console.error(`Error inserting file ${file.canonical_path}:`, error);
        totalSkipped++;
      }
    }
  }
  
  console.log(`📁 Files: ${totalInserted} inserted, ${totalSkipped} skipped duplicates`);
}

async function insertContributions(contributions) {
  if (contributions.length === 0) return;
  
  console.log(`🔗 Processing ${contributions.length} contributions...`);
  
  // Get contributor and file mappings
  const { data: dbContributors } = await supabase
    .from('contributors')
    .select('id, github_login, email');
  
  const { data: dbFiles } = await supabase
    .from('files')
    .select('id, canonical_path');
  
  const contributorMap = new Map();
  dbContributors.forEach(c => {
    contributorMap.set(c.github_login, c.id);
    if (c.email) contributorMap.set(c.email, c.id);
  });
  
  const fileMap = new Map();
  dbFiles.forEach(f => {
    fileMap.set(f.canonical_path, f.id);
  });
  
  const mappedContributions = [];
  let skipped = 0;
  
  for (const contrib of contributions) {
    const contributorId = contributorMap.get(contrib.contributor_email) || 
                         contributorMap.get(contrib.contributor_login);
    const fileId = fileMap.get(contrib.file_path);
    
    if (contributorId && fileId) {
      mappedContributions.push({
        contributor_id: contributorId,
        file_id: fileId,
        activity_type: contrib.activity_type,
        activity_id: contrib.activity_id,
        contribution_date: contrib.contribution_date,
        lines_added: contrib.lines_added || 0,
        lines_deleted: contrib.lines_deleted || 0,
        lines_modified: contrib.lines_modified || 0,
        pr_number: contrib.pr_number || null
      });
    } else {
      skipped++;
    }
  }
  
  console.log(`🔗 Mapped ${mappedContributions.length} contributions (skipped ${skipped})`);
  
  // Insert in batches
  const batchSize = 500;
  let totalInserted = 0;
  
  for (let i = 0; i < mappedContributions.length; i += batchSize) {
    const batch = mappedContributions.slice(i, i + batchSize);
    
    const { error } = await supabase
      .from('contributions')
      .insert(batch);
    
    if (error) {
      console.error('Error inserting contributions batch:', error);
    } else {
      totalInserted += batch.length;
      console.log(`🔗 Inserted contributions batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(mappedContributions.length/batchSize)}`);
    }
  }
  
  console.log(`✅ Successfully inserted ${totalInserted} contributions`);
}

async function insertReviewComments(comments) {
  if (comments.length === 0) return;
  
  console.log(`💬 Processing ${comments.length} review comments...`);
  
  // Get contributor mappings
  const { data: dbContributors } = await supabase
    .from('contributors')
    .select('id, github_login');
  
  const contributorMap = new Map();
  dbContributors.forEach(c => {
    contributorMap.set(c.github_login, c.id);
  });
  
  const mappedComments = [];
  let skipped = 0;
  
  for (const comment of comments) {
    const contributorId = contributorMap.get(comment.contributor_login);
    
    if (contributorId) {
      mappedComments.push({
        contributor_id: contributorId,
        pr_number: comment.pr_number,
        comment_date: comment.comment_date,
        comment_text: comment.comment_text
      });
    } else {
      skipped++;
    }
  }
  
  console.log(`💬 Mapped ${mappedComments.length} comments (skipped ${skipped})`);
  
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
    } else {
      totalInserted += batch.length;
      console.log(`💬 Inserted comments batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(mappedComments.length/batchSize)}`);
    }
  }
  
  console.log(`✅ Successfully inserted ${totalInserted} review comments`);
}

// Run if called directly
if (require.main === module) {
  initializeRepository();
}

module.exports = { initializeRepository };
