// Bootstrap: seeds reference data + users into an EMPTY database on deploy.
// Guarded by station count — a no-op on any database that already has data.
// A failure here is logged but never blocks the API from starting.
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';

const prisma = new PrismaClient();

const d = (v) => (v == null ? null : new Date(v));

async function main() {
  const stationCount = await prisma.station.count();
  if (stationCount > 0) {
    console.log(`bootstrap: ${stationCount} stations already present — skipping`);
    return;
  }

  const raw = JSON.parse(readFileSync(new URL('../prisma/seed-data.json', import.meta.url), 'utf8'));

  for (const s of raw.stations) {
    await prisma.station.create({ data: { ...s, createdAt: d(s.createdAt), updatedAt: d(s.updatedAt) } });
  }
  for (const a of raw.ambulances) {
    await prisma.ambulance.create({ data: { ...a, createdAt: d(a.createdAt), updatedAt: d(a.updatedAt) } });
  }
  for (const m of raw.medicines) {
    await prisma.medicine.create({
      data: { ...m, deletedAt: d(m.deletedAt), createdAt: d(m.createdAt), updatedAt: d(m.updatedAt) },
    });
  }
  for (const b of raw.batches) {
    await prisma.medicineBatch.create({
      data: {
        ...b,
        expiryDate: d(b.expiryDate),
        receivedDate: d(b.receivedDate),
        deletedAt: d(b.deletedAt),
        createdAt: d(b.createdAt),
        updatedAt: d(b.updatedAt),
      },
    });
  }
  for (const i of raw.inventory) {
    await prisma.inventory.create({
      data: { ...i, deletedAt: d(i.deletedAt), createdAt: d(i.createdAt), updatedAt: d(i.updatedAt) },
    });
  }
  for (const t of raw.inventoryTransactions) {
    await prisma.inventoryTransaction.create({ data: { ...t, createdAt: d(t.createdAt) } });
  }
  for (const u of raw.users) {
    await prisma.user.create({
      data: {
        ...u,
        approvedAt: d(u.approvedAt),
        createdAt: d(u.createdAt),
        updatedAt: d(u.updatedAt),
        lastLoginAt: d(u.lastLoginAt),
      },
    });
  }
  for (const m of raw.managedStations) {
    await prisma.managedStation.create({ data: { ...m } });
  }

  console.log(
    `bootstrap: seeded ${raw.stations.length} stations, ${raw.ambulances.length} ambulances, ` +
      `${raw.medicines.length} medicines, ${raw.batches.length} batches, ${raw.inventory.length} inventory rows, ` +
      `${raw.users.length} users`,
  );
}

main()
  .catch((err) => {
    console.error('bootstrap failed (service will still start):', err.message);
  })
  .finally(() => prisma.$disconnect());
