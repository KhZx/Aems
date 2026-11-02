import { Prisma } from '@prisma/client';
import { prisma } from '../config/prisma.js';

/**
 * Reports / analytics rollup. Everything here is read-only and station-scoped:
 * an ADMIN passes `stationIds: undefined` (all stations) while a SUPERVISOR
 * passes the units they manage. An empty array means "no access" and every
 * section is returned empty.
 *
 * The service deliberately mixes Prisma groupBy (for simple counts) with raw
 * SQL (for windowed/ranked aggregations) so the browser never has to receive
 * the full transaction ledger just to compute a total.
 */

const DAY_MS = 86_400_000;
const WARN_DAYS = 30; // must match js/ui.js
const BELOW_PAR_LIMIT = 200;
const TABLE_LIMIT = 100;

export interface AnalyticsInput {
  stationIds?: string[];
  ambulanceId?: string;
  from: Date;
  to: Date;
  days: number;
}

export interface AnalyticsResult {
  generatedAt: string;
  period: { from: string; to: string; days: number };
  totals: {
    itemLines: number;
    units: number;
    equipmentLines: number;
    equipmentUnits: number;
    medicines: number;
    ambulances: number;
    stations: number;
  };
  health: { expired: number; warning: number; ok: number; noExpiry: number };
  expiry: {
    expiredUnits: number;
    warningUnits: number;
    rows: ExpiryRow[];
  };
  belowPar: { count: number; shortfall: number; rows: BelowParRow[] };
  supply: {
    outstanding: number;
    byStatus: Record<string, number>;
    rows: SupplyRow[];
  };
  repair: { count: number; rows: RepairRow[] };
  consumption: {
    totalUnits: number;
    events: number;
    byDay: Array<{ date: string; units: number }>;
    byItem: Array<{ medicineId: string; medicineName: string; category: string; units: number; events: number }>;
    byStation: Array<{ stationId: string; stationCode: string; stationName: string; units: number }>;
  };
  reasons: Array<{
    code: string;
    labelEn: string;
    labelAr: string;
    family: string;
    events: number;
    units: number;
  }>;
  discrepancies: {
    rows: DiscrepancyRow[];
    byStation: Array<{ stationId: string; stationCode: string; stationName: string; inspections: number; flagged: number; corrections: number }>;
  };
}

export interface ExpiryRow {
  inventoryId: string;
  medicineName: string;
  category: string;
  ambulanceId: string;
  vehicleNumber: string;
  stationCode: string;
  stationName: string;
  quantity: number;
  expiryDate: string;
  daysLeft: number;
  status: 'expired' | 'warning';
}

export interface BelowParRow {
  ambulanceId: string;
  vehicleNumber: string;
  stationId: string;
  stationCode: string;
  stationName: string;
  medicineId: string;
  medicineName: string;
  category: string;
  required: number;
  onHand: number;
  shortfall: number;
}

export interface SupplyRow {
  id: string;
  status: string;
  quantity: number;
  medicineName: string;
  ambulanceId: string;
  vehicleNumber: string;
  stationCode: string;
  stationName: string;
  createdAt: string;
  ageDays: number;
  expectedArrivalAt: string | null;
  reason: string | null;
}

export interface RepairRow {
  inventoryId: string;
  medicineId: string;
  medicineName: string;
  category: string;
  batchNumber: string;
  ambulanceId: string;
  vehicleNumber: string;
  stationCode: string;
  stationName: string;
  quantity: number;
  sentAt: string;
  daysOut: number;
}

export interface DiscrepancyRow {
  ambulanceId: string;
  vehicleNumber: string;
  stationId: string;
  stationCode: string;
  stationName: string;
  inspections: number;
  flagged: number;
  corrections: number;
  unitsOff: number;
  lastAt: string | null;
}

const OUTSTANDING_SUPPLY_STATUSES = ['PENDING', 'APPROVED', 'DISPATCHED', 'IN_TRANSIT', 'RECEIVED'] as const;

