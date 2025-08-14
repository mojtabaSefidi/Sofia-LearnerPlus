// .github/scripts/suggest-reviewers.js
const { createClient } = require('@supabase/supabase-js');
const core = require('@actions/core');
const github = require('@actions/github');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_ANON_KEY
);

async function suggestReviewers() {
  console.log('🔍 Analyzing PR for reviewer suggestions...');
  
  try {
    const context = github.context;
    const pr = context.payload.pull_request;
    
    if (!pr) {
      throw new Error('No pull request found in context');
    }
    
    // Get PR files
    const token = core.getInput('github-token');
    const octokit = github.getOctokit(token);
    
    const { data: prFiles } = await octokit.rest.pulls.listFiles({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: pr.number
    });
    
    console.log(`📁 Found ${prFiles.length} files in PR`);
    
    // Calculate reviewer scores
    const reviewerScores = await calculateReviewerScores(prFiles, pr.user.login);
    
    // Generate comment
    const comment = generateReviewerComment(reviewerScores, prFiles);
    
    // Post comment
    await octokit.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: pr.number,
      body: comment
    });
    
    console.log('✅ Reviewer suggestions posted successfully!');
    
  } catch (error) {
    console.error('❌ Error suggesting reviewers:', error);
    core.setFailed(error.message);
  }
}

async function calculateReviewerScores(prFiles, prAuthor) {
  console.log('📊 Calculating reviewer knowledge scores...');
  
  const filePaths = prFiles.map(f => f.filename);
  const totalFiles = filePaths.length;
  
  // Get all contributors who have worked on these files
  const { data: contributions } = await supabase
    .from('contributions')
    .select(`
      contributor_id,
      contributors!inner(github_login, canonical_name),
      file_id,
      files!inner(current_path, canonical_path)
    `)
    .in('files.current_path', filePaths)
    .neq('contributors.github_login', prAuthor); // Exclude PR author
  
  if (!contributions || contributions.length === 0) {
    console.log('📋 No historical contributions found for these files');
    return [];
  }
  
  // Group contributions by contributor
  const contributorKnowledge = new Map();
  
  contributions.forEach(contribution => {
    const login = contribution.contributors.github_login;
    const filePath = contribution.files.current_path;
    
    if (!contributorKnowledge.has(login)) {
      contributorKnowledge.set(login, {
        login,
        canonical_name: contribution.contributors.canonical_name,
        knownFiles: new Set(),
        contributions: 0
      });
    }
    
    const contributor = contributorKnowledge.get(login);
    contributor.knownFiles.add(filePath);
    contributor.contributions++;
  });
  
  // Calculate scores
  const scores = Array.from(contributorKnowledge.values()).map(contributor => {
    const knownFileCount = contributor.knownFiles.size;
    const knowledgeScore = knownFileCount / totalFiles;
    
    return {
      github_login: contributor.login,
      canonical_name: contributor.canonical_name,
      known_files: knownFileCount,
      total_files: totalFiles,
      knowledge_score: knowledgeScore,
      total_contributions: contributor.contributions,
      known_file_list: Array.from(contributor.knownFiles)
    };
  });
  
  // Sort by knowledge score (descending) and then by total contributions
  scores.sort((a, b) => {
    if (b.knowledge_score !== a.knowledge_score) {
      return b.knowledge_score - a.knowledge_score;
    }
    return b.total_contributions - a.total_contributions;
  });
  
  console.log(`📈 Calculated scores for ${scores.length} potential reviewers`);
  
  return scores.slice(0, 5); // Top 5 suggestions
}

function generateReviewerComment(reviewerScores, prFiles) {
  if (reviewerScores.length === 0) {
    return `## 🔍 Reviewer Suggestions

No historical data available for the files in this PR. Consider assigning reviewers based on:
- Code ownership
- Team responsibilities  
- Subject matter expertise

**Files in this PR:**
${prFiles.map(f => `- \`${f.filename}\``).join('\n')}`;
  }
  
  const fileList = prFiles.map(f => `- \`${f.filename}\``).join('\n');
  
  let comment = `## 🔍 Reviewer Suggestions

Based on historical contributions to the files in this PR, here are the recommended reviewers:

| Reviewer | Knowledge Score | Known Files | Details |
|----------|----------------|-------------|---------|
`;
  
  reviewerScores.forEach((score, index) => {
    const percentage = (score.knowledge_score * 100).toFixed(1);
    const knownFilesText = score.known_files === score.total_files 
      ? `${score.known_files}/${score.total_files} (all files)` 
      : `${score.known_files}/${score.total_files}`;
    
    comment += `| @${score.github_login} | ${percentage}% | ${knownFilesText} | ${score.total_contributions} contributions |\n`;
  });
  
  comment += `\n**Scoring Method:** \`NumFilesDevKnows / TotalNumFiles\`

<details>
<summary>📁 Files in this PR</summary>

${fileList}
</details>

<details>
<summary>📊 Detailed Knowledge Breakdown</summary>

`;
  
  reviewerScores.forEach(score => {
    comment += `**@${score.github_login}** knows these files:\n`;
    score.known_file_list.forEach(file => {
      comment += `- \`${file}\`\n`;
    });
    comment += '\n';
  });
  
  comment += `</details>

---
*This suggestion is based on historical commit and review data. Consider team availability and current workload when assigning reviewers.*`;
  
  return comment;
}

// Run if called directly
if (require.main === module) {
  suggestReviewers();
}

module.exports = { suggestReviewers };
