using Microsoft.Extensions.Logging;
using RelationalGit.Simulation;
using System;

namespace RelationalGit.Recommendation
{
    public class NoReviewerRecommendationStrategy : RecommendationStrategy
    {
        public NoReviewerRecommendationStrategy(string knowledgeSaveReviewerReplacementType, ILogger logger, bool changePast, string simulationType)
            : base(knowledgeSaveReviewerReplacementType, logger, changePast, simulationType)
        {
        }

        protected override PullRequestRecommendationResult RecommendReviewers(PullRequestContext pullRequestContext)
        {
            return new PullRequestRecommendationResult(Array.Empty<DeveloperKnowledge>(), Array.Empty<DeveloperKnowledge>(),null,null);
        }
    }
}
