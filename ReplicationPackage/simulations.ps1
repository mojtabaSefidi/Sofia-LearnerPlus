# Update the paths in the following variables based on the corresponding configuration file.

$corefx_conf_Seed = "\absolute\path\to\Replace_All\corefx_conf.json"
$coreclr_conf_Seed = "\absolute\path\to\Replace_All\coreclr_conf.json"
$roslyn_conf_Seed = "\absolute\path\to\Replace_All\roslyn_conf.json"
$rust_conf_Seed = "\absolute\path\to\Replace_All\rust_conf.json"
$kubernetes_conf_Seed = "\absolute\path\to\Replace_All\kubernetes_conf.json"

# Get Seeded Random Ids
dotnet-rgit --cmd simulate-recommender --recommendation-strategy cHRev --simulation-type "Random" --conf-path $corefx_conf_Seed
dotnet-rgit --cmd simulate-recommender --recommendation-strategy cHRev --simulation-type "Random" --conf-path $coreclr_conf_Seed
dotnet-rgit --cmd simulate-recommender --recommendation-strategy cHRev --simulation-type "Random" --conf-path $roslyn_conf_Seed
dotnet-rgit --cmd simulate-recommender --recommendation-strategy cHRev --simulation-type "Random" --conf-path $rust_conf_Seed
dotnet-rgit --cmd simulate-recommender --recommendation-strategy cHRev --simulation-type "Random" --conf-path $kubernetes_conf_Seed

# RQ1: Baseline
# Update the paths in the following variables based on the corresponding configuration file.
$corefx_conf_RQ1 = "\absolute\path\to\Replace_Risky\corefx_conf.json"
$coreclr_conf_RQ1 = "\absolute\path\to\Replace_Risky\coreclr_conf.json"
$roslyn_conf_RQ1 = "\absolute\path\to\Replace_Risky\roslyn_conf.json"
$rust_conf_RQ1 = "\absolute\path\to\Replace_Risky\rust_conf.json"
$kubernetes_conf_RQ1 = "\absolute\path\to\Replace_Risky\kubernetes_conf.json"

# RQ1 CoreFX Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy cHRev --simulation-type "SeededRandom" --conf-path $corefx_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy AuthorshipRec --simulation-type "SeededRandom" --conf-path $corefx_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy RevOwnRec --simulation-type "SeededRandom" --conf-path $corefx_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy RetentionRec --simulation-type "SeededRandom" --conf-path $corefx_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy LearnRec --simulation-type "SeededRandom" --conf-path $corefx_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path $corefx_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy WhoDo --simulation-type "SeededRandom" --conf-path $corefx_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy Reality --conf-path $corefx_conf_RQ1

# RQ1 CoreCLR Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy cHRev --simulation-type "SeededRandom" --conf-path $coreclr_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy AuthorshipRec --simulation-type "SeededRandom" --conf-path $coreclr_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy RevOwnRec --simulation-type "SeededRandom" --conf-path $coreclr_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy RetentionRec --simulation-type "SeededRandom" --conf-path $coreclr_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy LearnRec --simulation-type "SeededRandom" --conf-path $coreclr_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path $coreclr_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy WhoDo --simulation-type "SeededRandom" --conf-path $coreclr_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy Reality --conf-path $coreclr_conf_RQ1

# RQ1 Roslyn Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy cHRev --simulation-type "SeededRandom" --conf-path $roslyn_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy AuthorshipRec --simulation-type "SeededRandom" --conf-path $roslyn_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy RevOwnRec --simulation-type "SeededRandom" --conf-path $roslyn_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy RetentionRec --simulation-type "SeededRandom" --conf-path $roslyn_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy LearnRec --simulation-type "SeededRandom" --conf-path $roslyn_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path $roslyn_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy WhoDo --simulation-type "SeededRandom" --conf-path $roslyn_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy Reality --conf-path $roslyn_conf_RQ1

# RQ1 Rust Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy cHRev --simulation-type "SeededRandom" --conf-path $rust_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy AuthorshipRec --simulation-type "SeededRandom" --conf-path $rust_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy RevOwnRec --simulation-type "SeededRandom" --conf-path $rust_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy RetentionRec --simulation-type "SeededRandom" --conf-path $rust_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy LearnRec --simulation-type "SeededRandom" --conf-path $rust_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path $rust_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy WhoDo --simulation-type "SeededRandom" --conf-path $rust_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy Reality --conf-path $rust_conf_RQ1

