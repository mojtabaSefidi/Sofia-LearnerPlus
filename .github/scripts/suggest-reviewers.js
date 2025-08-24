// .github/scripts/suggest-reviewers.js
const { achrev_suggestion } = require('./recommenders/AcHRev');
const { turnoverRec_suggestion } = require('./recommenders/TurnoverRec');

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

const timeAgo = (dateInput) => {
  if (!dateInput) return 'No Activity';

  // Handle both Date objects and date strings
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (isNaN(d.getTime())) return 'No Activity';

  const now = new Date();
  let diffMs = now - d; // difference in milliseconds

  if (diffMs < 0) return 'In the future'; // optional: handle future dates

  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  diffMs -= diffDays * (1000 * 60 * 60 * 24);

  const diffHours = Math.round(diffMs / (1000 * 60 * 60)); // round hours

  let result = '';
  if (diffDays > 0) result += `${diffDays} day${diffDays > 1 ? 's' : ''} `;
  result += `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;

  return result;
};

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

    // Get ACHRev Suggestion
    console.log('🎯 Running ACHRev to compute CxFactor scores...');

    let achrevResults = [];
    try {
      achrevResults = await achrev_suggestion(
        pr.number,
        pr.user.login,
        prFiles,
        200,                  // topN (tune as needed)
        pr.created_at,        // prCreatedAt -> ensure prior-history only
        { includeAuthor: true, perFileForAuthorOnly: true }
      );
    } catch (err) {
      // Fail gracefully: log and continue with empty ACHRev results
      console.error('⚠️ achrev_suggestion failed or errored:', err);
      achrevResults = [];
    }

    // Build quick lookup maps:
    // per-file map keyed by "<login>|<file>" -> per-file object (contains normalizedFileCx and normalizedFileCxByPR)
    const achrevPerFileMap = new Map();
    // aggregated map per login -> { cxFactorScore, fileCount, perFile: [...] }
    const achrevByLoginMap = new Map();

    if (Array.isArray(achrevResults)) {
      achrevResults.forEach(r => {
        achrevByLoginMap.set(r.login, {cxFactorScore: r.cxFactorScore, fileCount: r.fileCount, perFile: r.perFile });
        if (Array.isArray(r.perFile)) {
          r.perFile.forEach(p => {
            achrevPerFileMap.set(`${r.login}|${p.file}`, p);
          });
        }
      });
    }

    // Get TurnoverRec Suggestion
    console.log('🎯 Computing TurnoverRec scores...');

    let turnoverRecResults = [];
    try {
      turnoverRecResults = await turnoverRec_suggestion(
        pr.user.login,        // prAuthor
        prFiles,              // prFiles
        pr.created_at,        // prCreatedAt
        200,                  // topN
      );
    } catch (err) {
      console.error('⚠️ turnoverRec_suggestion failed or errored:', err);
      turnoverRecResults = [];
    }
    
    // Build TurnoverRec lookup map
    const turnoverRecByLoginMap = new Map();
    if (Array.isArray(turnoverRecResults)) {
      turnoverRecResults.forEach(r => {
        turnoverRecByLoginMap.set(r.login, {
          turnoverRec: r.turnoverRec || 0,
          learnRec: r.learnRec || 0,
          retentionRec: r.retentionRec || 0,
          knowledge: r.knowledge || 0
        });
      });
    }

    // Analyze files in detail — pass achrevPerFileMap so analyzeFiles can set per-file author CxFactor
    const fileAnalysis = await analyzeFiles(prFiles, pr.user.login, pr.created_at, achrevPerFileMap);
    
    // Calculate detailed reviewer metrics — pass achrevByLoginMap so we don't re-run achrev inside it
    const reviewerMetrics = await calculateDetailedReviewerMetrics(prFiles, pr.user.login, achrevByLoginMap, turnoverRecByLoginMap);
    
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

async function analyzeFiles(prFiles, prAuthor, prCreatedAt, achrevPerFileMap) {
  console.log('📊 Analyzing PR files & Author Knowledge...');

  const fileAnalysis = [];

  for (const prFile of prFiles) {
    const filePath = prFile.filename;
    const changeType = getChangeType(prFile);

    // Use GitHub API fields if available: total changed lines
    const changeSize = typeof prFile.changes === 'number'
      ? prFile.changes
      : ( (typeof prFile.additions === 'number' && typeof prFile.deletions === 'number')
          ? prFile.additions + prFile.deletions
          : null );

    // 1) Get contributions on this file by OTHER developers (prior to PR creation date)
    const { data: fileContributions } = await supabase
      .from('contributions')
      .select(`
        contributor_id,
        activity_type,
        contribution_date,
        contributors!inner(github_login, canonical_name),
        files!inner(current_path, canonical_path)
      `)
      .eq('files.current_path', filePath)
      .lt('contribution_date', prCreatedAt)
      .neq('contributors.github_login', prAuthor);

    // Count unique other developers who have prior commits/reviews on this file
    const uniqueDevs = new Set();
    if (fileContributions && Array.isArray(fileContributions)) {
      fileContributions.forEach(contrib => {
        const login = contrib.contributors?.github_login;
        if (login && typeof login === 'string' && login.trim()) {
          uniqueDevs.add(login);
        }
      });
    }
    const numKnowledgable = uniqueDevs.size;

    // 2) Get contributions on this file BY THE AUTHOR (prior to PR creation date)
    const { data: authorContributions } = await supabase
      .from('contributions')
      .select(`
        activity_type,
        contribution_date,
        lines_modified,
        contributors!inner(github_login),
        files!inner(current_path, canonical_path)
      `)
      .eq('files.current_path', filePath)
      .lt('contribution_date', prCreatedAt)
      .eq('contributors.github_login', prAuthor);

    // Aggregate author stats for this file
    let authorNumCommits = 0;
    let authorNumReviews = 0;
    let authorLastCommitDate = null;
    let authorLastReviewDate = null;

    if (authorContributions && Array.isArray(authorContributions)) {
      authorContributions.forEach(ac => {
        if (!ac || !ac.activity_type || !ac.contribution_date) return;
        
        const dt = new Date(ac.contribution_date);
        if (isNaN(dt.getTime())) return; // Skip invalid dates
        
        if (ac.activity_type === 'commit') {
          authorNumCommits++;
          if (!authorLastCommitDate || dt > authorLastCommitDate) {
            authorLastCommitDate = dt;
          }
        } else if (ac.activity_type === 'review') {
          authorNumReviews++;
          if (!authorLastReviewDate || dt > authorLastReviewDate) {
            authorLastReviewDate = dt;
          }
        }
      });
    }

    let authorCxFactor = 0; // Default to 0 instead of null
    try {
      if (achrevPerFileMap && achrevPerFileMap instanceof Map) {
        const per = achrevPerFileMap.get(`${prAuthor}|${filePath}`);
        if (per) {
          // prefer per.normalizedFileCx (0..1); fallback to normalizedFileCxByPR if available
          if (typeof per.normalizedFileCx === 'number') {
            authorCxFactor = per.normalizedFileCx;
          } else if (typeof per.normalizedFileCxByPR === 'number') {
            authorCxFactor = per.normalizedFileCxByPR;
          } else if (typeof per.fileScore === 'number') {
            // last-resort: convert raw 0..5 to 0..1
            authorCxFactor = per.fileScore / 5;
          }
          // If none of the above conditions are met, authorCxFactor remains 0
        }
        // If per is null/undefined, authorCxFactor remains 0
      }
    } catch (err) {
      // defensive: do not throw here; keep 0 and continue
      console.warn(`⚠️ achrevPerFileMap lookup failed for ${prAuthor}|${filePath}:`, err);
      authorCxFactor = 0;
    }

    fileAnalysis.push({
      filename: filePath,
      changeType,
      numKnowledgable,           
      changeSize,                
      authorNumCommits,          
      authorLastCommitDate,      
      authorNumReviews,          
      authorLastReviewDate,      
      authorCxFactor,            
      // topContributor,
      isNew: changeType === 'create'
    });
  }

  return fileAnalysis;
}


async function calculateDetailedReviewerMetrics(prFiles, prAuthor, achrevByLoginMap, turnoverRecByLoginMap) {
  console.log('📈 Calculating detailed reviewer metrics...');
  
  const filePaths = prFiles.map(f => f.filename);
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  
  // Get all potential reviewers (all contributors from the last year, excluding PR author)
  const { data: allContributors } = await supabase
    .from('contributors')
    .select('github_login, canonical_name')
    .neq('github_login', prAuthor);
  
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
  
  // Initialize metrics for ALL contributors
  const contributorMetrics = new Map();
  
  if (allContributors) {
    allContributors.forEach(contributor => {
      contributorMetrics.set(contributor.github_login, {
        login: contributor.github_login,
        canonical_name: contributor.canonical_name,
        knownFiles: new Set(),
        localCommits: 0,
        localReviews: 0,
        globalCommits: 0,
        globalReviews: 0,
        activeMonths: new Set()
      });
    });
  }
  
  // Process PR file knowledge
  if (prFileContributions) {
    prFileContributions.forEach(contrib => {
      const login = contrib.contributors.github_login;
      const filePath = contrib.files.current_path;
      
      // Only process if we have this contributor in our map
      if (contributorMetrics.has(login)) {
        const metrics = contributorMetrics.get(login);
        metrics.knownFiles.add(filePath);
        
        if (contrib.activity_type === 'commit') {
          metrics.localCommits++;
        } else if (contrib.activity_type === 'review') {
          metrics.localReviews++;
        }
      }
    });
  }
  
  // Process global activity
  if (globalContributions) {
    globalContributions.forEach(contrib => {
      const login = contrib.contributors.github_login;
      const date = new Date(contrib.contribution_date);
      const monthKey = `${date.getFullYear()}-${date.getMonth()}`;
      
      // Only process if we have this contributor in our map
      if (contributorMetrics.has(login)) {
        const metrics = contributorMetrics.get(login);
        metrics.activeMonths.add(monthKey);
        
        if (contrib.activity_type === 'commit') {
          metrics.globalCommits++;
        } else if (contrib.activity_type === 'review') {
          metrics.globalReviews++;
        }
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

  const expertScoreMap = new Map();
  if (achrevByLoginMap && achrevByLoginMap instanceof Map) {
    for (const [login, info] of achrevByLoginMap) {
      const cxFactorScore = typeof info.cxFactorScore === 'number' ? info.cxFactorScore : 0;
      const fileCount = typeof info.fileCount === 'number' ? info.fileCount : (Array.isArray(info.perFile) ? info.perFile.length : 0);
      expertScoreMap.set(login, { cxFactorScore, fileCount });
    }
  }

  // TurnoverRec scores lookup
  const turnoverRecScoreMap = new Map();
  if (turnoverRecByLoginMap && turnoverRecByLoginMap instanceof Map) {
    for (const [login, info] of turnoverRecByLoginMap) {
      turnoverRecScoreMap.set(login, {
        turnoverRec: info.turnoverRec || 0,
        learnRec: info.learnRec || 0,
        retentionRec: info.retentionRec || 0,
        knowledge: info.knowledge || 0
      });
    }
  }
  
  // Combine all metrics (including CxFactor)
  const enhancedMetrics = finalMetrics.map(metrics => {
    const workload = workloadData.get(metrics.login) || {};
    const performance = performanceData.get(metrics.login) || {};
    const activity = activityData.get(metrics.login) || {};
    const expertScore = expertScoreMap.get(metrics.login) || { cxFactorScore: 0, fileCount: 0 };
    const turnoverRecScore = turnoverRecScoreMap.get(metrics.login) || { turnoverRec: 0, learnRec: 0, retentionRec: 0, knowledge: 0 };
  
    
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
      lastModificationInPRFiles: activity.lastModificationInPRFiles,
      // CxFactor score
      cxFactorScore: expertScore.cxFactorScore,
      expertFileCount: expertScore.fileCount,
      // TurnoverRec scores
      turnoverRecScore: turnoverRecScore.turnoverRec,
      learnRecScore: turnoverRecScore.learnRec,
      retentionRecScore: turnoverRecScore.retentionRec,
      knowledgeScore: turnoverRecScore.knowledge
    };
  });
  
  // Sort by knowledge (knows) first, then by total local activity (original sorting)
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

### Author Knowledge: ${prAuthor}

| ChangedFile | Change Type | NumKnowledgable | Change Size | NumCommit | Last Commit Date | NumReview | Last Review Date | Author CxFactor |
|-------------|-------------|-----------------|-------------|-----------|------------------|-----------|------------------|-----------------|
`;

  // Categorize files
  const abandonedFiles = [];
  const hoardedFiles = [];

  fileAnalysis.forEach(file => {

    const changeSizeText = (typeof file.changeSize === 'number') ? file.changeSize : 'N/A';
    const cxText = (typeof file.authorCxFactor === 'number') ? file.authorCxFactor.toFixed(3) : '0.000';

    comment += `| \`${file.filename}\` | ${file.changeType} | ${file.numKnowledgable} | ${changeSizeText} | ${file.authorNumCommits} | ${timeAgo(file.authorLastCommitDate)} | ${file.authorNumReviews} | ${timeAgo(file.authorLastReviewDate)} | ${cxText} |\n`;

  });

  comment += `
  
  **Column descriptions:**
  - **NumKnowledgable**: Number of developers (excluding PR author) who have prior commits or reviews on this file.
  - **Change Size**: Total lines changed in this PR for the file (additions + deletions).
  - **NumCommit**: Number of prior commits made by the PR author on this file (excluding the current PR commits).
  - **Last Commit Date**: Date of the author's most recent prior commit on this file.
  - **NumReview**: Number of times the PR author acted as a reviewer on this file prior to this PR.
  - **Last Review Date**: Date of the author's most recent prior review activity on this file.
  - **Author CxFactor**: Author's levels of expertise on this file.
  `;
  
  // Add enhanced reviewer suggestions with LEARNS column
  if (reviewerMetrics.length === 0) {
    comment += `\n### 👥 Reviewer Records

No developers found with prior experience on these files. Consider assigning reviewers based on:
- Team responsibilities
- Code architecture knowledge
- Subject matter expertise`;
  } else {
    comment += `\n### 👥 Reviewer Records

| Developer | Knows | Learns | LastCommit | LastModificationOnPR | PR-Commits | Total-Commits | PR-Reviews | Total-Reviews | A-Months | Workload Share | Percentile Rank | Relative To Mean | ΔGiniWorkload(Absolute) | AvgTime(h) | AvgSize(line) | line/hour |
|-----------|-------|--------|------------|----------------------|------------|---------------|------------|---------------|----------|----------------|-----------------|------------------|-------------------------|------------|---------------|-----------|
`;

    const formatNumber = (num, decimals = 1) =>
      typeof num === 'number' && !isNaN(num) ? num.toFixed(decimals) : '0.0';

    reviewerMetrics.forEach(metrics => {
      comment += `| ${metrics.login} | ${metrics.knows} | ${metrics.learns} | ${timeAgo(metrics.lastCommitDate)} | ${timeAgo(metrics.lastModificationInPRFiles)} | ${metrics.lCommits} | ${metrics.gCommits} | ${metrics.lReviews} | ${metrics.gReviews} | ${metrics.aMonths} | ${formatNumber(metrics.workloadShare)} | ${formatNumber(metrics.percentileRank)} | ${formatNumber(metrics.relativeToMean)} | ${formatNumber(metrics.giniWorkload)} | ${formatNumber(metrics.avgReviewTimeHours)} | ${Math.round(metrics.avgReviewSizeLines)} | ${formatNumber(metrics.linesPerHour)} |\n`;
    });

    comment += `\n**Columns Description:**
- **Knows**: Files in this PR the reviewer has worked on before  
- **Learns**: Files in this PR new to the reviewer (${filePaths.length} total - Knows)  
- **LastCommit**: Date of last commit (any file, all time)
- **LastModificationOnPR**: Date of last modification in any of this PR's files (all time)
- **PR-Commits**: Number of commits on files in this PR
- **Total-Commits**: Total commits in the last year
- **PR-Reviews**: Number of reviews on files in this PR
- **Total-Reviews**: Total reviews in the last year
- **A-Months**: Active months in the last year
- **Workload Share**: Percentage of total reviews in the last quarter  
- **Percentile Rank**: Position in team workload distribution  
- **Relative To Mean**: Deviation from the team average workload  
- **ΔGiniWorkload(Absolute)**: Gini coefficient of workload inequality  
- **AvgTime(h)**: Average review time in hours  
- **AvgSize(line)**: Average diff size in lines  
- **line/hour**: Lines reviewed per hour  
`;

    const cxFactorScores = reviewerMetrics
      .sort((a, b) => b.cxFactorScore - a.cxFactorScore);

    if (cxFactorScores.length > 0) {
      comment += `\n### 🎯 CxFactor Expertise Scores

| Developer | CxFactor Score | Knowledge Distribution Score |
|-----------|----------------|------------------------------|
`;

      cxFactorScores.forEach(metrics => {
        comment += `| ${metrics.login} | ${(metrics.cxFactorScore || 0).toFixed(3)} | ${(metrics.turnoverRecScore || 0).toFixed(3)} |\n`;
      });

  comment += `\n**CxFactor Score**: ACHRev expertise score (0-1) based on review history, commit history, work patterns, and recency of contributions on PR files.
**Knowledge Distribution Score**: TurnoverRec score combining learning potential and retention likelihood.
`;
}
    
// ### File Knowledge Breakdown
//     reviewerMetrics.forEach(metrics => {
//       if (metrics.knownFilesList.length > 0) {
//         comment += `**${metrics.login}** knows these files:\n`;
//         metrics.knownFilesList.forEach(file => {
//           comment += `- \`${file}\`\n`;
//         });
//         comment += '\n';
//       }
//     });
    
  }
  
  comment += `\n---
*Suggestions:`;
  
  return comment;
}

// Run if called directly
if (require.main === module) {
  suggestReviewers();
}

module.exports = { suggestReviewers };
