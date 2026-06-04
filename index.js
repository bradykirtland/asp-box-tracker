// Action Spa Parts — Box Tracker API + static host
// One Express server: serves the front-end (index.html) and a small JSON API
// at POST /api. Counts live in PostgreSQL so everyone shares the same data.
//
// Open access by design — no login. Anyone with the URL can view and edit.
//
// Env vars:
//   DATABASE_URL  Postgres connection (Railway injects via ${{Postgres.DATABASE_URL}})
//   PORT          Railway sets this automatically

import express from 'express';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { Pool } = pg;

const DATABASE_URL = process.env.DATABASE_URL;
const PORT = process.env.PORT || 3000;

if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL is not set. Add a Postgres database in Railway and set DATABASE_URL = ${{Postgres.DATABASE_URL}}.');
  process.exit(1);
}

// SSL is only needed for Railway's public proxy URLs (rlwy.net / railway.app).
// Internal URLs (postgres.railway.internal) don't need or want SSL.
const sslNeeded = /\.rlwy\.net|\.railway\.app/.test(DATABASE_URL);
const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: sslNeeded ? { rejectUnauthorized: false } : false,
  max: 5,
});

// The 13 popular box sizes the warehouse stocks, used to seed a brand-new
// database. Once seeded, the manager edits the list in the app, not here.
const SEED_DIMENSIONS = [
  '6x6x6', '8x6x4', '8x8x8', '10x6x4', '12x6x6', '12x10x10', '14x6x4',
  '16x12x8', '18x6x6', '21x11x11', '24x6x6', '29x17x7', '32x17x16',
];
const SEED_AREAS = ['Loading Dock Rack', 'Box Area'];

// =================================================================
// Schema bootstrap + first-run seed
// =================================================================

