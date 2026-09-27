import assert from "node:assert/strict";
import { rememberBoundedDeliveryKey } from "../ui/src/coachResponseDelivery.ts";

const delivered = new Map();
const response = "coach:req-1|hash-1|cruise|answer";
assert.equal(rememberBoundedDeliveryKey(delivered, response, 4), false);
assert.equal(rememberBoundedDeliveryKey(delivered, "fast:choice-hint", 4), false);
assert.equal(rememberBoundedDeliveryKey(delivered, "runtime-fallback:ocr", 4), false);
assert.equal(rememberBoundedDeliveryKey(delivered, response, 4), true, "interleaved hint/fallback must not make the same coach answer deliverable again");
assert.equal(delivered.size, 3);

rememberBoundedDeliveryKey(delivered, "coach:req-2", 4);
rememberBoundedDeliveryKey(delivered, "coach:req-3", 4);
assert.equal(delivered.size, 4, "delivery identity cache must stay bounded");
assert.equal(delivered.has(response), false, "oldest delivery identity should be evicted only after the bound is exceeded");

console.log(JSON.stringify({
  ok: true,
  schema: "jcc-coach-response-delivery-dedup-v1",
  checked: [
    "direct_and_canonical_response_identity_survives_interleaved_fast_hint",
    "fallback_does_not_overwrite_formal_response_identity",
    "delivery_identity_cache_is_bounded",
  ],
}, null, 2));
