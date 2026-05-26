import { readFileSync } from 'node:fs';

import * as XLSX from 'xlsx';

export type ParsedEventCategory = 'growth' | 'hardware_change' | 'openshift';

export interface ParsedEvent {
  effectiveDate: string; // 'YYYY-MM-DD'
  title: string;
  category: ParsedEventCategory;
  capacityDelta: number | null;
  consumptionDelta: number | null;
}

export interface ParsedCluster {
  name: string;
  baselineConsumption: number;
  baselineCapacity: number;
  events: ParsedEvent[];
}

const SHEET_NAME = 'Forecast';
const HEADER_ROW = 7; // 1-indexed; row 7 carries the month dates
const FIRST_DATA_COL = 'F'; // first month column
const LAST_DATA_COL = 'AA'; // last month column

// Sub-event columns have no date in the header row; they share the calendar
// month of the immediately-preceding column (L belongs to K's month, P to O's).
const SUB_EVENT_PARENT_MAP: Record<string, string> = {
  L: 'K',
  P: 'O',
};

// Offset from the cluster name row to each data row within the block:
//   +0 = event title labels
//   +2 = HW-Limit Δ (capacity delta)
//   +3 = Verbrauch Δ (consumption delta)
//   +4 = baseline values (C = consumption, D = capacity)
const OFFSET_HW_DELTA = 2;
const OFFSET_CONSUMPTION_DELTA = 3;
const OFFSET_BASELINE = 4;

export function inferCategory(title: string): ParsedEventCategory {
  const t = title.trim();
  if (/^Wachstum/i.test(t)) return 'growth';
  if (/^Ausbau|^Umbau/i.test(t)) return 'hardware_change';
  if (/OpenShift/i.test(t)) return 'openshift';
  throw new Error(
    `Unmapped event title prefix: ${JSON.stringify(title)}. Add a rule to inferCategory.`,
  );
}

/**
 * Convert a Date returned by xlsx (`cellDates: true`) into 'YYYY-MM-01' for
 * the month the spreadsheet author wrote.
 *
 * `xlsx` applies the host timezone offset when producing Date objects (it
 * preserves the "wall-clock" value of the Excel cell as a local-TZ instant).
 * So a cell stored as 2026-05-01 comes back as `Date(2026-04-30T22:00:00Z)`
 * in UTC+2 and as `Date(2026-05-01T00:00:00Z)` in UTC. Re-anchor by adding
 * the local offset back so getUTC* returns the original wall-clock fields
 * regardless of where the test runs.
 */
function cellDateToMonthStart(d: Date): string {
  const reanchored = new Date(d.getTime() - d.getTimezoneOffset() * 60_000);
  const yyyy = reanchored.getUTCFullYear();
  const mm = String(reanchored.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}-01`;
}

interface MonthByColumn {
  [col: string]: string; // YYYY-MM-DD (always first of month)
}

function buildMonthByColumn(ws: XLSX.WorkSheet): MonthByColumn {
  const map: MonthByColumn = {};
  const start = XLSX.utils.decode_col(FIRST_DATA_COL);
  const end = XLSX.utils.decode_col(LAST_DATA_COL);

  // First pass: columns that have a date in the header row
  for (let c = start; c <= end; c++) {
    const col = XLSX.utils.encode_col(c);
    const addr = `${col}${HEADER_ROW}`;
    const cell = ws[addr];
    if (cell && cell.v instanceof Date) {
      map[col] = cellDateToMonthStart(cell.v);
    }
  }

  // Second pass: sub-event columns inherit their parent's month as-is.
  // These are appended to the iteration order (L and P land after AA in
  // Object.keys()), but `parseCapacityXlsx` sorts events by effectiveDate
  // afterwards, so the column-iteration order does not affect output order.
  for (const [sub, parent] of Object.entries(SUB_EVENT_PARENT_MAP)) {
    if (map[parent]) map[sub] = map[parent];
  }

  return map;
}

function readNumber(ws: XLSX.WorkSheet, col: string, row: number): number | null {
  const cell = ws[`${col}${row}`];
  if (!cell || cell.v === null || cell.v === undefined || cell.v === '') return null;
  const n = Number(cell.v);
  if (!Number.isFinite(n)) return null;
  return n;
}

function readString(ws: XLSX.WorkSheet, col: string, row: number): string | null {
  const cell = ws[`${col}${row}`];
  if (!cell || cell.v === null || cell.v === undefined) return null;
  const s = String(cell.v).trim();
  return s.length > 0 ? s : null;
}

/** Find the 1-indexed rows where cluster names (CL-*) appear in column B. */
function findClusterHeaderRows(ws: XLSX.WorkSheet): number[] {
  const rows: number[] = [];
  const range = XLSX.utils.decode_range(ws['!ref'] ?? 'A1');
  for (let r = HEADER_ROW + 1; r <= range.e.r + 1; r++) {
    const name = readString(ws, 'B', r);
    if (name && /^CL-/.test(name)) rows.push(r);
  }
  return rows;
}

export function parseCapacityXlsx(filePath: string): ParsedCluster[] {
  const buf = readFileSync(filePath);
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true });
  const ws = wb.Sheets[SHEET_NAME];
  if (!ws) {
    throw new Error(
      `Missing sheet '${SHEET_NAME}' in ${filePath}. Sheets: ${wb.SheetNames.join(', ')}`,
    );
  }

  const monthByColumn = buildMonthByColumn(ws);
  const headerRows = findClusterHeaderRows(ws);
  const result: ParsedCluster[] = [];

  for (const headerRow of headerRows) {
    const name = readString(ws, 'B', headerRow);
    if (!name) continue;

    const baselineRow = headerRow + OFFSET_BASELINE;
    const baselineConsumption = readNumber(ws, 'C', baselineRow);
    const baselineCapacity = readNumber(ws, 'D', baselineRow);
    if (baselineConsumption === null || baselineCapacity === null) {
      throw new Error(`Cluster '${name}' row ${baselineRow} missing baseline values in C/D`);
    }

    const events: ParsedEvent[] = [];

    for (const col of Object.keys(monthByColumn)) {
      const title = readString(ws, col, headerRow);
      if (!title) continue;

      const capacityDelta = readNumber(ws, col, headerRow + OFFSET_HW_DELTA);
      const consumptionDelta = readNumber(ws, col, headerRow + OFFSET_CONSUMPTION_DELTA);

      // Zero-delta filter: skip rows where both deltas are zero or missing.
      const capacityIsZero = capacityDelta === null || capacityDelta === 0;
      const consumptionIsZero = consumptionDelta === null || consumptionDelta === 0;
      if (capacityIsZero && consumptionIsZero) continue;

      events.push({
        effectiveDate: monthByColumn[col]!,
        title,
        category: inferCategory(title),
        capacityDelta: capacityDelta !== null && capacityDelta !== 0 ? capacityDelta : null,
        consumptionDelta:
          consumptionDelta !== null && consumptionDelta !== 0 ? consumptionDelta : null,
      });
    }

    // Stable sort by effectiveDate ascending.
    events.sort((a, b) => a.effectiveDate.localeCompare(b.effectiveDate));

    result.push({ name, baselineConsumption, baselineCapacity, events });
  }

  return result;
}