// Runs once on every boot. Creating tables IF NOT EXISTS is safe to re-run.
// On a truly empty database we also insert the starter areas and box sizes so
// the app isn't blank on first open. Counts always start at 0.
async function ensureSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS box_areas (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS box_types (
      id          SERIAL PRIMARY KEY,
      dimensions  TEXT NOT NULL,
      reorder_at  INTEGER,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS box_inventory (
      area_id     INTEGER NOT NULL REFERENCES box_areas(id) ON DELETE CASCADE,
      type_id     INTEGER NOT NULL REFERENCES box_types(id) ON DELETE CASCADE,
      quantity    INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (area_id, type_id)
    );
  `);

  const { rows: a } = await pool.query('SELECT count(*)::int AS n FROM box_areas');
  if (a[0].n === 0) {
    for (const name of SEED_AREAS) {
      await pool.query('INSERT INTO box_areas (name) VALUES ($1)', [name]);
    }
    console.log('Seeded starter areas.');
  }
  const { rows: t } = await pool.query('SELECT count(*)::int AS n FROM box_types');
  if (t[0].n === 0) {
    for (const dim of SEED_DIMENSIONS) {
      await pool.query('INSERT INTO box_types (dimensions, reorder_at) VALUES ($1, NULL)', [dim]);
    }
    console.log('Seeded starter box sizes.');
  }
}

// =================================================================
// Helpers
// =================================================================

// Parse a non-negative whole number. Returns null if not a valid integer.
function cleanInt(v) {
  if (typeof v === 'number') return Number.isInteger(v) ? v : null;
  const s = String(v == null ? '' : v).trim();
  if (!/^-?\d+$/.test(s)) return null;
  return parseInt(s, 10);
}

// =================================================================
// Action handlers
// =================================================================

// The whole tracker in one payload, shaped exactly like the front-end's state:
//   { areas:[{id,name}], boxTypes:[{id,dimensions,reorderAt}],
//     inventory:{ "<areaId>:<typeId>": quantity } }
async function getState() {
  const [areas, types, inv] = await Promise.all([
    pool.query('SELECT id, name FROM box_areas ORDER BY id'),
    pool.query('SELECT id, dimensions, reorder_at AS "reorderAt" FROM box_types ORDER BY id'),
    pool.query('SELECT area_id, type_id, quantity FROM box_inventory'),
  ]);
  const inventory = {};
  for (const r of inv.rows) inventory[`${r.area_id}:${r.type_id}`] = r.quantity;
  return { areas: areas.rows, boxTypes: types.rows, inventory };
}

// Increase/decrease a count by delta, clamped at 0, atomically in the DB.
async function adjustQty(areaId, typeId, delta) {
  const a = cleanInt(areaId), t = cleanInt(typeId), d = cleanInt(delta);
  if (a === null || t === null || d === null) return { error: 'Bad area, type, or delta' };
  await pool.query(
    `INSERT INTO box_inventory (area_id, type_id, quantity)
     VALUES ($1, $2, GREATEST($3, 0))
     ON CONFLICT (area_id, type_id)
     DO UPDATE SET quantity = GREATEST(box_inventory.quantity + $3, 0), updated_at = now()`,
    [a, t, d]
  );
  return { ok: true };
}

// Set a count to an exact value (clamped at 0).
async function setQty(areaId, typeId, quantity) {
  const a = cleanInt(areaId), t = cleanInt(typeId), q = cleanInt(quantity);
  if (a === null || t === null || q === null) return { error: 'Bad area, type, or quantity' };
  await pool.query(
    `INSERT INTO box_inventory (area_id, type_id, quantity)
     VALUES ($1, $2, GREATEST($3, 0))
     ON CONFLICT (area_id, type_id)
     DO UPDATE SET quantity = GREATEST($3, 0), updated_at = now()`,
    [a, t, q]
  );
  return { ok: true };
}

async function addArea(name) {
  const n = String(name || '').trim();
  if (!n) return { error: 'Area name is required' };
  const { rows } = await pool.query('INSERT INTO box_areas (name) VALUES ($1) RETURNING id', [n]);
  return { ok: true, id: rows[0].id };
}

async function addType(dimensions, reorderAt) {
  const dim = String(dimensions || '').trim();
  if (!dim) return { error: 'Dimensions are required' };
  // reorderAt is optional: null/blank means "no warning".
  let ro = null;
  if (reorderAt !== null && reorderAt !== undefined && String(reorderAt).trim() !== '') {
    ro = cleanInt(reorderAt);
    if (ro === null || ro < 0) return { error: 'Reorder level must be a whole number (0 or more)' };
  }
  const { rows } = await pool.query(
    'INSERT INTO box_types (dimensions, reorder_at) VALUES ($1, $2) RETURNING id', [dim, ro]
  );
  return { ok: true, id: rows[0].id };
}

async function deleteArea(id) {
  const a = cleanInt(id);
  if (a === null) return { error: 'Bad area id' };
  await pool.query('DELETE FROM box_areas WHERE id = $1', [a]);  // inventory cascades
  return { ok: true };
}

async function deleteType(id) {
  const t = cleanInt(id);
  if (t === null) return { error: 'Bad box-type id' };
  await pool.query('DELETE FROM box_types WHERE id = $1', [t]);  // inventory cascades
  return { ok: true };
}

// =================================================================
// HTTP server
// =================================================================

const app = express();
app.use(express.json({ limit: '64kb' }));

app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/health', (req, res) => res.json({ ok: true, app: 'asp-box-tracker' }));

app.post('/api', async (req, res) => {
  const body = req.body || {};
  try {
    let out;
    switch (body.action) {
      case 'getState':   out = await getState(); break;
      case 'adjustQty':  out = await adjustQty(body.areaId, body.typeId, body.delta); break;
      case 'setQty':     out = await setQty(body.areaId, body.typeId, body.quantity); break;
      case 'addArea':    out = await addArea(body.name); break;
      case 'addType':    out = await addType(body.dimensions, body.reorderAt); break;
      case 'deleteArea': out = await deleteArea(body.id); break;
      case 'deleteType': out = await deleteType(body.id); break;
      default:           out = { error: 'Unknown action: ' + body.action };
    }
    res.json(out);
  } catch (err) {
    console.error('handler error:', err);
    res.status(500).json({ error: String(err.message || err) });
  }
});

(async () => {
  try {
    await ensureSchema();
  } catch (e) {
    console.error('ensureSchema failed (continuing to serve anyway):', e);
  }
  app.listen(PORT, () => console.log('ASP Box Tracker listening on port', PORT));
})();
