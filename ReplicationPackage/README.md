# Replication Package

The overall steps are

1. Install Relational Git
2. Get the Database
3. Run the Simulations for each research question
4. Dump the Simulation Data to CSV
5. Calculate the outcome measures: Expertise, Gini-Workload, FaR, and Reviewer++

## Install Relational Git

1) [Install](../README.md) the Relational Git and its dependencies.

## Get the Database

1) Restore the data backup into MS SQL Server from [Figshare](https://figshare.com/s/b79fc69acad8e11be31a). There is a separate database for each studied project. Note that the databases are approximately 2 GB in size.
2) Copy the configuration files and simulation.ps1, which are provided in the replication package.
3) Open and modify each configuration file to set the connection string. You need to provide the server address along with the credentials. The following snippet shows a sample of how the connection string should be set.

```json
 {
	"ConnectionStrings": {
	  "RelationalGit": "Server=ip_db_server;User Id=user_name;Password=pass_word;Database=Roslyn_PlusPlus"
	},
	"Mining":{
 		
  	}
 }
```

## Run the Simulations

1) Open [simulations.ps1](simulations.ps1) using an editor and make sure the corresponding config variables for each research question are defined in the file and refer to the correct location. For instance, each of the following variables contains the absolute path of the corresponding configuration file for the first research question.


```PowerShell
$corefx_conf_RQ1 = "RQ1/absolute/path/to/corefx_conf.json"
$coreclr_conf_RQ1 = "RQ1/absolute/path/to/coreclr_conf.json"
$roslyn_conf_RQ1 = "RQ1/absolute/path/to/roslyn_conf.json"
$rust_conf_RQ1 = "RQ1/absolute/path/to/rust_conf.json"
$kubernetes_conf_RQ1 = "RQ1/absolute/path/to/kubernetes_conf.json"
```

2) Run the [simulations.ps1](simulations.ps1) script. Open PowerShell and run the following command in the directory of the file

``` PowerShell
./simulations.ps1
```

This script simulates the performance of all the defined reviewer recommendation algorithms across all projects.

