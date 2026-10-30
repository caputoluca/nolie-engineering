/*
 * nolie-engineering note, not in the original file; the code below is as it ran.
 * The worker registers this script as a Redis command and calls it through
 * validateAndAcceptBid, left out, which unpacks its answer. Everything else is
 * plumbing: the shared validation codes.
 */

// IMPORTANT:
// Redis SOT assumes this idempotency guard runs BEFORE Lua.
// If drain jobs become retryable after Lua or parallelized,
// add Lua-level bidId dedupe.

import { BidValidationCode } from "@nolie/schemas/auction/bid-validation";

export const VALIDATE_BID_LUA = `
local stateKey = KEYS[1]
local pendingBidsKey = KEYS[2]

--[[
  Minimum bid increment by price tier.

  $0-$24 → +$1
  $25-$49 → +$5
  $50-$499 → +$10
  $500-$999 → +$25
  $1,000-$2,499 → +$50
  $2,500-$4,999 → +$100
  $5,000-$9,999 → +$250
  $10,000-$19,999 → +$500
  $20,000-$29,999 → +$1,000
  $30,000-$49,999 → +$2,500
  $50,000-$99,999 → +$5,000
  $100,000-$199,999 → +$10,000
  $200,000-$299,999 → +$20,000
  $300,000-$599,999 → +$25,000
  $600,000-$999,999 → +$50,000
  $1,000,000+ → +$100,000

  ⚠️ DUPLICATED from TypeScript for atomic Redis validation.
  If you change this, also update:
  packages/core/src/auctions/bids.ts
]]
local function getMinIncrement(amount)
  if amount < 25 then return 1 end
  if amount < 50 then return 5 end
  if amount < 500 then return 10 end
  if amount < 1000 then return 25 end
  if amount < 2500 then return 50 end
  if amount < 5000 then return 100 end
  if amount < 10000 then return 250 end
  if amount < 20000 then return 500 end
  if amount < 30000 then return 1000 end
  if amount < 50000 then return 2500 end
  if amount < 100000 then return 5000 end
  if amount < 200000 then return 10000 end
  if amount < 300000 then return 20000 end
  if amount < 600000 then return 25000 end
  if amount < 1000000 then return 50000 end
  return 100000
end

local state = redis.call(
  "HMGET",
  stateKey,
  "status",
  "currentHighestBidAmount",
  "startingBidAmount",
  "sellerUserId",
  "highestBidUserId",
  "version"
)

local status = state[1]
local currentHighestRaw = state[2]
local startingBidRaw = state[3]
local sellerUserId = state[4]
local currentHighestBidUserId = state[5]

if not status or (status ~= "active" and status ~= "scheduled") then
  return { "rejected", "${BidValidationCode.auction_not_active}", currentHighestRaw or "0" }
end

if ARGV[3] == "1" then
  -- Exhaustion: skip validation, don't update highest
  redis.call("INCR", pendingBidsKey)
  return { "accepted", tostring(ARGV[1]), tostring(currentHighestRaw or 0), currentHighestBidUserId or "" }
end

if ARGV[2] == sellerUserId then
  return { "rejected", "${BidValidationCode.cannot_bid_on_own_auction}", currentHighestRaw or "0" }
end

local bidAmount = tonumber(ARGV[1])
local currentHighest = tonumber(currentHighestRaw)
local startingBid = tonumber(startingBidRaw)

-- Calculate minimum required bid amount.
-- Proxy bids may tie-break at the current amount (allowEqualToCurrentBid = true),
-- while manual bids must strictly exceed it.
local minBid
if currentHighest then
  if ARGV[4] == "1" then
    minBid = currentHighest
  else
    minBid = currentHighest + getMinIncrement(currentHighest)
  end
else
  minBid = startingBid
end

if bidAmount < minBid then
  return { "rejected", "${BidValidationCode.bid_too_low}", tostring(currentHighest or 0) }
end

redis.call(
  "HSET",
  stateKey,
  "currentHighestBidAmount", bidAmount,
  "highestBidUserId", ARGV[2]
)

redis.call("HINCRBY", stateKey, "version", 1)

redis.call("INCR", pendingBidsKey)

return { "accepted", tostring(bidAmount), tostring(currentHighest or 0), currentHighestBidUserId }
`;
