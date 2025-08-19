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
    
    // Get GitHub token (should be available from environment)
    const token = process.env.GITHUB_TOKEN;
    
    if (!token) {
      throw new Error('GitHub token not available');
    }
    
    console.log(`✅ GitHub token found: ${token.substring(0, 4)}... (${token.length} chars)`);
    
    // Create Octokit instance
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
    const comment = generateDetailedComment(fileAnalysis, reviewerMetrics, pr.user.login, prFiles);
    
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

async function analyzeFiles(prFiles) {
  console.log('📊 Analyzing files in detail...');
  
  const fileAnalysis = [];
  const filePaths = prFiles.map(f => f.filename);
  
  // Get PR author from context
  const context = github.context;
  const prAuthor = context.payload.pull_request.user.login;
  
  // Get file information and contributor history
  for (const prFile of prFiles) {
    const filePath = prFile.filename;
    const changeType = getChangeType(prFile);
    
    // Get contributors for this specific file - EXCLUDE PR AUTHOR
    const { data: fileContributions } = await supabase
      .from('contributions')
      .select(`
        contributor_id,
        activity_type,
        contributors!inner(github_login, canonical_name),
        files!inner(current_path, canonical_path)
      `)
      .or(`files.current_path.eq.${filePath},files.canonical_path.eq.${filePath}`)
      .neq('contributors.github_login', prAuthor); // Exclude PR author
    
    // Count unique developers (excluding author)
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
    
    // Find top contributor (excluding author)
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
      developerCount: uniqueDevs.size, // This now excludes the author
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
    learns: filePaths.length - metrics.knownFiles.size, // NEW: Calculate learns
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

function generateDetailedComment(fileAnalysis, reviewerMetrics, prAuthor, prFiles) {
  const filePaths = prFiles.map(f => f.filename);
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

  // Add enhanced reviewer suggestions with LEARNS column
  if (reviewerMetrics.length === 0) {
    comment += `\n### 👥 Reviewer Suggestions

No developers found with prior experience on these files. Consider assigning reviewers based on:
- Team responsibilities
- Code architecture knowledge
- Subject matter expertise`;
  } else {
    comment += `\n### 👥 Reviewer Candidates

| Developer | Knows | Learns | WorkloadShare% | PercentileRank% | Relative To Mean% | ΔGiniWorkload(Absolute) | AvgTime(h) | AvgSize(line) | line/hour | LastReview | LastReviewOnPRFile |
|-----------|-------|--------|----------------|-----------------|-------------------|-------------------------|------------|---------------|-----------|------------|--------------------|
`;

    // helpers
    const formatDate = (dateStr) => {
      const d = new Date(dateStr);
      return dateStr && !isNaN(d)
        ? d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
        : 'N/A';
    };

    const formatNumber = (num, decimals = 1) =>
      typeof num === 'number' && !isNaN(num) ? num.toFixed(decimals) : '0.0';

    reviewerMetrics.forEach(metrics => {
      comment += `| @${metrics.login} | ${metrics.knows} | ${metrics.learns} | ${formatNumber(metrics.workloadShare)} | ${formatNumber(metrics.percentileRank)} | ${formatNumber(metrics.relativeToMean)} | ${formatNumber(metrics.giniWorkload)} | ${formatNumber(metrics.avgReviewTimeHours)} | ${Math.round(metrics.avgReviewSizeLines)} | ${formatNumber(metrics.linesPerHour)} | ${formatDate(metrics.lastReviewDate)} | ${formatDate(metrics.lastReviewInPRFiles)} |\n`;
    });

    comment += `\n**Legend:**
- **Knows**: Files in this PR the reviewer has worked on before  
- **Learns**: Files in this PR new to the reviewer (${filePaths.length} total - Knows)  
- **WorkloadShare%**: Percentage of total reviews in the last quarter  
- **PercentileRank%**: Position in team workload distribution  
- **Relative To Mean%**: Deviation from the team average workload  
- **ΔGiniWorkload(Absolute)**: Gini coefficient of workload inequality  
- **AvgTime(h)**: Average review time in hours  
- **AvgSize(line)**: Average diff size in lines  
- **line/hour**: Lines reviewed per hour  
- **LastReview**: Date of last review activity  
- **LastReviewOnPRFile**: Date of last review on any file in this PR  
`;

    // Additional metrics section
    comment += `<details>
<summary>📊 Additional Metrics & Activity Timeline</summary>

### Activity Timeline
| Developer | LastCommit | LastModPR | L-Commits | L-Reviews | G-Commits | G-Reviews | A-Months |
|-----------|------------|-----------|-----------|-----------|-----------|-----------|----------|
`;

    reviewerMetrics.forEach(metrics => {
      comment += `| @${metrics.login} | ${formatDate(metrics.lastCommitDate)} | ${formatDate(metrics.lastModificationInPRFiles)} | ${metrics.lCommits} | ${metrics.lReviews} | ${metrics.gCommits} | ${metrics.gReviews} | ${metrics.aMonths} |\n`;
    });

    comment += `\n**Timeline Legend:**
- **LastCommit**: Date of last commit (any file, all time)
- **LastModPR**: Date of last modification in any of this PR's files (all time)
- **L-Commits**: Local commits on known files (all time)
- **L-Reviews**: Local reviews on known files (all time)
- **G-Commits**: Global commits in the last year
- **G-Reviews**: Global reviews in the last year
- **A-Months**: Active months in the last year

// ### File Knowledge Breakdown
// `;
    
//     reviewerMetrics.forEach(metrics => {
//       if (metrics.knownFilesList.length > 0) {
//         comment += `**@${metrics.login}** knows these files:\n`;
//         metrics.knownFilesList.forEach(file => {
//           comment += `- \`${file}\`\n`;
//         });
//         comment += '\n';
//       }
//     });
    
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
