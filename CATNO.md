# CATNO-Fork

Branch `catno` trägt die CATNO-Erweiterungen (Drop-Resolver, k-Passthrough, Outbound-Events).
Upstream-Merges: `git fetch upstream && git merge upstream/main` auf `catno`, danach `npm test`.
Deploy: Coolify, Docker-Compose-Ressource `openreply`, Domain reply.catno.ai. Env-Namen in `.env.production.example`.
Spec: ~/catno-development/docs/superpowers/specs/2026-09-10-instagram-freestuff-funnel-spec.md
