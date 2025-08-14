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
  try {
    // Get commit details with proper format
    const show = await git.show([commit.hash, '--name-status', '--format=']);
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
      
      // Record file history for renames
      if (fileChange.status === 'R') {
        // Handle rename later when we have actual database IDs
      }
    }
  } catch (error) {
    console.warn(`⚠️ Could not process commit ${commit.hash}: ${error.message}`);
    // Continue with next commit instead of failing entirely
  }
}

async function getOrCreateContributor(commit, contributorMap) {
  const email = commit.author_email;
  const name = commit.author_name;
  const normalizedName = normalizeName(name);
  
  // Use email as primary key for deduplication
  let contributor = contributorMap.get(email);
  
  if (!contributor) {
    contributor = {
      temp_id: `temp_contributor_${contributorMap.size + 1}`,
      github_login: await getGitHubLogin(email, name),
      canonical_name: normalizedName,
      email: email
    };
    contributorMap.set(email, contributor);
  }
  
  return contributor;
}

async function getOrCreateFile(fileChange, fileMap) {
  const path = fileChange.file;
  let file = fileMap.get(path);
  
  if (!file) {
    file = {
      temp_id: `temp_file_${fileMap.size + 1}`,
      canonical_path: path,
      current_path: path
    };
    fileMap.set(path, file);
  }
  
  return file;
}

function parseGitShowOutput(output) {
  const lines = output.split('\n').filter(line => line.trim() && line.match(/^[AMDRT]/));
  return lines.map(line => {
    const parts = line.split('\t');
    const status = parts[0];
    let file = parts[1];
    let oldFile = null;
    
    // Handle rename/copy cases
    if (status.startsWith('R') || status.startsWith('C')) {
      oldFile = parts[1];
      file = parts[2];
    }
    
    return {
      status: status[0], // First character (A, M, D, R, C, T)
      file: file,
      oldFile: oldFile
    };
  });
}

function normalizeName(name) {
  return name
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '');
}

async function getGitHubLogin(email, name) {
  // Try to get GitHub login from git config
  try {
    const config = await git.listConfig();
    const userLogin = config.all['user.login'];
    if (userLogin) return userLogin;
  } catch (error) {
    // Ignore config errors
  }
  
  // Fallback to normalized name
  return normalizeName(name);
}

async function insertContributors(contributors) {
  if (contributors.length === 0) return;
  
  console.log(`📝 Inserting ${contributors.length} contributors...`);
  
  // Insert in batches to avoid overwhelming the database
  const batchSize = 50;
  for (let i = 0; i < contributors.length; i += batchSize) {
    const batch = contributors.slice(i, i + batchSize);
    const { error } = await supabase
      .from('contributors')
      .insert(batch.map(c => ({
        github_login: c.github_login || c.canonical_name,
        canonical_name: c.canonical_name,
        email: c.email
      })));
    
    if (error) {
      console.error('Error inserting contributors batch:', error);
      throw error;
    }
    
    console.log(`📝 Inserted contributors batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(contributors.length/batchSize)}`);
  }
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

async function insertContributions(contributions) {
  if (contributions.length === 0) return;
  
  console.log(`🔗 Processing ${contributions.length} contributions...`);
  
  // First, get the actual IDs from the database
  const { data: contributors, error: contributorError } = await supabase
    .from('contributors')
    .select('id, canonical_name, github_login, email');
    
  if (contributorError) throw contributorError;
    
  const { data: files, error: filesError } = await supabase
    .from('files')
    .select('id, canonical_path');
  
  if (filesError) throw filesError;
  
  // Create mapping from temp IDs to actual IDs
  const contributorIdMap = new Map();
  contributors.forEach(c => {
    contributorIdMap.set(c.email, c.id);
    contributorIdMap.set(c.canonical_name, c.id);
  });
  
  const fileIdMap = new Map();
  files.forEach(f => fileIdMap.set(f.canonical_path, f.id));
  
  // Map contributions to actual IDs
  let mappedContributions = [];
  let skippedContributions = 0;
  
  for (const contribution of contributions) {
    // Find contributor by temp_id
    const contributorTempId = contribution.contributor_id;
    const fileTempId = contribution.file_id;
    
    // We need to map these back to actual values
    // This is a bit tricky since we used temp IDs, let's use a different approach
    
    // For now, skip the mapping complexity and insert directly
    // We'll fix this by changing the approach above
  }
  
  // Alternative approach: rebuild contributions with actual lookups
  console.log('🔄 Re-scanning commits for contribution insertion...');
  
  // Get all commits again and map directly to database IDs
  const log = await git.log({ '--all': null });
  const commits = log.all;
  
  mappedContributions = [];
  
  for (const commit of commits.reverse()) {
    try {
      const show = await git.show([commit.hash, '--name-status', '--format=']);
      const files = parseGitShowOutput(show);
      
      // Find contributor
      const contributor = contributors.find(c => 
        c.email === commit.author_email || 
        c.canonical_name === normalizeName(commit.author_name)
      );
      
      if (!contributor) continue;
      
      // Process files
      for (const fileChange of files) {
        const file = files.find(f => f.canonical_path === fileChange.file);
        if (!file) continue;
        
        mappedContributions.push({
          contributor_id: contributor.id,
          file_id: file.id,
          activity_type: 'commit',
          activity_id: commit.hash,
          contribution_date: new Date(commit.date)
        });
      }
    } catch (error) {
      console.warn(`⚠️ Skipping commit ${commit.hash}: ${error.message}`);
    }
  }
  
  console.log(`🔗 Inserting ${mappedContributions.length} mapped contributions...`);
  
  // Insert in batches
  const batchSize = 500;
  for (let i = 0; i < mappedContributions.length; i += batchSize) {
    const batch = mappedContributions.slice(i, i + batchSize);
    const { error } = await supabase
      .from('contributions')
      .insert(batch);
    
    if (error) {
      console.error('Error inserting contributions batch:', error);
      // Don't throw here, just log and continue
    } else {
      console.log(`🔗 Inserted contributions batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(mappedContributions.length/batchSize)}`);
    }
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