# RQ1 Kubernetes Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy cHRev --simulation-type "SeededRandom" --conf-path $kubernetes_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy AuthorshipRec --simulation-type "SeededRandom" --conf-path $kubernetes_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy RevOwnRec --simulation-type "SeededRandom" --conf-path $kubernetes_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy RetentionRec --simulation-type "SeededRandom" --conf-path $kubernetes_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy LearnRec --simulation-type "SeededRandom" --conf-path $kubernetes_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path $kubernetes_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy WhoDo --simulation-type "SeededRandom" --conf-path $kubernetes_conf_RQ1
dotnet-rgit --cmd simulate-recommender --recommendation-strategy Reality --conf-path $kubernetes_conf_RQ1


# RQ2: Recommenders++
# Update the paths in the following variables based on the corresponding configuration file.
$corefx_conf_RQ2 = "\absolute\path\to\Add_Risky\corefx_conf.json"
$coreclr_conf_RQ2 = "\absolute\path\to\Add_Risky\coreclr_conf.json"
$roslyn_conf_RQ2 = "\absolute\path\to\Add_Risky\roslyn_conf.json"
$rust_conf_RQ2 = "\absolute\path\to\Add_Risky\rust_conf.json"
$kubernetes_conf_RQ2 = "\absolute\path\to\Add_Risky\kubernetes_conf.json"

# RQ2 CoreFX Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy cHRev --conf-path $corefx_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy AuthorshipRec --conf-path $corefx_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy RevOwnRec --conf-path $corefx_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy RetentionRec --conf-path $corefx_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy LearnRec --conf-path $corefx_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --conf-path $corefx_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy WhoDo --conf-path $corefx_conf_RQ2

# RQ2 CoreCLR Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy cHRev --conf-path $coreclr_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy AuthorshipRec --conf-path $coreclr_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy RevOwnRec --conf-path $coreclr_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy RetentionRec --conf-path $coreclr_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy LearnRec --conf-path $coreclr_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --conf-path $coreclr_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy WhoDo --conf-path $coreclr_conf_RQ2

# RQ2 Roslyn Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy cHRev --conf-path $roslyn_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy AuthorshipRec --conf-path $roslyn_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy RevOwnRec --conf-path $roslyn_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy RetentionRec --conf-path $roslyn_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy LearnRec --conf-path $roslyn_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --conf-path $roslyn_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy WhoDo --conf-path $roslyn_conf_RQ2

# RQ2 Rust Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy cHRev --conf-path $rust_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy AuthorshipRec --conf-path $rust_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy RevOwnRec --conf-path $rust_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy RetentionRec --conf-path $rust_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy LearnRec --conf-path $rust_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --conf-path $rust_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy WhoDo --conf-path $rust_conf_RQ2

# RQ2 Kubernetes Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy cHRev --conf-path $kubernetes_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy AuthorshipRec --conf-path $kubernetes_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy RevOwnRec --conf-path $kubernetes_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy RetentionRec --conf-path $kubernetes_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy LearnRec --conf-path $kubernetes_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --conf-path $kubernetes_conf_RQ2
dotnet-rgit --cmd simulate-recommender --recommendation-strategy WhoDo --conf-path $kubernetes_conf_RQ2

# RQ3: FarAwareRec
# Update the paths in the following variables based on the corresponding configuration file.

$corefx_conf_RQ3 = "\absolute\path\to\FaR_Aware\corefx_conf.json"
$coreclr_conf_RQ3 = "\absolute\path\to\FaR_Aware\coreclr_conf.json"
$roslyn_conf_RQ3 = "\absolute\path\to\FaR_Aware\roslyn_conf.json"
$rust_conf_RQ3 = "\absolute\path\to\FaR_Aware\rust_conf.json"
$kubernetes_conf_RQ3 = "\absolute\path\to\FaR_Aware\kubernetes_conf.json"

# RQ3 CoreFX Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path $corefx_conf_RQ3

# RQ3 CoreCLR Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path $coreclr_conf_RQ3

# RQ3 Roslyn Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path $roslyn_conf_RQ3

# RQ3 Rust Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path $rust_conf_RQ3

# RQ3 Kubernetes Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path $kubernetes_conf_RQ3


# RQ4_2: Hoarded2Rec
# Update the paths in the following variables based on the corresponding configuration file.

$corefx_conf_RQ4_2 = "\absolute\path\to\Hoarded2Rec\corefx_conf.json"
$coreclr_conf_RQ4_2 = "\absolute\path\to\Hoarded2Rec\coreclr_conf.json"
$roslyn_conf_RQ4_2 = "\absolute\path\to\Hoarded2Rec\roslyn_conf.json"
$rust_conf_RQ4_2 = "\absolute\path\to\Hoarded2Rec\rust_conf.json"
$kubernetes_conf_RQ4_2 = "\absolute\path\to\Hoarded2Rec\kubernetes_conf.json"

