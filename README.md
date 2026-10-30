# NoLie engineering

The core of NoLie, a marketplace I built with my cofounder, one topic per folder, with each file's real commit history.

## What NoLie was

A marketplace where anything can be listed and sold, by checkout, by offer or at a live auction. We built it for trading cards and collectibles, and marketed it to their buyers and sellers. It ran in production from January to September 2026.

The stack: TypeScript, Fastify and Postgres (through Prisma) for the API, BullMQ on Redis for the workers, Next.js and React in the browser, Stripe for money, Ably for realtime. The API and workers ran on AWS, written in Pulumi; the web app on Vercel.

## The folders

Six folders each carry one flow end to end, with the browser code it needs; routes/ and infra/ show the patterns every flow stands on. Each README tells the story: the problem, the numbers, the rules and what enforces them, the bugs I fixed, and what I'd change now.

| Folder | What it does |
|---|---|
| [payments/](payments/) | Charges each buyer once, for an item they get |
| [payouts/](payouts/) | Pays sellers for every item the buyer keeps |
| [bids/](bids/) | Runs live auctions, a crowd bidding on one item |
| [realtime/](realtime/) | Puts bids, offers and in-person pickups on screen as they happen |
| [listing/](listing/) | Writes a listing from the seller's photos |
| [ranking/](ranking/) | Orders the explore feed, where buyers browse, and logs what they do there |
| [routes/](routes/) | How every API endpoint is written: signed in and checked by default |
| [infra/](infra/) | NoLie on AWS: deploys, rollbacks and alarms |

## About these files

Copied from the production repo with their history: `git log --follow` on any file reaches its first commit. Helpers are left out; a short note at the top of a file, marked as not in the original, names the code it relies on that this repo leaves out. The code under it is untouched, as it ran in production.
