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
    // Step 1: Process commits using GitHub API
    console.log('📊 Processing commits...');
    const commitData = await processAllCommits();
    
    // Step 2: Process Pull Requests
    console.log('📋 Processing pull requests...');
    const prData = await processPullRequests();
    
    console.log('✅ Repository initialization completed successfully!');
    console.log(`📈 Summary:
    - Contributors: ${commitData.contributors.length}
    - Files: ${commitData.files.length}
    - Commits: ${commitData.contributions.length}
    - Pull Requests: ${prData.pullRequests.length}
    - Review Contributions: ${prData.reviewContributions.length}
    - Review Comments: ${prData.reviewComments.length}`);
    
  } catch (error) {
    console.error('❌ Error during initialization:', error);
    core.setFailed(error.message);
  }
}

async function processAllCommits() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.log('⚠️ No GITHUB_TOKEN provided, skipping commit processing');
    return { contributors: [], files: [], contributions: [] };
  }

  const octokit = github.getOctokit(token);
  const context = github.context;
  
  // Fetch all commits using GitHub API
  const allCommits = await fetchAllRepoCommits(octokit, context);
  
  // Extract unique contributors and  missing data
  const contributorsMap = new Map();
  await resolveContributors(allCommits, contributorsMap, octokit);
  
  // Process files and contributions
  const filesMap = new Map();
  const contributions = [];
  
  for (const commit of allCommits) {
    if (!commit.author?.login) continue; // Skip commits without GitHub username
    
    try {
      await processCommitContribution(commit, contributorsMap, filesMap, contributions);
    } catch (error) {
      console.warn(`⚠️ Error processing commit ${commit.sha}: ${error.message}`);
    }
  }
  
  const contributors = Array.from(contributorsMap.values());
  const files = Array.from(filesMap.values());
  
  // Insert data
  await insertContributors(contributors);
  await insertFiles(files);
  await insertContributions(contributions);
  
  return { contributors, files, contributions };
}

async function fetchAllRepoCommits(octokit, context) {
  const allCommits = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const { data: commits } = await octokit.rest.repos.listCommits({
      owner: context.repo.owner,
      repo: context.repo.repo,
      per_page: perPage,
      page: page,
    });

    if (commits.length === 0) break;
    allCommits.push(...commits);
    page++;
  }

  console.log(`📊 Found ${allCommits.length} total commits in repository`);
  return allCommits;
}

async function resolveContributors(allCommits, contributorsMap, octokit) {
  const uniqueAuthors = new Map();
  let nullCounters = { username: 0, name: 0, email: 0 };
  
  // Extract unique contributors from commits
  for (const commit of allCommits) {
    const username = commit.author?.login || null;
    const name = commit.commit.author?.name || null;
    const email = commit.commit.author?.email || null;
    
    // Count nulls for logging
    if (!username) nullCounters.username++;
    if (!name) nullCounters.name++;
    if (!email) nullCounters.email++;
    
    // Store unique authors by username (skip if username is null)
    if (username) {
      uniqueAuthors.set(username, { name, email });
    }
  }
  
  console.log(`👥 Processing ${uniqueAuthors.size} unique contributors (nulls: username=${nullCounters.username}, name=${nullCounters.name}, email=${nullCounters.email})`);
  
  // Resolve missing name/email data from GitHub API
  for (const [username, data] of uniqueAuthors) {
    let { name, email } = data;
    
    // If name or email is missing, try to get from GitHub user API
    if (!name || !email) {
      try {
        const { data: user } = await octokit.rest.users.getByUsername({ username });
        name = name || user.name || username;
        email = email || user.email; // Note: user.email might still be null if private
      } catch (error) {
        console.warn(`⚠️ Could not fetch user data for ${username}`);
        name = name || username;
      }
    }
    
    contributorsMap.set(username, {
      github_login: username,
      canonical_name: name || username,
      email: email
    });
  }
}

