# Replication Package
This repository contains the necessary data to replicate the information from the study "_The Cost vs. the Benefit of Adding an Extra Code Reviewer to Mitigate Developer Turnover through Reviewer Recommenders_" which is published in [ICSE'26](https://conf.researchr.org/details/icse-2026/icse-2026-research-track/28/The-Cost-vs-the-Benefit-of-Adding-an-Extra-Code-Reviewer-to-Mitigate-Developer-Turnov). First, you should install the dependencies for the replication package, and then follow the instructions in the [README File](ReplicationPackage/README.md) to run the simulations.

# Dependencies

Before installing the replication package, you need to install the following dependencies.

## 1) .NET Core

You need to get the latest bits on [.NET Core](https://www.microsoft.com/net/download).

## 2) SQL Server
Download and install [Microsoft SQL Server](https://www.microsoft.com/en-us/sql-server/sql-server-downloads) and set up a local server instance in your computer. You can install [SQL Server Management Studio](https://docs.microsoft.com/en-us/sql/ssms/download-sql-server-management-studio-ssms) to query the database.

## 3) PowerShell Core

You need to get the latest version of [PowerShell Core](https://github.com/PowerShell/PowerShell/releases). RelationalGit uses PowerShell for extracting blame information.

# RelationalGit :cupid: Open Source
RelationalGit has been built on top of the most popular Git Libraries. It uses [libgit2Sharp](https://github.com/libgit2/libgit2sharp), [Octokit.Net](https://github.com/octokit/octokit.net), and [Octokit.Extensions](https://github.com/mirsaeedi/octokit.net.extensions) to extract the data from the git data structure and GitHub, respectively.

RelationalGit extracts valuable information about commits, blame, changes, developers, and pull requests from Git's data structure and imports it into a relational database, such as Microsoft SQL Server. These data can be used for further source code mining analysis. You can easily query the database and find answers to many interesting questions. Since source code mining is one of the most prominent topics in academia and industry, RelationalGit aims to facilitate researchers' investigations more conveniently.
For example, you can find answers to the following questions by running a simple SQL query over extracted data.

* What files have recently been changed by a given developer?
* Who is the author of a specific line in a specific file? (Git Blame)
* Which developer has the most commits?
* What files are usually changed together? This way, you can detect and document your hidden dependencies.
* Which developer has the most knowledge about a file or project? This idea is based on [Rigby's paper](http://ieeexplore.ieee.org/document/7886975/).
* Which files are constantly changing? Maybe they are bug-prone.
* Who is the most appropriate developer to work on a given file?

## Install (dotnet Global Tool)

SofiaWL-LearnerPlusPlus is a [dotnet Global tool](https://www.nuget.org/packages/SofiaWL-LearnerPlusPlus) based on RelationalGit. You should install this tool to run the simulations. You can use it seamlessly with your favorite command-line application. 

```PowerShell
dotnet tool install --global SofiaWL-LearnerPlusPlus --version 1.1.2
```

# Replication
For replication steps and running simulations, follow the instructions in [README File](ReplicationPackage/README.md).
