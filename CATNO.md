# CATNO-Fork

Branch `catno` trägt die CATNO-Erweiterungen (Drop-Resolver, k-Passthrough, Outbound-Events).
Upstream-Merges: `git fetch upstream && git merge upstream/main` auf `catno`, danach `npm test`.
Deploy: Coolify, Docker-Compose-Ressource `openreply`, Domain reply.catno.ai. Env-Namen in `.env.production.example`.
Spec: ~/catno-development/docs/superpowers/specs/2026-09-10-instagram-freestuff-funnel-spec.md

## Release identities (`lib/internal/release-auth.ts`)

Allowlist `RELEASE_IDENTITIES`: the Bearer selects one identity, each identity acts only on its own account and scopes.
- `catno`: `CATNO_RELEASE_SECRET` + `CATNO_RELEASE_INSTAGRAM_ACCOUNT_ID`, scopes media, resolve, bindings (unchanged).
- `kibybyte`: `KIBYBYTE_RELEASE_SECRET` + `KIBYBYTE_RELEASE_INSTAGRAM_ACCOUNT_ID` (native Instagram ID as stored in `InstagramAccount.instagramId`), scope campaigns only.
- Shared secret or shared account between identities → 503. Missing secret → 401, missing/unknown account → 503.

`/api/internal/release/campaigns` (kibybyte): `POST` creates the per-reel keyword campaign (comment keyword → public comment reply + follow prompt → tap → `is_user_follow_business` check → DM with one tracked handout link) after a Graph check of permalink + `#kibybyte<N>` tag and a `HEAD` of the handout; same media id + same fields → 200 same campaign, any difference or an any-post/next-reel campaign on the account → 409. Failures carry `committed: false` when nothing can have been stored. `GET ?mediaId=` reads back all campaigns of the own account on that reel. No migration; existing campaigns are never changed or deleted.

Release campaign settings mirror the live CATNO campaigns (reply.catno.ai `GET /api/automations`, 2026-10-31, all 4 `@catno.ai` campaigns identical): `requireFollow: true` with the CATNO follow prompt and button text, `publicReplyEnabled: true` with the CATNO reply texts (one of three picked at random), opening DM and follow-up off. Texts are copied verbatim (they name no channel) as constants in `lib/internal/release-campaigns.ts`. They are part of the idempotency comparison: a campaign stored with other values (e.g. the earlier ungated fields from before 2026-10-31) answers 409 and stays unchanged; live there were 0 KIbyByte campaigns when this changed. The follow check fails open (link is sent when Instagram returns no follow status, see README "Follow gate"); at comment time a Meta account still gets the prompt when the status is unknown.
