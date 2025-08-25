// .github/scripts/initialize-repo.js
const github = require('@actions/github');
const { createClient } = require('@supabase/supabase-js');
const git = require('simple-git')();
const core = require('@actions/core');
const { deduplicateContributors } = require('./deduplicate-contributors');
const { detectAllContributors, findResolvedContributor, createTempContributor, updateWithLatestCommitData } = require('./contributor-resolver');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

const { Octokit } = require("@octokit/rest");
const octokit = new Octokit({
  auth: process.env.GITHUB_TOKEN
});

async function initializeRepository() {
  console.log('🚀 Starting repository initialization...');
  
  try {
    // STEP 1: Detect and resolve all contributors FIRST
    const log = await git.log({ "--all": null });
    const commits = log.all;

    // STEP 2: For each commit, fetch details from GitHub API
    for (const commit of commits) {
      const sha = commit.hash;

      // Call GitHub API
      const { data } = await octokit.repos.getCommit({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        ref: sha
      });

      console.log("SHA:", sha);
      console.log("Author username:", data.author ? data.author.login : commit.author_email);
      console.log("Commit message:", commit.message);

      // Files & line stats
      data.files.forEach(file => {
        console.log("File:", file.filename);
        console.log("Additions:", file.additions);
        console.log("Deletions:", file.deletions);
      });

      console.log("-----");
    }
    
    // console.log(`📊 Found ${commits.length} commits to analyze`);
    
    // const fileMap = new Map();
    // const contributions = [];
    
    // // STEP 3: Process commits with resolved contributor data
    // for (const commit of commits.reverse()) {
    //   await processCommitWithResolvedContributors(commit, resolvedContributors, fileMap, contributions);
    // }
    
    // // Continue with existing code for PR processing...
    // console.log('🔄 Starting pull request processing...');
    // const { prContributions, allComments } = await processPullRequests();
    
    // // Add PR contributors to the contributor map
    // for (const prContrib of prContributions) {
    //   if (!Array.from(resolvedContributors.values()).some(c => 
    //       c.github_usernames.has(prContrib.contributor_login) || 
    //       c.primary_github_login === prContrib.contributor_login)) {
        
    //     // Create new contributor from PR data
    //     const newContributor = {
    //       primary_github_login: prContrib.contributor_login,
    //       canonical_name: prContrib.contributor_login.toLowerCase(),
    //       github_usernames: new Set([prContrib.contributor_login]),
    //       emails: new Set(),
    //       names: new Set(),
    //       primary_email: null,
    //       priority: 'pr_auto',
    //       git_data: []
    //     };
        
    //     resolvedContributors.set(prContrib.contributor_login, newContributor);
    //   }
    // }
    
    // // Combine commit and PR contributions
    // contributions.push(...prContributions);

    // // Insert files first
    // await insertFiles(Array.from(fileMap.values()));
    
    // // Insert contributors (resolved contributors)
    // await insertResolvedContributors(resolvedContributors);
   
    // // Insert contributions with resolved contributor IDs
    // console.log('🔧 Processing contributions with resolved IDs...');
    // await insertContributionsWithResolvedIds(contributions, resolvedContributors);

    // if (allComments.length > 0) {
    //   console.log(`💬 Processing ${allComments.length} review comments...`);
    //   await insertReviewComments(allComments);
    // }
    
    // // Update last scan metadata
    // await updateMetadata('last_scan_commit', commits[commits.length - 1].hash);
    
    // console.log('✅ Repository initialization completed successfully!');
    // console.log(`📈 Statistics:
    // - Contributors: ${resolvedContributors.size}
    // - Files: ${fileMap.size}  
    // - Contributions: ${contributions.length}
    // - PR Contributions: ${prContributions.length}`);
    
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

async function insertContributionsWithResolvedIds(contributions, resolvedContributors) {
  if (contributions.length === 0) return;
  
  console.log(`🔗 Processing ${contributions.length} contributions with resolved IDs...`);
  
  // Get the contributors and files from database
  const { data: dbContributors, error: contributorError } = await supabase
    .from('contributors')
    .select('id, github_login');
    
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
  
  // Create lookup maps
  const contributorLookup = new Map();
  dbContributors.forEach(c => {
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
    const contributorId = contributorLookup.get(contribution.contributor_login.toLowerCase());
    
    // Handle null file_path (commits with no file changes)
    let fileId = null;
    if (contribution.file_path !== null) {
      fileId = fileLookup.get(contribution.file_path);
      if (!fileId) {
        skippedCount++;
        continue;
      }
    }
    
    if (contributorId) {
      mappedContributions.push({
        contributor_id: contributorId,
        file_id: fileId, // Can be null for commits without file changes
        activity_type: contribution.activity_type,
        activity_id: contribution.activity_id,
        contribution_date: contribution.contribution_date,
        lines_added: contribution.lines_added || 0,
        lines_deleted: contribution.lines_deleted || 0,
        lines_modified: contribution.lines_modified || 0,
        pr_number: contribution.pr_number || null
      });
    } else {
      skippedCount++;
    }
  }
  
  console.log(`🔗 Mapped ${mappedContributions.length} contributions (skipped ${skippedCount})`);
  
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
      throw error;
    }
    
    totalInserted += batch.length;
    console.log(`🔗 Inserted contributions batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(mappedContributions.length/batchSize)} (${totalInserted} total)`);
  }
  
  console.log(`✅ Successfully inserted ${totalInserted} contributions`);
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

async function getCommitFiles(commitHash) {
  try {
    // Method 1: Try the current approach
    const nameStatus = await git.show([commitHash, '--name-status', '--format=']);
    const numStat = await git.show([commitHash, '--numstat', '--format=']);
    return { nameStatus, numStat, method: 'show' };
  } catch (error) {
    console.warn(`⚠️ git show failed for ${commitHash}, trying diff-tree...`);
    
    try {
      // Method 2: Use diff-tree as fallback
      const nameStatus = await git.raw(['diff-tree', '--no-commit-id', '--name-status', '-r', commitHash]);
      const numStat = await git.raw(['diff-tree', '--no-commit-id', '--numstat', '-r', commitHash]);
      return { nameStatus, numStat, method: 'diff-tree' };
    } catch (diffError) {
      console.error(`❌ Both git show and diff-tree failed for ${commitHash}:`, diffError);
      throw diffError;
    }
  }
}

async function processCommitWithResolvedContributors(commit, resolvedContributors, fileMap, contributions) {
  try {
    const { nameStatus, numStat } = await getCommitFiles(commit.hash);
    
    if (!nameStatus && !numStat) {
      console.warn(`⚠️ No file changes found for commit ${commit.hash}, but processing anyway`);
    }
    
    const combinedOutput = (numStat || '') + '\n' + (nameStatus || '');
    const files = parseGitShowOutputWithLines(combinedOutput);
    
    // Find the resolved contributor for this commit
    let contributor = findResolvedContributor(commit, resolvedContributors);
    
    if (!contributor) {
      console.error(`❌ Could not resolve contributor for commit ${commit.hash} (${commit.author_name} <${commit.author_email}>)`);
      // DON'T SKIP - create a temporary contributor
      const tempContributor = createTempContributor(commit);
      resolvedContributors.set(tempContributor.primary_github_login, tempContributor);
      contributor = tempContributor;
    }
    
    // Process files (even if empty - some commits might have no file changes)
    if (files.length === 0) {
      // Create a placeholder contribution for commits with no file changes
      contributions.push({
        contributor_login: contributor.primary_github_login,
        contributor_email: contributor.primary_email,
        contributor_canonical_name: contributor.canonical_name,
        file_path: null, // Special marker for commits without file changes
        activity_type: 'commit',
        activity_id: commit.hash,
        contribution_date: new Date(commit.date),
        lines_added: 0,
        lines_deleted: 0,
        lines_modified: 0
      });
    } else {
      // Process each file normally
      for (const fileChange of files) {
        const file = await getOrCreateFile(fileChange, fileMap);
        
        contributions.push({
          contributor_login: contributor.primary_github_login,
          contributor_email: contributor.primary_email,
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
    
  } catch (error) {
    console.error(`❌ Error processing commit ${commit.hash}: ${error.message}`);
    // Don't skip - process as no-file-change commit
  }
}

async function insertResolvedContributors(resolvedContributors) {
  if (resolvedContributors.size === 0) return;
  
  console.log(`📝 Inserting ${resolvedContributors.size} resolved contributors...`);
  
  const contributorsToInsert = Array.from(resolvedContributors.values()).map(contributor => {
    // Ensure we have the latest data
    updateWithLatestCommitData(contributor);
    
    return {
      github_login: contributor.primary_github_login,
      canonical_name: contributor.canonical_name,
      email: contributor.primary_email || contributor.latest_email || Array.from(contributor.emails)[0] || null,
      // Store additional metadata for debugging
      first_seen: contributor.first_seen || null,
      last_seen: contributor.last_seen || contributor.latest_commit_date || null,
      total_commits: contributor.git_data ? contributor.git_data.length : 0
    };
  });
  
  // Sort by last activity (most recent first) for better logging
  contributorsToInsert.sort((a, b) => {
    const dateA = a.last_seen || new Date(0);
    const dateB = b.last_seen || new Date(0);
    return dateB - dateA;
  });
  
  console.log('\n📊 Contributors to insert (sorted by latest activity):');
  contributorsToInsert.slice(0, 10).forEach(c => {
    const lastSeen = c.last_seen ? c.last_seen.toISOString().split('T')[0] : 'unknown';
    console.log(`   ${c.github_login}: ${c.canonical_name} <${c.email}> (${c.total_commits} commits, latest: ${lastSeen})`);
  });
  if (contributorsToInsert.length > 10) {
    console.log(`   ... and ${contributorsToInsert.length - 10} more`);
  }
  
  // Insert contributors one by one to handle duplicates gracefully
  // since we don't have a unique constraint to rely on for upsert
  let totalInserted = 0;
  let totalSkipped = 0;
  
  for (const contributor of contributorsToInsert) {
    try {
      // First, check if contributor already exists
      const { data: existingContributor, error: checkError } = await supabase
        .from('contributors')
        .select('id')
        .eq('github_login', contributor.github_login)
        .single();
      
      if (checkError && checkError.code !== 'PGRST116') {
        // PGRST116 is "no rows returned" - that's expected for new contributors
        throw checkError;
      }
      
      if (existingContributor) {
        // Contributor exists, update it
        const { error: updateError } = await supabase
          .from('contributors')
          .update({
            canonical_name: contributor.canonical_name,
            email: contributor.email
          })
          .eq('github_login', contributor.github_login);
        
        if (updateError) {
          throw updateError;
        }
        
        totalSkipped++;
        console.log(`🔄 Updated existing contributor: ${contributor.github_login}`);
      } else {
        // Contributor doesn't exist, insert it
        const { error: insertError } = await supabase
          .from('contributors')
          .insert({
            github_login: contributor.github_login,
            canonical_name: contributor.canonical_name,
            email: contributor.email
          });
        
        if (insertError) {
          throw insertError;
        }
        
        totalInserted++;
        console.log(`➕ Inserted new contributor: ${contributor.github_login}`);
      }
      
    } catch (error) {
      console.error(`❌ Error processing contributor ${contributor.github_login}:`, error);
      throw error;
    }
  }
  
  console.log(`✅ Successfully processed ${totalInserted + totalSkipped} contributors (${totalInserted} inserted, ${totalSkipped} updated/skipped)`);
}

function parseGitShowOutputWithLines(output) {
  const lines = output.split('\n').filter(line => line.trim());
  const files = [];
  
  // Parse numstat lines (additions deletions filename)
  const numstatLines = lines.filter(line => line.match(/^\d+\t\d+\t/) || line.match(/^-\t-\t/));
  const namestatLines = lines.filter(line => line.match(/^[AMDRTCUX]/));
  
  // Create maps to properly match files by filename
  const numstatMap = new Map();
  const namestatMap = new Map();
  
  // Process numstat lines
  numstatLines.forEach((line) => {
    const parts = line.split('\t');
    if (parts.length >= 3) {
      // Handle cases where filename might have tabs
      const filename = parts.slice(2).join('\t');
      const linesAdded = parts[0] === '-' ? 0 : parseInt(parts[0]) || 0;
      const linesDeleted = parts[1] === '-' ? 0 : parseInt(parts[1]) || 0;
      numstatMap.set(filename, { linesAdded, linesDeleted });
    } else {
      console.warn(`⚠️ Invalid numstat line: ${line}`);
    }
  });
  
  // Process name-status lines with better handling
  namestatLines.forEach((line) => {
    const parts = line.split('\t');
    const status = parts[0];
    let file, oldFile = null;
    
    // Handle different status types
    if (status.startsWith('R') || status.startsWith('C')) {
      // Rename/Copy: R100  old_name  new_name
      if (parts.length >= 3) {
        oldFile = parts[1];
        file = parts[2];
      } else {
        console.warn(`⚠️ Invalid rename line: ${line}`);
        return;
      }
    } else {
      // Add/Modify/Delete: A  filename
      if (parts.length >= 2) {
        file = parts.slice(1).join('\t'); // Handle filenames with tabs
      } else {
        console.warn(`⚠️ Invalid namestatus line: ${line}`);
        return;
      }
    }
    
    namestatMap.set(file, { status: status[0], oldFile });
  });
  
  // Combine the data by matching filenames
  const allFiles = new Set([...numstatMap.keys(), ...namestatMap.keys()]);
  
  allFiles.forEach(filename => {
    const numstat = numstatMap.get(filename) || { linesAdded: 0, linesDeleted: 0 };
    const namestat = namestatMap.get(filename) || { status: 'M', oldFile: null };
    
    // Fix the filename parsing issue - handle git rename format
    let cleanFilename = filename;
    
    // Handle git rename format like "src/{RelationalGit.Data => RelationalGit.Data}/Models/Developer.cs"
    if (cleanFilename.includes('{') && cleanFilename.includes('}')) {
      // Extract the pattern: path/{old => new}/restofpath
      const renameMatch = cleanFilename.match(/^(.*?)\{([^}]*)\}(.*)$/);
      if (renameMatch) {
        const [, prefix, renamepart, suffix] = renameMatch;
        
        // Split the rename part by " => "
        const renameParts = renamepart.split(' => ');
        if (renameParts.length === 2) {
          const newName = renameParts[1].trim();
          cleanFilename = prefix + newName + suffix;
        } else {
          // If it's just {something}, use the something
          cleanFilename = prefix + renamepart.trim() + suffix;
        }
      }
    }
    
    // Additional cleanup - remove any remaining git formatting artifacts
    cleanFilename = cleanFilename.replace(/^{.*?}/, '').trim();
    
    files.push({
      status: namestat.status,
      file: cleanFilename,
      oldFile: namestat.oldFile,
      linesAdded: numstat.linesAdded,
      linesDeleted: numstat.linesDeleted,
      linesModified: numstat.linesAdded + numstat.linesDeleted
    });
  });
  
  return files;
}

// Add this function to track specific files
function debugSpecificFile(filename, commitHash, operation) {
  if (filename.includes('migrate-database.js') || filename.includes('debug-token.js')) {
    console.log(`🔍 DEBUG: ${operation} - ${filename} in commit ${commitHash}`);
    
    // Also log if filename has the problematic format
    if (filename.includes('{') && filename.includes('=>')) {
      console.log(`🚨 PROBLEMATIC PATH FORMAT: ${filename}`);
    }
  }
}

// Add this call in getOrCreateFile:
async function getOrCreateFile(fileChange, fileMap) {
  const path = fileChange.file;
  debugSpecificFile(path, 'N/A', 'CREATING_FILE_RECORD');
  
  let file = fileMap.get(path);
  
  if (!file) {
    file = {
      canonical_path: path,
      current_path: path
    };
    fileMap.set(path, file);
    debugSpecificFile(path, 'N/A', 'NEW_FILE_ADDED_TO_MAP');
  }
  
  return file;
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

// async function getOrCreateFile(fileChange, fileMap) {
//   const path = fileChange.file;
//   let file = fileMap.get(path);
  
//   if (!file) {
//     file = {
//       canonical_path: path,
//       current_path: path
//     };
//     fileMap.set(path, file);
//   }
  
//   return file;
// }

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
  let totalInserted = 0;
  let totalSkipped = 0;
  
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    
    // Use upsert instead of insert to handle duplicates
    const { data, error } = await supabase
      .from('files')
      .upsert(batch.map(f => ({
        canonical_path: f.canonical_path,
        current_path: f.current_path
      })), { 
        onConflict: 'canonical_path',
        ignoreDuplicates: false // This will update existing records
      })
      .select('canonical_path');
    
    if (error) {
      console.error('Error inserting files batch:', error);
      throw error;
    }
    
    // Count how many were actually inserted vs updated
    const batchCount = data ? data.length : batch.length;
    totalInserted += batchCount;
    
    console.log(`📁 Processed files batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(files.length/batchSize)} (${batchCount} files)`);
  }
  
  console.log(`✅ Successfully processed ${totalInserted} files (inserted new + updated existing)`);
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
