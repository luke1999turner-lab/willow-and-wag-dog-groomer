# Willow & Wag — Dog Grooming Booking System

Static front end (Cloudflare Pages) + API (Cloudflare Worker, `willow-and-wag-api`) + D1 database (`willow-and-wag-db`).

## Deploying Worker changes

Pushing to `main` auto-deploys the static site (Pages), but the Worker (`worker.js`) is **not** connected to GitHub for auto-deploy. After committing changes to `worker.js`, deploy manually via the Cloudflare dashboard: Workers & Pages -> `willow-and-wag-api` -> Edit code (Quick Edit) -> paste in updated `worker.js` -> Deploy.

## Appointment reminder emails (cron)

`worker.js` exports a `scheduled(event, env, ctx)` handler that finds appointments starting 23.5-24.5 hours out with `status = 'booked'` and `reminder_sent_at IS NULL`, emails the client a reminder, and stamps `reminder_sent_at` so it's never sent twice.

This only runs if an hourly Cron Trigger is configured. To enable it:

1. Cloudflare dashboard -> Workers & Pages -> `willow-and-wag-api` -> Settings -> Trigger events -> Add.
2. Choose "Cron Triggers".
3. Cron expression: `0 * * * *` (every hour, on the hour).
4. Add.

This has already been enabled in production as of this change. If it's ever removed or the Worker is redeployed to a new environment, re-add it using the steps above.
