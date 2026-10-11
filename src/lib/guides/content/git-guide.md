---
title: A guide to git commits
description: how to make your reviewers' life easier
sidebar:
  order: 2
---

## Things to install :)
- Download [VSCode](code.visualstudio.com/download)
- Install [Hackatime](https://hackatime.hackclub.com)

[![wakatime](https://user-cdn.hackclub-assets.com/019d39a1-fb8a-7280-945d-a2e394a1801a/image%20(4).png)](link_url)

- Configure [Hackatime](https://hackatime.hackclub.com/my/wakatime_setup)

    -   Run the script here to configure your Wakatime extension to use Hackatime - Hack Club’s time-tracking platform.

    -   Once you start coding, make sure you check back on Hackatime to see if your project is there!
- [git!!](http://git-scm.com/downloads)

## What is git?
- Lets you save your code changes permanently (not locally)
- Keeps track of your code’s changes over time
- Allows you to collaborate with friends
- Universally used by devs


## Lets make a repo!!!
1. Make a folder on your device for your projects

2. Connect your GitHub repo with your local project

[![code](https://user-cdn.hackclub-assets.com/019d39a6-6844-7c5f-8a30-27a6680ad623/image%20(7).png)](link_url)

[![copy](https://user-cdn.hackclub-assets.com/019d39a6-4883-7ac3-993a-fd22725decf7/image%20(6).png)](link_url)
3. Open your terminal
For example, if your projects folder is in Documents/Projects, type ```cd Documents/Projects```

Then type git clone ```<linkyoucopied>``` and press enter

4. Start coding!
But before you make any major features, keep reading.

## Commits
Saves all your current code Like a snapshot in time (you can go back to see previous versions) Good practice to commit often (1 per hour is recommended) **1 commit = 1 feature, or change**


[![copy](https://user-cdn.hackclub-assets.com/019d39ad-1e6c-7ac6-9d85-5784e8ec4c8b/image%20(8).png)](link_url)

[![commit msg](https://user-cdn.hackclub-assets.com/019d39b0-db82-73cf-afb8-060e6fe5c701/image.png)](link_url)

## Commit Best Practices

Detailed commits that explain what you fixed or changed
e.g “Added info page and search functionality”
- [Conventional commits](https://gist.github.com/qoomon/5dfcdf8eec66a051ecd85625518cfd13#examples) are also pretty cool! e.g “feat: search functionality”

Use whatever works for you – commits are there to help you and others keep track of changes in your code.


## What Counts as shipped?

- [x] Project has all code files needed to run
- [x] Project has a detailed [README.md](http://README.md) (not written by AI)
- [x] Project is deployed/has a link where someone else can try it
- [x] Project has a demo video or screenshot of it in action
- [x] You’re proud of what you made!

Your README should show the following:
- What your project is and where it can be used
- What you made it with
- A demo of your project (image or video works!)
- How other people can contribute to it
- How it can be deployed

The README is the first thing people see when they’re looking at your repository, so it’s important that it looks nice and is informative!

README files are usually in Markdown. Check out the [GitHub markdown guide](https://docs.github.com/en/get-started/writing-on-github/getting-started-with-writing-and-formatting-on-github/basic-writing-and-formatting-syntax) to make your README look good.

## Deploying Python projects
If you’ve made a Python project that is not a web project, you can deploy it using [Pyinstaller](https://pyinstaller.org/en/stable/). Some common examples are terminal based projects and projects that open up a GUI e.g Pygame games. 

Once you have Pyinstaller installed, run this command in the location of your code file (e.g in the VSCode terminal of your open project) 

```pyinstaller --onefile nameofyourpythonfilehere.py```


*This guide was originally written by Phthallo for [HCTG](https://hack.club/hctg/guide).*
