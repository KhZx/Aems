import { Router } from 'express';
import { authenticate, verifyFirebaseToken } from '../middleware/authenticate.js';
import { requirePermission } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { authRateLimiter } from '../middleware/rateLimiter.js';
import * as auth from '../controllers/auth.controller.js';
import * as health from '../controllers/health.controller.js';
import * as users from '../controllers/user.controller.js';
import * as stations from '../controllers/station.controller.js';
import * as ambulances from '../controllers/ambulance.controller.js';
import * as medicines from '../controllers/medicine.controller.js';
import * as batches from '../controllers/batch.controller.js';
import * as inventory from '../controllers/inventory.controller.js';
import * as transfers from '../controllers/transfer.controller.js';
import * as inspections from '../controllers/inspection.controller.js';
import * as auditLogs from '../controllers/audit.controller.js';
import * as dashboard from '../controllers/dashboard.controller.js';
import * as shiftNotes from '../controllers/shiftNote.controller.js';
import * as handovers from '../controllers/handover.controller.js';
import * as reports from '../controllers/report.controller.js';
import * as supplyRequests from '../controllers/supplyRequest.controller.js';
import {
  registerSchema,
  listUsersQuerySchema,
  approveUserSchema,
  changeRoleSchema,
  setUserStatusSchema,
  updateMyManagedStationsSchema,
  idParamSchema,
  createStationSchema,
  updateStationSchema,
  listStationsQuerySchema,
  stationCodeParamSchema,
  createAmbulanceSchema,
  updateAmbulanceSchema,
  listAmbulancesQuerySchema,
  createMedicineSchema,
  updateMedicineSchema,
  listMedicinesQuerySchema,
  createBatchSchema,
  listBatchesQuerySchema,
  useMedicineSchema,
  restockSchema,
  adjustSchema,
  removeStockSchema,
  updateInventoryNotesSchema,
  updateInventoryExpirySchema,
  returnSchema,
  initialStockSchema,
  listInventoryQuerySchema,
  inventoryIdParamSchema,
  transferSchema,
  listTransfersQuerySchema,
  createInspectionSchema,
  listInspectionsQuerySchema,
  createShiftNoteSchema,
  listShiftNotesQuerySchema,
  createHandoverSchema,
  acknowledgeHandoverSchema,
  listHandoversQuerySchema,
  createReportSchema,
  listReportsQuerySchema,
  createSupplyRequestSchema,
  reviewSupplyRequestSchema,
  listSupplyRequestsQuerySchema,
} from '../validators/index.js';

const router = Router();

// ── Auth ────────────────────────────────────────────────────────
router.post('/auth/register', authRateLimiter, verifyFirebaseToken, validate(registerSchema), auth.register);
router.post('/auth/login', authRateLimiter, authenticate, auth.login);
router.get('/auth/me', authenticate, auth.me);
router.put('/auth/me/managed-stations', authenticate, requirePermission('station:read'), validate(updateMyManagedStationsSchema), users.updateMyManagedStations);

// ── Users ───────────────────────────────────────────────────────
router.get('/users', authenticate, requirePermission('user:read'), validate(listUsersQuerySchema, 'query'), users.list);
router.get('/users/:id', authenticate, requirePermission('user:read'), validate(idParamSchema, 'params'), users.getById);
router.post('/users/:id/approve', authenticate, requirePermission('user:approve'), validate(idParamSchema, 'params'), validate(approveUserSchema), users.approve);
router.post('/users/:id/reject', authenticate, requirePermission('user:approve'), validate(idParamSchema, 'params'), users.reject);
router.patch('/users/:id/status', authenticate, requirePermission('user:disable'), validate(idParamSchema, 'params'), validate(setUserStatusSchema), users.setStatus);
router.patch('/users/:id/role', authenticate, requirePermission('user:changeRole'), validate(idParamSchema, 'params'), validate(changeRoleSchema), users.changeRole);
router.delete('/users/:id', authenticate, requirePermission('user:update'), validate(idParamSchema, 'params'), users.remove);

// ── Public (no auth — minimal directory for the signup form) ───
router.get('/health', health.health);
router.get('/public/stations', stations.publicList);

// ── Stations ────────────────────────────────────────────────────
router.get('/stations', authenticate, requirePermission('station:read'), validate(listStationsQuerySchema, 'query'), stations.list);
router.get('/stations/code/:code', authenticate, requirePermission('station:read'), validate(stationCodeParamSchema, 'params'), stations.getByCode);
router.post('/stations', authenticate, requirePermission('station:create'), validate(createStationSchema), stations.create);
router.patch('/stations/:id', authenticate, requirePermission('station:update'), validate(idParamSchema, 'params'), validate(updateStationSchema), stations.update);
router.delete('/stations/:id', authenticate, requirePermission('station:delete'), validate(idParamSchema, 'params'), stations.remove);

// ── Ambulances ──────────────────────────────────────────────────
router.get('/ambulances', authenticate, requirePermission('ambulance:read'), validate(listAmbulancesQuerySchema, 'query'), ambulances.list);
router.get('/ambulances/:id', authenticate, requirePermission('ambulance:read'), validate(idParamSchema, 'params'), ambulances.getById);
router.post('/ambulances', authenticate, requirePermission('ambulance:create'), validate(createAmbulanceSchema), ambulances.create);
router.patch('/ambulances/:id', authenticate, requirePermission('ambulance:update'), validate(idParamSchema, 'params'), validate(updateAmbulanceSchema), ambulances.update);
router.delete('/ambulances/:id', authenticate, requirePermission('ambulance:update'), validate(idParamSchema, 'params'), ambulances.remove);

