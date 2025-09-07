# Replication Package

The overall steps are

1. Install the dependencies and ```SofiaWL-LearnerPlusPlus``` package
2. Get the Database
3. Run the Simulations for each research question
4. Dump the Simulation Data to CSV
5. Calculate the outcome measures: Expertise, Gini-Workload, Files at Risk to Turnover (FaR), and Rev++

## Install Dependencies

1) Make sure you [download and install](../README.md) the ```SofiaWL-LearnerPlusPlus``` package and its dependencies.

## Get the Database

1) Download and restore the database backup into your local MS SQL Server from [Figshare](https://figshare.com/s/b79fc69acad8e11be31a). There is a separate database for each studied project, and you should restore all of them. To restore a database from a ```.bacpac``` file, start by opening SQL Server Management Studio (SSMS) and connecting to your local SQL Server instance. In the Object Explorer, right-click on the Databases node and choose Import Data-tier Application. From there, click Browse to locate the ```.bacpac``` file on your local disk. Once you’ve selected the file, follow the wizard by clicking Next, reviewing the steps, and then clicking Finish to complete the import process. This will restore your database and make it available in your SQL Server instance. Note that the databases are approximately 2 GB in size.
2) Open and modify each configuration file in the [config directory](./config) to set up the connection with the database. You have to provide the server address along with the credentials to your local SQL server. The following snippet shows a sample of how the connection string should be set.

```json

"ConnectionStrings": {
  "RelationalGit": "Server=ip_db_server;User Id=user_name;Password=pass_word;Database=Roslyn_PlusPlus"
},

```

## Run the Simulations

1) Open [simulations.ps1](simulations.ps1) using an editor and update all the paths to the configuration files. For instance, each of the following variables contains the absolute path of the corresponding configuration file for the first research question.


```PowerShell
$corefx_conf_RQ1 = "\absolute\path\to\Replace_Risky\corefx_conf.json"
$coreclr_conf_RQ1 = "\absolute\path\to\Replace_Risky\coreclr_conf.json"
$roslyn_conf_RQ1 = "\absolute\path\to\Replace_Risky\roslyn_conf.json"
$rust_conf_RQ1 = "\absolute\path\to\Replace_Risky\rust_conf.json"
$kubernetes_conf_RQ1 = "\absolute\path\to\Replace_Risky\kubernetes_conf.json"
```

2) Open PowerShell and run the [simulations.ps1](simulations.ps1) script.

``` PowerShell
./simulations.ps1
```

This script simulates the performance of all the defined reviewer recommendation algorithms across all projects.

