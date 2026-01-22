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
  
  $1-$49 → +$1
  $50-$199 → +$5
  $200-$499 → +$10
  $500-$999 → +$25
  $1,000-$4,999 → +$50
  $5,000+ → +$100
  
  ⚠️ DUPLICATED from TypeScript for atomic Redis validation.
  If you change this, also update:
  packages/core/src/auctions/bids.ts
]]
local function getMinIncrement(amount)
  if amount < 50 then return 1 end
  if amount < 200 then return 5 end
  if amount < 500 then return 10 end
  if amount < 1000 then return 25 end
  if amount < 5000 then return 50 end
  return 100
end

local state = redis.call(
  "HMGET",
  stateKey,
  "status",
  "currentHighestBidAmount",
  "startingBidAmount",
  "creatorUserId",
  "highestBidUserId",
  "version"
)

local status = state[1]
local currentHighestRaw = state[2]
local startingBidRaw = state[3]
local creatorUserId = state[4]
local currentHighestBidUserId = state[5]

if not status or (status ~= "active" and status ~= "scheduled") then
  return { "rejected", "${BidValidationCode.auction_not_active}", currentHighestRaw or "0" }
end

if ARGV[3] == "1" then
  -- Exhaustion: skip validation, don't update highest
  redis.call("INCR", pendingBidsKey)
  return { "accepted", tostring(ARGV[1]), tostring(currentHighestRaw or 0), currentHighestBidUserId or "" }
end

if ARGV[2] == creatorUserId then
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
