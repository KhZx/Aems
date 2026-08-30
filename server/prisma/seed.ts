import { PrismaClient, MedicineCategory } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Seeds reference data: stations, ambulances, medicines, batches and initial
 * stock. Idempotent — safe to run repeatedly.
 *
 * Users are NOT seeded here: real accounts are created via Firebase Auth and
 * self-registration. Bootstrap your first ADMIN by setting BOOTSTRAP_ADMIN_UID
 * and registering that Firebase account.
 */
async function main() {
  // ── Stations (units — code is the car number) ───────────────
  const central = await prisma.station.upsert({
    where: { code: '01' },
    update: { name: 'Central Station', location: 'Main City — Ambulance Bay 1' },
    create: { code: '01', name: 'Central Station', location: 'Main City — Ambulance Bay 1' },
  });
  const south = await prisma.station.upsert({
    where: { code: '02' },
    update: { name: 'South Station', location: 'South District' },
    create: { code: '02', name: 'South Station', location: 'South District' },
  });
  const north = await prisma.station.upsert({
    where: { code: '03' },
    update: { name: 'North Station', location: 'North District' },
    create: { code: '03', name: 'North Station', location: 'North District' },
  });

  // ── Ambulances (one car per unit; car number = unit code) ───
  const ambCentral = await prisma.ambulance.upsert({
    where: { vehicleNumber: '01' },
    update: { stationId: central.id },
    create: { vehicleNumber: '01', stationId: central.id },
  });
  await prisma.ambulance.upsert({
    where: { vehicleNumber: '02' },
    update: { stationId: south.id },
    create: { vehicleNumber: '02', stationId: south.id },
  });
  await prisma.ambulance.upsert({
    where: { vehicleNumber: '03' },
    update: { stationId: north.id },
    create: { vehicleNumber: '03', stationId: north.id },
  });

  // ── Medicines ─────────────────────────────────────────────
  const meds = [
    {
      name: 'Paracetamol',
      genericName: 'Acetaminophen',
      category: MedicineCategory.MEDICATION,
      strength: '500mg',
      dosageForm: 'Tablet',
      unit: 'tab',
      barcode: 'AEMS-PARA-500',
      minimumStock: 20,
      maximumStock: 200,
    },
    {
      name: 'Ibuprofen',
      genericName: 'Ibuprofen',
      category: MedicineCategory.MEDICATION,
      strength: '400mg',
      dosageForm: 'Tablet',
      unit: 'tab',
      barcode: 'AEMS-IBU-400',
      minimumStock: 10,
      maximumStock: 100,
    },
    {
      name: 'Adrenaline (Epinephrine)',
      genericName: 'Epinephrine',
      category: MedicineCategory.MEDICATION,
      strength: '1mg/1ml',
      dosageForm: 'Ampoule',
      unit: 'amp',
      barcode: 'AEMS-ADR-1MG',
      minimumStock: 5,
      maximumStock: 30,
    },
    {
      name: 'Lifepak 15 Defib Pads',
      genericName: null,
      category: MedicineCategory.LIFEPAK,
      strength: null,
      dosageForm: 'Set',
      unit: 'set',
      barcode: 'AEMS-LP15-PADS',
      minimumStock: 2,
      maximumStock: 10,
    },
    {
      name: 'Ambu Bag (Adult)',
      genericName: null,
      category: MedicineCategory.RESPONDER,
      strength: null,
      dosageForm: 'Unit',
      unit: 'pc',
      barcode: 'AEMS-AMBUBAG-AD',
      minimumStock: 2,
      maximumStock: 8,
    },
  ];

  const medicineIds: string[] = [];
  for (const m of meds) {
    const med = await prisma.medicine.upsert({
      where: { barcode: m.barcode },
      update: {},
      create: m,
    });
    medicineIds.push(med.id);
  }

  // ── Batches (two expiry dates per medicine for FEFO demo) ──
  const now = new Date();
  const inDays = (d: number) => new Date(now.getTime() + d * 86_400_000).toISOString().slice(0, 10);

  const batchRows: Array<{ medicineId: string; batchNumber: string; expiryDate: string; supplier: string }> = [];
  medicineIds.forEach((medicineId, i) => {
    const near = 45 + i;
    const far = 400 + i * 30;
    batchRows.push(
      { medicineId, batchNumber: `B${i + 1}A`, expiryDate: inDays(near), supplier: 'MEDI-SUPPLY CO' },
      { medicineId, batchNumber: `B${i + 1}B`, expiryDate: inDays(far), supplier: 'MEDI-SUPPLY CO' },
    );
  });

  for (const b of batchRows) {
    await prisma.medicineBatch.upsert({
      where: { medicineId_batchNumber: { medicineId: b.medicineId, batchNumber: b.batchNumber } },
      update: {},
      create: {
        medicineId: b.medicineId,
        batchNumber: b.batchNumber,
        expiryDate: new Date(b.expiryDate),
        supplier: b.supplier,
      },
    });
  }

  // ── Initial stock on unit 01's car ────────────────────────
  const batches = await prisma.medicineBatch.findMany();
  let stockCount = 0;
  for (const batch of batches) {
    const exists = await prisma.inventory.findUnique({
      where: { ambulanceId_batchId: { ambulanceId: ambCentral.id, batchId: batch.id } },
    });
    if (!exists) {
      const qty = 15 + (stockCount % 20);
      const inv = await prisma.inventory.create({
        data: { ambulanceId: ambCentral.id, batchId: batch.id, quantity: qty },
      });
      await prisma.inventoryTransaction.create({
        data: {
          inventoryId: inv.id,
          transactionType: 'INITIAL_STOCK',
          quantityChange: qty,
          quantityBefore: 0,
          quantityAfter: qty,
          reason: 'Seed: initial stock load',
        },
      });
      stockCount++;
    }
  }

  console.log(
    `Seeded: 3 units, 3 cars, ${medicineIds.length} medicines, ${batches.length} batches, ~${stockCount} initial stock rows.`,
  );
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