**Note**: if you get any error, make sure you have set the PowerShell [execution policy](https://superuser.com/questions/106360/how-to-enable-execution-of-powershell-scripts) to **Unrestricted** or **RemoteAssigned**.

## If you want to run the simulations separately for each RQ:

The following sections describe the commands needed to run simulations for each research question. For each simulation, a sample is provided that illustrates how to run the simulation using the tool. To run the simulations for each of the following research questions, you need to open the [source code](../src/RelationalGit.sln) as a project in your IDE like [Microsoft Visual Studio](https://visualstudio.microsoft.com/downloads/) and run the corresponding commands for each RQ (Debug → RelationalGit Debug Properties → Create a new profile → Project → insert the commands in ```Command line arguments``` box). 

### Seeded Random Replacement Initialization:
To run the simulations, you should first run the cHRev recommender to obtain the seeded indices for all the PRs in each project. By running the following command, the simulator will randomly replace one of the actual reviewers with the top candidate from cHRev. We will use these seeded indices in the following RQs to have a fair comparison between recommenders, as all of them replace the same reviewer.

```PowerShell
# cHRev Recommender
dotnet-rgit --cmd simulate-recommender --recommendation-strategy cHRev --simulation-type "Random" --conf-path <path_to_replace_all_config_file>
```

### Simulation RQ1, Baseline: On PRKRs, how well do existing recommenders perform?

By choosing the following selection strategy in the configuration file, the recommenders randomly (seeded) replace one of the reviewers of PRKRs with the top-recommended candidate. 

```
"PullRequestReviewerSelectionStrategy" : "0:nothing-nothing,-:farreplacerandom-1",
```

To replicate the performance of recommenders at the replacement level on PRKRs, you should run the following commands for each project to simulate the performance of recommenders on PRKRs. 

```PowerShell
# Reality
dotnet-rgit --cmd simulate-recommender --recommendation-strategy Reality --conf-path <path_to_rq1_config_file>
# AuthorshipRec Recommender
dotnet-rgit --cmd simulate-recommender --recommendation-strategy AuthorshipRec --simulation-type "SeededRandom" --conf-path <path_to_rq1_config_file>
# RevOwnRec Recommender
dotnet-rgit --cmd simulate-recommender --recommendation-strategy RevOwnRec --simulation-type "SeededRandom" --conf-path <path_to_rq1_config_file>
# cHRev Recommender
dotnet-rgit --cmd simulate-recommender --recommendation-strategy cHRev --simulation-type "SeededRandom" --conf-path <path_to_rq1_config_file>
# LearnRec Recommender
dotnet-rgit --cmd simulate-recommender --recommendation-strategy LearnRec --simulation-type "SeededRandom" --conf-path <path_to_rq1_config_file>
# RetentionRec Recommender
dotnet-rgit --cmd simulate-recommender --recommendation-strategy RetentionRec --simulation-type "SeededRandom" --conf-path <path_to_rq1_config_file>
# TurnoverRec Recommender
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path <path_to_rq1_config_file>
#WhoDo recommender
dotnet-rgit --cmd simulate-recommender --recommendation-strategy WhoDo --simulation-type "SeededRandom" --conf-path <path_to_rq1_config_file>
```

**Note**: In order to select between ```Random``` and ```SeededRandom```, adjust the ```--simulation-type``` command. If you set the value of ```--simulation-type``` to ```SeededRandom``` for recommenders, they will replace the same actual reviewers in all simulations.

---

### Simulation RQ2, Recommenders++: How does adding a reviewer on PRKRs impact the turnover risk and the amount of extra reviewing work?

Based on the following strategy in the configuration file, the recommenders will add the top candidate to the review process. 

```
"PullRequestReviewerSelectionStrategy" : "0:nothing-nothing,-:add-1",
```

To simulate the performance of recommenders, you should run the following commands one by one. Since the Recommenders++ strategy suggests an extra reviewer for all PRKRs and doesn't do any replacement, there is no need to use the ```--simulation-type``` command.

```PowerShell
# AuthorshipRec++ Recommender
dotnet-rgit --cmd simulate-recommender --recommendation-strategy AuthorshipRec --conf-path <path_to_config_file>
# RevOwnRec++ Recommender
dotnet-rgit --cmd simulate-recommender --recommendation-strategy RevOwnRec --conf-path <path_to_config_file>
# cHRev++ Recommender
dotnet-rgit --cmd simulate-recommender --recommendation-strategy cHRev --conf-path <path_to_config_file>
# LearnRec++ Recommender
dotnet-rgit --cmd simulate-recommender --recommendation-strategy LearnRec --conf-path <path_to_config_file>
# RetentionRec++ Recommender
dotnet-rgit --cmd simulate-recommender --recommendation-strategy RetentionRec --conf-path <path_to_config_file>
# TurnoverRec++ Recommender
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --conf-path <path_to_config_file>
# WhoDo++ recommender
dotnet-rgit --cmd simulate-recommender --recommendation-strategy WhoDo --conf-path <path_to_config_file>
```
---

### Simulation RQ3, FarAwareRec: What is the impact of adding a reviewer on abandoned files and replacing a reviewer on hoarded files for PRKRs?

FarAwareRec adds an extra reviewer for PRs with abandoned files and suggests a seeded random replacement for one of the reviewers in PRs containing hoarded files.

```
"PullRequestReviewerSelectionStrategy" : "0:nothing-nothing,-:addAndReplace-1",
```

To simulate the performance of the FarAwareRec recommender in each project, you should run the following commands. The ``--simulation-type `` command forces the recommender to replace the same reviewer in all the simulations.

```PowerShell
# FarAwareRec recommender for CoreFX
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path <path_to_CoreFX_config_file>
# FarAwareRec recommender for CoreCLR
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path <path_to_CoreCLR_config_file>
# FarAwareRec recommender for Roslyn
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path <path_to_Roslyn_config_file>
# FarAwareRec recommender for Rust
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path <path_to_Rust_config_file>
# FarAwareRec recommender for Kubernetes
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path <path_to_Kubernetes_config_file>
```
---

### Simulation RQ4, HoardedXRec: Can we balance the trade-off between &#916;FaR and Reviewer++ when we recommend an extra reviewer for PRKRs?

The HoardedXRec recommender adds a learner to the pull requests containing abandoned files or those with X or more hoarded files. It also recommends a new reviewer when a pull request includes at least one but fewer than X hoarded files. The X parameter should be adjusted based on the project. In our paper, we run simulations for X = {2,3,4}. For example, if you want to run the **Hoarded2Rec** recommender, you should select the selection strategy in the config files as follows.

```
"PullRequestReviewerSelectionStrategy" : "0:nothing-nothing,-:addHoarded_2-1",
```

To replicate the performance of these recommenders, you should run the following commands.

```PowerShell
# HoardedXRec recommender for CoreFX
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path <path_to_CoreFX_config_file>
# HoardedXRec recommender for CoreCLR
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path <path_to_CoreCLR_config_file>
#HoardedXRec recommender for Roslyn
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path <path_to_Roslyn_config_file>
# HoardedXRec recommender for Rust
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path <path_to_Rust_config_file>
# HoardedXRec recommender for Kubernetes
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path <path_to_Kubernetes_config_file>
```
---

## Dump the Simulation Data to CSV

Log in to the database of each project and run the following command to find the IDs of your simulation.

```SQL
-- Get the Id of the simulation 
SELECT  Id,
	KnowledgeShareStrategyType, 
	StartDateTime,
	EndDateTime
	PullRequestReviewerSelectionStrategy,
	SimulationType 
FROM LossSimulations
WHERE EndDateTime > StartDateTime
ORDER BY StartDateTime DESC
```

To get your simulation results, you should run the analyzer using the following command. Substitute the ```<rec_sim_id>``` variable with the Id of your desired recommender, and compare the recommender performance with the actual values, ```<reality_id>```. Note that you can add multiple simulation IDs and separate them using a space.
You should also substitute ```<path_to_result>``` and ```<path_to_config_file>``` variables with the path where you want to save the results and the config file of the corresponding RQ and project.

```PowerShell
dotnet-rgit --cmd analyze-simulations --analyze-result-path <path_to_result> --recommender-simulation <rec_sim_id> --reality-simulation <reality_id>  --conf-path <path_to_config_file>
```

### Results for the outcome measures:

After running the analyzer, the tool creates four CSV files: **Expertise.csv**, **FaR.csv**, **Core_Workload.csv**, and **ReviewerPlusPlus.csv**. The first column shows the project's periods (quarters) in the first four files. Each column corresponds to one of the simulations. Each cell in the first four files displays the percentage change between the actual and simulated outcomes for that period. The last two rows show the *median* and *average* of columns. The **ReviewerPlusPlus.csv** file shows the proportion of pull requests to which a recommender adds an extra reviewer in each period. The last rows of this file present the *Reviewer++* outcome during the whole lifetime of projects. Note that the **Core_Workload.csv** file includes the number of reviews for the top 10 reviewers in each period. This outcome measure is defined in [prior work](https://dl.acm.org/doi/10.1145/3377811.3380335) that was published in ICSE 2020. To calculate the Gini-Workload of reviewers, follow the instructions in [WorkloadAUC.r](WorkloadMeasures/README.md).

### Our Simulation IDs:

As some of the simulations can take hours to run, the following table includes the simulation IDs for our experiments. 

| **Recommender**     | **CoreFX** | **CoreCLR** | **Roslyn** | **Rust** | **Kubernetes** |
|:-------------------:|:---------:|:----------:|:--------:|:----:|:----------:|
| *Reality*          | 21139     | 20217      | 140      | 138  | 139        |
| **RQ1: Baseline**  |           |            |          |      |            |
| *AuthorshipRec*    | 21133     | 20211      | 134      | 132  | 133        |
| *RevOwnRec*        | 21134     | 20212      | 135      | 133  | 134        |
| *CHRev*            | 21132     | 20210      | 133      | 131  | 132        |
| *LearnRec*         | 21136     | 20214      | 137      | 135  | 136        |
| *RetentionRec*     | 21135     | 20213      | 136      | 134  | 135        |
| *TurnoverRec*      | 21137     | 20215      | 138      | 136  | 137        |
| *WhoDo*            | 21138     | 20216      | 139      | 137  | 138        |
| **RQ2: Recommenders++**  |     |            |          |      |            |
| *AuthorshipRec++*  | 21141     | 20219      | 142      | 140  | 141        |
| *RevOwnRec++*      | 21142     | 20220      | 143      | 141  | 142        |
| *CHRev++*          | 21140     | 20218      | 141      | 139  | 140        |
| *LearnRec++*       | 21144     | 20222      | 145      | 143  | 144        |
| *RetentionRec++*   | 21143     | 20221      | 144      | 142  | 143        |
| *TurnoverRec++*    | 21145     | 20223      | 146      | 144  | 145        |
| *WhoDo++*          | 21146     | 20224      | 147      | 145  | 146        |
| **RQ3: FarAwareRec** |         |            |          |      |            |
| *FarAwareRec*      | 21147     | 20225      | 148      | 146  | 147        |
| **RQ4: HoardedXRec** |         |            |          |      |            |
| *Hoarded2Rec*      | 21148     | 20226      | 149      | 147  | 148        |
| *Hoarded3Rec*      | 21149     | 20227      | 150      | 148  | 149        |
| *Hoarded4Rec*      | 21150     | 20228      | 151      | 149  | 150        |
