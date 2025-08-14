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
    // Record PR as merged and process reviews
    await processMergedPR(pr);
  }
}

async function processNewCommit(commitSha) {
  const commit = await git.show([commitSha, '--name-status', '--format=fuller']);
  const commitInfo = parseCommitInfo(commit);
  
  // Get or create contributor
  const contributor = await getOrCreateContributor(commitInfo.author);
  
  // Process files
  for (const fileChange of commitInfo.files) {
    const file = await getOrCreateFile(fileChange.path);
    
    // Record contribution
    await recordContribution({
      contributor_id: contributor.id,
      file_id: file.id,
      activity_type: 'commit',
      activity_id: commitSha,
      contribution_date: new Date(commitInfo.date)
    });
  }
}

async function processMergedPR(pr) {
  // Get PR files from GitHub API
  const token = core.getInput('github-token');
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
  
  // Process each reviewer's contribution to each file
  for (const review of reviews) {
    if (review.user.login !== pr.user.login) { // Exclude PR author
      const reviewer = await getOrCreateContributorByLogin(review.user.login);
      
      for (const file of files) {
        const fileRecord = await getOrCreateFile(file.filename);
        
        await recordContribution({
          contributor_id: reviewer.id,
          file_id: fileRecord.id,
          activity_type: 'review',
          activity_id: pr.number.toString(),
          contribution_date: new Date(review.submitted_at)
        });
      }
    }
  }
  
  // Record PR
  const { error } = await supabase
    .from('pull_requests')
    .insert({
      pr_number: pr.number,
      status: 'merged',
      author_login: pr.user.login,
      created_date: new Date(pr.created_at),
      merged_date: new Date(pr.merged_at)
    });
}

async function getOrCreateContributor(authorInfo) {
  const { data: existing } = await supabase
    .from('contributors')
    .select('*')
    .eq('email', authorInfo.email)
    .single();
    
  if (existing) return existing;
  
  // Create new contributor
  const { data: newContributor, error } = await supabase
    .from('contributors')
    .insert({
      github_login: authorInfo.login || authorInfo.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase(),
      canonical_name: authorInfo.name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase(),
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
  const { data: existing } = await supabase
    .from('files')
    .select('*')
    .eq('current_path', path)
    .single();
    
  if (existing) return existing;
  
  // Create new file
  const { data: newFile, error } = await supabase
    .from('files')
    .insert({
      canonical_path: path,
      current_path: path
    })
    .select()
    .single();
    
  if (error) throw error;
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
  // Parse git show output to extract commit information
  const lines = commitOutput.split('\n');
  const authorLine = lines.find(l => l.startsWith('Author:'));
  const dateLine = lines.find(l => l.startsWith('AuthorDate:'));
  
  const files = [];
  let inFilesList = false;
  
  for (const line of lines) {
    if (line.match(/^[AMD]\t/)) {
      inFilesList = true;
      const [status, path] = line.split('\t');
      files.push({ status, path });
    }
  }
  
  return {
    author: {
      name: authorLine.split(' <')[0].replace('Author: ', ''),
      email: authorLine.split(' <')[1].replace('>', ''),
      login: null // We'll try to resolve this later
    },
    date: dateLine.replace('AuthorDate: ', ''),
    files
  };
}

// Run if called directly
if (require.main === module) {
  updateRepositoryData();
}

module.exports = { updateRepositoryData };
