// .github/scripts/debug-token.js
const core = require('@actions/core');
const github = require('@actions/github');

async function debugTokenAccess() {
  console.log('🔍 Debugging GitHub token access...');
  
  // Check all possible ways to get the token
  const tokenSources = {
    'process.env.GITHUB_TOKEN': process.env.GITHUB_TOKEN,
    'process.env.github_token': process.env.github_token,
    'core.getInput("github-token")': core.getInput('github-token'),
    'core.getInput("token")': core.getInput('token'),
    'core.getInput("GITHUB_TOKEN")': core.getInput('GITHUB_TOKEN'),
  };
  
  console.log('\n📊 Token sources check:');
  for (const [source, value] of Object.entries(tokenSources)) {
    if (value) {
      console.log(`✅ ${source}: Available (length: ${value.length}, starts with: ${value.substring(0, 4)}...)`);
    } else {
      console.log(`❌ ${source}: Not available (value: ${JSON.stringify(value)})`);
    }
  }
  
  // Check environment variables
  console.log('\n🌍 All environment variables that might contain tokens:');
  Object.keys(process.env)
    .filter(key => key.toLowerCase().includes('token') || key.toLowerCase().includes('github'))
    .forEach(key => {
      const value = process.env[key];
      if (value) {
        console.log(`${key}: ${value.substring(0, 4)}... (length: ${value.length})`);
      } else {
        console.log(`${key}: ${JSON.stringify(value)}`);
      }
    });
  
  // Try to find any token
  let token = process.env.GITHUB_TOKEN || 
              process.env.github_token || 
              core.getInput('github-token') ||
              core.getInput('token') ||
              core.getInput('GITHUB_TOKEN');
  
  if (!token) {
    console.log('\n❌ No token found through any method');
    return;
  }
  
  console.log(`\n✅ Token found: ${token.substring(0, 4)}... (length: ${token.length})`);
  
  // Test the token with GitHub API
  try {
    console.log('\n🧪 Testing token with GitHub API...');
    const octokit = github.getOctokit(token);
    
    // Try a simple API call that should work with basic permissions
    try {
      const { data: user } = await octokit.rest.users.getAuthenticated();
      console.log(`✅ Token works! Authenticated as: ${user.login}`);
    } catch (userError) {
      console.log(`⚠️ User authentication failed (this is often normal): ${userError.message}`);
      console.log(`🔄 Trying repository-level test instead...`);
      
      // Try a repository-level call instead
      const context = github.context;
      try {
        const { data: repo } = await octokit.rest.repos.get({
          owner: context.repo.owner,
          repo: context.repo.repo
        });
        console.log(`✅ Repository access works! Repo: ${repo.full_name}`);
      } catch (repoError) {
        console.log(`❌ Repository access failed: ${repoError.message}`);
        throw repoError;
      }
    }
    
    // Check token permissions
    const context = github.context;
    console.log(`\n📋 GitHub context info:`);
    console.log(`- Repository: ${context.repo.owner}/${context.repo.repo}`);
    console.log(`- Event: ${context.eventName}`);
    console.log(`- Actor: ${context.actor}`);
    
    if (context.payload.pull_request) {
      console.log(`- PR number: ${context.payload.pull_request.number}`);
      console.log(`- PR author: ${context.payload.pull_request.user.login}`);
      
      // Try to access PR files
      try {
        const { data: files } = await octokit.rest.pulls.listFiles({
          owner: context.repo.owner,
          repo: context.repo.repo,
          pull_number: context.payload.pull_request.number
        });
        console.log(`✅ Can access PR files: ${files.length} files found`);
        
        // Try to post a test comment (we'll delete it)
        try {
          const { data: comment } = await octokit.rest.issues.createComment({
            owner: context.repo.owner,
            repo: context.repo.repo,
            issue_number: context.payload.pull_request.number,
            body: '🧪 Test comment from token debug script - will be deleted'
          });
          console.log(`✅ Can post comments: comment ID ${comment.id}`);
          
          // Delete the test comment
          await octokit.rest.issues.deleteComment({
            owner: context.repo.owner,
            repo: context.repo.repo,
            comment_id: comment.id
          });
          console.log(`✅ Test comment deleted successfully`);
        } catch (error) {
          console.log(`❌ Cannot post comments: ${error.message}`);
        }
        
      } catch (error) {
        console.log(`❌ Cannot access PR files: ${error.message}`);
      }
    } else {
      console.log(`❌ No pull request in context - cannot test PR-specific operations`);
    }
    
  } catch (error) {
    console.log(`❌ Token test failed: ${error.message}`);
    console.log(`Full error:`, error);
  }
}

// Check GitHub Actions context
function debugContext() {
  console.log('\n🎯 GitHub Actions Context:');
  console.log('- GITHUB_ACTIONS:', process.env.GITHUB_ACTIONS);
  console.log('- GITHUB_WORKFLOW:', process.env.GITHUB_WORKFLOW);
  console.log('- GITHUB_RUN_ID:', process.env.GITHUB_RUN_ID);
  console.log('- GITHUB_ACTOR:', process.env.GITHUB_ACTOR);
  console.log('- GITHUB_REPOSITORY:', process.env.GITHUB_REPOSITORY);
  console.log('- GITHUB_EVENT_NAME:', process.env.GITHUB_EVENT_NAME);
  console.log('- GITHUB_REF:', process.env.GITHUB_REF);
}

async function main() {
  debugContext();
  await debugTokenAccess();
}

if (require.main === module) {
  main().catch(error => {
    console.error('Debug script failed:', error);
    process.exit(1);
  });
}

module.exports = { debugTokenAccess };
