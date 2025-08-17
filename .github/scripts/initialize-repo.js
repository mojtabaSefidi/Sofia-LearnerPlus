// .github/scripts/initialize-repo.js
const { createClient } = require('@supabase/supabase-js');
const git = require('simple-git')();
const core = require('@actions/core');
const { deduplicateContributors } = require('./deduplicate-contributors');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

// Replace the initializeRepository function with this updated version:

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
    
    // Insert files first
    await insertFiles(Array.from(fileMap.values()));
    
    // Insert contributors (may have duplicates)
    await insertContributors(Array.from(contributorMap.values()));
    
    // Deduplicate contributors BEFORE processing contributions
    console.log('🔧 Deduplicating contributors...');
    await deduplicateContributors();
    
    // Now insert contributions with deduplicated contributor IDs
    await insertContributionsWithDeduplicatedIds(contributions, contributorMap);
    
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
    
    if (contribution.contributor_email) {
      contributorId = contributorLookup.get(contribution.contributor_email.toLowerCase());
    }
    
    if (!contributorId && contribution.contributor_canonical_name) {
      contributorId = contributorLookup.get(contribution.contributor_canonical_name.toLowerCase());
    }
    
    if (!contributorId) {
      const originalContributor = Array.from(originalContributorMap.values())
        .find(c => c.email === contribution.contributor_email);
      if (originalContributor && originalContributor.github_login) {
        contributorId = contributorLookup.get(originalContributor.github_login.toLowerCase());
      }
    }
    
    if (contributorId && fileId) {
      mappedContributions.push({
        contributor_id: contributorId,
        file_id: fileId,
        activity_type: contribution.activity_type,
        activity_id: contribution.activity_id,
        contribution_date: contribution.contribution_date,
        lines_modified: contribution.lines_modified || 0
      });
    } else {
      skippedCount++;
      if (skippedCount <= 5) {
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
    } else {
      totalInserted += batch.length;
      console.log(`🔗 Inserted contributions batch ${Math.floor(i/batchSize) + 1}/${Math.ceil(mappedContributions.length/batchSize)} (${totalInserted} total)`);
    }
  }
  
  console.log(`✅ Successfully inserted ${totalInserted} contributions`);
}

async function processCommit(commit, contributorMap, fileMap, contributions) {
  try {
    // Get commit details with proper format including line changes
    const show = await git.show([commit.hash, '--name-status', '--numstat', '--format=']);
    const files = parseGitShowOutputWithLines(show);
    
    // Process contributor
    const contributor = await getOrCreateContributor(commit, contributorMap);
    
    // Process each file in the commit
    for (const fileChange of files) {
      const file = await getOrCreateFile(fileChange, fileMap);
      
      // Record contribution with lines modified
      contributions.push({
        contributor_email: contributor.email,
        contributor_canonical_name: contributor.canonical_name,
        file_path: file.canonical_path,
        activity_type: 'commit',
        activity_id: commit.hash,
        contribution_date: new Date(commit.date),
        lines_modified: fileChange.linesModified || 0
      });
    }
  } catch (error) {
    console.warn(`⚠️ Could not process commit ${commit.hash}: ${error.message}`);
  }
}

function parseGitShowOutputWithLines(output) {
  const lines = output.split('\n').filter(line => line.trim());
  const files = [];
  
  // Parse numstat lines (additions deletions filename)
  const numstatLines = lines.filter(line => line.match(/^\d+\t\d+\t/) || line.match(/^-\t-\t/));
  const namestatLines = lines.filter(line => line.match(/^[AMDRT]/));
  
  // Combine numstat and name-status data
  namestatLines.forEach((nameLine, index) => {
    const parts = nameLine.split('\t');
    const status = parts[0];
    let file = parts[1];
    let oldFile = null;
    let linesModified = 0;
    
    // Handle rename/copy cases
    if (status.startsWith('R') || status.startsWith('C')) {
      oldFile = parts[1];
      file = parts[2];
    }
    
    // Get line changes from numstat
    if (numstatLines[index]) {
      const numstatParts = numstatLines[index].split('\t');
      const additions = numstatParts[0] === '-' ? 0 : parseInt(numstatParts[0]) || 0;
      const deletions = numstatParts[1] === '-' ? 0 : parseInt(numstatParts[1]) || 0;
      linesModified = additions + deletions;
    }
    
    files.push({
      status: status[0],
      file: file,
      oldFile: oldFile,
      linesModified: linesModified
    });
  });
  
  return files;
}

// UPDATE in initialize-repo.js - Replace getOrCreateContributor function:
async function getOrCreateContributor(commit, contributorMap) {
  const email = commit.author_email;
  const name = commit.author_name;
  
  // Try to get GitHub login from email or commit info
  let githubLogin = await getGitHubLoginFromCommit(commit);
  
  // If we can't find a GitHub login, use normalized name as fallback
  if (!githubLogin) {
    githubLogin = normalizeName(name);
  }
  
  // Use GitHub login as primary key for deduplication instead of email
  let contributor = contributorMap.get(githubLogin);
  
  if (!contributor) {
    contributor = {
      github_login: githubLogin,
      canonical_name: githubLogin, // Use github_login instead of normalized name
      email: email
    };
    contributorMap.set(githubLogin, contributor);
  }
  
  return contributor;
}

// NEW function to extract GitHub login from commit
async function getGitHubLoginFromCommit(commit) {
  try {
    // Try to get GitHub login from commit message or other sources
    const commitDetails = await git.show([commit.hash, '--format=%aN%n%aE%n%cN%n%cE']);
    
    // Check if email contains GitHub username pattern
    if (commit.author_email && commit.author_email.includes('@users.noreply.github.com')) {
      const match = commit.author_email.match(/(\d+\+)?([^@]+)@users\.noreply\.github\.com/);
      if (match && match[2]) {
        return match[2];
      }
    }
    
    // Try to get from git config
    const config = await git.listConfig();
    const userLogin = config.all['user.login'];
    if (userLogin) return userLogin;
    
    // Fallback: use normalized name
    return normalizeName(commit.author_name);
  } catch (error) {
    return normalizeName(commit.author_name);
  }
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
