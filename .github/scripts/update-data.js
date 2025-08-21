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
  console.log('🔄 Updating repository data...');
  
  try {
    const context = github.context;
    
    if (context.eventName === 'push') {
      await processPushEvent(context);
    } else if (context.eventName === 'pull_request') {
      await processPullRequestEvent(context);
    }
    
    console.log('✅ Repository data updated successfully!');
    
  } catch (error) {
    console.error('❌ Error updating data:', error);
    core.setFailed(error.message);
  }
}

async function processPushEvent(context) {
  const commits = context.payload.commits || [];
  
  for (const commitData of commits) {
    await processNewCommit(commitData.id);
  }
}

async function processPullRequestEvent(context) {
  const pr = context.payload.pull_request;
  
  if (pr.state === 'closed' && pr.merged) {
    // First ensure PR exists in the database before processing comments
    await ensurePRExists(pr);
    
    // Then record PR as merged and process reviews
    await processMergedPR(pr);
  }
}

async function ensurePRExists(pr) {
  // Check if PR already exists
  const { data: existingPR } = await supabase
    .from('pull_requests')
    .select('pr_number')
    .eq('pr_number', pr.number)
    .single();
    
  if (existingPR) {
    console.log(`📋 PR #${pr.number} already exists in database`);
    return;
  }
  
  console.log(`📋 PR #${pr.number} not found, inserting...`);
  
  // Get additional PR data if we have GitHub token
  const token = process.env.GITHUB_TOKEN || core.getInput('github-token') || core.getInput('token');
  let reviewers = [];
  let totalLinesModified = 0;
  
  if (token) {
    const octokit = github.getOctokit(token);
    
    try {
      // Get reviewers
      const { data: reviews } = await octokit.rest.pulls.listReviews({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        pull_number: pr.number
      });
      
      reviewers = reviews
        .filter(review => review.user.login !== pr.user.login)
        .map(review => ({
          login: review.user.login,
          submitted_at: review.submitted_at
        }))
        .filter((reviewer, index, self) => 
          index === self.findIndex(r => r.login === reviewer.login)
        );
        
      // Get total lines modified
      const { data: files } = await octokit.rest.pulls.listFiles({
        owner: github.context.repo.owner,
        repo: github.context.repo.repo,
        pull_number: pr.number
      });
      
      totalLinesModified = files.reduce((total, file) => {
        return total + (file.additions || 0) + (file.deletions || 0);
      }, 0);
      
    } catch (error) {
      console.warn(`⚠️ Could not fetch additional data for PR #${pr.number}: ${error.message}`);
    }
  }
  
  // Insert the PR
  const { error } = await supabase
    .from('pull_requests')
    .insert({
      pr_number: pr.number,
      status: pr.merged_at ? 'merged' : pr.state,
      author_login: pr.user.login,
      reviewers: reviewers,
      created_date: new Date(pr.created_at),
      merged_date: pr.merged_at ? new Date(pr.merged_at) : null,
      closed_date: pr.closed_at ? new Date(pr.closed_at) : null,
      lines_modified: totalLinesModified
    });
    
  if (error) {
    console.error(`❌ Error inserting PR #${pr.number}:`, error);
    throw error;
  }
  
  console.log(`✅ Successfully inserted PR #${pr.number}`);
}

async function processNewCommit(commitSha) {
  // Use separate commands like in the working initialize-repo.js
  const nameStatus = await git.show([commitSha, '--name-status', '--format=']);
  const numStat = await git.show([commitSha, '--numstat', '--format=']);
  const commitDetails = await git.show([commitSha, '--format=fuller']);
  const commit = numStat + '\n' + nameStatus + '\n' + commitDetails;
  
  const files = parseGitShowOutputWithLines(commit);
  
  // Get commit info for author and date
  const commitInfo = parseCommitInfo(commit);
  
  // Get or create contributor
  const contributor = await getOrCreateContributor(commitInfo.author);
  
  // Process files
  for (const fileChange of files) {
    const file = await getOrCreateFile(fileChange.path);
    
    // Record contribution with lines modified
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
  }
}

