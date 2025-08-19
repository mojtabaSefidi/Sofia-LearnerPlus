# Replication Package
This repository contains the necessary data to replicate the information from the study "_The Cost vs. the Benefit of Adding an Extra Code Reviewer to Mitigate Developer Turnover through Reviewer Recommenders_" which was published in ICSE'26. First, you should install the dependencies for RelationalGit, as outlined in the [README File](ReplicationPackage/README.md) located in the _ReplicationPackage_ directory.

# RelationalGit

RelationalGit extracts valuable information about commits, blame, changes, developers, and pull requests from Git's data structure and imports it into a relational database, such as Microsoft SQL Server. These data can be used for further source code mining analysis. You can easily query the database and find answers to many interesting questions. Since source code mining is one of the most prominent topics in academia and industry, RelationalGit aims to facilitate researchers' investigations more conveniently.
For example, you can find answers to the following questions by running a simple SQL query over extracted data.

* What files have recently been changed by a given developer?
* Who is the author of a specific line in a specific file? (Git Blame)
* Which developer has the most commits?
* What files are usually changed together? This way, you can detect and document your hidden dependencies.
* Which developer has the most knowledge about a file or project? This idea is based on [Rigby's paper](http://ieeexplore.ieee.org/document/7886975/).
* Which files are constantly changing? Maybe they are bug-prone.
* Who is the most appropriate developer to work on a given file?

# Dependencies

Before installing RelationalGit, you need to install the following dependencies.

## 1) .NET Core

You need to get the latest bits on [.NET Core](https://www.microsoft.com/net/download).

## 2) SQL Server
**Cross-Platform**: Download the [SQL Server Docker image](https://docs.microsoft.com/en-us/sql/linux/quickstart-install-connect-docker?view=sql-server-linux-2017) to run it natively on your system. Then you need to install [Microsoft SQL Operation Studio](https://docs.microsoft.com/en-us/sql/sql-operations-studio/download) or [SQLCMD](https://docs.microsoft.com/en-us/sql/linux/sql-server-linux-setup-tools?view=sql-server-linux-2017) to query the database. On Windows, you can install [Sql Server Management Studio](https://docs.microsoft.com/en-us/sql/ssms/download-sql-server-management-studio-ssms) to query the database.

**Windows**: You can download SQL Server - [LocalDb, Express, and Developer Editions](https://www.microsoft.com/en-ca/sql-server/sql-server-downloads) - and [SQL Server Management Studio](https://docs.microsoft.com/en-us/sql/ssms/download-sql-server-management-studio-ssms) free of charge.

## 3) PowerShell Core

You need to get the latest version of [PowerShell Core](https://github.com/PowerShell/PowerShell/releases). RelationalGit uses PowerShell for extracting blame information.


# RelationalGit :cupid: Open Source
RelationalGit has been built on top of the most popular Git Libraries. It uses [libgit2Sharp](https://github.com/libgit2/libgit2sharp), [Octokit.Net](https://github.com/octokit/octokit.net), and [Octokit.Extensions](https://github.com/mirsaeedi/octokit.net.extensions) to extract the data from the git data structure and GitHub, respectively.

## Install (dotnet Global Tool)

RelationalGit is a [dotnet Global tool](https://www.nuget.org/packages/RelationalGit). You should install the following tool to run the simulations. You can use it seamlessly with your favorite command-line application. 

```PowerShell
dotnet tool install --global SofiaWL-LearnerPlusPlus --version 1.1.2
```

# Replication
For replication steps and running simulations, read the [README File](ReplicationPackage/README.md) in the _ReplicationPackage_ directory.

---
If you have any issues, don't hesitate to contact us.

