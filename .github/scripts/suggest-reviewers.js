// .github/scripts/suggest-reviewers.js
const { 
  calculateWorkloadAnalytics, 
  getPRPerformanceMetrics, 
  getLastActivityDatesForPRFiles 
} = require('./workload-analytics');
const { createClient } = require('@supabase/supabase-js');
const core = require('@actions/core');
const github = require('@actions/github');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function suggestReviewers() {
  console.log('🔍 Analyzing PR for detailed reviewer suggestions...');
  
  try {
    const context = github.context;
    const pr = context.payload.pull_request;
    
    if (!pr) {
      throw new Error('No pull request found in context');
    }
    
    // Debug: Check all possible token sources
    console.log('🔍 Debug: Checking token sources...');
    const tokenSources = {
      'process.env.GITHUB_TOKEN': process.env.GITHUB_TOKEN,
      'process.env.github_token': process.env.github_token,
      'core.getInput("github-token")': core.getInput('github-token'),
      'core.getInput("token")': core.getInput('token'),
      'core.getInput("GITHUB_TOKEN")': core.getInput('GITHUB_TOKEN'),
    };
    
    for (const [source, value] of Object.entries(tokenSources)) {
      if (value) {
        console.log(`✅ ${source}: Available (${value.length} chars)`);
      } else {
        console.log(`❌ ${source}: Not available`);
      }
    }
    
    // Try multiple ways to get the GitHub token
    let token = process.env.GITHUB_TOKEN || 
                process.env.github_token || 
                core.getInput('github-token') ||
                core.getInput('token') ||
                core.getInput('GITHUB_TOKEN');
    
    if (!token) {
      console.log('⚠️ No GitHub token available, falling back to context-only analysis');
      console.log('Environment vars containing "token" or "github":');
      Object.keys(process.env)
        .filter(key => key.toLowerCase().includes('token') || key.toLowerCase().includes('github'))
        .forEach(key => {
          const value = process.env[key];
          console.log(`  ${key}: ${value ? `${value.substring(0, 4)}... (${value.length} chars)` : 'undefined'}`);
        });
      return await suggestReviewersWithoutAPI(context, pr);
    }
    
    console.log(`✅ GitHub token found: ${token.substring(0, 4)}... (${token.length} chars)`);
    
    // Create Octokit instance (skip user authentication test as it may fail with limited permissions)
    console.log('🧪 Creating Octokit client...');
    const octokit = github.getOctokit(token);
    
    // Get PR files from GitHub API
    const { data: prFiles } = await octokit.rest.pulls.listFiles({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pr.number
    });
    
    console.log(`📁 Found ${prFiles.length} files in PR`);
    
    // Analyze files in detail
    const fileAnalysis = await analyzeFiles(prFiles);
    
    // Calculate detailed reviewer metrics
    const reviewerMetrics = await calculateDetailedReviewerMetrics(prFiles, pr.user.login);
    
    // Generate comprehensive comment
    const comment = generateDetailedComment(fileAnalysis, reviewerMetrics, pr.user.login);
    
    // Post comment
    await octokit.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: pr.number,
      body: comment
    });
    
    console.log('✅ Detailed reviewer suggestions posted successfully!');
    
  } catch (error) {
    console.error('❌ Error suggesting reviewers:', error);
    core.setFailed(error.message);
  }
}

// Fallback function that works without GitHub API access
async function suggestReviewersWithoutAPI(context, pr) {
  console.log('🔄 Running analysis without GitHub API access...');
  
  try {
    // We can't get the actual PR files without API access,
    // but we can still provide general reviewer suggestions
    // based on historical data and the PR author
    
    const reviewerMetrics = await calculateReviewerMetricsWithoutFiles(pr.user.login);
    
    const fallbackComment = generateFallbackComment(reviewerMetrics, pr.user.login);
    
    // We can't post the comment without API access either,
    // so we'll output it as an action output
    core.setOutput('reviewer-suggestions', fallbackComment);
    core.setOutput('top-reviewers', JSON.stringify(reviewerMetrics.slice(0, 3).map(m => m.login)));
    
    console.log('📊 Reviewer analysis completed (no API access)');
    console.log('Top suggested reviewers:', reviewerMetrics.slice(0, 3).map(m => `@${m.login}`).join(', '));
    
  } catch (error) {
    console.error('❌ Error in fallback analysis:', error);
    throw error;
  }
}

