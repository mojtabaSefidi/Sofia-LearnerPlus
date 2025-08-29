using Microsoft.Extensions.Logging;
using RelationalGit.Simulation;
using System;

namespace RelationalGit.Recommendation
{
    public class RandomRecRecommendationStrategy : ScoreBasedRecommendationStrategy
    {
        private Random _rnd = new Random();

        public RandomRecRecommendationStrategy(string knowledgeSaveReviewerReplacementType, ILogger logger, string pullRequestReviewerSelectionStrategy, bool? addOnlyToUnsafePullrequests, string recommenderOption, bool changePast, string simulationType)
            : base(knowledgeSaveReviewerReplacementType, logger, pullRequestReviewerSelectionStrategy, addOnlyToUnsafePullrequests, recommenderOption, changePast, simulationType)
        {
        }

        internal override double ComputeReviewerScore(PullRequestContext pullRequestContext, DeveloperKnowledge reviewer)
        {
            return _rnd.NextDouble();
        }
    }
}
