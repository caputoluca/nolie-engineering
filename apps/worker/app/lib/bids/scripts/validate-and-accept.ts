// IMPORTANT:
// Redis SOT assumes this idempotency guard runs BEFORE Lua.
// If drain jobs become retryable after Lua or parallelized,
// add Lua-level bidId dedupe.

import { BidValidationCode } from "@nolie/schemas/auction/bid-validation";

export const VALIDATE_BID_LUA = `
local stateKey = KEYS[1]
local pendingBidsKey = KEYS[2]

local state = redis.call(
  "HMGET",
  stateKey,
  "status",
  "currentHighestBidAmount",
  "startingBidAmount",
  "creatorUserId",
  "version"
)

local status = state[1]
local currentHighestRaw = state[2]
local startingBidRaw = state[3]
local creatorUserId = state[4]

if not status or status ~= "active" then
  return { "rejected", "${BidValidationCode.auction_not_active}", currentHighestRaw or "0" }
end

if ARGV[3] == "1" then
  -- Exhaustion: skip validation, don't update highest
  redis.call("INCR", pendingBidsKey)
  return { "accepted", tostring(ARGV[1]), tostring(currentHighestRaw or 0) }
end

if ARGV[2] == creatorUserId then
  return { "rejected", "${BidValidationCode.cannot_bid_on_own_auction}", currentHighestRaw or "0" }
end

local bidAmount = tonumber(ARGV[1])
local currentHighest = tonumber(currentHighestRaw)
local startingBid = tonumber(startingBidRaw)

local minBid
if currentHighest then
  minBid = currentHighest + 1
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

return { "accepted", tostring(bidAmount), tostring(currentHighest or 0) }
`;