async function calculateReviewerMetricsWithoutFiles(prAuthor) {
  console.log('📈 Calculating reviewer metrics based on historical data...');
  
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  
  // Get all contributors who have been active in the last year (excluding PR author)
  const { data: activeContributors } = await supabase
    .from('contributions')
    .select(`
      contributor_id,
      activity_type,
      contribution_date,
      lines_modified,
      contributors!inner(github_login, canonical_name)
    `)
    .gte('contribution_date', oneYearAgo.toISOString())
    .neq('contributors.github_login', prAuthor);
  
  if (!activeContributors) {
    return [];
  }
  
  // Process metrics by contributor
  const contributorMetrics = new Map();
  
  activeContributors.forEach(contrib => {
    const login = contrib.contributors.github_login;
    const date = new Date(contrib.contribution_date);
    const monthKey = `${date.getFullYear()}-${date.getMonth()}`;
    
    if (!contributorMetrics.has(login)) {
      contributorMetrics.set(login, {
        login,
        canonical_name: contrib.contributors.canonical_name,
        globalCommits: 0,
        globalReviews: 0,
        activeMonths: new Set(),
        totalLinesModified: 0
      });
    }
    
    const metrics = contributorMetrics.get(login);
    metrics.activeMonths.add(monthKey);
    metrics.totalLinesModified += contrib.lines_modified || 0;
    
    if (contrib.activity_type === 'commit') {
      metrics.globalCommits++;
    } else if (contrib.activity_type === 'review') {
      metrics.globalReviews++;
    }
  });
  
  // Convert to final metrics array
  const finalMetrics = Array.from(contributorMetrics.values()).map(metrics => ({
    login: metrics.login,
    canonical_name: metrics.canonical_name,
    gCommits: metrics.globalCommits,
    gReviews: metrics.globalReviews,
    aMonths: metrics.activeMonths.size,
    totalLines: metrics.totalLinesModified
  }));
  
  // Sort by review activity, then by commit activity
  finalMetrics.sort((a, b) => {
    if (b.gReviews !== a.gReviews) {
      return b.gReviews - a.gReviews;
    }
    return b.gCommits - a.gCommits;
  });
  
  return finalMetrics.slice(0, 10); // Top 10 candidates
}

function generateFallbackComment(reviewerMetrics, prAuthor) {
  let comment = `## 📊 Pull Request Analysis (Limited Mode)

> ⚠️ **Note**: This analysis is running in limited mode due to GitHub API restrictions. File-specific analysis is not available.

### 👥 Active Reviewer Candidates (Last Year)

`;

  if (reviewerMetrics.length === 0) {
    comment += `No active reviewers found in the database. Consider:
- Initializing the repository analysis system
- Assigning reviewers based on team responsibilities
- Using code ownership files (CODEOWNERS)`;
  } else {
    comment += `| Developer | Reviews | Commits | Active Months | Total Lines |
|-----------|---------|---------|---------------|-------------|
`;
    
    reviewerMetrics.forEach(metrics => {
      comment += `| @${metrics.login} | ${metrics.gReviews} | ${metrics.gCommits} | ${metrics.aMonths} | ${metrics.totalLines.toLocaleString()} |\n`;
    });
    
    comment += `\n**Legend:**
- **Reviews**: Number of PR reviews in the last year
- **Commits**: Number of commits in the last year  
- **Active Months**: Number of months with activity in the last year
- **Total Lines**: Total lines modified (commits + reviews) in the last year

### 🎯 Top Recommendations

Based on recent activity, consider assigning:
`;
    
    const topThree = reviewerMetrics.slice(0, 3);
    topThree.forEach((metrics, index) => {
      comment += `${index + 1}. **@${metrics.login}** - ${metrics.gReviews} reviews, ${metrics.aMonths} active months\n`;
    });
  }
  
  comment += `\n---
*Limited analysis mode: For full file-specific analysis, ensure GitHub token permissions are properly configured.*

*Generated for PR by @${prAuthor}*`;
  
  return comment;
}

