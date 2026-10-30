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

`/api/internal/release/campaigns` (kibybyte): `POST` creates the per-reel keyword campaign (comment keyword → DM with one tracked handout link) after a Graph check of permalink + `#kibybyte<N>` tag and a `HEAD` of the handout; same media id + same fields → 200 same campaign, any difference or an any-post/next-reel campaign on the account → 409. Failures carry `committed: false` when nothing can have been stored. `GET ?mediaId=` reads back all campaigns of the own account on that reel. No migration; existing campaigns are never changed or deleted.
