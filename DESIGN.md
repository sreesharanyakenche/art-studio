# DESIGN

## How do login and the two roles work?
Customers sign up with email and password (bcrypt-hashed). Login returns a JWT (8h) that the browser sends as a Bearer token.
The studio account comes from the seed data; there is no studio sign-up. On every request the server verifies the token,
reloads the user from the DB (so the role is never trusted from the client), and applies a role check middleware.
No/invalid token = 401; wrong role = 403; a customer touching someone else's order/booking/request = 404
(queries filter on `user_id`, so the record simply is not found).

## Which database, and why?
SQLite via Node's built-in `node:sqlite`. It needs no install or account, so the app runs on a clean machine with `npm install && npm start`,
and it gives real transactions and unique indexes, which the "no double booking" rules need. Trade-off: it is a local file, not cloud-hosted;
moving to Postgres would be mostly a driver swap (the same partial unique indexes work there).

## How do you stop two people taking the same painting or date?
- Painting: buying runs inside `BEGIN IMMEDIATE` and does `UPDATE paintings SET status='sold' WHERE id=? AND status='available'`.
  Only one caller sees `changes = 1`; the others get 409 "just sold". A partial unique index (one `placed` order per painting) is a second backstop.
  Cancelling an order flips the painting back to available in the same transaction.
- Date: a partial unique index on `bookings(date) WHERE status IN ('requested','confirmed')`. The database rejects a second live booking
  for the same date (409 "date just taken"); declined or cancelled bookings free the date.
- Admin decisions, pottery edits and cancels use `UPDATE ... WHERE status='requested'`, so state changes cannot race either.
The guarantees live in the database, not in application "check then insert" code.

## What did you finish, what did you leave out, what next?
**Finished:** all three flows and both roles: paintings (add/edit while available, buy, cancel), wall bookings (7-90 day window,
10-500 sq ft, price = sqft x rate, one per date, confirm/decline, cancel until 3 days before), pottery (item/glaze/qty 1-12/needed-by 14+ days,
edit/cancel while requested, accept/decline). Server-side RBAC with 401/403/404, loading/empty/error states, clear refusal messages, API tests (`npm test`).

**Left out / caveats:**
- The seed data has no pottery prices, so pottery requests show no price.
- Paintings marked `sold` in the seed data are loaded as sold with no order behind them, so they cannot be bought or cancelled.
- "Days away" uses the server's local date; no timezone handling beyond that.
- The concurrency test fires parallel requests but Node's SQLite calls are synchronous, so it shows correct outcomes rather than true multi-process contention.
- Also built beyond the brief: image upload when adding or editing a painting, a buy confirmation prompt, and deleting an available painting that has never been ordered (ordered ones are kept so order history stays intact).
- No pagination and minimal styling (out of scope per the brief). Uploaded images are stored on local disk (`public/uploads`, not in git), so they would need object storage if deployed.

**Next:** move to a hosted Postgres, add pagination and a calendar picker that greys out taken dates, rate limiting on login, and browser-level tests.
