// .github/scripts/update-data.js
const { createClient } = require('@supabase/supabase-js');
const git = require('simple-git')();
const core = require('@actions/core');
const github = require('@actions/github');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function updateRepositoryData() {
  console.log('🔄 Starting repository data update...');
  
  try {
    const context = github.context;
    
    if (context.eventName === 'push') {
      await processPushEvent(context);
    } else if (context.eventName === 'pull_request') {
      await processPullRequestEvent(context);
    }
    
    console.log('✅ Repository data update completed successfully!');
    
  } catch (error) {
    console.error('❌ WORKFLOW FAILED - Error details:');
    console.error('Event:', github.context.eventName);
    console.error('Repository:', github.context.repo);
    console.error('Error message:', error.message);
    console.error('Stack trace:', error.stack);
    core.setFailed(`Workflow failed: ${error.message}`);
  }
}

async function processPushEvent(context) {
  const commits = context.payload.commits || [];
  console.log(`📝 Processing ${commits.length} commits from push event`);
  
  for (const commitData of commits) {
    // Skip merge commits (they have multiple parents and message usually starts with "Merge")
    if (commitData.message && commitData.message.startsWith('Merge ')) {
      console.log(`⏭️ Skipping merge commit: ${commitData.id.substring(0, 8)} - "${commitData.message.substring(0, 50)}..."`);
      continue;
    }
    
    await processCommitWithLogs(commitData.id);
  }
}

async function processPullRequestEvent(context) {
  const pr = context.payload.pull_request;
  const action = context.payload.action;
  
  console.log(`📋 Processing PR #${pr.number} - Action: ${action}, State: ${pr.state}`);
  
  if (action === 'closed' && pr.merged) {
    console.log(`🔀 PR #${pr.number} was merged, processing...`);
    await processMergedPR(pr);
  } else if (action === 'reopened') {
    console.log(`🔄 PR #${pr.number} was reopened, checking for updates...`);
    await processReopenedPR(pr);
  } else if (action === 'closed' && !pr.merged) {
    console.log(`❌ PR #${pr.number} was closed without merging, updating status...`);
    await updatePRStatus(pr, 'closed');
  }
}

async function processCommitWithLogs(commitSha) {
  try {
    // Check if commit already processed
    const existingCommit = await checkCommitExists(commitSha);
    if (existingCommit) {
      console.log(`⏭️ Commit ${commitSha.substring(0, 8)} already processed, skipping...`);
      return;
    }

    // Get commit data
    const nameStatus = await git.show([commitSha, '--name-status', '--format=']);
    const numStat = await git.show([commitSha, '--numstat', '--format=']);
    const commitDetails = await git.show([commitSha, '--format=fuller']);
    const commit = numStat + '\n' + nameStatus + '\n' + commitDetails;
    
    const files = parseGitShowOutputWithLines(commit);
    const commitInfo = parseCommitInfo(commit);
    
    if (files.length === 0) {
      console.log(`⚠️ No files found in commit ${commitSha.substring(0, 8)}, skipping...`);
      return;
    }
    
    // Get or create contributor
    const contributor = await getOrCreateContributor(commitInfo.author);
    
    let totalLinesModified = 0;
    
    // Process each file
    for (const fileChange of files) {
      if (!fileChange.path) {
        console.warn(`⚠️ Skipping file with empty path in commit ${commitSha.substring(0, 8)}`);
        continue;
      }
      
      const file = await getOrCreateFile(fileChange.path);
      if (!file) {
        console.warn(`⚠️ Could not create/find file record for: ${fileChange.path}`);
        continue;
      }
      
      // Record file history if it's a rename/move
      if (fileChange.status.startsWith('R') || fileChange.status.startsWith('C')) {
        await recordFileHistory(file.id, fileChange.oldFile, fileChange.path, fileChange.status, commitSha);
      }
      
      // Record contribution
      await recordContribution({
        contributor_id: contributor.id,
        file_id: file.id,
        activity_type: 'commit',
        activity_id: commitSha,
        contribution_date: new Date(commitInfo.date),
        lines_added: fileChange.linesAdded,
        lines_deleted: fileChange.linesDeleted,
        lines_modified: fileChange.linesModified
      });
      
      totalLinesModified += fileChange.linesModified;
      
      // Log individual file change
      console.log(`📝 The following commit successfully transferred to the database:`);
      console.log(`   Developer: ${contributor.canonical_name} (${contributor.github_login})`);
      console.log(`   Change type: ${getChangeTypeDescription(fileChange.status)}`);
      console.log(`   Modified file: ${fileChange.path}`);
      console.log(`   Change size: ${fileChange.linesModified} lines modified (+${fileChange.linesAdded}/-${fileChange.linesDeleted})`);
      console.log(`   Commit SHA: ${commitSha}`);
      console.log(`   Commit date: ${commitInfo.date}`);
      console.log(''); // Empty line for readability
    }
    
    console.log(`✅ Commit ${commitSha.substring(0, 8)} processed successfully - ${files.length} files, ${totalLinesModified} total lines modified`);
    
  } catch (error) {
    console.error(`❌ FAILED to process commit ${commitSha.substring(0, 8)}:`);
    console.error('Error:', error.message);
    console.error('Commit SHA:', commitSha);
    throw error;
  }
}