// Keep all the existing functions for when API access is available
async function analyzeFiles(prFiles) {
  console.log('📊 Analyzing files in detail...');
  
  const fileAnalysis = [];
  const filePaths = prFiles.map(f => f.filename);
  
  // Get file information and contributor history
  for (const prFile of prFiles) {
    const filePath = prFile.filename;
    const changeType = getChangeType(prFile);
    
    // Get contributors for this specific file
    const { data: fileContributions } = await supabase
      .from('contributions')
      .select(`
        contributor_id,
        activity_type,
        contributors!inner(github_login, canonical_name)
      `)
      .eq('files.current_path', filePath)
      .eq('files.canonical_path', filePath);
    
    // Count unique developers
    const uniqueDevs = new Set();
    const commitCounts = new Map();
    const reviewCounts = new Map();
    
    if (fileContributions) {
      fileContributions.forEach(contrib => {
        const login = contrib.contributors.github_login;
        uniqueDevs.add(login);
        
        if (contrib.activity_type === 'commit') {
          commitCounts.set(login, (commitCounts.get(login) || 0) + 1);
        } else if (contrib.activity_type === 'review') {
          reviewCounts.set(login, (reviewCounts.get(login) || 0) + 1);
        }
      });
    }
    
    // Find top contributor
    let topContributor = null;
    let maxContributions = 0;
    
    for (const [login, commits] of commitCounts) {
      const reviews = reviewCounts.get(login) || 0;
      const total = commits + reviews;
      if (total > maxContributions) {
        maxContributions = total;
        topContributor = {
          login,
          commits,
          reviews,
          total
        };
      }
    }
    
    fileAnalysis.push({
      filename: filePath,
      changeType,
      developerCount: uniqueDevs.size,
      topContributor,
      isNew: changeType === 'create'
    });
  }
  
  return fileAnalysis;
}

async function calculateDetailedReviewerMetrics(prFiles, prAuthor) {
  console.log('📈 Calculating detailed reviewer metrics...');
  
  const filePaths = prFiles.map(f => f.filename);
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  
  // Get all contributions for PR files
  const { data: prFileContributions } = await supabase
    .from('contributions')
    .select(`
      contributor_id,
      activity_type,
      contribution_date,
      lines_modified,
      contributors!inner(github_login, canonical_name),
      files!inner(current_path)
    `)
    .in('files.current_path', filePaths)
    .neq('contributors.github_login', prAuthor);
  
  // Get global contributions for the last year
  const { data: globalContributions } = await supabase
    .from('contributions')
    .select(`
      contributor_id,
      activity_type,
      contribution_date,
      lines_modified,
      contributors!inner(github_login, canonical_name)
    `)
    .gte('contribution_date', oneYearAgo.toISOString())
    .neq('contributors.github_login', prAuthor);
  
  // Process metrics by contributor
  const contributorMetrics = new Map();
  
  // Process PR file knowledge
  if (prFileContributions) {
    prFileContributions.forEach(contrib => {
      const login = contrib.contributors.github_login;
      const filePath = contrib.files.current_path;
      
      if (!contributorMetrics.has(login)) {
        contributorMetrics.set(login, {
          login,
          canonical_name: contrib.contributors.canonical_name,
          knownFiles: new Set(),
          localCommits: 0,
          localReviews: 0,
          globalCommits: 0,
          globalReviews: 0,
          activeMonths: new Set()
        });
      }
      
      const metrics = contributorMetrics.get(login);
      metrics.knownFiles.add(filePath);
      
      if (contrib.activity_type === 'commit') {
        metrics.localCommits++;
      } else if (contrib.activity_type === 'review') {
        metrics.localReviews++;
      }
    });
  }
  
  // Process global activity
  if (globalContributions) {
    globalContributions.forEach(contrib => {
      const login = contrib.contributors.github_login;
      const date = new Date(contrib.contribution_date);
      const monthKey = `${date.getFullYear()}-${date.getMonth()}`;
      
      if (!contributorMetrics.has(login)) {
        contributorMetrics.set(login, {
          login,
          canonical_name: contrib.contributors.canonical_name,
          knownFiles: new Set(),
          localCommits: 0,
          localReviews: 0,
          globalCommits: 0,
          globalReviews: 0,
          activeMonths: new Set()
        });
      }
      
      const metrics = contributorMetrics.get(login);
      metrics.activeMonths.add(monthKey);
      
      if (contrib.activity_type === 'commit') {
        metrics.globalCommits++;
      } else if (contrib.activity_type === 'review') {
        metrics.globalReviews++;
      }
    });
  }
  
  // Convert to final metrics array
  const finalMetrics = Array.from(contributorMetrics.values()).map(metrics => ({
    login: metrics.login,
    canonical_name: metrics.canonical_name,
    knows: metrics.knownFiles.size,
    learns: filePaths.length,
    lCommits: metrics.localCommits,
    lReviews: metrics.localReviews,
    gCommits: metrics.globalCommits,
    gReviews: metrics.globalReviews,
    aMonths: metrics.activeMonths.size,
    knownFilesList: Array.from(metrics.knownFiles)
  }));
  
  // Calculate workload analytics
  console.log('📊 Calculating workload analytics...');
  const workloadData = await calculateWorkloadAnalytics(finalMetrics);
  
  // Get PR performance metrics
  console.log('⏱️ Calculating PR performance metrics...');
  const contributorLogins = finalMetrics.map(m => m.login);
  const performanceData = await getPRPerformanceMetrics(contributorLogins);
  
  // Get last activity dates for PR files
  console.log('📅 Getting last activity dates...');
  const activityData = await getLastActivityDatesForPRFiles(contributorLogins, filePaths);
  
  // Combine all metrics
  const enhancedMetrics = finalMetrics.map(metrics => {
    const workload = workloadData.get(metrics.login) || {};
    const performance = performanceData.get(metrics.login) || {};
    const activity = activityData.get(metrics.login) || {};
    
    return {
      ...metrics,
      // Workload metrics
      workloadShare: workload.workloadShare || 0,
      percentileRank: workload.percentileRank || 0,
      relativeToMean: workload.relativeToMean || 0,
      giniWorkload: workload.giniWorkload || 0,
      // Performance metrics
      avgReviewTimeHours: performance.avgReviewTimeHours || 0,
      avgReviewSizeLines: performance.avgReviewSizeLines || 0,
      linesPerHour: performance.linesPerHour || 0,
      lastReviewDate: performance.lastReviewDate,
      lastReviewInPRFiles: activity.lastReviewInPRFiles,
      lastCommitDate: activity.lastCommitDate,
      lastModificationInPRFiles: activity.lastModificationInPRFiles
    };
  });
  
  // Sort by knowledge (knows) first, then by total local activity
  enhancedMetrics.sort((a, b) => {
    if (b.knows !== a.knows) {
      return b.knows - a.knows;
    }
    return (b.lCommits + b.lReviews) - (a.lCommits + a.lReviews);
  });
  
  return enhancedMetrics.slice(0, 10); // Top 10 candidates
}

