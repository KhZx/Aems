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

    it('seeds a roster on approval and exposes it in the session', async () => {
      const me = await request(app).get('/api/auth/me').set(auth('token-pending')).expect(200);
      expect(me.body.data.dutyRoster).toHaveLength(1);
      expect(me.body.data.dutyRoster[0].code).toBe('100');
    });
  });
});