async function processMergedPR(pr) {
  try {
    const token = process.env.GITHUB_TOKEN || core.getInput('github-token') || core.getInput('token');
    
    if (!token) {
      console.warn('⚠️ No GitHub token available, limited PR processing');
      return;
    }
    
    const octokit = github.getOctokit(token);
    
    // Wait for merge to complete
    console.log('🔄 Waiting for merge to complete...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Get PR data
    const { data: files } = await octokit.rest.pulls.listFiles({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      pull_number: pr.number
    });
    
    const { data: prCommits } = await octokit.rest.pulls.listCommits({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      pull_number: pr.number,
      per_page: 100
    });
    
    const { data: reviews } = await octokit.rest.pulls.listReviews({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      pull_number: pr.number
    });
    
    // Calculate totals
    const totalLinesModified = files.reduce((total, file) => {
      return total + (file.additions || 0) + (file.deletions || 0);
    }, 0);
    
    const uniqueReviewers = reviews
      .filter(review => review.user.login !== pr.user.login)
      .map(review => review.user.login)
      .filter((login, index, self) => self.indexOf(login) === index);
    
    // Start logging PR summary
    console.log(`📋 ============ PR #${pr.number} Processing Summary ============`);
    console.log(`PR number: ${pr.number}`);
    console.log(`Creation date: ${pr.created_at}`);
    console.log(`Author: ${pr.user.login}`);
    console.log(`Change size: ${totalLinesModified} lines modified`);
    console.log(`#commits: ${prCommits.length} & #changedFiles: ${files.length}`);
    console.log(`Breakdown:`);
    
    // Process individual commits (skip merge commits)
    let processedCommits = 0;
    const fileCommitMap = new Map();
    
    for (const commit of prCommits) {
      // Skip merge commits
      if (commit.commit.message && commit.commit.message.startsWith('Merge ')) {
        console.log(`⏭️ Skipping merge commit: ${commit.sha.substring(0, 8)}`);
        continue;
      }
      
      try {
        await processCommitWithLogs(commit.sha);
        processedCommits++;
        
        // Track which files were changed by which commits
        const commitFiles = await getCommitFiles(commit.sha);
        commitFiles.forEach(file => {
          if (!fileCommitMap.has(file)) {
            fileCommitMap.set(file, []);
          }
          fileCommitMap.get(file).push(commit.sha.substring(0, 8));
        });
        
      } catch (error) {
        console.warn(`⚠️ Could not process commit ${commit.sha.substring(0, 8)}: ${error.message}`);
      }
    }
    
    // Show file-commit breakdown
    fileCommitMap.forEach((commits, file) => {
      console.log(`   Changed ${file}: Commit ${commits.join(', ')}`);
    });
    
    console.log(`Reviewers: ${uniqueReviewers.join(', ') || 'None'}`);
    
    // Process reviewers
    let reviewContributions = 0;
    for (const review of reviews) {
      if (review.user.login !== pr.user.login) {
        const reviewer = await getOrCreateContributorByLogin(review.user.login);
        
        for (const file of files) {
          const fileRecord = await getOrCreateFile(file.filename);
          if (!fileRecord) continue;
          
          const fileLinesModified = (file.additions || 0) + (file.deletions || 0);
          
          await recordContribution({
            contributor_id: reviewer.id,
            file_id: fileRecord.id,
            activity_type: 'review',
            activity_id: pr.number.toString(),
            contribution_date: new Date(review.submitted_at),
            lines_added: 0,
            lines_deleted: 0,
            lines_modified: fileLinesModified,
            pr_number: pr.number
          });
          
          reviewContributions++;
        }
      }
    }
    
    // Process comments
    const comments = await processPRComments(pr, octokit);
    const commentsByUser = new Map();
    comments.forEach(comment => {
      const user = comment.contributor_login;
      commentsByUser.set(user, (commentsByUser.get(user) || 0) + 1);
    });
    
    console.log(`#reviewComments: ${comments.length}`);
    
    if (comments.length > 0) {
      await insertReviewComments(comments);
    }
    
    // Update/Create PR record
    await upsertPullRequest(pr, uniqueReviewers, totalLinesModified);
    
    // Final summary
    console.log(`✅ ${processedCommits} commits on ${files.length} files for ${pr.user.login} successfully transferred.`);
    console.log(`✅ ${reviewContributions} review activities for ${uniqueReviewers.join(', ')} successfully transferred.`);
    
    const commentUsers = Array.from(commentsByUser.keys());
    console.log(`✅ ${comments.length} review comments for ${commentUsers.join(', ')} successfully transferred.`);
    console.log(`===============================================`);
    
  } catch (error) {
    console.error(`❌ FAILED to process merged PR #${pr.number}:`);
    console.error('Error:', error.message);
    console.error('PR data:', { number: pr.number, author: pr.user.login, merged_at: pr.merged_at });
    throw error;
  }
}

async function processReopenedPR(pr) {
  try {
    const token = process.env.GITHUB_TOKEN || core.getInput('github-token') || core.getInput('token');
    
    if (!token) {
      console.warn('⚠️ No GitHub token available for reopened PR processing');
      return;
    }
    
    const octokit = github.getOctokit(token);
    console.log(`🔄 Checking for new reviews and comments in reopened PR #${pr.number}...`);
    
    // Get existing review comments from database
    const { data: existingComments } = await supabase
      .from('review_comments')
      .select('comment_date, comment_text, contributor_id')
      .eq('pr_number', pr.number);
    
    // Get current comments from GitHub
    const currentComments = await processPRComments(pr, octokit);
    
    // Filter out existing comments
    const newComments = currentComments.filter(comment => {
      return !existingComments.some(existing => 
        existing.comment_text === comment.comment_text &&
        new Date(existing.comment_date).getTime() === comment.comment_date.getTime()
      );
    });
    
    if (newComments.length > 0) {
      await insertReviewComments(newComments);
      console.log(`✅ Added ${newComments.length} new review comments to reopened PR #${pr.number}`);
    } else {
      console.log(`ℹ️ No new comments found in reopened PR #${pr.number}`);
    }
    
    // Update PR status to 'open'
    await updatePRStatus(pr, 'open');
    
  } catch (error) {
    console.error(`❌ FAILED to process reopened PR #${pr.number}:`, error.message);
    throw error;
  }
}

// Helper function to get files changed in a commit
async function getCommitFiles(commitSha) {
  try {
    const nameStatus = await git.show([commitSha, '--name-status', '--format=']);
    const lines = nameStatus.split('\n').filter(line => line.match(/^[A-Z]+\d*\t/));
    return lines.map(line => {
      const parts = line.split('\t');
      return parts[parts.length - 1]; // Last part is always the current filename
    }).filter(Boolean);
  } catch (error) {
    console.warn(`Could not get files for commit ${commitSha}: ${error.message}`);
    return [];
  }
}

// Helper function to record file history
async function recordFileHistory(fileId, oldPath, newPath, changeType, commitSha) {
  if (!oldPath || oldPath === newPath) return;
  
  try {
    await supabase
      .from('file_history')
      .insert({
        file_id: fileId,
        old_path: oldPath,
        new_path: newPath,
        change_type: changeType.startsWith('R') ? 'renamed' : 'copied',
        commit_sha: commitSha
      });
    
    console.log(`📝 File history recorded: ${oldPath} -> ${newPath}`);
  } catch (error) {
    console.warn(`Could not record file history: ${error.message}`);
  }
}

// Helper function to get change type description
function getChangeTypeDescription(status) {
  const statusMap = {
    'A': 'Added',
    'M': 'Modified',
    'D': 'Deleted',
    'R': 'Renamed',
    'C': 'Copied',
    'U': 'Updated'
  };
  
  const baseStatus = status[0];
  return statusMap[baseStatus] || status;
}

// Helper function to update PR status
async function updatePRStatus(pr, status) {
  const { error } = await supabase
    .from('pull_requests')
    .update({ 
      status: status,
      closed_date: status === 'closed' ? new Date(pr.closed_at) : null
    })
    .eq('pr_number', pr.number);
    
  if (error) {
    console.warn(`Could not update PR #${pr.number} status: ${error.message}`);
  } else {
    console.log(`✅ Updated PR #${pr.number} status to: ${status}`);
  }
}

// Helper function to upsert pull request
async function upsertPullRequest(pr, reviewers, totalLinesModified) {
  const reviewerObjects = reviewers.map(login => ({ login }));
  
  const { error } = await supabase
    .from('pull_requests')
    .upsert({
      pr_number: pr.number,
      status: pr.merged_at ? 'merged' : pr.state,
      author_login: pr.user.login,
      reviewers: reviewerObjects,
      created_date: new Date(pr.created_at),
      merged_date: pr.merged_at ? new Date(pr.merged_at) : null,
      closed_date: pr.closed_at ? new Date(pr.closed_at) : null,
      lines_modified: totalLinesModified
    }, { onConflict: 'pr_number' });
    
  if (error) {
    console.error('Error upserting PR:', error);
    throw error;
  }
}

// Keep all the existing helper functions (checkCommitExists, getOrCreateContributor, etc.)
// ... [The rest of the helper functions remain the same as in your original code]

async function checkCommitExists(commitSha) {
  const { data: existing, error } = await supabase
    .from('contributions')
    .select('activity_id')
    .eq('activity_type', 'commit')
    .eq('activity_id', commitSha)
    .limit(1)
    .single();
    
  if (error && error.code !== 'PGRST116') {
    console.warn(`Warning checking commit existence: ${error.message}`);
    return false;
  }
  
  return !!existing;
}

async function processPRComments(pr, octokit) {
  const comments = [];
  
  try {
    // Get regular PR comments
    const { data: prComments } = await octokit.rest.issues.listComments({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      issue_number: pr.number
    });
    
    // Get review comments (inline comments on code)
    const { data: reviewComments } = await octokit.rest.pulls.listReviewComments({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
      pull_number: pr.number
    });
    
    // Get PR reviews (which can also contain comments)
    const { data: reviews } = await octokit.rest.pulls.listReviews({
      owner: github.context.repo.owner,
      repo: github.context.repo.repo,
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

async function insertReviewComments(comments) {
  if (comments.length === 0) return;
  
  console.log(`💬 Processing ${comments.length} review comments...`);
  
  const mappedComments = [];
  let skippedCount = 0;
  
  for (const comment of comments) {
    const contributor = await getOrCreateContributorByLogin(comment.contributor_login);
    if (!contributor) {
      skippedCount++;
      continue;
    }
    
    // Check if comment already exists
    const { data: existingComment } = await supabase
      .from('review_comments')
      .select('id')
      .eq('contributor_id', contributor.id)
      .eq('pr_number', comment.pr_number)
      .eq('comment_date', comment.comment_date)
      .eq('comment_text', comment.comment_text)
      .single();
      
    if (existingComment) continue;
    
    mappedComments.push({
      contributor_id: contributor.id,
      pr_number: comment.pr_number,
      comment_date: comment.comment_date,
      comment_text: comment.comment_text
    });
  }
  
  if (mappedComments.length === 0) {
    console.log('ℹ️ No new comments to insert');
    return;
  }
  
  const { error } = await supabase
    .from('review_comments')
    .insert(mappedComments);
  
  if (error) {
    console.error('Error inserting review comments:', error);
    throw error;
  }
  
  console.log(`✅ Successfully inserted ${mappedComments.length} review comments`);
}

async function getOrCreateContributor(authorInfo) {
  let githubLogin = authorInfo.login;
  
  if (!githubLogin && authorInfo.email && authorInfo.email.includes('@users.noreply.github.com')) {
    const match = authorInfo.email.match(/(\d+\+)?([^@]+)@users\.noreply\.github\.com/);
    if (match && match[2]) {
      githubLogin = match[2];
    }
  }
  
  if (!githubLogin) {
    githubLogin = authorInfo.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  }
  
  const { data: existing } = await supabase
    .from('contributors')
    .select('*')
    .eq('github_login', githubLogin)
    .single();
    
  if (existing) return existing;
  
  const { data: existingByEmail } = await supabase
    .from('contributors')
    .select('*')
    .eq('email', authorInfo.email)
    .single();
    
  if (existingByEmail) return existingByEmail;
  
  const { data: newContributor, error } = await supabase
    .from('contributors')
    .insert({
      github_login: githubLogin,
      canonical_name: githubLogin,
      email: authorInfo.email
    })
    .select()
    .single();
    
  if (error) throw error;
  return newContributor;
}

async function getOrCreateContributorByLogin(login) {
  const { data: existing } = await supabase
    .from('contributors')
    .select('*')
    .eq('github_login', login)
    .single();
    
  if (existing) return existing;
  
  const { data: newContributor, error } = await supabase
    .from('contributors')
    .insert({
      github_login: login,
      canonical_name: login,
      email: null
    })
    .select()
    .single();
    
  if (error) throw error;
  return newContributor;
}

async function getOrCreateFile(path) {
  if (!path || typeof path !== 'string' || path.trim() === '') {
    console.error('getOrCreateFile called with empty/falsy path:', JSON.stringify(path));
    return null;
  }

  const canonical = path.trim();

  const { data: existing, error: selectError } = await supabase
    .from('files')
    .select('*')
    .eq('canonical_path', canonical)
    .single();

  if (selectError && selectError.code !== 'PGRST116') {
    console.debug('getOrCreateFile: select error (non-fatal):', selectError);
  }
  if (existing) return existing;

  const { data: newFile, error } = await supabase
    .from('files')
    .insert({
      canonical_path: canonical,
      current_path: canonical
    })
    .select()
    .single();

  if (error) {
    console.error('getOrCreateFile: failed to insert file', { canonical, error });
    throw error;
  }
  console.debug('getOrCreateFile: created file', { id: newFile.id, path: canonical });
  return newFile;
}

async function recordContribution(contribution) {
  const { data: existing } = await supabase
    .from('contributions')
    .select('id')
    .eq('contributor_id', contribution.contributor_id)
    .eq('file_id', contribution.file_id)
    .eq('activity_type', contribution.activity_type)
    .eq('activity_id', contribution.activity_id)
    .single();
    
  if (existing) {
    return;
  }
  
  const { error } = await supabase
    .from('contributions')
    .insert(contribution);
    
  if (error && !error.message.includes('duplicate')) {
    throw error;
  }
}

function parseCommitInfo(commitOutput) {
  const lines = commitOutput.split('\n');
  const authorLine = lines.find(l => l.startsWith('Author:'));
  const dateLine = lines.find(l => l.startsWith('AuthorDate:'));
  
  return {
    author: {
      name: authorLine.split(' <')[0].replace('Author: ', ''),
      email: authorLine.split(' <')[1].replace('>', ''),
      login: null
    },
    date: dateLine.replace('AuthorDate: ', '')
  };
}

function parseGitShowOutputWithLines(output) {
  const lines = output.split('\n');
  const files = [];

  const numstatLines = lines.filter(line => line.match(/^\d+\t\d+\t/) || line.match(/^-\t-\t/));
  const namestatLines = lines.filter(line => line.match(/^[A-Z]+\d*\t/));

  if (namestatLines.length === 0 && numstatLines.length === 0) {
    console.debug('parseGitShowOutputWithLines: no numstat or name-status lines found');
  }

  namestatLines.forEach((nameLine, index) => {
    const parts = nameLine.split('\t');
    const statusRaw = parts[0] || '';
    const status = statusRaw[0] || '';
    let file = parts[1];
    let oldFile = null;
    let linesAdded = 0;
    let linesDeleted = 0;
    let linesModified = 0;

    if (statusRaw.startsWith('R') || statusRaw.startsWith('C')) {
      oldFile = parts[1];
      file = parts[2];
    }

    if (numstatLines[index]) {
      const numstatParts = numstatLines[index].split('\t');
      linesAdded = numstatParts[0] === '-' ? 0 : parseInt(numstatParts[0]) || 0;
      linesDeleted = numstatParts[1] === '-' ? 0 : parseInt(numstatParts[1]) || 0;
      linesModified = linesAdded + linesDeleted;
    }

    if (!file) {
      console.warn('parseGitShowOutputWithLines: parsed empty file path.', {
        nameLine,
        index,
        statusRaw
      });
      return;
    }

    files.push({
      status: status,
      path: file,
      oldFile: oldFile,
      linesAdded: linesAdded,
      linesDeleted: linesDeleted,
      linesModified: linesModified
    });
  });

  return files;
}

if (require.main === module) {
  updateRepositoryData();
}

module.exports = { updateRepositoryData };
