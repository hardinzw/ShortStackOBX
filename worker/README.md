# Short Stack website and booking server

One Cloudflare Worker runs the whole site: Cloudflare serves the web pages and photos in
`../public/`, and `src/index.js` answers everything else (settings, availability, bookings,
the calendar feed). It takes online bookings for the website. Guests pay on Stripe's own checkout page, so card
details never reach this server or the website. It stores only dates, guest name/email/phone
and Stripe reference IDs, in a Cloudflare D1 database.

How a booking works:
1. A guest taps an open week, enters guest counts and clicks **Book & pay securely**.
2. The server checks the week against online bookings, `site-config.json` and the live Vrbo /
   Houfy calendars, holds it for 30 minutes and sends the guest to Stripe Checkout.
3. When Stripe confirms payment, the week is marked paid. It shows as booked on the website and
   appears in `/calendar.ics`, which Vrbo and Houfy import to block the week there.
4. If the guest backs out, the hold is released straight away (otherwise after 30 minutes).
5. To cancel, give a **full refund** in the Stripe dashboard: the week reopens automatically.

Rates, season dates, tax, guest limit, Venmo handle and hand-entered bookings are all in
`../site-config.json`, which the website also reads.

Push to GitHub to publish: the **Deploy site** workflow (`.github/workflows/deploy.yml`)
updates the website and server together whenever `public/`, `worker/` or `site-config.json`
changes. Without it, run `npm run deploy` in `worker/`.

## Test on your computer

Needs [Node.js LTS](https://nodejs.org) and the [Stripe CLI](https://docs.stripe.com/stripe-cli).

```sh
cd worker
npm install
cp .dev.vars.example .dev.vars    # then paste your sk_test_ key into .dev.vars
npm run db:local                  # create the local bookings table
npm run dev                       # website + server at http://localhost:8787
```

In a second terminal, forward Stripe's payment notices to it, and copy the `whsec_...` it
prints into `.dev.vars` as `STRIPE_WEBHOOK_SECRET` (restart `npm run dev` after):

```sh
stripe listen --forward-to localhost:8787/api/stripe-webhook
```

Set `"onlineBooking": true` in `site-config.json`, open http://localhost:8787 and book a week
with test card `4242 4242 4242 4242`, any future date and any CVC.

## Go live

1. **Cloudflare**: create a free account, then in `worker/` run `npx wrangler login` and
   `npx wrangler d1 create shortstack-bookings`. Paste the `database_id` it prints into
   `wrangler.toml`.
2. **Secrets**: run `npx wrangler secret put STRIPE_SECRET_KEY` (and `VRBO_ICAL_URL`,
   `HOUFY_ICAL_URL`). Use your test key first; switch to the live `sk_live_` key when ready.
3. **Deploy**: `npm run db:remote` then `npm run deploy`. Note the address it prints,
   e.g. `https://shortstack-booking.<you>.workers.dev`.
4. **Stripe webhook**: Stripe dashboard > Developers > Webhooks > Add endpoint:
   `https://shortstack-booking.<you>.workers.dev/api/stripe-webhook`, with events
   `checkout.session.completed`, `checkout.session.async_payment_succeeded`,
   `checkout.session.async_payment_failed`, `checkout.session.expired` and `charge.refunded`.
   Save its signing secret with `npx wrangler secret put STRIPE_WEBHOOK_SECRET`.
5. **Stripe settings**: turn on customer email receipts and your own "successful payment"
   emails (Settings > Emails), and check which payment methods are on (Settings > Payment
   methods; cards, Apple Pay and Google Pay are enough).
6. **Website**: set `"onlineBooking": true` in `site-config.json` and push.
7. **Vrbo / Houfy**: import `https://shortstack-booking.<you>.workers.dev/calendar.ics` into
   each listing's calendar so online bookings block those dates there too.
8. **Automatic deploys**: add `CLOUDFLARE_API_TOKEN` (Cloudflare > My Profile > API Tokens >
   "Edit Cloudflare Workers" template) and `CLOUDFLARE_ACCOUNT_ID` repository secrets and a
   `BOOKING_SERVER_ENABLED` = `true` repository variable. Pushing then publishes the site.
9. **Your own domain (optional)**: add the domain to Cloudflare (free; you switch its
   nameservers at your registrar), then Workers & Pages > shortstack-booking > Settings >
   Domains & Routes > Add > Custom domain. Update `siteUrl` in `site-config.json`, the Stripe
   webhook address, and the calendar link imported into Vrbo / Houfy.

## Venmo bookings

Venmo is handled by hand: the guest sends an inquiry, you confirm the week and they pay your
Venmo business profile. Then add the week's check-in date to `"booked"` in `site-config.json`
and push. The website marks it booked, and the calendar feed blocks it on Vrbo and Houfy.
(Without step 8 above, also run `npm run deploy`.)
