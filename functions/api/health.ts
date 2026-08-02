// GET /api/health — trivial liveness check, no auth, no DB. Useful for the
// `wrangler pages deployment tail` runbook (README) to confirm a deploy is
// actually serving before chasing a real request.
import { json } from '../_lib/env'

export const onRequestGet: PagesFunction = async () => json({ ok: true })