**Note**: Make sure you have set the PowerShell [execution policy](https://superuser.com/questions/106360/how-to-enable-execution-of-powershell-scripts) to **Unrestricted** or **RemoteAssigned**.

## If you want to run the simulations separately for each RQ

If you want to run the simulation separately, the following sections describe the commands needed to run simulations for each research question. For each simulation, a sample is provided that illustrates how to run the simulation using the tool.

**Note:** To run the simulations for each of the following research questions, you need to change the config file of all three projects. To avoid confusion, we recommend creating a separate configuration file for each research question.

### Simulation RQ1, Baseline: On PRKRs, how well do existing recommenders perform?

On PRKRs, to replicate the performance of recommenders at the replacement level, you should apply the following change to each project's config file.

```
"PullRequestReviewerSelectionStrategy" : "0:nothing-nothing,-:farreplacerandom-1",
```

In this way, one of the reviewers of PRKRs will be randomly (seeded) replaced with the top-recommended candidate. Then you should run the following commands for each project to simulate the performance of recommenders.

```PowerShell
# Reality
dotnet-rgit --cmd simulate-recommender --recommendation-strategy Reality --conf-path <path_to_config_file>
# cHRev Recommender
dotnet-rgit --cmd simulate-recommender --recommendation-strategy cHRev --simulation-type "Random" --conf-path <path_to_config_file>
# AuthorshipRec Recommender
dotnet-rgit --cmd simulate-recommender --recommendation-strategy AuthorshipRec --simulation-type "SeededRandom" --conf-path <path_to_config_file>
# RevOwnRec Recommender
dotnet-rgit --cmd simulate-recommender --recommendation-strategy RevOwnRec --simulation-type "SeededRandom" --conf-path <path_to_config_file>
# LearnRec Recommender
dotnet-rgit --cmd simulate-recommender --recommendation-strategy LearnRec --simulation-type "SeededRandom" --conf-path <path_to_config_file>
# RetentionRec Recommender
dotnet-rgit --cmd simulate-recommender --recommendation-strategy RetentionRec --simulation-type "SeededRandom" --conf-path <path_to_config_file>
# TurnoverRec Recommender
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path <path_to_config_file>
# Sofia Recommender
dotnet-rgit --cmd simulate-recommender --recommendation-strategy Sofia --simulation-type "SeededRandom" --conf-path <path_to_config_file>
#WhoDo recommender
dotnet-rgit --cmd simulate-recommender --recommendation-strategy WhoDo --simulation-type "SeededRandom" --conf-path <path_to_config_file>
# SofiaWL Recommender
dotnet-rgit --cmd simulate-recommender --recommendation-strategy SofiaWL --simulation-type "SeededRandom" --conf-path <path_to_config_file>
```

**Note**: In order to select between ```Random``` and ```SeededRandom```, adjust the ```--simulation-type``` command. If you want to run the seeded version, set the value of ```--simulation-type``` to ```Random``` for **cHRev** and all the other algorithms to ```SeededRandom```. If you wish to run the random version, set the value of ```--simulation-type``` to ```Random``` for all the algorithms.

---

### Simulation RQ2, Recommenders++: How does adding a reviewer on PRKRs impact the turnover risk and the amount of extra reviewing work?

To run the Recommenders++ strategy, you should apply the following change to the config file of each project.

```
"PullRequestReviewerSelectionStrategy" : "0:nothing-nothing,-:add-1",
```

In the next step, simulate each recommender. Since the Recommenders++ strategy suggests an extra reviewer for all PRKRs and doesn't do any replacement, there is no need to use the ```--simulation-type``` command.

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

To run the FarAwareRec approach, you should apply the following change to each project's config files.

```
"PullRequestReviewerSelectionStrategy" : "0:nothing-nothing,-:addAndReplace-1",
```

Then, you should simulate the FarAwareRec recommender for each project. The ```--simulation-type``` command forces the recommender to replace the same reviewer in all the simulations.

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

To run the HoardedXRec strategy, you should apply the following changes to the config file of each project.

```
"PullRequestReviewerSelectionStrategy" : "0:nothing-nothing,-:addHoarded_X-1",
```

The X parameter should be adjusted based on the recommender. In our paper, we run simulations for X = {2,3,4}. For example, if you want to run the **Hoarded2Rec** recommender, you should change the config files as follows:

```
"PullRequestReviewerSelectionStrategy" : "0:nothing-nothing,-:addHoarded_2-1",
```

After adjusting the config files for all projects, you should run the HoardedXRec approach for each project and X = {2,3,4}. 

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

To get your simulation results you should run the analyzer using the following command. Substitute the ```<rec_sim_id>``` variable with the Id of your desired recommender, and compare the recommender performance with the actual values, ```<reality_id>```. Note that you can add multiple simulation IDs and separate them using space.
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
| *Reality*          | 11095     | 10163      | 101      | 110  | 107        |
| **RQ1: Baseline**  |           |            |          |      |            |
| *AuthorshipRec*    | 21098     | 20188      | 120      | 127  | 123        |
| *RevOwnRec*        | 21100     | 20189      | 119      | 124  | 124        |
| *CHRev*            | 21101     | 20195      | 116      | 120  | 122        |
| *LearnRec*         | 21102     | 20199      | 118      | 123  | 126        |
| *RetentionRec*     | 21099     | 20200      | 117      | 122  | 125        |
| *TurnoverRec*      | 11083     | 10164      | 109      | 112  | 114        |
| *WhoDo*            | 21103     | 20194      | 123      | 121  | 130        |
| **RQ2: Recommenders++**  |     |            |          |      |            |
| *AuthorshipRec++*  | 11085     | 10155      | 102      | 107  | 108        |
| *RevOwnRec++*      | 11086     | 10156      | 103      | 106  | 109        |
| *CHRev++*          | 11088     | 10157      | 104      | 105  | 110        |
| *LearnRec++*       | 11089     | 10158      | 107      | 104  | 111        |
| *RetentionRec++*   | 11090     | 10159      | 106      | 103  | 112        |
| *TurnoverRec++*    | 11084     | 10176      | 108      | 109  | 113        |
| *WhoDo++*          | 11092     | 10161      | 99       | 101  | 106        |
| **RQ3: FarAwareRec** |         |            |          |      |            |
| *FarAwareRec*      | 11081     | 10169      | 111      | 113  | 116        |
| **RQ4: HoardedXRec** |         |            |          |      |            |
| *Hoarded2Rec*      | 11098     | 10179      | 112      | 115  | 119        |
| *Hoarded3Rec*      | 11097     | 10180      | 113      | 116  | 118        |
| *Hoarded4Rec*      | 11096     | 10181      | 114      | 117  | 117        |
