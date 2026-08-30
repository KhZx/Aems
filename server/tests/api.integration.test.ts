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
    app = createApp();

    const station = await prisma.station.create({ data: { code: '100', name: 'Test Station' } });
    stationId = station.id;

    const ambA = await prisma.ambulance.create({ data: { stationId, vehicleNumber: 'TST-AMB-A' } });
    const ambB = await prisma.ambulance.create({ data: { stationId, vehicleNumber: 'TST-AMB-B' } });
    ambulanceA = ambA.id;
    ambulanceB = ambB.id;

    const med = await prisma.medicine.create({
      data: { name: 'Test Med', category: 'MEDICATION', minimumStock: 5, maximumStock: 100 },
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

  // Full unit-operator flow: page-load GETs + add-medicine with the new form.
  it('lets a paramedic load unit data and add a medicine with blank optional fields', async () => {
    const sid = stationId;
    const gets = await Promise.all([
      request(app).get(`/api/inventory?stationId=${sid}&includeEmpty=true`).set(auth('token-paramedic')),
      request(app).get(`/api/shift-notes?stationId=${sid}&pageSize=50`).set(auth('token-paramedic')),
      request(app).get(`/api/handovers?stationId=${sid}&pageSize=50`).set(auth('token-paramedic')),
    ]);
    for (const res of gets) expect(res.status).toBe(200);

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
        minimumStock: 4,
        maximumStock: 12,
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
});
