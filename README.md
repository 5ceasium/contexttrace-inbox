# ContextTrace Decision Inbox — app shell

The static frontend for the ContextTrace Decision Inbox. Public because a
browser has to download it; it carries no secrets and no research data.

- `config.js` holds the Supabase project URL and the **publishable** key, which
  is designed to ship to browsers. It identifies the project and nothing more.
- Every table it can reach is governed by row-level security. An anonymous
  visitor loading this page sees a sign-in gate and can read nothing — verified
  live, not assumed.
- Signing in is not the same as being authorized: a session without a profile
  row is refused.
- All content is fetched from the database at runtime. None of it is in here.

The research itself — the world, the handbook, the trajectories, the harness —
lives in a separate private repository.
