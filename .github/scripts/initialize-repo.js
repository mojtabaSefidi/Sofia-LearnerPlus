// .github/scripts/initialize-repo.js
const github = require('@actions/github');
const { createClient } = require('@supabase/supabase-js');
const core = require('@actions/core');
const { execSync } = require('child_process');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function initializeRepository() {
  console.log('🚀 Starting repository initialization...');
  
  try {
    const handleDuplicates = process.env.HANDLE_DUPLICATES === 'true';
    console.log(`🔧 Handle duplicates: ${handleDuplicates}`);
    
    // Step 1: Process Commits first (as requested)
    console.log('📊 Processing commits...');
    const commitData = await processCommits(handleDuplicates);
    
    // Step 2: Process Pull Requests
    console.log('📋 Processing pull requests...');
    const prData = await processPullRequests(handleDuplicates);
    
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

async function processCommits(handleDuplicates) {
  console.log('📊 Processing commits outside PRs...');
  
  try {
    // Get all commits using git log
    const gitLogOutput = execSync('git log --all --pretty=format:"%H|%an|%ae|%ad|%s" --date=iso', { encoding: 'utf8' });
    const commits = gitLogOutput.split('\n').filter(line => line.trim()).map(line => {
      const [hash, author_name, author_email, date, message] = line.split('|');
      return { hash, author_name, author_email, date: new Date(date), message };
    });
    
    console.log(`Found ${commits.length} total commits`);
    
    // Get commits that are in PRs to exclude them
    const prCommits = await getPRCommitHashes();
    
    // Filter out merge commits and PR commits
    const standaloneCommits = commits.filter(commit => 
      !commit.message.toLowerCase().startsWith('merge') &&
      !prCommits.has(commit.hash)
    );
    
    console.log(`Processing ${standaloneCommits.length} standalone commits`);
    
    const contributors = new Map();
    const files = new Map();
    const contributions = [];
    
    for (const commit of standaloneCommits) {
      try {
        await processStandaloneCommit(commit, contributors, files, contributions, handleDuplicates);
      } catch (error) {
        console.warn(`⚠️ Error processing commit ${commit.hash}: ${error.message}`);
      }
    }
    
    // Insert data
    await insertContributors(Array.from(contributors.values()));
    await insertFiles(Array.from(files.values()));
    await insertContributions(contributions);
    
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

async function processStandaloneCommit(commit, contributors, files, contributions, handleDuplicates) {
  // Get commit file changes
  const fileChanges = await getCommitFileChanges(commit.hash);
  
  // Process contributor
  const contributor = await resolveContributor(
    commit.author_name,
    commit.author_email,
    null, // No GitHub login from git commit
    handleDuplicates
  );
  
  const contributorKey = contributor.email || contributor.github_login;
  if (!contributors.has(contributorKey)) {
    contributors.set(contributorKey, contributor);
  }
  
  // Process each file
  for (const fileChange of fileChanges) {
  // Add ALL files to files map (not just new ones)
    if (!files.has(fileChange.file)) {
      files.set(fileChange.file, {
        canonical_path: fileChange.file,
        current_path: fileChange.file
      });
    }
    
    // Check for duplicate contribution (basic check for now)
    const contributionKey = `${contributorKey}-${fileChange.file}-${commit.date.toISOString()}-${commit.hash}-${fileChange.linesModified}`;
    
    contributions.push({
      contributor_key: (contributor.email ? contributor.email.toLowerCase() : null) || contributor.github_login,
      file_path: fileChange.file,
      activity_type: 'commit',
      activity_id: commit.hash,
      contribution_date: commit.date,
      lines_added: fileChange.linesAdded || 0,
      lines_deleted: fileChange.linesDeleted || 0,
      lines_modified: fileChange.linesModified || 0,
      pr_number: null,
      contribution_key: contributionKey
    });
  }
}

async function getCommitFileChanges(commitHash) {
  try {
    const nameStatusOutput = execSync(`git show ${commitHash} --name-status --format=""`, { encoding: 'utf8' });
    const numStatOutput = execSync(`git show ${commitHash} --numstat --format=""`, { encoding: 'utf8' });
    
    const files = [];
    const numStatLines = numStatOutput.split('\n').filter(line => line.trim());
    const nameStatusLines = nameStatusOutput.split('\n').filter(line => line.trim());
    
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
      if (parts.length >= 2) {
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
      }
    });
    
    return files;
  } catch (error) {
    console.warn(`⚠️ Error getting file changes for commit ${commitHash}:`, error.message);
    return [];
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

async function processPullRequests(handleDuplicates) {
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
      // Skip draft PRs
      if (pr.draft) {
        console.log(`⏭️ Skipping draft PR #${pr.number}`);
        continue;
      }

      const prResult = await processSinglePR(pr, octokit, context, handleDuplicates);
      
      // Collect PR data
      pullRequests.push(prResult.prData);
      
      // Handle PR based on status
      if (pr.state === 'open') {
        // For open PRs: only add PR data and basic contributor info
        if (!contributors.has(prResult.prData.author_login)) {
          const contributor = await resolveContributor(
            prResult.prData.author_login,
            null,
            prResult.prData.author_login,
            handleDuplicates
          );
          contributors.set(prResult.prData.author_login, contributor);
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
  
  // Insert data
  await insertPullRequests(pullRequests);
  await insertContributors(Array.from(contributors.values()));
  await insertFiles(Array.from(files.values()));
  await insertContributions(contributions);
  await insertReviewComments(reviewComments);
  
  return {
    pullRequests,
    contributions,
    contributors: Array.from(contributors.values()),
    files: Array.from(files.values()),
    reviewComments
  };
}

async function processSinglePR(pr, octokit, context, handleDuplicates) {
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
  const prAuthor = await resolveContributor(pr.user.login, null, pr.user.login, handleDuplicates);
  contributors.push(prAuthor);
  
  // Add new files created by the PR author
  // const newFiles = prFiles.filter(file => file.status === 'added');
  prFiles.forEach(file => {
    files.push({
      canonical_path: file.filename,
      current_path: file.filename
    });
  });
  
  // Add commit contributions (excluding merge commits)
  for (const commit of nonMergeCommits) {
    // Add commit author if different from PR author
    let commitAuthor = prAuthor;
    if (commit.author && commit.author.login !== pr.user.login) {
      commitAuthor = await resolveContributor(
        commit.author.login,
        null,
        commit.author.login,
        handleDuplicates
      );
      contributors.push(commitAuthor);
    }
    
    // For each file in each commit
    for (const file of prFiles) {
      const fileLinesModified = (file.additions || 0) + (file.deletions || 0);
      
      contributions.push({
        contributor_key: commitAuthor.email || commitAuthor.github_login,
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
    const reviewerContributor = await resolveContributor(
      reviewer.login,
      null,
      reviewer.login,
      handleDuplicates
    );
    contributors.push(reviewerContributor);
    
    // Add review contribution for each file
    for (const file of prFiles) {
      const fileLinesModified = (file.additions || 0) + (file.deletions || 0);
      
      contributions.push({
        contributor_key: reviewerContributor.email || reviewerContributor.github_login,
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
  const reviewComments = await getPRComments(pr, octokit, context, handleDuplicates);
  
  return {
    prData,
    contributors,
    files,
    contributions,
    reviewComments
  };
}

async function getPRComments(pr, octokit, context, handleDuplicates) {
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
          contributor_key: comment.user.login,
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
  if (comment.user.login === 'github-actions[bot]' || comment.user.login.includes('[bot]')) return false;
  
  // Skip command-like comments
  if (body.includes('@sofiabot') || 
      body.includes('\\sofiabot') ||
      body.includes('assign-reviewer') || 
      body.startsWith('/') || 
      body.startsWith('@bot')) {
    return false;
  }
  
  return true;
}

async function resolveContributor(name, email, githubLogin, handleDuplicates) {
  if (handleDuplicates) {
    // Check for duplicates in database
    const primaryLogin = await findPrimaryContributor(name, email, githubLogin);
    if (primaryLogin) {
      return {
        github_login: primaryLogin,
        canonical_name: normalizeName(name || primaryLogin),
        email: email
      };
    }
  }
  
  // If no duplicate found, create new contributor
  const resolvedLogin = githubLogin || extractUsernameFromEmail(email) || normalizeName(name);
  
  return {
    github_login: resolvedLogin,
    canonical_name: normalizeName(name || resolvedLogin),
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
    
    for (const duplicate of duplicates || []) {
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
    .replace(/\s+/g, '-') || 'unknown';
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
  let totalSkipped = 0;
  
  for (let i = 0; i < pullRequests.length; i += batchSize) {
    const batch = pullRequests.slice(i, i + batchSize);
    
    const { error } = await supabase
      .from('pull_requests')
      .upsert(batch, { onConflict: 'pr_number' });
    
    if (error) {
      console.error('Error inserting PRs batch:', error);
      totalSkipped += batch.length;
    } else {
      totalInserted += batch.length;
    }
    
    console.log(`📝 Processed PR batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(pullRequests.length/batchSize)}`);
  }
  
  console.log(`✅ Pull requests: ${totalInserted} inserted/updated, ${totalSkipped} failed`);
}

async function insertContributors(contributors) {
  if (contributors.length === 0) return;
  
  console.log(`👥 Inserting ${contributors.length} contributors...`);
  
  let totalInserted = 0;
  let totalSkipped = 0;
  
  // Remove duplicates by github_login
  const uniqueContributors = Array.from(
    new Map(contributors.map(c => [c.github_login, c])).values()
  );
  
  for (const contributor of uniqueContributors) {
    try {
      const { error } = await supabase
        .from('contributors')
        .upsert({
          github_login: contributor.github_login,
          canonical_name: contributor.canonical_name,
          email: contributor.email
        // }, { onConflict: 'github_login' });
        });
      
      if (error) {
        console.warn(`⚠️ Error inserting contributor ${contributor.github_login}:`, error);
        totalSkipped++;
      } else {
        totalInserted++;
      }
    } catch (error) {
      console.error(`Error inserting contributor ${contributor.github_login}:`, error);
      totalSkipped++;
    }
  }
  
  console.log(`👥 Contributors: ${totalInserted} inserted/updated, ${totalSkipped} failed`);
}

async function insertFiles(files) {
  if (files.length === 0) return;
  
  console.log(`📁 Inserting ${files.length} files...`);
  
  // Remove duplicates
  const uniqueFiles = Array.from(
    new Map(files.map(f => [f.canonical_path, f])).values()
  );
  
  let totalInserted = 0;
  let totalSkipped = 0;
  
  // Insert files one by one to handle duplicates gracefully
  for (const file of uniqueFiles) {
    try {
      const { error } = await supabase
        .from('files')
        .upsert({
          canonical_path: file.canonical_path,
          current_path: file.current_path
        }, { onConflict: 'canonical_path' });
      
      if (error) {
        console.warn(`⚠️ Error inserting file ${file.canonical_path}:`, error);
        totalSkipped++;
      } else {
        totalInserted++;
      }
    } catch (error) {
      console.error(`Error inserting file ${file.canonical_path}:`, error);
      totalSkipped++;
    }
  }
  
  console.log(`📁 Files: ${totalInserted} inserted/updated, ${totalSkipped} failed`);
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
  
  if (!dbContributors || !dbFiles) {
    console.error('❌ Failed to fetch contributors or files from database');
    return;
  }
  
  const contributorMap = new Map();
  dbContributors.forEach(c => {
    contributorMap.set(c.github_login, c.id);
    if (c.email) contributorMap.set(c.email, c.id);
  });

  console.log(Array.from(contributorMap.entries()));
  console.log('---------CONT-------------');
  
  const fileMap = new Map();
  dbFiles.forEach(f => {
    fileMap.set(f.canonical_path, f.id);
  });
  
  console.log('Sample files in DB:', dbFiles.slice(0, 10).map(f => f.canonical_path));
  console.log('---------Files-------------');

  const mappedContributions = [];
  let skipped = 0;
  
  // Remove duplicates based on contribution_key if available
  const uniqueContributions = contributions.filter((contrib, index, self) => {
    if (contrib.contribution_key) {
      return index === self.findIndex(c => c.contribution_key === contrib.contribution_key);
    }
    return true;
  });
  
  let debugCount = 0;
  for (const contrib of uniqueContributions) {
    const contributorId = contributorMap.get(contrib.contributor_key);
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
      if (debugCount < 5)
      {
        console.log(
          "Looking up contributor:",
          JSON.stringify(contrib.contributor_key),
          "→ found id:",
          contributorId
        );
        
        console.log(
          "Looking up file:",
          JSON.stringify(contrib.file_path),
          "→ found id:",
          fileId
        );
        debugCount++;
      }
      
      console.warn(`⚠️ Cannot map contribution: contributor_key=${contrib.contributor_key}, file_path=${contrib.file_path}`);
      skipped++;
    }
  }
  
  console.log(`🔗 Mapped ${mappedContributions.length} contributions (skipped ${skipped})`);
  
  // Insert in batches
  const batchSize = 500;
  let totalInserted = 0;
  let totalFailed = 0;
  
  for (let i = 0; i < mappedContributions.length; i += batchSize) {
    const batch = mappedContributions.slice(i, i + batchSize);
    
    const { error } = await supabase
      .from('contributions')
      .upsert(batch, { 
        // onConflict: 'contributor_id,file_id,contribution_date,activity_id,lines_modified',
        ignoreDuplicates: true 
      });
    
    if (error) {
      console.warn(`⚠️ Error inserting contributions batch ${Math.floor(i/batchSize) + 1}:`, error);
      totalFailed += batch.length;
    } else {
      totalInserted += batch.length;
    }
    
    console.log(`🔗 Processed contributions batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(mappedContributions.length/batchSize)}`);
  }
  
  console.log(`✅ Contributions: ${totalInserted} inserted/updated, ${totalFailed} failed`);
}

async function insertReviewComments(comments) {
  if (comments.length === 0) return;
  
  console.log(`💬 Processing ${comments.length} review comments...`);
  
  // Get contributor mappings
  const { data: dbContributors } = await supabase
    .from('contributors')
    .select('id, github_login');
  
  if (!dbContributors) {
    console.error('❌ Failed to fetch contributors from database');
    return;
  }
  
  const contributorMap = new Map();
  dbContributors.forEach(c => {
    contributorMap.set(c.github_login, c.id);
  });
  
  const mappedComments = [];
  let skipped = 0;
  
  for (const comment of comments) {
    const contributorId = contributorMap.get(comment.contributor_key);
    
    if (contributorId) {
      mappedComments.push({
        contributor_id: contributorId,
        pr_number: comment.pr_number,
        comment_date: comment.comment_date,
        comment_text: comment.comment_text
      });
    } else {
      console.warn(`⚠️ Cannot map comment: contributor_key=${comment.contributor_key}`);
      skipped++;
    }
  }
  
  console.log(`💬 Mapped ${mappedComments.length} comments (skipped ${skipped})`);
  
  // Insert in batches
  const batchSize = 100;
  let totalInserted = 0;
  let totalFailed = 0;
  
  for (let i = 0; i < mappedComments.length; i += batchSize) {
    const batch = mappedComments.slice(i, i + batchSize);
    
    const { error } = await supabase
      .from('review_comments')
      .insert(batch);
    
    if (error) {
      console.warn(`⚠️ Error inserting comments batch ${Math.floor(i/batchSize) + 1}:`, error);
      totalFailed += batch.length;
    } else {
      totalInserted += batch.length;
    }
    
    console.log(`💬 Processed comments batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(mappedComments.length/batchSize)}`);
  }
  
  console.log(`✅ Review comments: ${totalInserted} inserted, ${totalFailed} failed`);
}

// Run if called directly
if (require.main === module) {
  initializeRepository();
}

module.exports = { initializeRepository };