// ── Medicines ───────────────────────────────────────────────────
router.get('/medicines', authenticate, requirePermission('medicine:read'), validate(listMedicinesQuerySchema, 'query'), medicines.list);
router.get('/medicines/:id', authenticate, requirePermission('medicine:read'), validate(idParamSchema, 'params'), medicines.getById);
router.post('/medicines', authenticate, requirePermission('medicine:create'), validate(createMedicineSchema), medicines.create);
router.patch('/medicines/:id', authenticate, requirePermission('medicine:update'), validate(idParamSchema, 'params'), validate(updateMedicineSchema), medicines.update);
router.delete('/medicines/:id', authenticate, requirePermission('medicine:delete'), validate(idParamSchema, 'params'), medicines.remove);

// ── Batches ─────────────────────────────────────────────────────
router.get('/batches', authenticate, requirePermission('batch:read'), validate(listBatchesQuerySchema, 'query'), batches.list);
router.post('/batches', authenticate, requirePermission('batch:create'), validate(createBatchSchema), batches.create);

// ── Inventory ───────────────────────────────────────────────────
router.get('/inventory', authenticate, requirePermission('inventory:read'), validate(listInventoryQuerySchema, 'query'), inventory.list);
router.get('/inventory/:id', authenticate, requirePermission('inventory:read'), validate(inventoryIdParamSchema, 'params'), inventory.getById);
router.post('/inventory/use', authenticate, requirePermission('inventory:use'), validate(useMedicineSchema), inventory.use);
router.post('/inventory/restock', authenticate, requirePermission('inventory:restock'), validate(restockSchema), inventory.restock);
router.post('/inventory/adjust', authenticate, requirePermission('inventory:adjust'), validate(adjustSchema), inventory.adjust);
router.post('/inventory/notes', authenticate, requirePermission('inventory:adjust'), validate(updateInventoryNotesSchema), inventory.updateNotes);
router.post('/inventory/expiry', authenticate, requirePermission('inventory:update-expiry'), validate(updateInventoryExpirySchema), inventory.updateExpiry);
router.post('/inventory/damaged', authenticate, requirePermission('inventory:adjust'), validate(removeStockSchema), inventory.damaged);
router.post('/inventory/expired', authenticate, requirePermission('inventory:adjust'), validate(removeStockSchema), inventory.expired);
router.post('/inventory/return', authenticate, requirePermission('inventory:restock'), validate(returnSchema), inventory.returnStock);
router.post('/inventory/initial-stock', authenticate, requirePermission('inventory:adjust'), validate(initialStockSchema), inventory.initialStock);
router.post('/inventory/transfer', authenticate, requirePermission('inventory:transfer'), validate(transferSchema), transfers.create);

// ── Transfers ───────────────────────────────────────────────────
router.get('/transfers', authenticate, requirePermission('transfer:read'), validate(listTransfersQuerySchema, 'query'), transfers.list);

// ── Inspections ─────────────────────────────────────────────────
router.get('/inspections', authenticate, requirePermission('inspection:read'), validate(listInspectionsQuerySchema, 'query'), inspections.list);
router.get('/inspections/:id', authenticate, requirePermission('inspection:read'), validate(idParamSchema, 'params'), inspections.getById);
router.post('/inspections', authenticate, requirePermission('inspection:create'), validate(createInspectionSchema), inspections.create);

// ── Audit logs ──────────────────────────────────────────────────
router.get('/audit-logs', authenticate, requirePermission('audit:read'), auditLogs.list);

// ── Dashboard ───────────────────────────────────────────────────
router.get('/dashboard/overview', authenticate, requirePermission('dashboard:read'), dashboard.overview);

// ── Shift Notes ─────────────────────────────────────────────────
router.get('/shift-notes', authenticate, requirePermission('shiftnote:read'), validate(listShiftNotesQuerySchema, 'query'), shiftNotes.list);
router.post('/shift-notes', authenticate, requirePermission('shiftnote:create'), validate(createShiftNoteSchema), shiftNotes.create);
router.delete('/shift-notes/:id', authenticate, requirePermission('shiftnote:delete'), validate(idParamSchema, 'params'), shiftNotes.remove);

// ── Handovers ───────────────────────────────────────────────────
router.get('/handovers', authenticate, requirePermission('handover:read'), validate(listHandoversQuerySchema, 'query'), handovers.list);
router.post('/handovers', authenticate, requirePermission('handover:create'), validate(createHandoverSchema), handovers.create);
router.post('/handovers/:id/acknowledge', authenticate, requirePermission('handover:acknowledge'), validate(idParamSchema, 'params'), validate(acknowledgeHandoverSchema), handovers.acknowledge);

// ── Reports ─────────────────────────────────────────────────────
router.get('/reports', authenticate, requirePermission('report:read'), validate(listReportsQuerySchema, 'query'), reports.list);
router.post('/reports', authenticate, requirePermission('report:create'), validate(createReportSchema), reports.create);

// ── Supply Requests ─────────────────────────────────────────────
router.get('/supply-requests', authenticate, requirePermission('supply:read'), validate(listSupplyRequestsQuerySchema, 'query'), supplyRequests.list);
router.post('/supply-requests', authenticate, requirePermission('supply:request'), validate(createSupplyRequestSchema), supplyRequests.create);
router.patch('/supply-requests/:id/status', authenticate, requirePermission('supply:review'), validate(idParamSchema, 'params'), validate(reviewSupplyRequestSchema), supplyRequests.review);
router.post('/supply-requests/:id/cancel', authenticate, requirePermission('supply:request'), validate(idParamSchema, 'params'), supplyRequests.cancel);

export default router;
