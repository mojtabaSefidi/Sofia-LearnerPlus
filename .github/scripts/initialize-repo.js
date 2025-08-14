// .github/scripts/initialize-repo.js
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
    
    // Insert data into Supabase
    await insertContributors(Array.from(contributorMap.values()));
    await insertFiles(Array.from(fileMap.values()));
    
    // Deduplicate contributors before inserting contributions
    console.log('🔧 Deduplicating contributors...');
    await deduplicateContributors();
    
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
        contributor_email: contributor.email,
        contributor_canonical_name: contributor.canonical_name,
        file_path: file.canonical_path,
        activity_type: 'commit',
        activity_id: commit.hash,
        contribution_date: new Date(commit.date)
      });
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
  
  // Get the actual IDs from the database (after deduplication)
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
  
  // Create lookup maps
  const contributorLookup = new Map();
  dbContributors.forEach(c => {
    contributorLookup.set(c.email, c.id);
    contributorLookup.set(c.canonical_name, c.id);
  });
  
  const fileLookup = new Map();
  dbFiles.forEach(f => {
    fileLookup.set(f.canonical_path, f.id);
  });
  
  // Map contributions to database IDs
  const mappedContributions = [];
  let skippedCount = 0;
  
  for (const contribution of contributions) {
    const contributorId = contributorLookup.get(contribution.contributor_email) || 
                         contributorLookup.get(contribution.contributor_canonical_name);
    const fileId = fileLookup.get(contribution.file_path);
    
    if (contributorId && fileId) {
      mappedContributions.push({
        contributor_id: contributorId,
        file_id: fileId,
        activity_type: contribution.activity_type,
        activity_id: contribution.activity_id,
        contribution_date: contribution.contribution_date
      });
    } else {
      skippedCount++;
      if (skippedCount <= 5) { // Log first few for debugging
        console.warn(`⚠️ Skipping contribution - Contributor: ${contribution.contributor_email} (ID: ${contributorId}), File: ${contribution.file_path} (ID: ${fileId})`);
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
      // Continue with next batch instead of failing completely
    } else {
      totalInserted += batch.length;
      console.log(`🔗 Inserted contributions batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(mappedContributions.length/batchSize)} (${totalInserted} total)`);
    }
  }
  
  console.log(`✅ Successfully inserted ${totalInserted} contributions`);
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
