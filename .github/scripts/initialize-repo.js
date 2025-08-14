// .github/scripts/initialize-repo.js
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
    
    // Insert data into Supabase
    await insertContributors(Array.from(contributorMap.values()));
    await insertFiles(Array.from(fileMap.values()));
    await insertContributions(contributions);
    
    // Update last scan metadata
    await updateMetadata('last_scan_commit', commits[0].hash);
    
    console.log('✅ Repository initialization completed successfully!');
    console.log(`📈 Statistics:
    - Contributors: ${contributorMap.size}
    - Files: ${fileMap.size}  
    - Contributions: ${contributions.length}`);
    
  } catch (error) {
    console.error('❌ Error during initialization:', error);
    core.setFailed(error.message);
  }
}

async function processCommit(commit, contributorMap, fileMap, contributions) {
  // Get commit details
  const show = await git.show([commit.hash, '--name-status', '--format=""']);
  const files = parseGitShowOutput(show);
  
  // Process contributor
  const contributor = await getOrCreateContributor(commit, contributorMap);
  
  // Process each file in the commit
  for (const fileChange of files) {
    const file = await getOrCreateFile(fileChange, fileMap);
    
    // Record contribution
    contributions.push({
      contributor_id: contributor.temp_id,
      file_id: file.temp_id,
      activity_type: 'commit',
      activity_id: commit.hash,
      contribution_date: new Date(commit.date)
    });
    
    // Record file history
    if (fileChange.status === 'R') { // Renamed
      await recordFileRename(file, fileChange, commit.hash);
    }
  }
}

async function getOrCreateContributor(commit, contributorMap) {
  const email = commit.author_email;
  const name = commit.author_name;
  const normalizedName = normalizeName(name);
  
  let contributor = contributorMap.get(email) || contributorMap.get(normalizedName);
  
  if (!contributor) {
    contributor = {
      temp_id: `temp_${contributorMap.size + 1}`,
      github_login: await getGitHubLogin(email, name),
      canonical_name: normalizedName,
      email: email
    };
    contributorMap.set(email, contributor);
    contributorMap.set(normalizedName, contributor);
  }
  
  return contributor;
}

async function getOrCreateFile(fileChange, fileMap) {
  const path = fileChange.file;
  let file = fileMap.get(path);
  
  if (!file) {
    file = {
      temp_id: `temp_${fileMap.size + 1}`,
      canonical_path: path,
      current_path: path
    };
    fileMap.set(path, file);
  }
  
  return file;
}

function parseGitShowOutput(output) {
  const lines = output.split('\n').filter(line => line.trim());
  return lines.map(line => {
    const parts = line.split('\t');
    return {
      status: parts[0][0], // First character (A, M, D, R)
      file: parts[1],
      oldFile: parts[0].startsWith('R') ? parts[1] : null
    };
  });
}

function normalizeName(name) {
  return name
    .replace(/[^a-zA-Z0-9]/g, '')
    .toLowerCase()
    .trim();
}

async function getGitHubLogin(email, name) {
  // Try to get GitHub login from git config or commit info
  // This is a simplified version - you might want to enhance this
  try {
    const config = await git.listConfig();
    return config.all['user.login'] || null;
  } catch {
    return null;
  }
}

async function insertContributors(contributors) {
  // Insert in batches
  const batchSize = 100;
  for (let i = 0; i < contributors.length; i += batchSize) {
    const batch = contributors.slice(i, i + batchSize);
    const { error } = await supabase
      .from('contributors')
      .insert(batch.map(c => ({
        github_login: c.github_login || c.canonical_name,
        canonical_name: c.canonical_name,
        email: c.email
      })));
    
    if (error) throw error;
  }
}

async function insertFiles(files) {
  const batchSize = 100;
  for (let i = 0; i < files.length; i += batchSize) {
    const batch = files.slice(i, i + batchSize);
    const { error } = await supabase
      .from('files')
      .insert(batch.map(f => ({
        canonical_path: f.canonical_path,
        current_path: f.current_path
      })));
    
    if (error) throw error;
  }
}

async function insertContributions(contributions) {
  // First, get the actual IDs from the database
  const { data: contributors } = await supabase
    .from('contributors')
    .select('id, canonical_name, github_login');
    
  const { data: files } = await supabase
    .from('files')
    .select('id, canonical_path');
  
  // Create mapping
  const contributorIdMap = new Map();
  contributors.forEach(c => {
    contributorIdMap.set(c.canonical_name, c.id);
    if (c.github_login) contributorIdMap.set(c.github_login, c.id);
  });
  
  const fileIdMap = new Map();
  files.forEach(f => fileIdMap.set(f.canonical_path, f.id));
  
  // Map contributions to actual IDs
  const mappedContributions = contributions.map(c => ({
    contributor_id: contributorIdMap.get(c.contributor_id.replace('temp_', '')),
    file_id: fileIdMap.get(c.file_id.replace('temp_', '')),
    activity_type: c.activity_type,
    activity_id: c.activity_id,
    contribution_date: c.contribution_date
  })).filter(c => c.contributor_id && c.file_id);
  
  // Insert in batches
  const batchSize = 1000;
  for (let i = 0; i < mappedContributions.length; i += batchSize) {
    const batch = mappedContributions.slice(i, i + batchSize);
    const { error } = await supabase
      .from('contributions')
      .insert(batch);
    
    if (error) throw error;
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
