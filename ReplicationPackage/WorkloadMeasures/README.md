Please review the overall replication package [ReadMe File](../README.md) for complete simulation details. The following steps get reviewers' open reviews across projects. Then you should use this data to calculate the final Gini-Workload of reviewers.

### Get the Open Reviews from the database

After running the simulations, you should use the number of open reviews for each reviewer to calculate the Gini-Workload. For each recommender, you should replace the ``` <rec-sim-id> ``` with its simulation IDs in each project. The following query generates the table for the number of open reviews for each reviewer.

```SQL
WITH OpenReview AS (
    SELECT
        Project,
        ROW_NUMBER() OVER (PARTITION BY Project ORDER BY DATEPART(YEAR, DateTime), DATEPART(QUARTER, DateTime), NormalizedName) AS PullIndex,
        COUNT(DISTINCT pullRequestId) AS pulls
    FROM (
        SELECT 'CoreFX' AS Project, NormalizedName, pullRequestId, DateTime
        FROM [CoreFX].[dbo].[DeveloperReviews]
        WHERE SimulationId = <rec-sim-id>
        
        UNION ALL
        
        SELECT 'CoreCLR' AS Project, NormalizedName, pullRequestId, DateTime
        FROM [CoreCLR].[dbo].[DeveloperReviews]
        WHERE SimulationId = <rec-sim-id>
        
        UNION ALL
        
        SELECT 'Roslyn' AS Project, NormalizedName, pullRequestId, DateTime
        FROM [Roslyn].[dbo].[DeveloperReviews]
        WHERE SimulationId = <rec-sim-id>
        
        UNION ALL
        
        SELECT 'Rust' AS Project, NormalizedName, pullRequestId, DateTime
        FROM [Rust].[dbo].[DeveloperReviews]
        WHERE SimulationId = <rec-sim-id>
        
        UNION ALL
        
        SELECT 'Kubernetes' AS Project, NormalizedName, pullRequestId, DateTime
        FROM [kubernetes].[dbo].[DeveloperReviews]
        WHERE SimulationId = <rec-sim-id>
    ) AS AllProjects
    GROUP BY Project, DATEPART(YEAR, DateTime), DATEPART(QUARTER, DateTime), NormalizedName
)
SELECT 
    MAX(CASE WHEN Project = 'CoreFX' THEN pulls END) AS CoreFX,
    MAX(CASE WHEN Project = 'CoreCLR' THEN pulls END) AS CoreCLR,
    MAX(CASE WHEN Project = 'Roslyn' THEN pulls END) AS Roslyn,
    MAX(CASE WHEN Project = 'Rust' THEN pulls END) AS Rust,
    MAX(CASE WHEN Project = 'Kubernetes' THEN pulls END) AS Kubernetes
FROM OpenReview
GROUP BY PullIndex
ORDER BY PullIndex;

```

Note: This query takes about 8~10 minutes to run for each recommender. The data from our simulations is available in [ResultsCSV](../ResultsCSV/WorkloadAUC/Simulated/) Directory.

### How to calculate the Gini-Workload for each recommender.

To calculate the Gini-Workload outcome for each recommender, you should run the [WorkloadAUC.r](WorkloadAUC.R) script. 
