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

  // Optional whole-box barcode (legacy / dimension labels). Safe to re-run.
  await pool.query(`ALTER TABLE box_types ADD COLUMN IF NOT EXISTS barcode TEXT`);

  // Per-station barcodes: a barcode is tied to one box AT one area, so the
  // same box size can have a different label at each station.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS box_barcodes (
      barcode  TEXT PRIMARY KEY,
      type_id  INTEGER NOT NULL REFERENCES box_types(id) ON DELETE CASCADE,
      area_id  INTEGER NOT NULL REFERENCES box_areas(id) ON DELETE CASCADE,
      UNIQUE (type_id, area_id)
    )
  `);

  // Incoming orders: a named order with box-size lines. Scanning its code
  // (ORD-<id>) on arrival fills those boxes into an area.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS orders (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL DEFAULT '',
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS order_lines (
      id        SERIAL PRIMARY KEY,
      order_id  INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      type_id   INTEGER NOT NULL REFERENCES box_types(id) ON DELETE CASCADE,
      qty       INTEGER NOT NULL CHECK (qty > 0)
    )
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
  const [areas, types, inv, bc] = await Promise.all([
    pool.query('SELECT id, name FROM box_areas ORDER BY id'),
    pool.query('SELECT id, dimensions, reorder_at AS "reorderAt", barcode FROM box_types ORDER BY id'),
    pool.query('SELECT area_id, type_id, quantity FROM box_inventory'),
    pool.query('SELECT barcode, type_id AS "typeId", area_id AS "areaId" FROM box_barcodes'),
  ]);
  const inventory = {};
  for (const r of inv.rows) inventory[`${r.area_id}:${r.type_id}`] = r.quantity;
  return { areas: areas.rows, boxTypes: types.rows, inventory, barcodes: bc.rows };
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
// Scanning
// =================================================================

// Look up a box by a scanned code. First tries a PER-STATION barcode (which
// also tells us which area/station the label is for); then falls back to a
// whole-box barcode or the dimensions text. Returns the box, the matched
// station (if any), and current stock at EVERY area.
async function lookupBarcode(code) {
  const c = String(code || '').trim();
  if (!c) return { found: false, code: c };
  const norm = c.toLowerCase();

  let type = null;
  let matchedAreaId = null;

  // 1) Per-station barcode → we know the box AND the station.
  const st = await pool.query(
    `SELECT bb.type_id, bb.area_id, t.dimensions, t.reorder_at AS "reorderAt"
       FROM box_barcodes bb JOIN box_types t ON t.id = bb.type_id
      WHERE lower(bb.barcode) = $1 LIMIT 1`,
    [norm]
  );
  if (st.rows.length) {
    type = { id: st.rows[0].type_id, dimensions: st.rows[0].dimensions, reorderAt: st.rows[0].reorderAt };
    matchedAreaId = st.rows[0].area_id;
  } else {
    // 2) Whole-box barcode or the dimensions text (e.g. a printed "12x6x6").
    const r = await pool.query(
      `SELECT id, dimensions, reorder_at AS "reorderAt"
         FROM box_types
        WHERE lower(coalesce(barcode, '')) = $1 OR lower(dimensions) = $1
        ORDER BY id LIMIT 1`,
      [norm]
    );
    if (r.rows.length) type = { id: r.rows[0].id, dimensions: r.rows[0].dimensions, reorderAt: r.rows[0].reorderAt };
  }

  if (!type) return { found: false, code: c };

  const { rows: areas } = await pool.query(
    `SELECT a.id, a.name, coalesce(i.quantity, 0) AS qty
       FROM box_areas a
       LEFT JOIN box_inventory i ON i.area_id = a.id AND i.type_id = $1
      ORDER BY a.id`,
    [type.id]
  );
  const locs = areas.map(r => ({ id: r.id, name: r.name, qty: Number(r.qty) }));
  return { found: true, type, matchedAreaId, areas: locs, total: locs.reduce((s, r) => s + r.qty, 0) };
}

// Assign (or change) the barcode for a specific box AT a specific station.
// One barcode per (box, station); replaces any previous one for that pair, and
// detaches the barcode from anywhere else it was used.
async function setStationBarcode(typeId, areaId, barcode) {
  const t = cleanInt(typeId), a = cleanInt(areaId);
  const bc = String(barcode || '').trim();
  if (t === null) return { error: 'Bad box id' };
  if (a === null) return { error: 'Bad station id' };
  if (!bc) return { error: 'Barcode is required' };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`DELETE FROM box_barcodes WHERE lower(barcode) = lower($1)`, [bc]);
    await client.query(`DELETE FROM box_barcodes WHERE type_id = $1 AND area_id = $2`, [t, a]);
    await client.query(`INSERT INTO box_barcodes (barcode, type_id, area_id) VALUES ($1, $2, $3)`, [bc, t, a]);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { ok: true };
}

// Ensure every box has a barcode at every station, generating a stable
// "ASP-<box>-<station>" code for any pair that lacks one. The Labels page calls
// this so there's a printable, scannable label per box per station. Existing
// (e.g. manually linked) barcodes are left untouched.
async function ensureStationBarcodes() {
  await pool.query(`
    INSERT INTO box_barcodes (barcode, type_id, area_id)
    SELECT 'ASP-' || t.id || '-' || a.id, t.id, a.id
      FROM box_types t CROSS JOIN box_areas a
     WHERE NOT EXISTS (SELECT 1 FROM box_barcodes b WHERE b.type_id = t.id AND b.area_id = a.id)
    ON CONFLICT (barcode) DO NOTHING
  `);
  return { ok: true };
}

// =================================================================
// Orders (incoming shipments)
// =================================================================

async function createOrder(name, lines) {
  const nm = String(name || '').trim() || 'Order';
  if (!Array.isArray(lines)) return { error: 'No box lines' };
  const clean = [];
  for (const l of (lines || [])) {
    const tid = cleanInt(l && l.typeId), q = cleanInt(l && l.qty);
    if (tid !== null && q !== null && q > 0) clean.push({ typeId: tid, qty: q });
  }
  if (!clean.length) return { error: 'Add at least one box with a quantity' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query('INSERT INTO orders (name) VALUES ($1) RETURNING id', [nm]);
    const id = rows[0].id;
    for (const l of clean) {
      await client.query('INSERT INTO order_lines (order_id, type_id, qty) VALUES ($1, $2, $3)', [id, l.typeId, l.qty]);
    }
    await client.query('COMMIT');
    return { ok: true, id, barcode: 'ORD-' + id };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

async function listOrders() {
  const { rows } = await pool.query(`
    SELECT o.id, o.name,
           coalesce(
             json_agg(json_build_object('typeId', l.type_id, 'dimensions', t.dimensions, 'qty', l.qty)
                      ORDER BY t.dimensions) FILTER (WHERE l.id IS NOT NULL),
             '[]'
           ) AS lines
      FROM orders o
      LEFT JOIN order_lines l ON l.order_id = o.id
      LEFT JOIN box_types t ON t.id = l.type_id
     GROUP BY o.id
     ORDER BY o.id DESC`);
  return { orders: rows.map(r => ({ id: r.id, name: r.name, barcode: 'ORD-' + r.id, lines: r.lines })) };
}

async function lookupOrder(code) {
  const m = /^ord-(\d+)$/i.exec(String(code || '').trim());
  if (!m) return { found: false };
  const id = parseInt(m[1], 10);
  const { rows: o } = await pool.query('SELECT id, name FROM orders WHERE id = $1', [id]);
  if (!o.length) return { found: false };
  const { rows: lines } = await pool.query(
    `SELECT l.type_id AS "typeId", t.dimensions, l.qty
       FROM order_lines l JOIN box_types t ON t.id = l.type_id
      WHERE l.order_id = $1 ORDER BY t.dimensions`, [id]
  );
  return { found: true, order: { id: o[0].id, name: o[0].name, barcode: 'ORD-' + id }, lines };
}

// Fill an order's boxes INTO an area (adds the quantities).
async function fillOrder(orderId, areaId) {
  const oid = cleanInt(orderId), aid = cleanInt(areaId);
  if (oid === null) return { error: 'Bad order id' };
  if (aid === null) return { error: 'Bad area id' };
  const { rows: lines } = await pool.query('SELECT type_id, qty FROM order_lines WHERE order_id = $1', [oid]);
  if (!lines.length) return { error: 'Order has no boxes' };
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const l of lines) {
      await client.query(
        `INSERT INTO box_inventory (area_id, type_id, quantity) VALUES ($1, $2, $3)
         ON CONFLICT (area_id, type_id)
         DO UPDATE SET quantity = GREATEST(box_inventory.quantity + $3, 0), updated_at = now()`,
        [aid, l.type_id, l.qty]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  return { ok: true, lines: lines.length };
}

async function deleteOrder(id) {
  const oid = cleanInt(id);
  if (oid === null) return { error: 'Bad order id' };
  await pool.query('DELETE FROM orders WHERE id = $1', [oid]);   // lines cascade
  return { ok: true };
}

// =================================================================
// HTTP server
// =================================================================

const app = express();
app.use(express.json({ limit: '64kb' }));

function sendPage(res, file) {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.sendFile(path.join(__dirname, file));
}

app.get('/', (req, res) => sendPage(res, 'index.html'));
app.get('/labels', (req, res) => sendPage(res, 'labels.html'));  // printable barcodes

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
      case 'lookupBarcode':     out = await lookupBarcode(body.code); break;
      case 'setStationBarcode': out = await setStationBarcode(body.typeId, body.areaId, body.barcode); break;
      case 'ensureStationBarcodes': out = await ensureStationBarcodes(); break;
      case 'createOrder': out = await createOrder(body.name, body.lines); break;
      case 'listOrders':  out = await listOrders(); break;
      case 'lookupOrder': out = await lookupOrder(body.code); break;
      case 'fillOrder':   out = await fillOrder(body.orderId, body.areaId); break;
      case 'deleteOrder': out = await deleteOrder(body.id); break;
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