async function processMergedPR(pr) {
  const token = process.env.GITHUB_TOKEN || core.getInput('github-token') || core.getInput('token');
  
  if (!token) {
    console.warn('⚠️ No GitHub token available, skipping PR file analysis');
    return;
  }
  
  const octokit = github.getOctokit(token);
  
  const { data: files } = await octokit.rest.pulls.listFiles({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
    pull_number: pr.number
  });
  
  const { data: reviews } = await octokit.rest.pulls.listReviews({
    owner: github.context.repo.owner,
    repo: github.context.repo.repo,
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
  
  // Process each reviewer's contribution to each file
  for (const review of reviews) {
    if (review.user.login !== pr.user.login) { // Exclude PR author
      const reviewer = await getOrCreateContributorByLogin(review.user.login);
      
      for (const file of files) {
        const fileRecord = await getOrCreateFile(file.filename);
        
        // Skip if file record creation failed
        if (!fileRecord) {
          console.warn(`⚠️ Skipping contribution for invalid file: ${file.filename}`);
          continue;
        }
        
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
      }
    }
  }
  
  // NEW: Process and insert review comments
  const comments = await processPRComments(pr, octokit);
  if (comments.length > 0) {
    console.log(`💬 Found ${comments.length} comments for PR #${pr.number}`);
    await insertReviewComments(comments);
  }
  
  // Record PR with reviewers
  const { error } = await supabase
    .from('pull_requests')
    .upsert({
      pr_number: pr.number,
      status: 'merged',
      author_login: pr.user.login,
      reviewers: reviewers,
      created_date: new Date(pr.created_at),
      merged_date: new Date(pr.merged_at),
      closed_date: new Date(pr.closed_at),
      lines_modified: totalLinesModified
    }, { onConflict: 'pr_number' });
    
  if (error) {
    console.error('Error updating PR:', error);
  }
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
      // Try to create contributor if not exists
      const newContributor = await getOrCreateContributorByLogin(comment.contributor_login);
      if (newContributor) {
        mappedComments.push({
          contributor_id: newContributor.id,
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
  }
  
  console.log(`💬 Mapped ${mappedComments.length} comments (skipped ${skippedCount})`);
  
  if (mappedComments.length === 0) {
    console.warn('⚠️ No comments to insert after mapping!');
    return;
  }
  
  // Insert comments
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
  // First try to find by GitHub login
  let githubLogin = authorInfo.login;
  
  // If no login provided, try to extract from email
  if (!githubLogin && authorInfo.email && authorInfo.email.includes('@users.noreply.github.com')) {
    const match = authorInfo.email.match(/(\d+\+)?([^@]+)@users\.noreply\.github\.com/);
    if (match && match[2]) {
      githubLogin = match[2];
    }
  }
  
  // Fallback to normalized name
  if (!githubLogin) {
    githubLogin = authorInfo.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
  }
  
  const { data: existing } = await supabase
    .from('contributors')
    .select('*')
    .eq('github_login', githubLogin) // Search by GitHub login first
    .single();
    
  if (existing) return existing;
  
  // Try to find by email if not found by login
  const { data: existingByEmail } = await supabase
    .from('contributors')
    .select('*')
    .eq('email', authorInfo.email)
    .single();
    
  if (existingByEmail) return existingByEmail;
  
  // Create new contributor
  const { data: newContributor, error } = await supabase
    .from('contributors')
    .insert({
      github_login: githubLogin,
      canonical_name: githubLogin, // Use GitHub login as canonical name
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
  
  // Create new contributor
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
  // Defensive: ensure path is a non-empty string
  if (!path || typeof path !== 'string' || path.trim() === '') {
    console.error('getOrCreateFile called with empty/falsy path:', JSON.stringify(path));
    // Return null so caller can decide what to do (and avoid inserting bad rows)
    return null;
  }

  const canonical = path.trim();

  // Check existing by canonical_path (your schema)
  const { data: existing, error: selectError } = await supabase
    .from('files')
    .select('*')
    .eq('canonical_path', canonical)
    .single();

  if (selectError && selectError.code !== 'PGRST116') {
    // PGRST116 is a "No rows found" in some versions; log otherwise
    console.debug('getOrCreateFile: select error (non-fatal):', selectError);
  }
  if (existing) return existing;

  // Create new file record
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
  
  const files = [];
  let inFilesList = false;
  
  // Parse both --name-status and --numstat output
  const numstatLines = [];
  const namestatLines = [];
  
  for (const line of lines) {
    if (line.match(/^\d+\t\d+\t/)) {
      // numstat format: additions deletions filename
      numstatLines.push(line);
    } else if (line.match(/^[AMD]\t/)) {
      // name-status format: status filename
      namestatLines.push(line);
    }
  }
  
  // Combine numstat and name-status data
  namestatLines.forEach((nameLine, index) => {
    const [status, path] = nameLine.split('\t');
    let linesAdded = 0;
    let linesDeleted = 0;
    let linesModified = 0;
    
    if (numstatLines[index]) {
      const parts = numstatLines[index].split('\t');
      linesAdded = parseInt(parts[0]) || 0;
      linesDeleted = parseInt(parts[1]) || 0;
      linesModified = linesAdded + linesDeleted;
    }
    
    files.push({ 
      status, 
      file: path, 
      linesAdded,
      linesDeleted,
      linesModified 
    });
  });
  
  return {
    author: {
      name: authorLine.split(' <')[0].replace('Author: ', ''),
      email: authorLine.split(' <')[1].replace('>', ''),
      login: null
    },
    date: dateLine.replace('AuthorDate: ', ''),
    files
  };
}

function parseGitShowOutputWithLines(output) {
  const lines = output.split('\n'); // keep blanks for debug
  const files = [];

  // numstat lines look like: "12\t3\tpath" or "-\t-\tpath"
  const numstatLines = lines.filter(line => line.match(/^\d+\t\d+\t/) || line.match(/^-\t-\t/));

  // name-status lines should start with a status token then a TAB.
  // Examples:
  //  A\tpath
  //  M\tpath
  //  R100\told\tnew
  //  C100\told\tnew
  // Require a tab to avoid picking up "Author:" lines etc.
  const namestatLines = lines.filter(line => line.match(/^[A-Z]+\d*\t/));

  // Debug: if anything unexpected appears, log a compact summary
  if (namestatLines.length === 0 && numstatLines.length === 0) {
    console.debug('parseGitShowOutputWithLines: no numstat or name-status lines found. Full output preview (first 40 lines):');
    console.debug(lines.slice(0, 40).map((l, i) => `${i+1}: ${l}`));
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

    // Handle rename/copy cases where there are 3 parts: status, old, new
    if (statusRaw.startsWith('R') || statusRaw.startsWith('C')) {
      oldFile = parts[1];
      file = parts[2];
    }

    // Get line changes from numstat if present at same index
    if (numstatLines[index]) {
      const numstatParts = numstatLines[index].split('\t');
      linesAdded = numstatParts[0] === '-' ? 0 : parseInt(numstatParts[0]) || 0;
      linesDeleted = numstatParts[1] === '-' ? 0 : parseInt(numstatParts[1]) || 0;
      linesModified = linesAdded + linesDeleted;
    }

    // Defensive: if file is falsy (undefined/null/empty), log context for debugging
    if (!file) {
      console.warn('parseGitShowOutputWithLines: parsed empty file path.', {
        nameLine,
        index,
        statusRaw,
        numstatLine: numstatLines[index] || null
      });
      // Skip adding an entry with an empty path
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

// Run if called directly
if (require.main === module) {
  updateRepositoryData();
}

module.exports = { updateRepositoryData };