async function resolveReviewerContributor(username, octokit) {
  // First check if contributor exists in DB by username
  
  console.log(`---------------------`)
  console.log(`Username: ${username}`)
  const { data: existingByUsername } = await supabase
    .from('contributors')
    .select('id, github_login, canonical_name, email')
    .eq('github_login', username)
    .single();
  
  console.log(`existingByUsername: ${JSON.stringify(existingByUsername, null, 2)}`);
  if (existingByUsername) {
    return existingByUsername;
  }
  
  // Not found by username, try to get email from GitHub API
  let email = null;
  let name = username;
  
  try {
    const { data: user } = await octokit.rest.users.getByUsername({ username });
    email = user.email;
    name = user.name || username;
  } catch (error) {
    console.warn(`⚠️ Could not fetch user data for reviewer ${username}`);
  }
  console.log(`email: ${email}`)
  console.log(`name: ${name}`)
  // If we have email, check DB by email
  if (email) {
    const { data: existingByEmail } = await supabase
      .from('contributors')
      .select('id, github_login, canonical_name, email')
      .eq('email', email)
      .single();
    
    console.log(`existingByEmail: ${existingByEmail}`);
    if (existingByEmail) {
      return existingByEmail;
    }
  }
  
  console.log('new user:')
  console.log(`github_login: ${username}`);
  console.log(`name: ${name}`);
  console.log(`email: ${email}`);
  // Not found in DB, return new contributor data for insertion
  return {
    github_login: username,
    canonical_name: name,
    email: email
  };
}

