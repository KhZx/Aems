// Bootstrap: reconciles the database with prisma/seed-data.json on every deploy.
// All writes are upserts — idempotent, safe on empty, partial or fully-seeded
// databases. A failure here is logged but never blocks the API from starting.
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';

const prisma = new PrismaClient();

const d = (v) => (v == null ? null : new Date(v));

async function main() {
  const raw = JSON.parse(readFileSync(new URL('../prisma/seed-data.json', import.meta.url), 'utf8'));
  let created = 0;
  const note = (n) => { created += n; };

  // Order respects foreign keys: users before the transactions that reference them.
  for (const s of raw.stations) {
    await prisma.station.upsert({
      where: { id: s.id },
      create: { ...s, createdAt: d(s.createdAt), updatedAt: d(s.updatedAt) },
      update: {},
    });
  }
  note(raw.stations.length);

  for (const a of raw.ambulances) {
    await prisma.ambulance.upsert({
      where: { id: a.id },
      create: { ...a, createdAt: d(a.createdAt), updatedAt: d(a.updatedAt) },
      update: {},
    });
  }
  note(raw.ambulances.length);

  for (const m of raw.medicines) {
    await prisma.medicine.upsert({
      where: { id: m.id },
      create: { ...m, deletedAt: d(m.deletedAt), createdAt: d(m.createdAt), updatedAt: d(m.updatedAt) },
      update: {},
    });
  }
  note(raw.medicines.length);

  for (const b of raw.batches) {
    await prisma.medicineBatch.upsert({
      where: { id: b.id },
      create: {
        ...b,
        expiryDate: d(b.expiryDate),
        receivedDate: d(b.receivedDate),
        deletedAt: d(b.deletedAt),
        createdAt: d(b.createdAt),
        updatedAt: d(b.updatedAt),
      },
      update: {},
    });
  }
  note(raw.batches.length);

  for (const i of raw.inventory) {
    await prisma.inventory.upsert({
      where: { id: i.id },
      create: { ...i, deletedAt: d(i.deletedAt), createdAt: d(i.createdAt), updatedAt: d(i.updatedAt) },
      update: {},
    });
  }
  note(raw.inventory.length);

  for (const u of raw.users) {
    await prisma.user.upsert({
      where: { firebaseUid: u.firebaseUid },
      create: {
        ...u,
        approvedAt: d(u.approvedAt),
        createdAt: d(u.createdAt),
        updatedAt: d(u.updatedAt),
        lastLoginAt: d(u.lastLoginAt),
      },
      update: {},
    });
  }
  note(raw.users.length);

  for (const t of raw.inventoryTransactions) {
    await prisma.inventoryTransaction.upsert({
      where: { id: t.id },
      create: { ...t, createdAt: d(t.createdAt) },
      update: {},
    });
  }
  note(raw.inventoryTransactions.length);

  for (const m of raw.managedStations) {
    await prisma.managedStation.upsert({
      where: { userId_stationId: { userId: m.userId, stationId: m.stationId } },
      create: { ...m },
      update: {},
    });
  }
  note(raw.managedStations.length);

  console.log(`bootstrap: database now holds ${created} seeded rows (upserts, idempotent)`);
}

main()
  .catch((err) => {
    console.error('bootstrap failed (service will still start):', err.message);
  })
  .finally(() => prisma.$disconnect());
