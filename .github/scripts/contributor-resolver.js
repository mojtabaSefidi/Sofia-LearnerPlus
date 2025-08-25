// .github/scripts/contributor-resolver.js
const fs = require('fs').promises;
const path = require('path');
const git = require('simple-git')();
const github = require('@actions/github');

async function detectAllContributors() {
  console.log('🔍 Starting comprehensive contributor detection...');
  
  // Step 1: Load manual mappings
  const manualMappings = await loadManualMappings();
  
  // Step 2: Collect all contributor data from git history
  const gitContributors = await collectGitContributors();
  
  // Step 3: Merge and resolve all contributors
  const resolvedContributors = await mergeContributorData(gitContributors, manualMappings);
  
  console.log(`✅ Detected and resolved ${resolvedContributors.size} unique contributors`);
  return resolvedContributors;
}

async function loadManualMappings() {
  try {
    const mappingPath = path.join(process.cwd(), '.github', 'config', 'contributor-identities.json');
    const content = await fs.readFile(mappingPath, 'utf8');
    const data = JSON.parse(content);
    
    console.log(`📋 Loaded ${data.contributors.length} manual contributor mappings`);
    return data.contributors;
  } catch (error) {
    console.log('📋 No manual contributor mappings found, using auto-detection only');
    return [];
  }
}

async function collectGitContributors() {
  console.log('🔍 Collecting all contributors from git history...');
  
  const log = await git.log({ '--all': null });
  const commits = log.all;
  
  const contributorData = new Map();
  
  for (const commit of commits) {
    const email = commit.author_email;
    const name = commit.author_name;
    const date = new Date(commit.date);
    
    // Create a unique key for this contributor
    const key = email.toLowerCase();
    
    if (!contributorData.has(key)) {
      contributorData.set(key, {
        emails: new Set([email]),
        names: new Set([name]),
        github_usernames: new Set(),
        first_seen: date,
        last_seen: date,
        commits: []
      });
    }
    
    const contributor = contributorData.get(key);
    contributor.emails.add(email);
    contributor.names.add(name);
    contributor.last_seen = date > contributor.last_seen ? date : contributor.last_seen;
    contributor.commits.push({
      hash: commit.hash,
      date: date,
      name: name,
      email: email
    });
    
    // Try to extract GitHub username
    const githubUsername = await getGitHubLoginFromCommit(commit);
    if (githubUsername) {
      contributor.github_usernames.add(githubUsername);
    }
  }
  
  console.log(`📊 Collected data for ${contributorData.size} raw contributors`);
  return contributorData;
}

async function mergeContributorData(gitContributors, manualMappings) {
  const resolvedContributors = new Map();
  
  // Step 1: Process manual mappings first (highest priority)
  for (const mapping of manualMappings) {
    processManualMapping(mapping, resolvedContributors);
  }
  
  // Step 2: Match git contributors to manual mappings and collect unmatched
  const unmatchedGitContributors = new Map();
  
  for (const [emailKey, gitData] of gitContributors) {
    let matched = false;
    
    // Check if this git contributor matches any manual mapping
    for (const [contributorId, resolved] of resolvedContributors) {
      if (isGitContributorMatch(gitData, resolved)) {
        // Merge git data into manual mapping
        mergeGitDataIntoResolved(gitData, resolved);
        matched = true;
        break;
      }
    }
    
    if (!matched) {
      unmatchedGitContributors.set(emailKey, gitData);
    }
  }
  
  // Step 3: Auto-resolve unmatched contributors
  await autoResolveContributors(unmatchedGitContributors, resolvedContributors);
  
  return resolvedContributors;
}

function processManualMapping(mapping, resolvedContributors) {
  const contributorId = mapping.primary_github_login;
  
  const contributor = {
    primary_github_login: mapping.primary_github_login,
    canonical_name: mapping.canonical_name, // Manual canonical name (high priority)
    github_usernames: new Set(mapping.github_usernames || []),
    emails: new Set(mapping.emails || []),
    names: new Set(mapping.names || []),
    priority: 'manual',
    git_data: [],
    // These will be updated when git data is merged
    primary_email: null,
    latest_name: null,
    latest_email: null,
    latest_commit_date: null
  };
  
  resolvedContributors.set(contributorId, contributor);
  
  console.log(`📋 Loaded manual mapping: ${contributorId} (canonical: ${mapping.canonical_name})`);
}

function isGitContributorMatch(gitData, resolved) {
  // Check if any email matches
  for (const email of gitData.emails) {
    if (resolved.emails.has(email)) return true;
  }
  
  // Check if any GitHub username matches
  for (const username of gitData.github_usernames) {
    if (resolved.github_usernames.has(username)) return true;
  }
  
  // Check if any name matches (fuzzy)
  for (const name of gitData.names) {
    for (const resolvedName of resolved.names) {
      if (name.toLowerCase().includes(resolvedName.toLowerCase()) || 
          resolvedName.toLowerCase().includes(name.toLowerCase())) {
        return true;
      }
    }
  }
  
  return false;
}

