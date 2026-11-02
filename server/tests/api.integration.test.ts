import { describe, expect, it, beforeAll, vi, afterAll } from 'vitest';
import { execSync } from 'node:child_process';
import request from 'supertest';
import type { Express } from 'express';

const HAS_DB = Boolean(process.env.TEST_DATABASE_URL);

// Firebase token -> identity map so tests can mint arbitrary verified tokens.
const mockTokens = vi.hoisted(() => ({
  identities: new Map<string, { uid: string; email: string | null }>(),
  addToken(token: string, uid: string, email: string | null = null) {
    this.identities.set(token, { uid, email });
  },
}));

vi.mock('../src/config/firebase.js', () => ({
  firebaseConfigured: () => true,
  adminAuth: () => ({
    verifyIdToken: async (token: string) => {
      const identity = mockTokens.identities.get(token);
      if (!identity) throw new Error('mock: unknown token');
      return { uid: identity.uid, email: identity.email };
    },
  }),
  firebaseAdmin: () => ({
    app: {},
    auth: {
      verifyIdToken: async (token: string) => {
        const identity = mockTokens.identities.get(token);
        if (!identity) throw new Error('mock: unknown token');
        return { uid: identity.uid, email: identity.email };
      },
    },
  }),
}));

// Imported after the mock + env setup.
const { createApp } = await import('../src/app.js');
const { prisma } = await import('../src/config/prisma.js');
const { syncStockReasons } = await import('../src/config/stockReasons.js');
const notificationService = await import('../src/services/notification.service.js');

