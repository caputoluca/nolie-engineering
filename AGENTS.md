# How this repo is built

For anyone, person or agent, reading or changing this repo.

## What it is
The core of NoLie's production code, one topic folder each: payments, payouts, bids, realtime, listing, ranking, routes, infra. The files were copied from the production repo with their history, so `git log --follow` on any file reaches its first commit there.

## The folders
Each folder holds the core logic only, plus one test when the original had one, plus a README. A folder carries its flow end to end: the browser files a flow needs sit in its own folder, so one README tells the whole story. routes/ and infra/ show a pattern rather than a flow; their reader is the next engineer.

## The code is as it ran
Helpers are left out. A short note at the top of a file, marked as not in the original, names the code it relies on that this repo leaves out, and calls the rest plumbing. The code under the note is untouched, as it ran in production.

## The README of a folder
Sections in this order, each under its own heading:
1. **The problem**: what the folder does for a buyer or a seller, as an outcome, in their words, then one line on the code that does it. routes/ and infra/ say what they give the next engineer instead.
2. **By the numbers**: one row of figures from the record (production data, a load test or a measurement), each source said under the table.
3. **The rules**: a table, rule · enforced in · proven by, each label 8 words or fewer.
4. **How it works**: one Mermaid diagram of the flow.
5. **Why it's built this way**: one sub-heading per decision, short bullets. A rejected alternative only when the history or a design doc records one.
6. **Start here**: the three files to open first.
7. **Bugs I fixed**: what, whether it reached production, and the fix commit.
8. **What I'd change now**.

What every folder shares (the history, what is left out, the code as it ran) is said once, in the root README.

Plain words: no paragraph over 60 words, and no code identifier in prose outside backticks. "I" for decisions, bugs and changes; the code as the subject for what it does; "we" only for the company.

Every number, bug and rejected alternative comes from a commit, a design doc, production data, a measurement or the author's own account, and every commit a README cites is in this repo's history.