function getChangeType(prFile) {
  if (prFile.status === 'added') return 'create';
  if (prFile.status === 'removed') return 'delete';
  if (prFile.status === 'modified') return 'modify';
  if (prFile.status === 'renamed') return 'rename';
  return 'modify'; // default
}

function generateDetailedComment(fileAnalysis, reviewerMetrics, prAuthor) {
  let comment = `## 📊 Pull Request Analysis

### 📁 Files Modified in this PR

| File | Change Type | Developers | Top Contributor |
|------|-------------|------------|-----------------|
`;
  
  // Categorize files
  const abandonedFiles = [];
  const hoardedFiles = [];
  
  fileAnalysis.forEach(file => {
    let topContribText = 'None (New file)';
    if (!file.isNew && file.topContributor) {
      topContribText = `@${file.topContributor.login} (${file.topContributor.commits}c/${file.topContributor.reviews}r)`;
    }
    
    comment += `| \`${file.filename}\` | ${file.changeType} | ${file.developerCount} | ${topContribText} |\n`;
    
    // Categorize files
    if (file.developerCount === 0) {
      abandonedFiles.push(file.filename);
    } else if (file.developerCount === 1 && file.topContributor) {
      hoardedFiles.push({
        filename: file.filename,
        owner: file.topContributor.login
      });
    }
  });
  
  // Add abandoned and hoarded files sections
  if (abandonedFiles.length > 0) {
    comment += `\n#### ⚠️ Abandoned Files (Nobody knows)\n`;
    abandonedFiles.forEach(file => {
      comment += `- \`${file}\`\n`;
    });
  }
  
  if (hoardedFiles.length > 0) {
    comment += `\n#### 🔒 Hoarded Files (Single expert)\n`;
    hoardedFiles.forEach(file => {
      comment += `- \`${file.filename}\` - Only known by @${file.owner}\n`;
    });
  }
  
  // Add enhanced reviewer suggestions
  if (reviewerMetrics.length === 0) {
    comment += `\n### 👥 Reviewer Suggestions

No developers found with prior experience on these files. Consider assigning reviewers based on:
- Team responsibilities
- Code architecture knowledge
- Subject matter expertise`;
  } else {
    comment += `\n### 👥 Reviewer Candidates (Q3 2024)

| Developer | Knows | WS% | PR% | RTM% | ΔGini | AvgTime(h) | AvgSize | L/h | LastRev | LastRevPR |
|-----------|-------|-----|-----|------|-------|------------|---------|-----|---------|----------|
`;
    
    reviewerMetrics.forEach(metrics => {
      const formatDate = (dateStr) => dateStr ? new Date(dateStr).toLocaleDateString('en-US', {month: 'short', day: 'numeric'}) : 'N/A';
      const formatNumber = (num, decimals = 1) => typeof num === 'number' ? num.toFixed(decimals) : '0.0';
      
      comment += `| @${metrics.login} | ${metrics.knows} | ${formatNumber(metrics.workloadShare)} | ${formatNumber(metrics.percentileRank)} | ${formatNumber(metrics.relativeToMean)} | ${formatNumber(metrics.giniWorkload)} | ${formatNumber(metrics.avgReviewTimeHours)} | ${Math.round(metrics.avgReviewSizeLines)} | ${formatNumber(metrics.linesPerHour)} | ${formatDate(metrics.lastReviewDate)} | ${formatDate(metrics.lastReviewInPRFiles)} |\n`;
    });
    
    comment += `\n**Enhanced Legend:**
- **Knows**: Files in this PR the candidate has worked on before
- **WS%**: Workload Share - percentage of total reviews in last quarter
- **PR%**: Percentile Rank - percentile position in team workload distribution  
- **RTM%**: Relative To Mean - percentage difference from team average workload
- **ΔGini**: Absolute Gini Workload coefficient (measure of workload inequality)
- **AvgTime(h)**: Average review time in hours (PR close - PR open) in last quarter
- **AvgSize**: Average review size in lines modified in last quarter
- **L/h**: Lines reviewed per hour (AvgSize / AvgTime)
- **LastRev**: Date of last review activity
- **LastRevPR**: Date of last review in any of this PR's files

<details>
<summary>📊 Additional Metrics & Activity Timeline</summary>

### Activity Timeline
| Developer | LastCommit | LastModPR | L-Commits | L-Reviews | G-Commits | G-Reviews | A-Months |
|-----------|------------|-----------|-----------|-----------|-----------|-----------|----------|
`;

    reviewerMetrics.forEach(metrics => {
      const formatDate = (dateStr) => dateStr ? new Date(dateStr).toLocaleDateString('en-US', {month: 'short', day: 'numeric'}) : 'N/A';
      
      comment += `| @${metrics.login} | ${formatDate(metrics.lastCommitDate)} | ${formatDate(metrics.lastModificationInPRFiles)} | ${metrics.lCommits} | ${metrics.lReviews} | ${metrics.gCommits} | ${metrics.gReviews} | ${metrics.aMonths} |\n`;
    });

    comment += `\n**Timeline Legend:**
- **LastCommit**: Date of last commit (any file)
- **LastModPR**: Date of last modification in any of this PR's files
- **L-Commits**: Local commits on known files (all time)
- **L-Reviews**: Local reviews on known files (all time)
- **G-Commits**: Global commits in the last year
- **G-Reviews**: Global reviews in the last year
- **A-Months**: Active months in the last year

### File Knowledge Breakdown
`;
    
    reviewerMetrics.forEach(metrics => {
      if (metrics.knownFilesList.length > 0) {
        comment += `**@${metrics.login}** knows these files:\n`;
        metrics.knownFilesList.forEach(file => {
          comment += `- \`${file}\`\n`;
        });
        comment += '\n';
      }
    });
    
    comment += `</details>`;
  }
  
  comment += `\n---
*This enhanced analysis includes workload distribution metrics and performance indicators from the last quarter (3 months). Workload metrics help ensure fair distribution of review responsibilities across the team.*

*Generated for PR by @${prAuthor}*`;
  
  return comment;
}

// Run if called directly
if (require.main === module) {
  suggestReviewers();
}

module.exports = { suggestReviewers };
