# ASP Box Tracker

A shared web app for tracking how many of each packaging **box size** are in each
**area** of the warehouse. Search by dimension, sort by length, and get a
restock warning when a box runs low. Open access — anyone with the link can view
and edit. Counts are shared across everyone in real time (auto-refreshes every 20s).

Built the same way as the ASP Bubbles app: **Node + Express** serving the
front-end, **PostgreSQL** for storage, hosted on **Railway**, deployed by
uploading files to a **GitHub** repo.

## Files

| File | What it is | Upload to GitHub? |
|------|------------|-------------------|
| `index.js` | The server (API + serves the page) | ✅ yes |
| `index.html` | The app you see in the browser | ✅ yes |
| `package.json` | Lists the code libraries Railway installs | ✅ yes |
| `schema.sql` | The database design, for reference | optional |
| `.gitignore` | Tells git to ignore junk files | optional |
| `README.md` | This file | optional |
| `dev-mock-server.py` | **Local testing only** — do NOT upload | ❌ no |

## First-time deploy (about 10 minutes)

1. **Make a new GitHub repo** named `asp-box-tracker`.
   - On github.com: **New repository** → name it → **Create**.
   - On the empty repo page: **uploading an existing file** → drag in `index.js`,
     `index.html`, and `package.json` → **Commit changes**.

2. **Create the Railway project from that repo.**
   - On railway.app: **New Project** → **Deploy from GitHub repo** → pick
     `asp-box-tracker`. Railway starts building it.

3. **Add a database.**
   - In the project: **New** → **Database** → **Add PostgreSQL**.

4. **Connect the app to the database.**
   - Click the **asp-box-tracker** service → **Variables** → **New Variable**:
     - Name: `DATABASE_URL`
     - Value: `${{Postgres.DATABASE_URL}}`  *(type it exactly — Railway fills it in)*
   - The service redeploys automatically.

5. **Turn on a public link.**
   - **asp-box-tracker** service → **Settings** → **Networking** →
     **Generate Domain**. That URL (e.g. `https://asp-box-tracker-production.up.railway.app`)
     is the app. Share it with whoever needs it.

On first open, the app automatically creates its tables and fills in the 13
starter box sizes and 2 areas (**Loading Dock Rack**, **Box Area**), all at 0.
You never run any SQL by hand.

## Updating it later

Edit `index.html` or `index.js`, then on the GitHub repo use **Add file →
Upload files**, drop in the changed file (it replaces the old one), and **Commit**.
Railway redeploys within a minute. (Same workflow as the Bubbles app.)

## Viewing/fixing the data directly

Railway → your project → the **Postgres** service → **Data** tab lets you browse
the `box_areas`, `box_types`, and `box_inventory` tables and run SQL if ever needed.

## Test it locally first (optional)

If you have Python: from this folder run `py dev-mock-server.py`, then open
`http://localhost:8780`. It runs the real front-end against an in-memory fake
database so you can click around without touching the live app. (Don't upload
`dev-mock-server.py` to GitHub — Railway doesn't use it.)
