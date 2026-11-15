# NoLie engineering

The core of NoLie, the marketplace I built with my cofounder. Each folder holds one topic, and each file keeps its real commit history.

## What NoLie was

A marketplace where anything can be listed and sold, by checkout, by offer or at a live auction. We built it for trading cards and collectibles, and marketed it to their buyers and sellers. It ran in production from January to September 2026.

From May it took 336 marketplace payments, $13,547 in all, with no double charge. Over its life it paid $12,324 to 83 sellers, held 3,631 listings, and its API answered 99.995% of 3.60M requests without a server error.

The stack: TypeScript, Fastify and Postgres (through Prisma) for the API, BullMQ on Redis for the workers, Next.js and React in the browser, Stripe for money, Ably for realtime. The API and workers ran on AWS, written in Pulumi; the web app on Vercel.

## The folders

Six folders each carry one flow end to end, with the browser code it needs. routes/ shows how every endpoint is written, and infra/ how it all ran on AWS. Every README follows the same order, from the problem to what I'd change now.

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