/** `AND a."stationId" IN (...)` / `AND a."id" = ...` for raw queries. */
function scopeClause(
  stationIds: string[] | undefined,
  ambulanceId: string | undefined,
  alias: string,
): Prisma.Sql {
  const parts: Prisma.Sql[] = [];
  if (stationIds) {
    parts.push(Prisma.sql`AND ${Prisma.raw(`${alias}."stationId"`)} IN (${Prisma.join(stationIds)})`);
  }
  if (ambulanceId) {
    parts.push(Prisma.sql`AND ${Prisma.raw(`${alias}."id"`)} = ${ambulanceId}`);
  }
  return parts.length ? Prisma.join(parts, ' ') : Prisma.empty;
}

function dayDiff(target: Date, now: number): number {
  return Math.ceil((target.getTime() - now) / DAY_MS);
}

export async function buildAnalytics(input: AnalyticsInput): Promise<AnalyticsResult> {
  const { stationIds, ambulanceId, from, to, days } = input;
  const now = Date.now();
  const generatedAt = new Date().toISOString();
  const period = { from: from.toISOString(), to: to.toISOString(), days };

  const emptyHealth = { expired: 0, warning: 0, ok: 0, noExpiry: 0 };
  const empty: AnalyticsResult = {
    generatedAt,
    period,
    totals: {
      itemLines: 0, units: 0, equipmentLines: 0, equipmentUnits: 0,
      medicines: 0, ambulances: 0, stations: 0,
    },
    health: emptyHealth,
    expiry: { expiredUnits: 0, warningUnits: 0, rows: [] },
    belowPar: { count: 0, shortfall: 0, rows: [] },
    supply: { outstanding: 0, byStatus: {}, rows: [] },
    repair: { count: 0, rows: [] },
    consumption: { totalUnits: 0, events: 0, byDay: [], byItem: [], byStation: [] },
    reasons: [],
    discrepancies: { rows: [], byStation: [] },
  };
  if (stationIds && stationIds.length === 0) return empty;

  const ambulanceScope: Prisma.AmbulanceWhereInput = {
    ...(stationIds ? { stationId: { in: stationIds } } : {}),
    ...(ambulanceId ? { id: ambulanceId } : {}),
  };
  const scope = scopeClause(stationIds, ambulanceId, 'a');

  const inventoryRows = await prisma.inventory.findMany({
    where: {
      deletedAt: null,
      quantity: { gt: 0 },
      batch: { deletedAt: null, medicine: { deletedAt: null } },
      ambulance: ambulanceScope,
    },
    select: {
      id: true,
      quantity: true,
      overrideExpiryDate: true,
      batch: {
        select: {
          expiryDate: true,
          medicine: { select: { id: true, name: true, category: true } },
        },
      },
      ambulance: {
        select: {
          id: true,
          vehicleNumber: true,
          station: { select: { id: true, code: true, name: true } },
        },
      },
    },
  });

  let units = 0;
  let equipmentUnits = 0;
  let equipmentLines = 0;
  const medicineIds = new Set<string>();
  const health = { ...emptyHealth };
  const expiryRows: ExpiryRow[] = [];

  for (const row of inventoryRows) {
    const medicine = row.batch.medicine;
    units += row.quantity;
    medicineIds.add(medicine.id);
    if (medicine.category !== 'MEDICATION') {
      equipmentUnits += row.quantity;
      equipmentLines += 1;
    }
    const effective = row.overrideExpiryDate ?? row.batch.expiryDate;
    if (!effective) {
      health.noExpiry += 1;
      continue;
    }
    const daysLeft = dayDiff(effective, now);
    let status: ExpiryRow['status'] | null = null;
    if (daysLeft < 0) {
      health.expired += 1;
      status = 'expired';
    } else if (daysLeft <= WARN_DAYS) {
      health.warning += 1;
      status = 'warning';
    } else {
      health.ok += 1;
    }
    if (status) {
      expiryRows.push({
        inventoryId: row.id,
        medicineName: medicine.name,
        category: medicine.category,
        ambulanceId: row.ambulance.id,
        vehicleNumber: row.ambulance.vehicleNumber,
        stationCode: row.ambulance.station.code,
        stationName: row.ambulance.station.name,
        quantity: row.quantity,
        expiryDate: effective.toISOString(),
        daysLeft,
        status,
      });
    }
  }
  expiryRows.sort((a, b) => a.daysLeft - b.daysLeft);

  const [
    ambulanceCount,
    stationCount,
    belowParRows,
    supplyByStatus,
    supplyRows,
    repairRows,
    consumptionTotals,
    consumptionByDay,
    consumptionByItem,
    consumptionByStation,
    transactionReasons,
    inspectionReasons,
    reasonCatalog,
    discrepancyRows,
    discrepancyByStation,
  ] = await Promise.all([
    prisma.ambulance.count({
      where: { ...ambulanceScope, status: { not: 'DECOMMISSIONED' } },
    }),
    stationIds
      ? prisma.station.count({ where: { id: { in: stationIds } } })
      : prisma.station.count(),
    prisma.$queryRaw<BelowParRow[]>(Prisma.sql`
      WITH latest_dist AS (
        SELECT DISTINCT ON (d."stationId") d."stationId", d."templateId"
        FROM "Distribution" d
        ORDER BY d."stationId", d."appliedAt" DESC, d."id" DESC
      ),
      required AS (
        SELECT ld."stationId", dti."medicineId", SUM(dtb."quantity")::int AS "required"
        FROM latest_dist ld
        JOIN "DistributionTemplateItem" dti ON dti."templateId" = ld."templateId"
        JOIN "DistributionTemplateBatch" dtb ON dtb."templateItemId" = dti."id"
        WHERE dti."medicineId" IS NOT NULL
        GROUP BY ld."stationId", dti."medicineId"
      ),
      onhand AS (
        SELECT a."id" AS "ambulanceId", b."medicineId", SUM(i."quantity")::int AS "onHand"
        FROM "Inventory" i
        JOIN "Ambulance" a ON a."id" = i."ambulanceId"
        JOIN "MedicineBatch" b ON b."id" = i."batchId"
        WHERE i."deletedAt" IS NULL AND i."quantity" > 0 AND b."deletedAt" IS NULL
        GROUP BY a."id", b."medicineId"
      )
      SELECT a."id" AS "ambulanceId", a."vehicleNumber" AS "vehicleNumber",
        s."id" AS "stationId", s."code" AS "stationCode", s."name" AS "stationName",
        m."id" AS "medicineId", m."name" AS "medicineName", m."category"::text AS "category",
        r."required" AS "required", COALESCE(oh."onHand", 0) AS "onHand",
        (r."required" - COALESCE(oh."onHand", 0)) AS "shortfall"
      FROM "Ambulance" a
      JOIN "Station" s ON s."id" = a."stationId"
      JOIN required r ON r."stationId" = a."stationId"
      JOIN "Medicine" m ON m."id" = r."medicineId"
      LEFT JOIN onhand oh ON oh."ambulanceId" = a."id" AND oh."medicineId" = r."medicineId"
      WHERE a."status" <> 'DECOMMISSIONED'
        AND m."deletedAt" IS NULL
        AND COALESCE(oh."onHand", 0) < r."required"
        ${scope}
      ORDER BY "shortfall" DESC, m."name" ASC
    `),
    prisma.supplyRequest.groupBy({
      by: ['status'],
      where: { status: { in: [...OUTSTANDING_SUPPLY_STATUSES] }, ambulance: ambulanceScope },
      _count: { _all: true },
    }),
    prisma.supplyRequest.findMany({
      where: { status: { in: [...OUTSTANDING_SUPPLY_STATUSES] }, ambulance: ambulanceScope },
      orderBy: { createdAt: 'asc' },
      take: TABLE_LIMIT,
      select: {
        id: true,
        status: true,
        quantity: true,
        reason: true,
        createdAt: true,
        expectedArrivalAt: true,
        medicine: { select: { name: true } },
        ambulance: {
          select: {
            id: true,
            vehicleNumber: true,
            station: { select: { code: true, name: true } },
          },
        },
      },
    }),
    prisma.$queryRaw<RepairRow[]>(Prisma.sql`
      WITH latest AS (
        SELECT DISTINCT ON (t."inventoryId")
          t."inventoryId", t."reasonCode", t."createdAt"
        FROM "InventoryTransaction" t
        ORDER BY t."inventoryId", t."createdAt" DESC, t."id" DESC
      )
      SELECT i."id" AS "inventoryId",
        m."id" AS "medicineId", m."name" AS "medicineName", m."category"::text AS "category",
        b."batchNumber" AS "batchNumber",
        a."id" AS "ambulanceId", a."vehicleNumber" AS "vehicleNumber",
        s."code" AS "stationCode", s."name" AS "stationName",
        i."quantity" AS "quantity", l."createdAt" AS "sentAt"
      FROM latest l
      JOIN "Inventory" i ON i."id" = l."inventoryId"
      JOIN "MedicineBatch" b ON b."id" = i."batchId"
      JOIN "Medicine" m ON m."id" = b."medicineId"
      JOIN "Ambulance" a ON a."id" = i."ambulanceId"
      JOIN "Station" s ON s."id" = a."stationId"
      WHERE l."reasonCode" = 'SENT_MAINTENANCE'
        AND (i."deletedAt" IS NOT NULL OR i."quantity" <= 0)
        ${scope}
      ORDER BY l."createdAt" DESC
    `),
    prisma.$queryRaw<Array<{ events: number; units: number }>>(Prisma.sql`
      SELECT COUNT(*)::int AS "events",
        COALESCE(SUM(-t."quantityChange"), 0)::int AS "units"
      FROM "InventoryTransaction" t
      JOIN "Inventory" i ON i."id" = t."inventoryId"
      JOIN "Ambulance" a ON a."id" = i."ambulanceId"
      WHERE (t."transactionType" = 'USE'
          OR (t."transactionType" = 'INSPECTION_CORRECTION'
            AND t."reasonCode" IN ('USED_PATIENT_CARE', 'WASTED_SPILLED')))
        AND t."quantityChange" < 0
        AND t."createdAt" >= ${from} AND t."createdAt" < ${to}
        ${scope}
    `),
    prisma.$queryRaw<Array<{ date: string; units: number }>>(Prisma.sql`
      SELECT to_char(date_trunc('day', t."createdAt"), 'YYYY-MM-DD') AS "date",
        SUM(-t."quantityChange")::int AS "units"
      FROM "InventoryTransaction" t
      JOIN "Inventory" i ON i."id" = t."inventoryId"
      JOIN "Ambulance" a ON a."id" = i."ambulanceId"
      WHERE (t."transactionType" = 'USE'
          OR (t."transactionType" = 'INSPECTION_CORRECTION'
            AND t."reasonCode" IN ('USED_PATIENT_CARE', 'WASTED_SPILLED')))
        AND t."quantityChange" < 0
        AND t."createdAt" >= ${from} AND t."createdAt" < ${to}
        ${scope}
      GROUP BY 1
      ORDER BY 1
    `),
    prisma.$queryRaw<Array<{ medicineId: string; medicineName: string; category: string; units: number; events: number }>>(Prisma.sql`
      SELECT m."id" AS "medicineId", m."name" AS "medicineName", m."category"::text AS "category",
        SUM(-t."quantityChange")::int AS "units", COUNT(*)::int AS "events"
      FROM "InventoryTransaction" t
      JOIN "Inventory" i ON i."id" = t."inventoryId"
      JOIN "MedicineBatch" b ON b."id" = i."batchId"
      JOIN "Medicine" m ON m."id" = b."medicineId"
      JOIN "Ambulance" a ON a."id" = i."ambulanceId"
      WHERE (t."transactionType" = 'USE'
          OR (t."transactionType" = 'INSPECTION_CORRECTION'
            AND t."reasonCode" IN ('USED_PATIENT_CARE', 'WASTED_SPILLED')))
        AND t."quantityChange" < 0
        AND t."createdAt" >= ${from} AND t."createdAt" < ${to}
        ${scope}
      GROUP BY m."id", m."name", m."category"
      ORDER BY "units" DESC
      LIMIT 15
    `),
    prisma.$queryRaw<Array<{ stationId: string; stationCode: string; stationName: string; units: number }>>(Prisma.sql`
      SELECT s."id" AS "stationId", s."code" AS "stationCode", s."name" AS "stationName",
        SUM(-t."quantityChange")::int AS "units"
      FROM "InventoryTransaction" t
      JOIN "Inventory" i ON i."id" = t."inventoryId"
      JOIN "Ambulance" a ON a."id" = i."ambulanceId"
      JOIN "Station" s ON s."id" = a."stationId"
      WHERE (t."transactionType" = 'USE'
          OR (t."transactionType" = 'INSPECTION_CORRECTION'
            AND t."reasonCode" IN ('USED_PATIENT_CARE', 'WASTED_SPILLED')))
        AND t."quantityChange" < 0
        AND t."createdAt" >= ${from} AND t."createdAt" < ${to}
        ${scope}
      GROUP BY s."id", s."code", s."name"
      ORDER BY "units" DESC
    `),
    prisma.inventoryTransaction.groupBy({
      by: ['reasonCode'],
      where: {
        reasonCode: { not: null },
        quantityChange: { lt: 0 },
        createdAt: { gte: from, lt: to },
        inventory: { ambulance: ambulanceScope },
      },
      _count: { _all: true },
      _sum: { quantityChange: true },
    }),
    prisma.inspectionItemReason.groupBy({
      by: ['reasonCode'],
      where: {
        reasonCode: { not: null },
        inspectionItem: {
          inspection: {
            status: { in: ['COMPLETED', 'ACKNOWLEDGED'] },
            completedAt: { gte: from, lt: to },
            ambulance: ambulanceScope,
          },
        },
      },
      _count: { _all: true },
      _sum: { quantity: true },
    }),
    prisma.stockReason.findMany({ select: { code: true, labelEn: true, labelAr: true, family: true } }),
    prisma.$queryRaw<DiscrepancyRow[]>(Prisma.sql`
      WITH ins AS (
        SELECT i."id", i."ambulanceId", i."correctionCount", i."completedAt"
        FROM "Inspection" i
        JOIN "Ambulance" a ON a."id" = i."ambulanceId"
        WHERE i."status"::text IN ('COMPLETED', 'ACKNOWLEDGED')
          AND i."completedAt" >= ${from} AND i."completedAt" < ${to}
          ${scope}
      ),
      diffs AS (
        SELECT ii."inspectionId", SUM(ABS(ii."difference"))::int AS "unitsOff"
        FROM "InspectionItem" ii
        JOIN ins ON ins."id" = ii."inspectionId"
        GROUP BY ii."inspectionId"
      )
      SELECT a."id" AS "ambulanceId", a."vehicleNumber" AS "vehicleNumber",
        s."id" AS "stationId", s."code" AS "stationCode", s."name" AS "stationName",
        COUNT(ins."id")::int AS "inspections",
        COUNT(ins."id") FILTER (WHERE ins."correctionCount" > 0)::int AS "flagged",
        COALESCE(SUM(ins."correctionCount"), 0)::int AS "corrections",
        COALESCE(SUM(diffs."unitsOff"), 0)::int AS "unitsOff",
        MAX(ins."completedAt") AS "lastAt"
      FROM ins
      JOIN "Ambulance" a ON a."id" = ins."ambulanceId"
      JOIN "Station" s ON s."id" = a."stationId"
      LEFT JOIN diffs ON diffs."inspectionId" = ins."id"
      GROUP BY a."id", a."vehicleNumber", s."id", s."code", s."name"
      HAVING COUNT(ins."id") FILTER (WHERE ins."correctionCount" > 0) > 0
      ORDER BY "corrections" DESC, "unitsOff" DESC, "inspections" DESC
    `),
    prisma.$queryRaw<Array<{ stationId: string; stationCode: string; stationName: string; inspections: number; flagged: number; corrections: number }>>(Prisma.sql`
      SELECT s."id" AS "stationId", s."code" AS "stationCode", s."name" AS "stationName",
        COUNT(i."id")::int AS "inspections",
        COUNT(i."id") FILTER (WHERE i."correctionCount" > 0)::int AS "flagged",
        COALESCE(SUM(i."correctionCount"), 0)::int AS "corrections"
      FROM "Inspection" i
      JOIN "Ambulance" a ON a."id" = i."ambulanceId"
      JOIN "Station" s ON s."id" = a."stationId"
      WHERE i."status"::text IN ('COMPLETED', 'ACKNOWLEDGED')
        AND i."completedAt" >= ${from} AND i."completedAt" < ${to}
        ${scope}
      GROUP BY s."id", s."code", s."name"
      HAVING COUNT(i."id") FILTER (WHERE i."correctionCount" > 0) > 0
      ORDER BY "corrections" DESC
    `),
  ]);

  // ── Merge the two reason sources into one ranked list ─────────
  const labels = new Map(reasonCatalog.map((r) => [r.code, r]));
  const reasonMap = new Map<string, { events: number; units: number }>();
  for (const row of transactionReasons) {
    if (!row.reasonCode) continue;
    const acc = reasonMap.get(row.reasonCode) ?? { events: 0, units: 0 };
    acc.events += row._count._all;
    acc.units += Math.abs(row._sum.quantityChange ?? 0);
    reasonMap.set(row.reasonCode, acc);
  }
  for (const row of inspectionReasons) {
    if (!row.reasonCode) continue;
    const acc = reasonMap.get(row.reasonCode) ?? { events: 0, units: 0 };
    acc.events += row._count._all;
    acc.units += row._sum.quantity ?? 0;
    reasonMap.set(row.reasonCode, acc);
  }
  const reasons = [...reasonMap.entries()]
    .map(([code, value]) => {
      const label = labels.get(code);
      return {
        code,
        labelEn: label?.labelEn ?? code,
        labelAr: label?.labelAr ?? code,
        family: label?.family ?? 'OTHER',
        events: value.events,
        units: value.units,
      };
    })
    // Process reasons (relocation, maintenance holds, data corrections) explain
    // a stock change but not a shortage, so they stay out of this ranking.
    .filter((r) => r.family !== 'PROCESS')
    .sort((a, b) => b.units - a.units || b.events - a.events);

  const supplyStatusMap: Record<string, number> = {};
  for (const row of supplyByStatus) supplyStatusMap[row.status] = row._count._all;

  const consumptionRows = consumptionTotals[0] ?? { events: 0, units: 0 };

  return {
    generatedAt,
    period,
    totals: {
      itemLines: inventoryRows.length,
      units,
      equipmentLines,
      equipmentUnits,
      medicines: medicineIds.size,
      ambulances: ambulanceCount,
      stations: stationCount,
    },
    health,
    expiry: {
      expiredUnits: expiryRows.filter((r) => r.status === 'expired').reduce((n, r) => n + r.quantity, 0),
      warningUnits: expiryRows.filter((r) => r.status === 'warning').reduce((n, r) => n + r.quantity, 0),
      rows: expiryRows.slice(0, TABLE_LIMIT),
    },
    belowPar: {
      count: belowParRows.length,
      shortfall: belowParRows.reduce((n, r) => n + r.shortfall, 0),
      rows: belowParRows.slice(0, BELOW_PAR_LIMIT),
    },
    supply: {
      outstanding: supplyByStatus.reduce((n, r) => n + r._count._all, 0),
      byStatus: supplyStatusMap,
      rows: supplyRows.map((r) => ({
        id: r.id,
        status: r.status,
        quantity: r.quantity,
        medicineName: r.medicine.name,
        ambulanceId: r.ambulance.id,
        vehicleNumber: r.ambulance.vehicleNumber,
        stationCode: r.ambulance.station.code,
        stationName: r.ambulance.station.name,
        createdAt: r.createdAt.toISOString(),
        ageDays: Math.max(0, Math.floor((now - r.createdAt.getTime()) / DAY_MS)),
        expectedArrivalAt: r.expectedArrivalAt ? r.expectedArrivalAt.toISOString() : null,
        reason: r.reason,
      })),
    },
    repair: {
      count: repairRows.length,
      rows: repairRows.slice(0, TABLE_LIMIT).map((r) => ({
        ...r,
        sentAt: new Date(r.sentAt).toISOString(),
        daysOut: Math.max(0, Math.floor((now - new Date(r.sentAt).getTime()) / DAY_MS)),
      })),
    },
    consumption: {
      totalUnits: consumptionRows.units,
      events: consumptionRows.events,
      byDay: consumptionByDay,
      byItem: consumptionByItem,
      byStation: consumptionByStation,
    },
    reasons,
    discrepancies: {
      rows: discrepancyRows.slice(0, TABLE_LIMIT).map((r) => ({
        ...r,
        lastAt: r.lastAt ? new Date(r.lastAt).toISOString() : null,
      })),
      byStation: discrepancyByStation,
    },
  };
}