async function processCommitContribution(commit, contributorsMap, filesMap, contributions) {
  const username = commit.author.login;
  const contributor = contributorsMap.get(username);
  
  if (!contributor) return;
  
  // Get commit file changes using git
  const fileChanges = await getCommitFileChanges(commit.sha);
  
  // Process each file
  for (const fileChange of fileChanges) {
    // Add file to files map
    if (!filesMap.has(fileChange.file)) {
      filesMap.set(fileChange.file, {
        canonical_path: fileChange.file,
        current_path: fileChange.file
      });
    }
    
    // Add contribution
    contributions.push({
      contributor_key: username,
      file_path: fileChange.file,
      activity_type: 'commit',
      activity_id: commit.sha,
      contribution_date: new Date(commit.commit.author.date),
      lines_added: fileChange.linesAdded || 0,
      lines_deleted: fileChange.linesDeleted || 0,
      lines_modified: fileChange.linesModified || 0,
      pr_number: null
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
    console.warn(`⚠️ Error getting file changes for commit ${commitHash}`);
    return [];
  }
}

async function processPullRequests() {
  const token = process.env.GITHUB_TOKEN;
  if (!token) {
    console.log('⚠️ No GITHUB_TOKEN provided, skipping PR processing');
    return { pullRequests: [], reviewContributions: [], reviewComments: [] };
  }

  const octokit = github.getOctokit(token);
  const context = github.context;
  
  // Get all PRs
  const allPRs = await fetchAllPRs(octokit, context);
  
  const pullRequests = [];
  const reviewContributions = [];
  const reviewComments = [];
  const contributors = new Map();
  const files = new Map();
  
  for (const pr of allPRs) {
    try {
      if (pr.draft) continue; // Skip draft PRs
      
      const prResult = await processSinglePR(pr, octokit, context);
      
      pullRequests.push(prResult.prData);
      
      // For closed/merged PRs, process contributions
      if (pr.state !== 'open') {
        // Add contributors
        prResult.contributors.forEach(contributor => {
          if (!contributors.has(contributor.github_login)) {
            contributors.set(contributor.github_login, contributor);
          }
        });
        
        // Add files
        prResult.files.forEach(file => {
          if (!files.has(file.canonical_path)) {
            files.set(file.canonical_path, file);
          }
        });
        
        // Add review contributions and comments
        reviewContributions.push(...prResult.reviewContributions);
        reviewComments.push(...prResult.reviewComments);
      } else {
        // For open PRs, just add the PR author
        if (!contributors.has(pr.user.login)) {
          contributors.set(pr.user.login, {
            github_login: pr.user.login,
            canonical_name: pr.user.login,
            email: null
          });
        }
      }
      
    } catch (error) {
      console.warn(`⚠️ Error processing PR #${pr.number}: ${error.message}`);
    }
  }
  
  // Insert data
  await insertPullRequests(pullRequests);
  await insertContributors(Array.from(contributors.values()));
  await insertFiles(Array.from(files.values()));
  await insertContributions(reviewContributions);
  await insertReviewComments(reviewComments);
  
  return {
    pullRequests,
    reviewContributions,
    reviewComments
  };
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
    page++;
  }
  
  console.log(`📊 Found ${allPRs.length} total pull requests`);
  return allPRs;
}

async function processSinglePR(pr, octokit, context) {
  const prNumber = pr.number;
  
  // Get PR files
  const { data: prFiles } = await octokit.rest.pulls.listFiles({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: prNumber
  });
  
  // Get PR reviews - this will capture all review submissions
  const { data: reviews } = await octokit.rest.pulls.listReviews({
    owner: context.repo.owner,
    repo: context.repo.repo,
    pull_number: prNumber
  });
  
  // Calculate total lines modified
  const totalLinesModified = prFiles.reduce((total, file) => 
    total + (file.additions || 0) + (file.deletions || 0), 0
  );
  
  // Get unique reviewers with their submission dates
  const reviewerSubmissions = reviews
    .filter(review => review.user.login !== pr.user.login)
    .map(review => ({
      login: review.user.login,
      submitted_at: review.submitted_at,
      review_id: review.id
    }));
  
  // Prepare PR data
  const prData = {
    pr_number: prNumber,
    status: pr.merged_at ? 'merged' : pr.state,
    author_login: pr.user.login,
    reviewers: reviewerSubmissions.reduce((acc, review) => {
      if (!acc.find(r => r.login === review.login)) {
        acc.push({
          login: review.login,
          submitted_at: review.submitted_at
        });
      }
      return acc;
    }, []),
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
      reviewContributions: [],
      reviewComments: []
    };
  }
  
  // For closed/merged PRs, process contributions
  const contributors = [];
  const files = [];
  const reviewContributions = [];
  
  // Add PR author
  contributors.push({
    github_login: pr.user.login,
    canonical_name: pr.user.login,
    email: null
  });
  
  // Add files
  prFiles.forEach(file => {
    files.push({
      canonical_path: file.filename,
      current_path: file.filename
    });
  });
  
  // Process each review submission as a separate contribution
  for (const review of reviewerSubmissions) {
    // Add reviewer as contributor (resolve properly)
    if (!contributors.find(c => c.github_login === review.login)) {
      const reviewer = await resolveReviewerContributor(review.login, octokit);
      contributors.push(reviewer);
    }
    
    // Add review contribution for each file (each review submission is separate)
    for (const file of prFiles) {
      const fileLinesModified = (file.additions || 0) + (file.deletions || 0);
      
      reviewContributions.push({
        contributor_key: review.login,
        file_path: file.filename,
        activity_type: 'review',
        activity_id: review.review_id.toString(),
        contribution_date: new Date(review.submitted_at),
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
    reviewContributions,
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
    
    // Track processed contributors to avoid duplicate API calls
    const processedContributors = new Map();
    
    for (const comment of allComments) {
      if (isValidComment(comment)) {
        // Resolve contributor if not already processed
        if (!processedContributors.has(comment.user.login)) {
          const contributor = await resolveReviewerContributor(comment.user.login, octokit);
          
          processedContributors.set(comment.user.login, contributor);
        }
        
        comments.push({
          contributor_key: comment.user.login,
          pr_number: pr.number,
          comment_date: new Date(comment.created_at),
          comment_text: comment.body
        });
      }
    }
    
  } catch (error) {
    console.warn(`⚠️ Error getting comments for PR #${pr.number}`);
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
  
  for (const file of uniqueFiles) {
    try {
      const { error } = await supabase
        .from('files')
        .upsert({
          canonical_path: file.canonical_path,
          current_path: file.current_path
        }, { onConflict: 'canonical_path' });
      
      if (error) {
        totalSkipped++;
      } else {
        totalInserted++;
      }
    } catch (error) {
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
  
  // Create lookup maps - prioritize github_login over email
  const contributorMap = new Map();
  dbContributors.forEach(c => {
    contributorMap.set(c.github_login, c.id);
    if (c.email && !contributorMap.has(c.email)) {
      contributorMap.set(c.email, c.id);
    }
  });
  
  const fileMap = new Map();
  dbFiles.forEach(f => {
    fileMap.set(f.canonical_path, f.id);
  });

  const mappedContributions = [];
  let skipped = 0;
  
  for (const contrib of contributions) {
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
      .upsert(batch, { ignoreDuplicates: true });
    
    if (error) {
      totalFailed += batch.length;
    } else {
      totalInserted += batch.length;
    }
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
      totalFailed += batch.length;
    } else {
      totalInserted += batch.length;
    }
  }
  
  console.log(`✅ Review comments: ${totalInserted} inserted, ${totalFailed} failed`);
}

// Run if called directly
if (require.main === module) {
  initializeRepository();
}

module.exports = { initializeRepository };