function mergeGitDataIntoResolved(gitData, resolved) {
  // Add all git data to the resolved contributor
  gitData.emails.forEach(email => resolved.emails.add(email));
  gitData.names.forEach(name => resolved.names.add(name));
  gitData.github_usernames.forEach(username => resolved.github_usernames.add(username));
  resolved.git_data.push(...gitData.commits);
  
  // IMPORTANT: Always update with most recent data, even if manual mapping exists
  updateWithLatestCommitData(resolved);
}

function updateWithLatestCommitData(resolved) {
  if (!resolved.git_data || resolved.git_data.length === 0) return;
  
  // Sort commits by date (most recent first)
  const sortedCommits = resolved.git_data.sort((a, b) => b.date - a.date);
  const latestCommit = sortedCommits[0];
  
  // Update with most recent commit data
  resolved.latest_name = latestCommit.name;
  resolved.latest_email = latestCommit.email;
  resolved.latest_commit_date = latestCommit.date;
  
  // If no canonical_name is set manually, use normalized latest name
  if (!resolved.canonical_name || resolved.priority !== 'manual') {
    resolved.canonical_name = normalizeName(latestCommit.name);
  }
  
  // Set primary_email to the most recent one
  resolved.primary_email = latestCommit.email;
  
  console.log(`📊 Updated contributor ${resolved.primary_github_login} with latest data: ${latestCommit.name} <${latestCommit.email}> (${latestCommit.date.toISOString().split('T')[0]})`);
}

async function autoResolveContributors(unmatchedGitContributors, resolvedContributors) {
  console.log(`🤖 Auto-resolving ${unmatchedGitContributors.size} unmatched contributors...`);
  
  for (const [emailKey, gitData] of unmatchedGitContributors) {
    // Sort commits by date to get the latest information
    const sortedCommits = gitData.commits.sort((a, b) => b.date - a.date);
    const latestCommit = sortedCommits[0];
    const earliestCommit = sortedCommits[sortedCommits.length - 1];
    
    // Try to determine the best GitHub username
    let primaryGithubLogin = null;
    
    if (gitData.github_usernames.size > 0) {
      // If we have GitHub usernames, pick the one from the most recent commit
      primaryGithubLogin = Array.from(gitData.github_usernames)[0];
    } else {
      // Try various fallback methods using the latest commit data
      primaryGithubLogin = extractUsernameFromEmail(latestCommit.email) || 
                          createTemporaryGitHubLogin(latestCommit.name, latestCommit.email);
    }
    
    const contributorId = primaryGithubLogin;
    const newContributor = {
      primary_github_login: primaryGithubLogin,
      canonical_name: normalizeName(latestCommit.name), // Use latest name
      github_usernames: gitData.github_usernames,
      emails: gitData.emails,
      names: gitData.names,
      primary_email: latestCommit.email, // Use latest email
      latest_name: latestCommit.name,
      latest_email: latestCommit.email,
      latest_commit_date: latestCommit.date,
      first_seen: earliestCommit.date,
      last_seen: latestCommit.date,
      priority: 'auto',
      git_data: gitData.commits
    };
    
    resolvedContributors.set(contributorId, newContributor);
    
    console.log(`🤖 Auto-resolved: ${latestCommit.name} <${latestCommit.email}> -> ${primaryGithubLogin} (${gitData.commits.length} commits, latest: ${latestCommit.date.toISOString().split('T')[0]})`);
  }
  
  console.log(`✅ Auto-resolved ${unmatchedGitContributors.size} contributors`);
}

// Helper function to find a resolved contributor for a commit
function findResolvedContributor(commit, resolvedContributors) {
  const email = commit.author_email.toLowerCase();
  const name = commit.author_name.toLowerCase();
  
  // Search through resolved contributors
  for (const [contributorId, contributor] of resolvedContributors) {
    // Check email match
    if (contributor.emails.has(commit.author_email)) {
      return contributor;
    }
    
    // Check name match
    for (const contributorName of contributor.names) {
      if (contributorName.toLowerCase() === name) {
        return contributor;
      }
    }
  }
  
  return null;
}

function createTempContributor(commit) {
  const githubLogin = extractUsernameFromEmail(commit.author_email) || 
                     createTemporaryGitHubLogin(commit.author_name, commit.author_email);
  
  return {
    primary_github_login: githubLogin,
    canonical_name: normalizeName(commit.author_name),
    github_usernames: new Set([githubLogin]),
    emails: new Set([commit.author_email]),
    names: new Set([commit.author_name]),
    primary_email: commit.author_email,
    priority: 'temp',
    git_data: []
  };
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

function normalizeName(name) {
  return name
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '');
}

module.exports = {
  detectAllContributors,
  findResolvedContributor,
  createTempContributor,
  updateWithLatestCommitData
};