describe.skipIf(!HAS_DB)('AEMS API integration', () => {
  let app: Express;
  let adminToken: string;

  let stationId: string;
  let ambulanceA: string;
  let ambulanceB: string;
  let medicineId: string;
  let batchId: string;

  beforeAll(async () => {
    execSync('npx prisma db push --force-reset --skip-generate', { stdio: 'pipe', timeout: 120_000 });
    await syncStockReasons(prisma);
    app = createApp();

    const station = await prisma.station.create({ data: { code: '100', name: 'Test Station' } });
    stationId = station.id;

    const ambA = await prisma.ambulance.create({ data: { stationId, vehicleNumber: 'TST-AMB-A' } });
    const ambB = await prisma.ambulance.create({ data: { stationId, vehicleNumber: 'TST-AMB-B' } });
    ambulanceA = ambA.id;
    ambulanceB = ambB.id;

    const med = await prisma.medicine.create({
      data: { name: 'Test Med', category: 'MEDICATION' },
    });
    medicineId = med.id;

    const batch = await prisma.medicineBatch.create({
      data: { medicineId: med.id, batchNumber: 'TB-1', expiryDate: new Date('2027-01-01') },
    });
    batchId = batch.id;

    await prisma.inventory.create({ data: { ambulanceId: ambA.id, batchId: batch.id, quantity: 10 } });
    await prisma.inventory.create({ data: { ambulanceId: ambB.id, batchId: batch.id, quantity: 3 } });

    const admin = await prisma.user.create({
      data: {
        firebaseUid: 'uid-admin',
        email: 'admin@test.dev',
        displayName: 'Admin',
        role: 'ADMIN',
        status: 'ACTIVE',
      },
    });

    await prisma.user.create({
      data: {
        firebaseUid: 'uid-pending',
        email: 'pending@test.dev',
        displayName: 'Pending User',
        role: 'PARAMEDIC',
        status: 'PENDING',
        stationId,
      },
    });

    await prisma.user.create({
      data: {
        firebaseUid: 'uid-paramedic',
        email: 'paramedic@test.dev',
        displayName: 'Paramedic',
        role: 'PARAMEDIC',
        status: 'ACTIVE',
        stationId,
      },
    });

    adminToken = 'token-admin';
    mockTokens.addToken(adminToken, 'uid-admin', 'admin@test.dev');
    mockTokens.addToken('token-pending', 'uid-pending', 'pending@test.dev');
    mockTokens.addToken('token-paramedic', 'uid-paramedic', 'paramedic@test.dev');
    expect(admin).toBeTruthy();
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('keeps notifications private to their recipient and marks them read idempotently', async () => {
    const paramedic = await prisma.user.findUniqueOrThrow({ where: { firebaseUid: 'uid-paramedic' } });
    const notification = await prisma.notification.create({
      data: {
        userId: paramedic.id,
        stationId,
        type: 'TEST_NOTIFICATION',
        severity: 'ACTION',
        titleKey: 'notifications.title',
        bodyKey: 'notifications.empty',
        data: { page: 'dashboard' },
        dedupeKey: `test-notification-${Date.now()}`,
      },
    });

    const crewList = await request(app).get('/api/notifications?pageSize=20').set(auth('token-paramedic')).expect(200);
    expect(crewList.body.data.notifications.some((n: { id: string }) => n.id === notification.id)).toBe(true);
    expect(crewList.body.data.unread).toBeGreaterThan(0);

    const adminList = await request(app).get('/api/notifications?pageSize=20').set(auth(adminToken)).expect(200);
    expect(adminList.body.data.notifications.some((n: { id: string }) => n.id === notification.id)).toBe(false);

    await request(app).post(`/api/notifications/${notification.id}/read`).set(auth('token-paramedic')).expect(200);
    await request(app).post(`/api/notifications/${notification.id}/read`).set(auth('token-paramedic')).expect(200);
    const unread = await request(app).get('/api/notifications?unreadOnly=true').set(auth('token-paramedic')).expect(200);
    expect(unread.body.data.notifications.some((n: { id: string }) => n.id === notification.id)).toBe(false);
  });

  it('streams refresh events only to the authenticated notification recipient', async () => {
    const paramedic = await prisma.user.findUniqueOrThrow({ where: { firebaseUid: 'uid-paramedic' } });
    const server = app.listen(0);
    try {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Test server did not bind a TCP port');
      const response = await fetch(`http://127.0.0.1:${address.port}/api/notifications/stream`, {
        headers: { Authorization: 'Bearer token-paramedic' },
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      const ready = decoder.decode((await reader.read()).value);
      expect(ready).toContain('event: ready');

      await notificationService.notifyUser(paramedic.id, {
        type: 'TEST_STREAM', severity: 'INFO', titleKey: 'notifications.title',
        bodyKey: 'notifications.empty', data: { page: 'dashboard' },
        dedupeKey: `stream-test-${Date.now()}`,
      });
      const update = decoder.decode((await reader.read()).value);
      expect(update).toContain('event: refresh');
      await reader.cancel();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  // Full unit-operator flow: page-load GETs + add-medicine with the new form.
  it('lets a paramedic load unit data and add a medicine with blank optional fields', async () => {
    const sid = stationId;
    const gets = await Promise.all([
      request(app).get(`/api/inventory?stationId=${sid}&includeEmpty=true`).set(auth('token-paramedic')),
      request(app).get(`/api/shift-notes?stationId=${sid}&pageSize=50`).set(auth('token-paramedic')),
      request(app).get(`/api/handovers?stationId=${sid}&pageSize=50`).set(auth('token-paramedic')),
    ]);
    for (const res of gets) expect(res.status).toBe(200);

    const firstInventoryPage = await request(app)
      .get(`/api/inventory?stationId=${sid}&includeEmpty=true&page=1&pageSize=1`)
      .set(auth('token-paramedic'))
      .expect(200);
    const secondInventoryPage = await request(app)
      .get(`/api/inventory?stationId=${sid}&includeEmpty=true&page=2&pageSize=1`)
      .set(auth('token-paramedic'))
      .expect(200);
    expect(firstInventoryPage.body.data.total).toBe(2);
    expect(firstInventoryPage.body.data.items).toHaveLength(1);
    expect(secondInventoryPage.body.data.items).toHaveLength(1);
    expect(firstInventoryPage.body.data.items[0].id).not.toBe(secondInventoryPage.body.data.items[0].id);

    const medRes = await request(app)
      .post('/api/medicines')
      .set(auth('token-paramedic'))
      .send({ name: 'Listed Dressing', category: 'RESPONDER', location: '', serialNumber: '', notes: '', technicalNotes: '', barcode: '' });
    expect(medRes.status).toBe(201);
    expect(medRes.body.data.name).toBe('Listed Dressing');

    const batchRes = await request(app)
      .post('/api/batches')
      .set(auth('token-paramedic'))
      .send({ medicineId: medRes.body.data.id, batchNumber: 'LISTED-1', expiryDate: '2027-12-31', supplier: '' });
    expect(batchRes.status).toBe(201);

    const stockRes = await request(app)
      .post('/api/inventory/restock')
      .set(auth('token-paramedic'))
      .send({ ambulanceId: ambulanceA, batchId: batchRes.body.data.id, quantity: 2, reason: 'initial stock' });
    expect(stockRes.status).toBe(201);

    const listRes = await request(app)
      .get(`/api/inventory?stationId=${sid}&includeEmpty=false`)
      .set(auth('token-paramedic'));
    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body.data)).toBe(true);
    expect(listRes.body.data.some((r: any) => r.id === stockRes.body.data.id)).toBe(true);
  });

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });

  async function invIdFor(ambulanceId: string): Promise<string> {
    const row = await prisma.inventory.findUniqueOrThrow({
      where: { ambulanceId_batchId: { ambulanceId, batchId } },
    });
    return row.id;
  }

  it('lets a unit override its own lot without touching the shared batch or other units', async () => {
    const invA = await invIdFor(ambulanceA);

    const res = await request(app)
      .patch(`/api/inventory/${invA}/lot`)
      .set(auth('token-paramedic'))
      .send({ batchNumber: 'TB-1-UNIT-A', reason: 'Relabel for this unit' });
    expect(res.status).toBe(200);
    expect(res.body.data.batch.batchNumber).toBe('TB-1-UNIT-A');
    expect(res.body.data.hasLotOverride).toBe(true);

    // The shared catalogue batch the fleet publishes is untouched.
    const shared = await prisma.medicineBatch.findUniqueOrThrow({ where: { id: batchId } });
    expect(shared.batchNumber).toBe('TB-1');

    // The other ambulance's line for the very same batch keeps the shared value.
    const invB = await invIdFor(ambulanceB);
    const bRow = await prisma.inventory.findUniqueOrThrow({ where: { id: invB } });
    expect(bRow.overrideBatchNumber).toBeNull();
    const list = await request(app)
      .get(`/api/inventory?stationId=${stationId}&includeEmpty=true`)
      .set(auth('token-paramedic'))
      .expect(200);
    const bSeen = (list.body.data as any[]).find(r => r.id === invB);
    expect(bSeen.batch.batchNumber).toBe('TB-1');
    expect(bSeen.hasLotOverride).toBe(false);

    // Audit records the per-unit edit with the shared number for context.
    const audit = await prisma.auditLog.findFirst({
      where: { action: 'UPDATE_STOCK_LOT', entityId: invA },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).toBeTruthy();
    expect(audit?.entityType).toBe('Inventory');
    const meta = audit?.metadata as any;
    expect(meta.reason).toBe('Relabel for this unit');
    expect(meta.sharedBatchNumber).toBe('TB-1');
    expect(meta.changes.batchNumber).toEqual({ from: 'TB-1', to: 'TB-1-UNIT-A' });
  });

  it('rejects a per-unit lot edit without a reason (400)', async () => {
    const invA = await invIdFor(ambulanceA);
    await request(app)
      .patch(`/api/inventory/${invA}/lot`)
      .set(auth('token-paramedic'))
      .send({ batchNumber: 'TB-X' })
      .expect(400);
  });

  it('clears the per-unit override when the value is set back to the shared lot', async () => {
    const invA = await invIdFor(ambulanceA);
    const res = await request(app)
      .patch(`/api/inventory/${invA}/lot`)
      .set(auth('token-paramedic'))
      .send({ batchNumber: 'TB-1', reason: 'Re-sync with published lot' })
      .expect(200);
    expect(res.body.data.batch.batchNumber).toBe('TB-1');
    expect(res.body.data.hasLotOverride).toBe(false);
    const row = await prisma.inventory.findUniqueOrThrow({ where: { id: invA } });
    expect(row.overrideBatchNumber).toBeNull();
  });

  it('edits the shared batch with a reason and records a field-level audit entry', async () => {
    const res = await request(app)
      .patch(`/api/batches/${batchId}`)
      .set(auth(adminToken))
      .send({ batchNumber: 'TB-1B', supplier: 'Acme Supplies', expiryDate: '2027-06-30', reason: 'Corrected supplier' });
    expect(res.status).toBe(200);
    expect(res.body.data.batchNumber).toBe('TB-1B');
    expect(res.body.data.supplier).toBe('Acme Supplies');

    const audit = await prisma.auditLog.findFirst({
      where: { action: 'UPDATE_BATCH', entityId: batchId },
      orderBy: { createdAt: 'desc' },
    });
    expect(audit).toBeTruthy();
    expect(audit?.entityType).toBe('MedicineBatch');
    const meta = audit?.metadata as any;
    expect(meta.reason).toBe('Corrected supplier');
    expect(meta.changes.batchNumber).toEqual({ from: 'TB-1', to: 'TB-1B' });
    expect(meta.changes.supplier).toEqual({ from: null, to: 'Acme Supplies' });
  });

  it('rejects a shared-batch edit without a reason (400)', async () => {
    await request(app)
      .patch(`/api/batches/${batchId}`)
      .set(auth(adminToken))
      .send({ supplier: 'No Reason Co' })
      .expect(400);
  });

  it('lets a paramedic edit a batch with a reason (all-roles policy, still audited)', async () => {
    const res = await request(app)
      .patch(`/api/batches/${batchId}`)
      .set(auth('token-paramedic'))
      .send({ batchNumber: 'TB-CREW', reason: 'Recount during inspection' })
      .expect(200);
    expect(res.body.data.batchNumber).toBe('TB-CREW');

    // The reason stays mandatory for every role, crews included.
    await request(app)
      .patch(`/api/batches/${batchId}`)
      .set(auth('token-paramedic'))
      .send({ supplier: 'No Reason Co' })
      .expect(400);
  });

  it('rejects a batch number that clashes with another lot (409)', async () => {
    const other = await prisma.medicineBatch.create({
      data: { medicineId, batchNumber: 'TB-CLASH', expiryDate: new Date('2028-01-01') },
    });
    const res = await request(app)
      .patch(`/api/batches/${batchId}`)
      .set(auth(adminToken))
      .send({ batchNumber: 'TB-CLASH', reason: 'Attempted clash' });
    expect(res.status).toBe(409);
    await prisma.medicineBatch.delete({ where: { id: other.id } });
  });

  it('rejects missing token with 401', async () => {
    await request(app).get('/api/auth/me').expect(401);
  });

  it('rejects invalid token with 401', async () => {
    await request(app).get('/api/auth/me').set(auth('not-a-real-token')).expect(401);
  });

  it('accepts a valid token for an active user', async () => {
    const res = await request(app).get('/api/auth/me').set(auth(adminToken)).expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.email).toBe('admin@test.dev');
    expect(res.body.data.permissions).toContain('user:approve');
  });

  it('blocks a pending user (403)', async () => {
    await request(app).get('/api/auth/me').set(auth('token-pending')).expect(403);
  });

  it('approval flow activates a pending user', async () => {
    const pending = await prisma.user.findUniqueOrThrow({ where: { firebaseUid: 'uid-pending' } });
    const res = await request(app)
      .post(`/api/users/${pending.id}/approve`)
      .set(auth(adminToken))
      .send({ role: 'PARAMEDIC', stationCode: '100' })
      .expect(200);
    expect(res.body.data.status).toBe('ACTIVE');

    const me = await request(app).get('/api/auth/me').set(auth('token-pending')).expect(200);
    expect(me.body.data.user.status).toBe('ACTIVE');
  });

  it('forbids a paramedic from admin-only user management', async () => {
    await request(app).post('/api/users/some-id/approve').set(auth('token-paramedic')).send({ role: 'PARAMEDIC' }).expect(403);
  });

  it('records an inventory use (10 -> 8) and decrements exactly', async () => {
    const inv = await prisma.inventory.findFirstOrThrow({
      where: { ambulanceId: ambulanceA, batchId },
    });
    const res = await request(app)
      .post('/api/inventory/use')
      .set(auth(adminToken))
      .send({ ambulanceId: ambulanceA, medicineId, quantity: 2, reason: 'Patient treatment' })
      .expect(200);
    expect(res.body.data.remaining).toBe(8);

    const after = await prisma.inventory.findUniqueOrThrow({ where: { id: inv.id } });
    expect(after.quantity).toBe(8);

    const tx = await prisma.inventoryTransaction.findMany({ where: { inventoryId: inv.id }, orderBy: { createdAt: 'desc' } });
    expect(tx[0].transactionType).toBe('USE');
    expect(tx[0].quantityChange).toBe(-2);
  });

  it('rejects overdraw (use more than in stock)', async () => {
    const res = await request(app)
      .post('/api/inventory/use')
      .set(auth(adminToken))
      .send({ ambulanceId: ambulanceA, medicineId, quantity: 999, reason: 'Should fail' })
      .expect(409);
    expect(res.body.success).toBe(false);
  });

  it('transfers stock atomically between ambulances', async () => {
    const res = await request(app)
      .post('/api/inventory/transfer')
      .set(auth(adminToken))
      .send({ sourceInventoryId: await getInvA(), destinationAmbulanceId: ambulanceB, quantity: 3 })
      .expect(201);
    expect(res.body.data.sourceRemaining).toBe(5);
    expect(res.body.data.destinationQuantity).toBe(6);

    const [a, b] = await Promise.all([
      prisma.inventory.findUniqueOrThrow({ where: { ambulanceId_batchId: { ambulanceId: ambulanceA, batchId } } }),
      prisma.inventory.findUniqueOrThrow({ where: { ambulanceId_batchId: { ambulanceId: ambulanceB, batchId } } }),
    ]);
    expect(a.quantity).toBe(5);
    expect(b.quantity).toBe(6);

    const transfers = await prisma.transfer.findMany({ orderBy: { createdAt: 'desc' }, take: 1 });
    expect(transfers[0].status).toBe('COMPLETED');
  });

  it('rolls back a failed transfer entirely', async () => {
    const beforeA = (await prisma.inventory.findUniqueOrThrow({ where: { ambulanceId_batchId: { ambulanceId: ambulanceA, batchId } } })).quantity;
    const beforeB = (await prisma.inventory.findUniqueOrThrow({ where: { ambulanceId_batchId: { ambulanceId: ambulanceB, batchId } } })).quantity;

    await request(app)
      .post('/api/inventory/transfer')
      .set(auth(adminToken))
      .send({ sourceInventoryId: await getInvA(), destinationAmbulanceId: ambulanceB, quantity: 9999 })
      .expect(409);

    const afterA = (await prisma.inventory.findUniqueOrThrow({ where: { ambulanceId_batchId: { ambulanceId: ambulanceA, batchId } } })).quantity;
    const afterB = (await prisma.inventory.findUniqueOrThrow({ where: { ambulanceId_batchId: { ambulanceId: ambulanceB, batchId } } })).quantity;
    expect(afterA).toBe(beforeA);
    expect(afterB).toBe(beforeB);
  });

  it('writes an audit entry for operations', async () => {
    const logs = await prisma.auditLog.findMany({ where: { action: 'USE_MEDICINE' }, orderBy: { createdAt: 'desc' }, take: 1 });
    expect(logs[0]).toBeTruthy();
    expect(logs[0].stationId).toBe(stationId);
  });

  it('lists inventory scoped to a station', async () => {
    const res = await request(app).get(`/api/inventory?stationId=${stationId}`).set(auth(adminToken)).expect(200);
    expect(res.body.data.length).toBeGreaterThan(0);
  });

  it('coerces numeric query params for user listing', async () => {
    const res = await request(app)
      .get('/api/users?page=1&pageSize=2')
      .set(auth(adminToken))
      .expect(200);
    expect(res.body.data.total).toBe(3);
    expect(res.body.data.pageSize).toBe(2);
    expect(res.body.data.users.length).toBe(2);
  });

  it('reports server/database health publicly', async () => {
    const res = await request(app).get('/api/health').expect(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.server).toBe('ok');
    expect(res.body.data.database).toBe('ok');
  });

  it('serves the structured reason catalog, filtered by item type and action', async () => {
    const all = await request(app).get('/api/stock-reasons').set(auth('token-paramedic')).expect(200);
    const codes = all.body.data.reasons.map((r: { code: string }) => r.code);
    expect(codes).toContain('EXPIRED');
    expect(codes).toContain('NOT_CHECKED');
    expect(codes).toContain('USED_PATIENT_CARE');

    const forUse = await request(app)
      .get('/api/stock-reasons?action=USE&itemType=MEDICATION')
      .set(auth('token-paramedic'))
      .expect(200);
    for (const r of forUse.body.data.reasons) {
      expect(r.actions).toContain('USE');
      expect(r.itemTypes).toContain('MEDICATION');
    }
    expect(forUse.body.data.reasons.length).toBeGreaterThan(0);
    expect(forUse.body.data.reasons.length).toBeLessThan(all.body.data.reasons.length);
  });

  it('rejects an unauthenticated reason-catalog request (401)', async () => {
    await request(app).get('/api/stock-reasons').expect(401);
  });

  it('creating a station auto-creates its unit car and rejects non-digit codes', async () => {
    const created = await request(app)
      .post('/api/stations')
      .set(auth(adminToken))
      .send({ code: '777', name: 'Unit 777' })
      .expect(201);
    const car = await prisma.ambulance.findFirst({ where: { stationId: created.body.data.id } });
    expect(car?.vehicleNumber).toBe('777');

    await request(app)
      .post('/api/stations')
      .set(auth(adminToken))
      .send({ code: 'CEN-99', name: 'Bad Code' })
      .expect(400);
  });

  it('edits a station: renames + re-numbers its own car, and rejects clashes', async () => {
    // A fresh unit keeps the code change isolated from other tests.
    const created = await request(app)
      .post('/api/stations')
      .set(auth(adminToken))
      .send({ code: '810', name: 'Unit 810' })
      .expect(201);
    const id = created.body.data.id;

    const updated = await request(app)
      .patch(`/api/stations/${id}`)
      .set(auth(adminToken))
      .send({ code: '811', name: 'Unit 811 Renamed', location: 'Al Barsha' })
      .expect(200);
    expect(updated.body.data.code).toBe('811');
    expect(updated.body.data.name).toBe('Unit 811 Renamed');
    expect(updated.body.data.location).toBe('Al Barsha');

    // The unit's OWN car follows the new unit number (numbered to match).
    const car = await prisma.ambulance.findFirst({ where: { stationId: id } });
    expect(car?.vehicleNumber).toBe('811');

    // A code already used by ANOTHER unit is rejected.
    await request(app)
      .patch(`/api/stations/${id}`)
      .set(auth(adminToken))
      .send({ code: '100' })
      .expect(409);

    // Non-digit codes are rejected by validation.
    await request(app)
      .patch(`/api/stations/${id}`)
      .set(auth(adminToken))
      .send({ code: 'ABC' })
      .expect(400);

    // Editing details never touches inventory or assigned users.
    const inv = await prisma.inventory.count({ where: { ambulance: { stationId: id } } });
    expect(inv).toBe(0);
  });

  it('only admins may edit or delete stations (403 for crew)', async () => {
    await request(app)
      .patch(`/api/stations/${stationId}`)
      .set(auth('token-paramedic'))
      .send({ name: 'Nope' })
      .expect(403);
    await request(app).delete(`/api/stations/${stationId}`).set(auth('token-paramedic')).expect(403);
  });

  it('refuses to delete a station that still has history, and says why', async () => {
    const res = await request(app).delete(`/api/stations/${stationId}`).set(auth(adminToken)).expect(409);
    expect(res.body.error.message).toMatch(/cannot be deleted/i);
    expect(res.body.error.message).toMatch(/inactive/i);
    // The station itself is untouched.
    expect(await prisma.station.findUnique({ where: { id: stationId } })).toBeTruthy();
  });

  it('just-created empty station can be hard-deleted (with its auto car)', async () => {
    const created = await request(app)
      .post('/api/stations')
      .set(auth(adminToken))
      .send({ code: '812', name: 'Unit 812' })
      .expect(201);
    const id = created.body.data.id;

    await request(app).delete(`/api/stations/${id}`).set(auth(adminToken)).expect(204);
    expect(await prisma.station.findUnique({ where: { id } })).toBeNull();
    expect(await prisma.ambulance.count({ where: { stationId: id } })).toBe(0);
  });

  it('deactivates a station without deleting history, hiding it from the public list', async () => {
    const res = await request(app)
      .patch(`/api/stations/${stationId}`)
      .set(auth(adminToken))
      .send({ status: 'INACTIVE' })
      .expect(200);
    expect(res.body.data.status).toBe('INACTIVE');

    const pub = await request(app).get('/api/public/stations').expect(200);
    expect(pub.body.data.some((s: { id: string }) => s.id === stationId)).toBe(false);

    // Restore for any later tests.
    await request(app)
      .patch(`/api/stations/${stationId}`)
      .set(auth(adminToken))
      .send({ status: 'ACTIVE' })
      .expect(200);
  });

  it('creates a medicine with details, its batch, then restocks a car', async () => {
    const med = await request(app)
      .post('/api/medicines')
      .set(auth(adminToken))
      .send({
        name: 'Test Dressing',
        category: 'RESPONDER',
        location: 'Upper cabinet',
        serialNumber: 'SN-9001',
        notes: 'Handle gently',
        technicalNotes: 'Keep dry',
        barcode: '520-9001',
      })
      .expect(201);
    expect(med.body.data.location).toBe('Upper cabinet');
    expect(med.body.data.serialNumber).toBe('SN-9001');
    expect(med.body.data.technicalNotes).toBe('Keep dry');

    const batch = await request(app)
      .post('/api/batches')
      .set(auth(adminToken))
      .send({ medicineId: med.body.data.id, batchNumber: 'LOT-TEST-1', expiryDate: '2027-12-31' })
      .expect(201);

    const restock = await request(app)
      .post('/api/inventory/restock')
      .set(auth(adminToken))
      .send({ ambulanceId: ambulanceA, batchId: batch.body.data.id, quantity: 6, reason: 'Integration test' })
      .expect(201);
    expect(restock.body.data.quantity).toBe(6);
  });

  async function getInvA(): Promise<string> {
    const row = await prisma.inventory.findUniqueOrThrow({ where: { ambulanceId_batchId: { ambulanceId: ambulanceA, batchId } } });
    return row.id;
  }

  // ─────────────────────────────────────────────────────────────
  //  Free-form inspection lifecycle.
  // ─────────────────────────────────────────────────────────────
  describe('inspection lifecycle', () => {
    let inspBatchId: string;
    let inspInventoryId: string;

    beforeAll(async () => {
      const med = await prisma.medicine.create({
        data: { name: `Inspectable ${Date.now()}`, category: 'RESPONDER' },
      });
      const batch = await prisma.medicineBatch.create({
        data: { medicineId: med.id, batchNumber: `IB-${Date.now()}`, expiryDate: new Date('2028-01-01') },
      });
      inspBatchId = batch.id;
      const inv = await prisma.inventory.create({
        data: { ambulanceId: ambulanceA, batchId: batch.id, quantity: 5 },
      });
      inspInventoryId = inv.id;
    });

    it('creates a draft, resumes it, then completing reconciles stock (auto-report)', async () => {
      const draft = await request(app)
        .post('/api/inspections')
        .set(auth('token-paramedic'))
        .send({
          ambulanceId: ambulanceA,
          title: 'Evening check',
          items: [{ inventoryId: inspInventoryId, actualQuantity: 5, condition: 'OK' }],
        })
        .expect(201);
      expect(draft.body.data.status).toBe('DRAFT');
      const id = draft.body.data.id as string;

      // Resume: mark it missing with a structured reason.
      await request(app)
        .put(`/api/inspections/${id}`)
        .set(auth('token-paramedic'))
        .send({ items: [{ inventoryId: inspInventoryId, actualQuantity: 3, condition: 'MISSING', reasonCode: 'LOST_OPERATIONS' }] })
        .expect(200);

      const detailBefore = await request(app).get(`/api/inspections/${id}`).set(auth('token-paramedic')).expect(200);
      expect(detailBefore.body.data.items).toHaveLength(1);
      expect(detailBefore.body.data.items[0].condition).toBe('MISSING');

      const done = await request(app)
        .post(`/api/inspections/${id}/complete`)
        .set(auth('token-paramedic'))
        .expect(200);
      expect(done.body.data.inspection.status).toBe('COMPLETED');
      expect(done.body.data.corrections).toHaveLength(1);
      expect(done.body.data.corrections[0].difference).toBe(-2);

      const inv = await prisma.inventory.findUniqueOrThrow({ where: { id: inspInventoryId } });
      expect(inv.quantity).toBe(3);

      const tx = await prisma.inventoryTransaction.findFirst({
        where: { referenceId: id, transactionType: 'INSPECTION_CORRECTION' },
      });
      expect(inv.quantity).toBe(3);
      expect(tx?.reasonCode).toBe('LOST_OPERATIONS');

      // Completed reports are immutable: the performer can no longer edit them.
      await request(app)
        .put(`/api/inspections/${id}`)
        .set(auth('token-paramedic'))
        .send({ items: [] })
        .expect(409);

      // A field crew member cannot acknowledge their own inspection.
      await request(app).post(`/api/inspections/${id}/acknowledge`).set(auth('token-paramedic')).send({}).expect(403);

      // A supervisor-admin acknowledges and closes the loop.
      const ack = await request(app)
        .post(`/api/inspections/${id}/acknowledge`)
        .set(auth(adminToken))
        .send({ reviewNotes: 'Noted' })
        .expect(200);
      expect(ack.body.data.status).toBe('ACKNOWLEDGED');
    });

    it('requires a reason for a loss line and rejects unknown reasons (400)', async () => {
      const draft = await request(app)
        .post('/api/inspections')
        .set(auth('token-paramedic'))
        .send({ ambulanceId: ambulanceA, items: [] })
        .expect(201);
      const id = draft.body.data.id as string;

      await request(app)
        .put(`/api/inspections/${id}`)
        .set(auth('token-paramedic'))
        .send({ items: [{ inventoryId: inspInventoryId, actualQuantity: 2, condition: 'MISSING' }] })
        .expect(400);

      await request(app)
        .put(`/api/inspections/${id}`)
        .set(auth('token-paramedic'))
        .send({ items: [{ inventoryId: inspInventoryId, actualQuantity: 2, condition: 'MISSING', reasonCode: 'NOPE' }] })
        .expect(400);

      await request(app).delete(`/api/inspections/${id}`).set(auth('token-paramedic')).expect(200);
    });

    it('splits one discrepancy across several reasons (e.g. 1 used + 1 lost)', async () => {
      await prisma.inventory.update({ where: { id: inspInventoryId }, data: { quantity: 5 } });

      const draft = await request(app)
        .post('/api/inspections')
        .set(auth('token-paramedic'))
        .send({ ambulanceId: ambulanceA, items: [] })
        .expect(201);
      const id = draft.body.data.id as string;

      // Sum of the split lines must equal the counted difference (5 → 3 = -2).
      const bad = await request(app)
        .put(`/api/inspections/${id}`)
        .set(auth('token-paramedic'))
        .send({
          items: [{
            inventoryId: inspInventoryId,
            actualQuantity: 3,
            condition: 'MISSING',
            reasonLines: [{ code: 'USED_PATIENT_CARE', quantity: 1 }],
          }],
        })
        .expect(400);
      expect(JSON.stringify(bad.body)).toMatch(/add up/i);

      await request(app)
        .put(`/api/inspections/${id}`)
        .set(auth('token-paramedic'))
        .send({
          items: [{
            inventoryId: inspInventoryId,
            actualQuantity: 3,
            condition: 'MISSING',
            reasonLines: [
              { code: 'USED_PATIENT_CARE', quantity: 1 },
              { code: 'LOST_OPERATIONS', quantity: 1 },
            ],
          }],
        })
        .expect(200);

      const detail = await request(app).get(`/api/inspections/${id}`).set(auth('token-paramedic')).expect(200);
      expect(detail.body.data.items[0].reasonLines).toHaveLength(2);
      expect(detail.body.data.items[0].reasonLines[0].reasonCode).toBe('USED_PATIENT_CARE');

      const done = await request(app)
        .post(`/api/inspections/${id}/complete`)
        .set(auth('token-paramedic'))
        .expect(200);
      expect(done.body.data.corrections[0].difference).toBe(-2);
      expect(done.body.data.corrections[0].lines).toHaveLength(2);
      expect(done.body.data.corrections[0].lines.map((l: { code: string }) => l.code).sort()).toEqual([
        'LOST_OPERATIONS',
        'USED_PATIENT_CARE',
      ]);

      const inv = await prisma.inventory.findUniqueOrThrow({ where: { id: inspInventoryId } });
      expect(inv.quantity).toBe(3);
    });

    it('compares a new inspection with the previous completed snapshot for the same ambulance', async () => {
      await prisma.inventory.update({ where: { id: inspInventoryId }, data: { quantity: 5 } });
      const baseline = await request(app)
        .post('/api/inspections')
        .set(auth('token-paramedic'))
        .send({ ambulanceId: ambulanceA, items: [] })
        .expect(201);
      const baselineId = baseline.body.data.id as string;
      await request(app)
        .put(`/api/inspections/${baselineId}`)
        .set(auth('token-paramedic'))
        .send({ items: [{ inventoryId: inspInventoryId, actualQuantity: 3, condition: 'MISSING', reasonCode: 'LOST_OPERATIONS' }] })
        .expect(200);
      await request(app).post(`/api/inspections/${baselineId}/complete`).set(auth('token-paramedic')).expect(200);
      await prisma.inventory.update({ where: { id: inspInventoryId }, data: { quantity: 5 } });

      const draft = await request(app)
        .post('/api/inspections')
        .set(auth('token-paramedic'))
        .send({ ambulanceId: ambulanceA, items: [] })
        .expect(201);
      const id = draft.body.data.id as string;

      await request(app)
        .put(`/api/inspections/${id}`)
        .set(auth('token-paramedic'))
        .send({ items: [{
          inventoryId: inspInventoryId,
          actualQuantity: 4,
          condition: 'MISSING',
          reasonLines: [
            { code: 'USED_PATIENT_CARE', quantity: 1 },
          ],
        }] })
        .expect(200);
      await request(app).post(`/api/inspections/${id}/complete`).set(auth('token-paramedic')).expect(200);

      const overview = await request(app)
        .get('/api/inspections/overview?days=0')
        .set(auth(adminToken))
        .expect(200);
      expect(overview.body.data.inspections.find((i: { id: string }) => i.id === id).status).toBe('COMPLETED');
      const comparison = overview.body.data.comparisons.find((c: { inspectionId: string }) => c.inspectionId === id);
      expect(comparison.previousInspectionId).toBe(baselineId);
      expect(comparison.changedItems).toBe(1);
      expect(comparison.qtyIncreased).toBe(1);

      const detail = await request(app)
        .get(`/api/inspections/${id}`)
        .set(auth(adminToken))
        .expect(200);
      expect(detail.body.data.previousInspection.id).toBe(baselineId);
      expect(detail.body.data.previousInspection.items[0].actualQuantity).toBe(3);

      // The other ambulance is at the same station, but must start its own baseline.
      const ambulanceBInventoryId = await invIdFor(ambulanceB);
      const otherDraft = await request(app)
        .post('/api/inspections')
        .set(auth('token-paramedic'))
        .send({ ambulanceId: ambulanceB, items: [{ inventoryId: ambulanceBInventoryId, actualQuantity: 3, condition: 'OK' }] })
        .expect(201);
      await request(app).post(`/api/inspections/${otherDraft.body.data.id}/complete`).set(auth('token-paramedic')).expect(200);
      const perAmbulance = await request(app)
        .get('/api/inspections/overview?days=0')
        .set(auth(adminToken))
        .expect(200);
      const otherComparison = perAmbulance.body.data.comparisons.find((c: { ambulanceId: string }) => c.ambulanceId === ambulanceB);
      expect(otherComparison.previousInspectionId).toBeNull();
    });

    it('voiding a completed inspection reverses its corrections', async () => {
      await prisma.inventory.update({ where: { id: inspInventoryId }, data: { quantity: 3 } });
      const draft = await request(app)
        .post('/api/inspections')
        .set(auth('token-paramedic'))
        .send({
          ambulanceId: ambulanceA,
          items: [{ inventoryId: inspInventoryId, actualQuantity: 10, condition: 'EXTRA', reasonCode: 'MISFILED' }],
        })
        .expect(201);
      const id = draft.body.data.id as string;

      // Completing bumps stock to the counted value...
      await request(app).post(`/api/inspections/${id}/complete`).set(auth('token-paramedic')).expect(200);
      let inv = await prisma.inventory.findUniqueOrThrow({ where: { id: inspInventoryId } });
      expect(inv.quantity).toBe(10);

      // ...and voiding restores the pre-inspection quantity.
      const voided = await request(app)
        .post(`/api/inspections/${id}/void`)
        .set(auth(adminToken))
        .send({ voidReason: 'Miscounted' })
        .expect(200);
      expect(voided.body.data.status).toBe('VOID');
      inv = await prisma.inventory.findUniqueOrThrow({ where: { id: inspInventoryId } });
      expect(inv.quantity).toBe(3);
      expect(inspBatchId).toBeTruthy();
    });
  });

  // ─────────────────────────────────────────────────────────────
  //  Supply-request fulfilment: approve → dispatch (held) → receive →
  //  double-confirm (credits stock) → close.
  // ─────────────────────────────────────────────────────────────
  describe('supply request lifecycle', () => {
    let medId: string;
    let supplyBatchId: string;

    beforeAll(async () => {
      const med = await prisma.medicine.create({ data: { name: `Resupply ${Date.now()}`, category: 'MEDICATION' } });
      medId = med.id;
      const batch = await prisma.medicineBatch.create({
        data: { medicineId: med.id, batchNumber: `SB-${Date.now()}`, expiryDate: new Date('2029-01-01') },
      });
      supplyBatchId = batch.id;
    });

    it('runs the full held → double-confirmed flow and credits stock on confirm', async () => {
      const created = await request(app)
        .post('/api/supply-requests')
        .set(auth('token-paramedic'))
        .send({ ambulanceId: ambulanceA, medicineId: medId, quantity: 4, reason: 'Low stock' })
        .expect(201);
      const id = created.body.data.id as string;
      expect(created.body.data.status).toBe('PENDING');

      await request(app)
        .patch(`/api/supply-requests/${id}/status`)
        .set(auth(adminToken))
        .send({ status: 'APPROVED' })
        .expect(200);

      const dispatched = await request(app)
        .post(`/api/supply-requests/${id}/dispatch`)
        .set(auth(adminToken))
        .send({ batchId: supplyBatchId, expectedArrivalAt: '2026-10-20T10:00:00.000Z' })
        .expect(200);
      expect(dispatched.body.data.status).toBe('DISPATCHED');

      // Stock is NOT credited yet (the item is on arrival hold).
      expect(await prisma.inventory.findUnique({ where: { ambulanceId_batchId: { ambulanceId: ambulanceA, batchId: supplyBatchId } } })).toBeNull();

      const received = await request(app)
        .post(`/api/supply-requests/${id}/receive`)
        .set(auth('token-paramedic'))
        .send({ receivedQuantity: 4 })
        .expect(200);
      expect(received.body.data.status).toBe('RECEIVED');

      const confirmed = await request(app)
        .post(`/api/supply-requests/${id}/confirm`)
        .set(auth(adminToken))
        .expect(200);
      expect(confirmed.body.data.status).toBe('FULFILLED');

      const inv = await prisma.inventory.findUnique({ where: { ambulanceId_batchId: { ambulanceId: ambulanceA, batchId: supplyBatchId } } });
      expect(inv?.quantity).toBe(4);

      const closed = await request(app)
        .post(`/api/supply-requests/${id}/close`)
        .set(auth(adminToken))
        .expect(200);
      expect(closed.body.data.status).toBe('CLOSED');
    });

    it('rejects FULFILLED on the generic review endpoint (must use dispatch → receive → confirm)', async () => {
      const created = await request(app)
        .post('/api/supply-requests')
        .set(auth('token-paramedic'))
        .send({ ambulanceId: ambulanceA, medicineId: medId, quantity: 2, reason: 'Low stock' })
        .expect(201);
      const id = created.body.data.id as string;

      await request(app)
        .patch(`/api/supply-requests/${id}/status`)
        .set(auth(adminToken))
        .send({ status: 'APPROVED' })
        .expect(200);

      // Jumping straight to FULFILLED would skip the arrival hold and credit
      // no stock, so the review endpoint must refuse it.
      await request(app)
        .patch(`/api/supply-requests/${id}/status`)
        .set(auth(adminToken))
        .send({ status: 'FULFILLED' })
        .expect(400);

      // The request must be untouched by the rejected call.
      const after = await prisma.supplyRequest.findUnique({ where: { id } });
      expect(after?.status).toBe('APPROVED');
    });

    it('forbids a paramedic from dispatching or confirming (403)', async () => {
      const created = await request(app)
        .post('/api/supply-requests')
        .set(auth('token-paramedic'))
        .send({ ambulanceId: ambulanceA, medicineId: medId, quantity: 1 })
        .expect(201);
      const id = created.body.data.id as string;
      await request(app).post(`/api/supply-requests/${id}/dispatch`).set(auth('token-paramedic')).send({}).expect(403);
      await request(app).post(`/api/supply-requests/${id}/confirm`).set(auth('token-paramedic')).expect(403);
    });
  });

  // ─────────────────────────────────────────────────────────────
  //  Security boundaries — the "rogue crew member" scenarios.
  // ─────────────────────────────────────────────────────────────
  describe('cross-unit and privilege boundaries', () => {
    let stationB: string;
    let ambulanceBUnit: string;
    let paramedicToken: string;
    let otherMedicToken: string;
    let supervisorToken: string;

    beforeAll(async () => {
      // A second unit the field crew has no access to.
      const b = await prisma.station.create({ data: { code: '200', name: 'Other Unit' } });
      stationB = b.id;
      const amb = await prisma.ambulance.create({ data: { stationId: b.id, vehicleNumber: 'TST-AMB-200' } });
      ambulanceBUnit = amb.id;
      const otherBatch = await prisma.medicineBatch.create({
        data: { medicineId, batchNumber: 'TB-200', expiryDate: new Date('2027-01-01') },
      });
      await prisma.inventory.create({ data: { ambulanceId: amb.id, batchId: otherBatch.id, quantity: 5 } });

      await prisma.user.create({
        data: { firebaseUid: 'uid-emt', email: 'emt@test.dev', displayName: 'EMT', role: 'EMT', status: 'ACTIVE', stationId },
      });
      await prisma.user.create({
        data: { firebaseUid: 'uid-emt-b', email: 'emtb@test.dev', displayName: 'EMT B', role: 'EMT', status: 'ACTIVE', stationId: b.id },
      });
      // Supervises unit 100 only.
      await prisma.user.create({
        data: {
          firebaseUid: 'uid-sup', email: 'sup@test.dev', displayName: 'Sup', role: 'SUPERVISOR', status: 'ACTIVE',
          managedStations: { create: [{ stationId }] },
        },
      });

      paramedicToken = 'token-paramedic';
      otherMedicToken = 'token-emt-b';
      supervisorToken = 'token-sup';
      mockTokens.addToken('token-emt', 'uid-emt', 'emt@test.dev');
      mockTokens.addToken(otherMedicToken, 'uid-emt-b', 'emtb@test.dev');
      mockTokens.addToken(supervisorToken, 'uid-sup', 'sup@test.dev');
    });

    it('blocks a crew member from deleting a medicine from the whole fleet', async () => {
      await request(app).delete(`/api/medicines/${medicineId}`).set(auth('token-emt')).expect(403);

      // Untouched: the medicine and its stock on both cars survive.
      const med = await prisma.medicine.findUniqueOrThrow({ where: { id: medicineId } });
      expect(med.deletedAt).toBeNull();
      const stock = await prisma.inventory.count({ where: { batchId, deletedAt: null } });
      expect(stock).toBe(2);
    });

    it('refuses a fleet-wide medicine delete unless it is confirmed, then allows a supervisor', async () => {
      const med = await prisma.medicine.findUniqueOrThrow({ where: { id: medicineId } });

      const refused = await request(app)
        .delete(`/api/medicines/${med.id}`)
        .set(auth(supervisorToken))
        .send({ force: false })
        .expect(409);
      expect(refused.body.error.message).toMatch(/ambulance/i);

      await request(app)
        .delete(`/api/medicines/${med.id}`)
        .set(auth(supervisorToken))
        .send({ force: true })
        .expect(200);

      const after = await prisma.medicine.findUniqueOrThrow({ where: { id: med.id } });
      expect(after.deletedAt).not.toBeNull();
      expect(await prisma.inventory.count({ where: { batchId, deletedAt: null } })).toBe(0);

      // Put it back for the remaining tests (the delete cascaded to batches and stock).
      await prisma.medicine.update({ where: { id: med.id }, data: { deletedAt: null, barcode: null } });
      await prisma.medicineBatch.updateMany({ where: { medicineId: med.id }, data: { deletedAt: null } });
      await prisma.inventory.updateMany({ where: { batch: { medicineId: med.id } }, data: { deletedAt: null } });
    });

    it('blocks a crew member from reaching another unit’s records', async () => {
      // Shift note on unit 200 — the EMT of unit 100 must not touch it.
      const noteB = await prisma.shiftNote.create({
        data: { stationId: stationB, title: 'Unit 200 note', content: 'not yours', createdById: null },
      });

      await request(app).delete(`/api/shift-notes/${noteB.id}`).set(auth('token-emt')).expect(403);
      expect((await prisma.shiftNote.findUniqueOrThrow({ where: { id: noteB.id } })).deletedAt).toBeNull();

      // Same for that unit's stock and vehicle.
      const invB = await prisma.inventory.findFirstOrThrow({ where: { ambulanceId: ambulanceBUnit, deletedAt: null } });
      await request(app).delete(`/api/inventory/${invB.id}`).set(auth('token-emt')).expect(403);
      expect((await prisma.inventory.findUniqueOrThrow({ where: { id: invB.id } })).deletedAt).toBeNull();

      await request(app).patch(`/api/ambulances/${ambulanceBUnit}`).set(auth('token-emt')).send({ status: 'MAINTENANCE' }).expect(403);
    });

    it('stops a supervisor from reaching units they do not manage', async () => {
      // Supervisors are read-only on vehicles and only see their own units.
      await request(app).patch(`/api/ambulances/${ambulanceBUnit}`).set(auth(supervisorToken)).send({ status: 'MAINTENANCE' }).expect(403);
      await request(app).delete(`/api/ambulances/${ambulanceBUnit}`).set(auth(supervisorToken)).expect(403);
      await request(app).get(`/api/ambulances/${ambulanceBUnit}`).set(auth(supervisorToken)).expect(403);

      await request(app).get(`/api/ambulances/${ambulanceA}`).set(auth(supervisorToken)).expect(200);
      await request(app).get('/api/ambulances').set(auth(supervisorToken)).expect(200);

      const listed = await request(app).get('/api/ambulances').set(auth(supervisorToken)).expect(200);
      expect(listed.body.data.every((a: { stationId: string }) => a.stationId === stationId)).toBe(true);

      // Admin-driven changes still work.
      await request(app).patch(`/api/ambulances/${ambulanceBUnit}`).set(auth(adminToken)).send({ status: 'MAINTENANCE' }).expect(200);
      await request(app).patch(`/api/ambulances/${ambulanceBUnit}`).set(auth(adminToken)).send({ status: 'ACTIVE' }).expect(200);
    });

    it('lets a supervisor self-assign units but not touch anyone else', async () => {
      const sup = await prisma.user.findUniqueOrThrow({ where: { firebaseUid: 'uid-sup' } });

      // The supervisor may widen their own managed list (no admin needed).
      await request(app)
        .put('/api/me/managed-stations')
        .set(auth(supervisorToken))
        .send({ stationCodes: ['100', '200'] })
        .expect(200);

      let row = await prisma.user.findUniqueOrThrow({ where: { id: sup.id }, include: { managedStations: true } });
      expect(row.managedStations.map((m) => m.stationId).sort()).toEqual([stationId, stationB].sort());

      // Crew cannot reach the self-service route at all.
      await request(app)
        .put('/api/me/managed-stations')
        .set(auth('token-emt'))
        .send({ stationCodes: ['100'] })
        .expect(403);

      // …and nobody but an admin may edit ANOTHER user's list.
      await request(app)
        .put(`/api/users/${sup.id}/managed-stations`)
        .set(auth(supervisorToken))
        .send({ stationCodes: ['100', '200'] })
        .expect(403);
      await request(app)
        .put(`/api/users/${sup.id}/managed-stations`)
        .set(auth('token-emt'))
        .send({ stationCodes: ['100'] })
        .expect(403);

      // An administrator can still set it directly.
      await request(app)
        .put(`/api/users/${sup.id}/managed-stations`)
        .set(auth(adminToken))
        .send({ stationCodes: ['100'] })
        .expect(200);

      row = await prisma.user.findUniqueOrThrow({ where: { id: sup.id }, include: { managedStations: true } });
      expect(row.managedStations.map((m) => m.stationId)).toEqual([stationId]);
    });

    it('soft-deletes a shift note: author within 12h, supervisor for the rest', async () => {
      const emt = await prisma.user.findUniqueOrThrow({ where: { firebaseUid: 'uid-emt' } });

      const mine = await prisma.shiftNote.create({
        data: { stationId, title: 'Mine', content: 'typo', createdById: emt.id },
      });
      const res = await request(app)
        .delete(`/api/shift-notes/${mine.id}`)
        .set(auth('token-emt'))
        .send({ reason: 'posted in the wrong place' })
        .expect(200);

      // The row survives — nothing is destroyed.
      const row = await prisma.shiftNote.findUniqueOrThrow({ where: { id: mine.id } });
      expect(row.deletedAt).not.toBeNull();
      expect(row.deleteReason).toBe('posted in the wrong place');
      expect(res.body.data.id).toBe(mine.id);

      // Gone from the normal list, visible to a supervisor who opts in.
      const list = await request(app).get(`/api/shift-notes?stationId=${stationId}`).set(auth('token-emt')).expect(200);
      expect(list.body.data.notes.find((n: { id: string }) => n.id === mine.id)).toBeUndefined();
      const supList = await request(app)
        .get(`/api/shift-notes?stationId=${stationId}&includeDeleted=true`)
        .set(auth(supervisorToken))
        .expect(200);
      expect(supList.body.data.notes.find((n: { id: string }) => n.id === mine.id)).toBeTruthy();

      // Someone else's note is off limits to a crew member…
      const other = await prisma.shiftNote.create({
        data: { stationId, title: 'Theirs', content: 'not yours', createdById: null },
      });
      await request(app).delete(`/api/shift-notes/${other.id}`).set(auth('token-emt')).expect(403);
      expect((await prisma.shiftNote.findUniqueOrThrow({ where: { id: other.id } })).deletedAt).toBeNull();

      // …and an author's note older than the window needs a supervisor.
      const stale = await prisma.shiftNote.create({
        data: { stationId, title: 'Stale', content: 'yesterday', createdById: emt.id, createdAt: new Date(Date.now() - 20 * 3600_000) },
      });
      await request(app).delete(`/api/shift-notes/${stale.id}`).set(auth('token-emt')).expect(403);
      await request(app).delete(`/api/shift-notes/${stale.id}`).set(auth(supervisorToken)).expect(200);

      // Only a supervisor can undo it.
      await request(app).post(`/api/shift-notes/${mine.id}/restore`).set(auth('token-emt')).expect(403);
      await request(app).post(`/api/shift-notes/${mine.id}/restore`).set(auth(supervisorToken)).expect(200);
      expect((await prisma.shiftNote.findUniqueOrThrow({ where: { id: mine.id } })).deletedAt).toBeNull();
    });

    it('stops a crew member cancelling someone else’s supply request', async () => {
      const creator = await prisma.user.findUniqueOrThrow({ where: { firebaseUid: 'uid-emt' } });
      const req = await prisma.supplyRequest.create({
        data: { ambulanceId: ambulanceA, medicineId, quantity: 2, createdById: creator.id },
      });

      await request(app).post(`/api/supply-requests/${req.id}/cancel`).set(auth(paramedicToken)).expect(403);
      expect((await prisma.supplyRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe('PENDING');

      // The requester can cancel their own.
      await request(app).post(`/api/supply-requests/${req.id}/cancel`).set(auth('token-emt')).expect(200);
      expect((await prisma.supplyRequest.findUniqueOrThrow({ where: { id: req.id } })).status).toBe('CANCELLED');
    });

    it('writes an audit entry when access is denied', async () => {
      const before = await prisma.auditLog.count({ where: { action: 'SECURITY_SCOPE_DENIED' } });
      await request(app).delete(`/api/medicines/${medicineId}`).set(auth('token-emt')).expect(403);
      const after = await prisma.auditLog.count({ where: { action: 'SECURITY_SCOPE_DENIED' } });
      expect(after).toBeGreaterThan(before);

      const entry = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'SECURITY_SCOPE_DENIED' },
        orderBy: { createdAt: 'desc' },
      });
      const meta = entry.metadata as { method: string; path: string };
      expect(meta.method).toBe('DELETE');
      expect(meta.path).toContain('/medicines/');
    });

    // ───────────────────────────────────────────────────────────
    //  Admin bulk stocking: one list → every car in the unit.
    // ───────────────────────────────────────────────────────────
    it('stocks every active vehicle in the selected units, and can be reused', async () => {
      // Unit 100 already has two cars (A, B); give unit 200 a third car on standby.
      const standby = await prisma.ambulance.create({
        data: { stationId: stationB, vehicleNumber: 'TST-AMB-200-STANDBY', status: 'MAINTENANCE' },
      });
      await prisma.ambulance.update({ where: { id: ambulanceBUnit }, data: { status: 'ACTIVE' } });

      const created = await request(app)
        .post('/api/distributions/templates')
        .set(auth(adminToken))
        .send({
          name: 'Standard Load-out',
          items: [
            {
              name: 'Fleet Gloves',
              category: 'CAR_CONTENTS',
              batches: [{ batchNumber: 'LOT-FLEET-1', expiryDate: '2028-01-31', quantity: 4 }],
            },
          ],
        })
        .expect(201);
      const templateId = created.body.data.id;

      const run = async () =>
        request(app)
          .post('/api/distributions/apply')
          .set(auth(adminToken))
          .send({ templateId, stationIds: [stationId, stationB] })
          .expect(200);

      const first = await run();
      const totals = first.body.data.totals;
      // Three active cars across the two units; the standby car is reported, not stocked.
      expect(totals.ambulances).toBe(3);
      expect(totals.stations).toBe(2);
      expect(totals.units).toBe(12);
      expect(first.body.data.applied.every((a: { unitsAdded: number }) => a.unitsAdded === 4)).toBe(true);
      expect(
        first.body.data.skipped.some((s: { vehicleNumber: string; reason: string }) =>
          s.vehicleNumber === 'TST-AMB-200-STANDBY' && /maintenance/i.test(s.reason)),
      ).toBe(true);

      const gloves = await prisma.medicine.findFirstOrThrow({ where: { name: 'Fleet Gloves' } });
      const stocked = await prisma.inventory.findMany({
        where: { batch: { medicineId: gloves.id }, deletedAt: null },
        include: { ambulance: true },
      });
      expect(stocked).toHaveLength(3);
      expect(stocked.every((s) => s.quantity === 4)).toBe(true);
      expect(stocked.some((s) => s.ambulanceId === standby.id)).toBe(false);

      // Reusable: applying again tops every car up instead of failing.
      const second = await run();
      expect(second.body.data.totals.ambulances).toBe(3);
      const topped = await prisma.inventory.findMany({
        where: { batch: { medicineId: gloves.id }, deletedAt: null },
      });
      expect(topped.every((s) => s.quantity === 8)).toBe(true);
      expect((await prisma.distributionTemplate.findUniqueOrThrow({ where: { id: templateId } })).isActive).toBe(true);
    });

    it('keeps fleet stocking out of reach of crew', async () => {
      const template = await prisma.distributionTemplate.findFirstOrThrow({ where: { name: 'Standard Load-out' } });
      await request(app).post('/api/distributions/apply').set(auth('token-emt')).send({ templateId: template.id, stationIds: [stationId] }).expect(403);
      await request(app).post('/api/distributions/apply').set(auth(supervisorToken)).send({ templateId: template.id, stationIds: [stationId] }).expect(403);
      await request(app).get('/api/distributions/templates').set(auth('token-emt')).expect(403);
    });
  });

  describe('duty unit switching', () => {
    let unitA: string; // roster: yes
    let unitB: string; // roster: yes
    let unitC: string; // roster: no
    let crewId: string;

    beforeAll(async () => {
      const a = await prisma.station.create({ data: { code: '300', name: 'Unit 300' } });
      const b = await prisma.station.create({ data: { code: '301', name: 'Unit 301' } });
      const c = await prisma.station.create({ data: { code: '302', name: 'Unit 302' } });
      unitA = a.id;
      unitB = b.id;
      unitC = c.id;

      const crew = await prisma.user.create({
        data: {
          firebaseUid: 'uid-duty',
          email: 'duty@test.dev',
          displayName: 'Duty Crew',
          role: 'PARAMEDIC',
          status: 'ACTIVE',
          stationId: unitA,
          dutyRoster: { create: [{ stationId: unitA }, { stationId: unitB }] },
        },
      });
      crewId = crew.id;
      mockTokens.addToken('token-duty', 'uid-duty', 'duty@test.dev');
    });

    it('returns the active unit and the roster allow-list', async () => {
      const duty = await request(app).get('/api/me/duty').set(auth('token-duty')).expect(200);
      expect(duty.body.data.active.id).toBe(unitA);
      expect(duty.body.data.units.map((u: { id: string }) => u.id).sort()).toEqual([unitA, unitB].sort());

      const me = await request(app).get('/api/auth/me').set(auth('token-duty')).expect(200);
      expect(me.body.data.dutyRoster.map((s: { id: string }) => s.id).sort()).toEqual([unitA, unitB].sort());
      expect(me.body.data.accessibleStationIds).toEqual([unitA]);
    });

    it('rejects a switch with a missing or too-short reason (400)', async () => {
      await request(app).post('/api/me/duty/switch').set(auth('token-duty')).send({ stationId: unitB }).expect(400);
      await request(app).post('/api/me/duty/switch').set(auth('token-duty')).send({ stationId: unitB, reason: 'x' }).expect(400);
    });

    it('forbids switching to a unit outside the roster (403)', async () => {
      const res = await request(app)
        .post('/api/me/duty/switch')
        .set(auth('token-duty'))
        .send({ stationId: unitC, reason: 'off-roster attempt' })
        .expect(403);
      expect(res.body.error.message).toMatch(/roster/i);

      const still = await prisma.user.findUniqueOrThrow({ where: { id: crewId } });
      expect(still.stationId).toBe(unitA);
    });

    it('switches units with a reason and audits it (scope follows the unit)', async () => {
      const res = await request(app)
        .post('/api/me/duty/switch')
        .set(auth('token-duty'))
        .send({ stationId: unitB, reason: 'covering sick leave' })
        .expect(200);
      expect(res.body.data.active.id).toBe(unitB);

      const user = await prisma.user.findUniqueOrThrow({ where: { id: crewId } });
      expect(user.stationId).toBe(unitB);

      const log = await prisma.auditLog.findFirst({
        where: { action: 'DUTY_SWITCH', userId: crewId },
        orderBy: { createdAt: 'desc' },
      });
      expect(log).toBeTruthy();
      const meta = log!.metadata as Record<string, unknown>;
      expect(meta.reason).toBe('covering sick leave');
      expect(meta.from).toBe('300');
      expect(meta.to).toBe('301');

      const me = await request(app).get('/api/auth/me').set(auth('token-duty')).expect(200);
      expect(me.body.data.accessibleStationIds).toEqual([unitB]);
    });

    it('treats a same-unit switch as a no-op (no extra audit row)', async () => {
      const before = await prisma.auditLog.count({ where: { action: 'DUTY_SWITCH', userId: crewId } });
      await request(app)
        .post('/api/me/duty/switch')
        .set(auth('token-duty'))
        .send({ stationId: unitB, reason: 'already here' })
        .expect(200);
      const after = await prisma.auditLog.count({ where: { action: 'DUTY_SWITCH', userId: crewId } });
      expect(after).toBe(before);
    });

    it('lets admins replace a roster and moves a user whose unit dropped off', async () => {
      const res = await request(app)
        .put(`/api/users/${crewId}/units`)
        .set(auth(adminToken))
        .send({ stationIds: [unitC] })
        .expect(200);
      expect(res.body.data.units.map((u: { id: string }) => u.id)).toEqual([unitC]);

      const user = await prisma.user.findUniqueOrThrow({ where: { id: crewId } });
      expect(user.stationId).toBe(unitC);

      const roster = await prisma.dutyRoster.findMany({ where: { userId: crewId } });
      expect(roster.map((r) => r.stationId)).toEqual([unitC]);

      const log = await prisma.auditLog.findFirst({
        where: { action: 'UPDATE_USER_UNITS', entityId: crewId },
        orderBy: { createdAt: 'desc' },
      });
      expect(log).toBeTruthy();
      expect((log!.metadata as Record<string, unknown>).moved).toBe(true);
    });

    it('refuses duty switches and roster edits for staff accounts', async () => {
      await request(app)
        .post('/api/me/duty/switch')
        .set(auth(adminToken))
        .send({ stationId: unitA, reason: 'nope' })
        .expect(403);

      const admin = await prisma.user.findFirstOrThrow({ where: { firebaseUid: 'uid-admin' } });
      await request(app)
        .put(`/api/users/${admin.id}/units`)
        .set(auth(adminToken))
        .send({ stationIds: [unitA] })
        .expect(400);
    });

    it('seeds the full active-unit roster on approval and exposes it in the session', async () => {
      // Re-approve so the roster is seeded now, with every unit this suite has
      // created (300/301/302) already active — the default is the full set.
      const pending = await prisma.user.findUniqueOrThrow({ where: { firebaseUid: 'uid-pending' } });
      await request(app)
        .post(`/api/users/${pending.id}/approve`)
        .set(auth(adminToken))
        .send({ role: 'PARAMEDIC', stationCode: '100' })
        .expect(200);

      const active = await prisma.station.findMany({ where: { status: 'ACTIVE' }, select: { code: true } });
      const me = await request(app).get('/api/auth/me').set(auth('token-pending')).expect(200);
      const codes = me.body.data.dutyRoster.map((s: { code: string }) => s.code).sort();
      expect(codes).toEqual(active.map((s) => s.code).sort());
      expect(codes).toContain('100');
    });
  });

  // ─────────────────────────────────────────────────────────────
  //  Audit visibility: units see operational events, admins see all.
  // ─────────────────────────────────────────────────────────────
  describe('audit visibility', () => {
    it('hides system/admin events from units but keeps operational ones', async () => {
      const paramedic = await prisma.user.findFirstOrThrow({ where: { firebaseUid: 'uid-paramedic' } });
      await prisma.auditLog.createMany({
        data: [
          { userId: paramedic.id, stationId, action: 'LOGIN' },
          { userId: paramedic.id, stationId, action: 'USE_MEDICINE' },
        ],
      });

      const unit = await request(app).get('/api/audit-logs?pageSize=200').set(auth('token-paramedic')).expect(200);
      const unitActions: string[] = unit.body.data.logs.map((l: { action: string }) => l.action);
      expect(unitActions).toContain('USE_MEDICINE');
      expect(unitActions).not.toContain('LOGIN');

      const unitLogin = await request(app).get('/api/audit-logs?action=LOGIN').set(auth('token-paramedic')).expect(200);
      expect(unitLogin.body.data.total).toBe(0);

      const admin = await request(app).get('/api/audit-logs?action=LOGIN').set(auth(adminToken)).expect(200);
      expect(admin.body.data.total).toBeGreaterThan(0);
    });
  });
});
