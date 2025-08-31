// .github/scripts/assign-reviewer.js
const core = require('@actions/core');
const github = require('@actions/github');

async function assignReviewer() {
  try {
    const context = github.context;
    const token = process.env.GITHUB_TOKEN;
    const octokit = github.getOctokit(token);
    
    // Get inputs
    const reviewer = core.getInput('reviewer');
    const prNumber = parseInt(core.getInput('pr_number'));
    
    if (!reviewer || !prNumber) {
      throw new Error('Missing required inputs: reviewer and pr_number');
    }
    
    console.log(`Assigning reviewer ${reviewer} to PR #${prNumber}`);
    
    // Assign the reviewer
    await octokit.rest.pulls.requestReviewers({
      owner: context.repo.owner,
      repo: context.repo.repo,
      pull_number: prNumber,
      reviewers: [reviewer]
    });
    
    // Post confirmation comment
    await octokit.rest.issues.createComment({
      owner: context.repo.owner,
      repo: context.repo.repo,
      issue_number: prNumber,
      body: `🤖 **Reviewer Assigned**: @${reviewer} has been requested to review this PR.`
    });
    
    console.log(`✅ Successfully assigned ${reviewer} to PR #${prNumber}`);
    
  } catch (error) {
    console.error('❌ Error assigning reviewer:', error);
    
    // Try to post error comment if we have the PR number
    const prNumber = parseInt(core.getInput('pr_number'));
    if (prNumber) {
      try {
        const token = process.env.GITHUB_TOKEN;
        const octokit = github.getOctokit(token);
        const context = github.context;
        
        await octokit.rest.issues.createComment({
          owner: context.repo.owner,
          repo: context.repo.repo,
          issue_number: prNumber,
          body: `⚠️ **Assignment Failed**: Could not assign @${core.getInput('reviewer')} as a reviewer. Error: ${error.message}`
        });
      } catch (commentError) {
        console.error('Failed to post error comment:', commentError);
      }
    }
    
    core.setFailed(error.message);
  }
}

// Run if called directly
if (require.main === module) {
  assignReviewer();
}

module.exports = { assignReviewer };
