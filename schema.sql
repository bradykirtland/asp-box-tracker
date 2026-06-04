-- ASP Box Tracker — PostgreSQL schema
-- Three tables: areas, box types (identified by dimensions), and the
-- per-area / per-type counts. The server creates these automatically on boot
-- (see ensureSchema in index.js), so you normally never run this by hand.
-- It's kept here as the record of the data model and for fresh setups.

CREATE TABLE IF NOT EXISTS box_areas (
  id          SERIAL PRIMARY KEY,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS box_types (
  id          SERIAL PRIMARY KEY,
  dimensions  TEXT NOT NULL,          -- e.g. "12x6x6"; this IS the box's identity
  reorder_at  INTEGER,               -- NULL = no restock warning for this box
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per (area, box type). The PRIMARY KEY enforces "one count per box
-- per area". Deleting an area or a box type removes its counts automatically.
CREATE TABLE IF NOT EXISTS box_inventory (
  area_id     INTEGER NOT NULL REFERENCES box_areas(id) ON DELETE CASCADE,
  type_id     INTEGER NOT NULL REFERENCES box_types(id) ON DELETE CASCADE,
  quantity    INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (area_id, type_id)
);