# RQ4_2 CoreFX Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path $corefx_conf_RQ4_2

# RQ4_2 CoreCLR Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path $coreclr_conf_RQ4_2

# RQ4_2 Roslyn Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path $roslyn_conf_RQ4_2

# RQ4_2 Rust Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path $rust_conf_RQ4_2

# RQ4_2 Kubernetes Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path $kubernetes_conf_RQ4_2


# RQ4_3: Hoarded3Rec
# Update the paths in the following variables based on the corresponding configuration file.

$corefx_conf_RQ4_3 = "\absolute\path\to\Hoarded3Rec\corefx_conf.json"
$coreclr_conf_RQ4_3 = "\absolute\path\to\Hoarded3Rec\coreclr_conf.json"
$roslyn_conf_RQ4_3 = "\absolute\path\to\Hoarded3Rec\roslyn_conf.json"
$rust_conf_RQ4_3 = "\absolute\path\to\Hoarded3Rec\rust_conf.json"
$kubernetes_conf_RQ4_3 = "\absolute\path\to\Hoarded3Rec\kubernetes_conf.json"

# RQ4_3 CoreFX Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path $corefx_conf_RQ4_3

# RQ4_3 CoreCLR Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path $coreclr_conf_RQ4_3

# RQ4_3 Roslyn Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path $roslyn_conf_RQ4_3

# RQ4_3 Rust Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path $rust_conf_RQ4_3

# RQ4_3 Kubernetes Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path $kubernetes_conf_RQ4_3


# RQ4_4: Hoarded4Rec
# Update the paths in the following variables based on the corresponding configuration file.

$corefx_conf_RQ4_4 = "\absolute\path\to\Hoarded4Rec\corefx_conf.json"
$coreclr_conf_RQ4_4 = "\absolute\path\to\Hoarded4Rec\coreclr_conf.json"
$roslyn_conf_RQ4_4 = "\absolute\path\to\Hoarded4Rec\roslyn_conf.json"
$rust_conf_RQ4_4 = "\absolute\path\to\Hoarded4Rec\rust_conf.json"
$kubernetes_conf_RQ4_4 = "\absolute\path\to\Hoarded4Rec\kubernetes_conf.json"

# RQ4_4 CoreFX Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path $corefx_conf_RQ4_4

# RQ4_4 CoreCLR Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path $coreclr_conf_RQ4_4

# RQ4_4 Roslyn Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path $roslyn_conf_RQ4_4

# RQ4_4 Rust Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path $rust_conf_RQ4_4

# RQ4_4 Kubernetes Simulations
dotnet-rgit --cmd simulate-recommender --recommendation-strategy TurnoverRec --simulation-type "SeededRandom" --conf-path $kubernetes_conf_RQ4_4

## Get Results from the Analyzer
## You should first run the previous commands and restore the Simulation-Ids from the database. Then, update the Simulation IDs and Reality ID for each project and run the following commands.
# dotnet-rgit --cmd analyze-simulations --analyze-result-path "\absolute\path\to\CoreFX_Results_Directory" --recommender-simulation <CoreFX-Simulation-Ids-SeparatedWithSpace> --reality-simulation <Reality-Id> --conf-path $corefx_conf_RQ1
# dotnet-rgit --cmd analyze-simulations --analyze-result-path "\absolute\path\to\CoreCLR_Results_Directory" --recommender-simulation <CoreCLR-Simulation-Ids-SeparatedWithSpace> --reality-simulation <Reality-Id> --conf-path $coreclr_conf_RQ1
# dotnet-rgit --cmd analyze-simulations --analyze-result-path "\absolute\path\to\Roslyn_Results_Directory" --recommender-simulation <Roslyn-Simulation-Ids-SeparatedWithSpace> --reality-simulation <Reality-Id> --conf-path $roslyn_conf_RQ1
# dotnet-rgit --cmd analyze-simulations --analyze-result-path "\absolute\path\to\Rust_Results_Directory" --recommender-simulation <Rust-Simulation-Ids-SeparatedWithSpace> --reality-simulation <Reality-Id> --conf-path $rust_conf_RQ1
# dotnet-rgit --cmd analyze-simulations --analyze-result-path "\absolute\path\to\Kubernetes_Results_Directory" --recommender-simulation <Kubernetes-Simulation-Ids-SeparatedWithSpace> --reality-simulation <Reality-Id> --conf-path $kubernetes_conf_RQ1
