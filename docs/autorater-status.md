# AutoRater rating and status records

AutoRater generation defaults to `https://www.auto-rater-cat.com/rating-result`.
This endpoint produces the existing AVG/RR/V2/V2.1/V2.2 response while persisting
the same record used by the website's iframe and compact status API. This prevents
a newly generated TUF vote from immediately appearing outdated due to a missing
website record. Existing validation, transaction boundaries and permissions stay
in place; failures preserve the previous TUF vote.

If `AUTORATER_API_URL` is explicitly configured, change it to
`https://www.auto-rater-cat.com` (no endpoint path), or remove it to use the default.
Custom API origins remain supported, but must provide the durable rating endpoint
for the status integration to work. The old standalone Railway API does not share
the website's saved records. The matching website endpoint must be deployed before
rolling out this backend change.

The companion frontend queries
`GET /embed/tuf/{levelId}/status?rating={displayedVote}` on the website origin when
an AutoRater card opens; ordinary raters do not trigger status requests. Opening a
page never invokes generation. Missing pre-existing records count as outdated,
and unscanned warnings remain unknown until the analysis is generated. There is
no automatic bulk backfill or TUF database migration.

Validation: run `node node_modules/tsx/dist/cli.mjs --test
src/server/services/data/AutoraterService.test.ts src/misc/utils/data/autoraterResult.test.ts`.
