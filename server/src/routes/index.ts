import { Router, type Request, type Response, type NextFunction } from 'express';
import { authenticate, verifyFirebaseToken } from '../middleware/authenticate.js';
import { requirePermission } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { authRateLimiter, destructiveRateLimiter } from '../middleware/rateLimiter.js';
import * as auth from '../controllers/auth.controller.js';
import * as duty from '../controllers/duty.controller.js';
import * as health from '../controllers/health.controller.js';
import * as users from '../controllers/user.controller.js';
import * as stations from '../controllers/station.controller.js';
import * as ambulances from '../controllers/ambulance.controller.js';
import * as medicines from '../controllers/medicine.controller.js';
import * as batches from '../controllers/batch.controller.js';
import * as inventory from '../controllers/inventory.controller.js';
import * as transfers from '../controllers/transfer.controller.js';
import * as inspections from '../controllers/inspection.controller.js';
import * as stockReasons from '../controllers/stockReason.controller.js';
import * as auditLogs from '../controllers/audit.controller.js';
import * as dashboard from '../controllers/dashboard.controller.js';
import * as shiftNotes from '../controllers/shiftNote.controller.js';
import * as handovers from '../controllers/handover.controller.js';
import * as reports from '../controllers/report.controller.js';
import * as analytics from '../controllers/analytics.controller.js';
import * as supplyRequests from '../controllers/supplyRequest.controller.js';
import * as distributions from '../controllers/distribution.controller.js';
import * as notifications from '../controllers/notification.controller.js';
import {
  registerSchema,
  listUsersQuerySchema,
  approveUserSchema,
  changeRoleSchema,
  setUserStatusSchema,
  setUserPasswordSchema,
  setManagedStationsSchema,
  updateMySupervisorZoneSchema,
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
  updateBatchSchema,
  listBatchesQuerySchema,
  useMedicineSchema,
  restockSchema,
  adjustSchema,
  removeStockSchema,
  removeStockLineSchema,
  updateInventoryNotesSchema,
  updateInventoryExpirySchema,
  updateInventoryLotSchema,
  returnSchema,
  initialStockSchema,
  importInventorySchema,
  listInventoryQuerySchema,
  inventoryIdParamSchema,
  transferSchema,
  listTransfersQuerySchema,
  createInspectionSchema,
  updateInspectionSchema,
  acknowledgeInspectionSchema,
  voidInspectionSchema,
  listInspectionsQuerySchema,
  inspectionOverviewQuerySchema,
  createShiftNoteSchema,
  listShiftNotesQuerySchema,
  createHandoverSchema,
  acknowledgeHandoverSchema,
  listHandoversQuerySchema,
  createReportSchema,
  listReportsQuerySchema,
  analyticsQuerySchema,
  createSupplyRequestSchema,
  reviewSupplyRequestSchema,
  dispatchSupplyRequestSchema,
  receiveSupplyRequestSchema,
  listSupplyRequestsQuerySchema,
  listStockReasonsQuerySchema,
  createDistributionTemplateSchema,
  updateDistributionTemplateSchema,
  distributionIdParamSchema,
  applyDistributionSchema,
  switchDutySchema,
  setUserUnitsSchema,
  listNotificationsQuerySchema,
} from '../validators/index.js';

const router = Router();

/**
 * Marks a handler's response cacheable for a short interval (helped GETs).
 * Authenticated responses use `private` so sensitive data is never stored in a
 * shared cache; pass `public: true` only for genuinely public endpoints.
 */
function cacheable(seconds: number, opts: { public?: boolean } = {}) {
  const visibility = opts.public ? 'public' : 'private';
  return (_req: Request, res: Response, next: NextFunction) => {
    res.set('Cache-Control', `${visibility}, max-age=${seconds}, stale-while-revalidate=${seconds * 10}`);
    next();
  };
}

// ── Auth ────────────────────────────────────────────────────────
router.post('/auth/register', authRateLimiter, verifyFirebaseToken, validate(registerSchema), auth.register);
router.post('/auth/login', authRateLimiter, authenticate, auth.login);
router.get('/auth/me', authenticate, auth.me);
router.post('/auth/password-changed', authenticate, auth.passwordChanged);

// 🗺️ Duty unit (crew switching — unlimited, reason required, audited)
router.get('/me/duty', authenticate, duty.state);

// Persistent, caller-scoped notification center and live refresh stream.
router.get('/notifications/stream', authenticate, notifications.stream);
router.get('/notifications', authenticate, validate(listNotificationsQuerySchema, 'query'), notifications.list);
router.post('/notifications/read-all', authenticate, notifications.markAllRead);
router.post('/notifications/:id/read', authenticate, validate(idParamSchema, 'params'), notifications.markRead);
router.post('/me/duty/switch', authenticate, validate(switchDutySchema), duty.switchUnit);
// Supervisor self-assignment: a supervisor may add/remove the units on their
// OWN managed list without admin approval (station:selfAssign). Admins can
// still assign any supervisor's list via PUT /users/:id/managed-stations.
router.put(
  '/me/managed-stations',
  authenticate,
  requirePermission('station:selfAssign'),
  validate(setManagedStationsSchema),
  users.setMyManagedStations,
);
router.put(
  '/me/supervisor-zone',
  authenticate,
  validate(updateMySupervisorZoneSchema),
  users.updateMySupervisorZone,
);

// ── Users ───────────────────────────────────────────────────────
router.get('/users', authenticate, requirePermission('user:read'), validate(listUsersQuerySchema, 'query'), users.list);
router.get('/users/:id', authenticate, requirePermission('user:read'), validate(idParamSchema, 'params'), users.getById);
router.put('/users/:id/managed-stations', authenticate, requirePermission('station:assign'), validate(idParamSchema, 'params'), validate(setManagedStationsSchema), users.setManagedStations);
router.put('/users/:id/units', authenticate, requirePermission('user:update'), validate(idParamSchema, 'params'), validate(setUserUnitsSchema), users.setUnits);
router.post('/users/:id/approve', authenticate, requirePermission('user:approve'), validate(idParamSchema, 'params'), validate(approveUserSchema), users.approve);
router.post('/users/:id/reject', authenticate, requirePermission('user:approve'), validate(idParamSchema, 'params'), users.reject);
router.patch('/users/:id/status', authenticate, requirePermission('user:disable'), validate(idParamSchema, 'params'), validate(setUserStatusSchema), users.setStatus);
router.patch('/users/:id/role', authenticate, requirePermission('user:changeRole'), validate(idParamSchema, 'params'), validate(changeRoleSchema), users.changeRole);
router.put('/users/:id/password', authenticate, requirePermission('user:update'), destructiveRateLimiter, validate(idParamSchema, 'params'), validate(setUserPasswordSchema), users.setPassword);
router.delete('/users/:id', authenticate, requirePermission('user:update'), destructiveRateLimiter, validate(idParamSchema, 'params'), users.remove);

// ── Public (no auth — minimal directory for the signup form) ───
router.get('/health', health.health);
router.get('/public/stations', cacheable(300, { public: true }), stations.publicList);

// ── Stations ────────────────────────────────────────────────────
router.get('/stations', authenticate, requirePermission('station:read'), validate(listStationsQuerySchema, 'query'), stations.list);
router.get('/stations/code/:code', authenticate, requirePermission('station:read'), validate(stationCodeParamSchema, 'params'), stations.getByCode);
router.post('/stations', authenticate, requirePermission('station:create'), validate(createStationSchema), stations.create);
router.patch('/stations/:id', authenticate, requirePermission('station:update'), validate(idParamSchema, 'params'), validate(updateStationSchema), stations.update);
router.delete('/stations/:id', authenticate, requirePermission('station:delete'), destructiveRateLimiter, validate(idParamSchema, 'params'), stations.remove);

// ── Ambulances ──────────────────────────────────────────────────
router.get('/ambulances', authenticate, requirePermission('ambulance:read'), validate(listAmbulancesQuerySchema, 'query'), ambulances.list);
router.get('/ambulances/:id', authenticate, requirePermission('ambulance:read'), validate(idParamSchema, 'params'), ambulances.getById);
router.post('/ambulances', authenticate, requirePermission('ambulance:create'), validate(createAmbulanceSchema), ambulances.create);
router.patch('/ambulances/:id', authenticate, requirePermission('ambulance:update'), validate(idParamSchema, 'params'), validate(updateAmbulanceSchema), ambulances.update);
router.delete('/ambulances/:id', authenticate, requirePermission('ambulance:update'), destructiveRateLimiter, validate(idParamSchema, 'params'), ambulances.remove);

// ── Medicines ───────────────────────────────────────────────────
router.get('/medicines', authenticate, requirePermission('medicine:read'), validate(listMedicinesQuerySchema, 'query'), cacheable(30), medicines.list);
router.get('/medicines/:id', authenticate, requirePermission('medicine:read'), validate(idParamSchema, 'params'), medicines.getById);
router.post('/medicines', authenticate, requirePermission('medicine:create'), validate(createMedicineSchema), medicines.create);
router.patch('/medicines/:id', authenticate, requirePermission('medicine:update'), validate(idParamSchema, 'params'), validate(updateMedicineSchema), medicines.update);
router.delete('/medicines/:id', authenticate, requirePermission('medicine:delete'), destructiveRateLimiter, validate(idParamSchema, 'params'), medicines.remove);

// ── Batches ─────────────────────────────────────────────────────
router.get('/batches', authenticate, requirePermission('batch:read'), validate(listBatchesQuerySchema, 'query'), batches.list);
router.post('/batches', authenticate, requirePermission('batch:create'), validate(createBatchSchema), batches.create);
// Edit a lot (number/expiry/supplier/received date). Shared fleet-wide, so the
// reason is mandatory and the from→to diff is captured in the audit log.
router.patch('/batches/:id', authenticate, requirePermission('batch:update'), validate(idParamSchema, 'params'), validate(updateBatchSchema), batches.update);

// ── Stock reasons ───────────────────────────────────────────────
// Structured reason catalog for stock actions and inspection discrepancies.
router.get('/stock-reasons', authenticate, requirePermission('inventory:read'), validate(listStockReasonsQuerySchema, 'query'), stockReasons.list);

// ── Inventory ───────────────────────────────────────────────────
router.get('/inventory', authenticate, requirePermission('inventory:read'), validate(listInventoryQuerySchema, 'query'), inventory.list);
router.get('/inventory/:id', authenticate, requirePermission('inventory:read'), validate(inventoryIdParamSchema, 'params'), inventory.getById);
// Per-unit lot edit — overrides lot number/expiry/supplier/received date on THIS
// ambulance's stock line only (the shared batch is left untouched). Audited.
router.patch('/inventory/:id/lot', authenticate, requirePermission('inventory:update-lot'), validate(inventoryIdParamSchema, 'params'), validate(updateInventoryLotSchema), inventory.updateLot);
router.post('/inventory/use', authenticate, requirePermission('inventory:use'), validate(useMedicineSchema), inventory.use);
router.post('/inventory/restock', authenticate, requirePermission('inventory:restock'), validate(restockSchema), inventory.restock);
router.post('/inventory/adjust', authenticate, requirePermission('inventory:adjust'), validate(adjustSchema), inventory.adjust);
router.post('/inventory/notes', authenticate, requirePermission('inventory:adjust'), validate(updateInventoryNotesSchema), inventory.updateNotes);
router.post('/inventory/expiry', authenticate, requirePermission('inventory:update-expiry'), validate(updateInventoryExpirySchema), inventory.updateExpiry);
router.post('/inventory/damaged', authenticate, requirePermission('inventory:adjust'), validate(removeStockSchema), inventory.damaged);
router.post('/inventory/expired', authenticate, requirePermission('inventory:adjust'), validate(removeStockSchema), inventory.expired);
router.post('/inventory/return', authenticate, requirePermission('inventory:restock'), validate(returnSchema), inventory.returnStock);
router.post('/inventory/initial-stock', authenticate, requirePermission('inventory:adjust'), validate(initialStockSchema), inventory.initialStock);
router.post('/inventory/import', authenticate, requirePermission('inventory:adjust'), validate(importInventorySchema), inventory.importInventory);
router.post('/inventory/transfer', authenticate, requirePermission('inventory:transfer'), validate(transferSchema), transfers.create);
// Delete a single stock line (one lot on one car) — never cascades to the medicine.
  router.delete('/inventory/:id', authenticate, requirePermission('inventory:adjust'), destructiveRateLimiter, validate(inventoryIdParamSchema, 'params'), validate(removeStockLineSchema), inventory.remove);

// ── Transfers ───────────────────────────────────────────────────
router.get('/transfers', authenticate, requirePermission('transfer:read'), validate(listTransfersQuerySchema, 'query'), transfers.list);

// ── Inspections ─────────────────────────────────────────────────
// Free-form lifecycle: a crew starts a DRAFT (save/resume any number of times),
// completes it to freeze + reconcile stock (auto-report), and a supervisor then
// acknowledges or voids it. A "not checked" line is always flagged for review.
router.get('/inspections', authenticate, requirePermission('inspection:read'), validate(listInspectionsQuerySchema, 'query'), inspections.list);
// Static segment must precede '/inspections/:id' or Express would treat it as an id.
router.get('/inspections/overview', authenticate, requirePermission('inspection:read'), validate(inspectionOverviewQuerySchema, 'query'), inspections.overview);
router.get('/inspections/:id', authenticate, requirePermission('inspection:read'), validate(idParamSchema, 'params'), inspections.getById);
router.post('/inspections', authenticate, requirePermission('inspection:create'), validate(createInspectionSchema), inspections.create);
router.put('/inspections/:id', authenticate, requirePermission('inspection:create'), validate(idParamSchema, 'params'), validate(updateInspectionSchema), inspections.save);
router.post('/inspections/:id/complete', authenticate, requirePermission('inspection:create'), validate(idParamSchema, 'params'), inspections.complete);
router.post('/inspections/:id/acknowledge', authenticate, requirePermission('inspection:review'), validate(idParamSchema, 'params'), validate(acknowledgeInspectionSchema), inspections.acknowledge);
router.post('/inspections/:id/void', authenticate, requirePermission('inspection:review'), validate(idParamSchema, 'params'), validate(voidInspectionSchema), inspections.voidInspection);
router.delete('/inspections/:id', authenticate, requirePermission('inspection:create'), destructiveRateLimiter, validate(idParamSchema, 'params'), inspections.remove);

// ── Audit logs ──────────────────────────────────────────────────
router.get('/audit-logs', authenticate, requirePermission('audit:read'), auditLogs.list);

// ── Dashboard ───────────────────────────────────────────────────
router.get('/dashboard/overview', authenticate, requirePermission('dashboard:read'), dashboard.overview);

// ── Shift Notes ─────────────────────────────────────────────────
router.get('/shift-notes', authenticate, requirePermission('shiftnote:read'), validate(listShiftNotesQuerySchema, 'query'), shiftNotes.list);
router.post('/shift-notes', authenticate, requirePermission('shiftnote:create'), validate(createShiftNoteSchema), shiftNotes.create);
router.delete('/shift-notes/:id', authenticate, requirePermission('shiftnote:delete'), destructiveRateLimiter, validate(idParamSchema, 'params'), shiftNotes.remove);
router.post('/shift-notes/:id/restore', authenticate, requirePermission('shiftnote:restore'), validate(idParamSchema, 'params'), shiftNotes.restore);

// ── Handovers ───────────────────────────────────────────────────
router.get('/handovers', authenticate, requirePermission('handover:read'), validate(listHandoversQuerySchema, 'query'), handovers.list);
router.post('/handovers', authenticate, requirePermission('handover:create'), validate(createHandoverSchema), handovers.create);
router.post('/handovers/:id/acknowledge', authenticate, requirePermission('handover:acknowledge'), validate(idParamSchema, 'params'), validate(acknowledgeHandoverSchema), handovers.acknowledge);

// ── Reports ─────────────────────────────────────────────────────
// Fleet/station analytics rollup for the Reports Dashboard (admin + supervisor).
// `dashboard:read` keeps crew roles out while both staff roles already hold it.
router.get('/reports/analytics', authenticate, requirePermission('dashboard:read'), validate(analyticsQuerySchema, 'query'), analytics.analytics);
router.get('/reports', authenticate, requirePermission('report:read'), validate(listReportsQuerySchema, 'query'), reports.list);
router.post('/reports', authenticate, requirePermission('report:create'), validate(createReportSchema), reports.create);

// ── Supply Requests ─────────────────────────────────────────────
router.get('/supply-requests', authenticate, requirePermission('supply:read'), validate(listSupplyRequestsQuerySchema, 'query'), supplyRequests.list);
router.post('/supply-requests', authenticate, requirePermission('supply:request'), validate(createSupplyRequestSchema), supplyRequests.create);
router.patch('/supply-requests/:id/status', authenticate, requirePermission('supply:review'), validate(idParamSchema, 'params'), validate(reviewSupplyRequestSchema), supplyRequests.review);
router.post('/supply-requests/:id/cancel', authenticate, requirePermission('supply:request'), validate(idParamSchema, 'params'), supplyRequests.cancel);
// Fulfilment lifecycle — request stays "held" (DISPATCHED → RECEIVED) until the
// receipt is double-confirmed, at which point stock is credited to the unit.
router.post('/supply-requests/:id/dispatch', authenticate, requirePermission('supply:review'), validate(idParamSchema, 'params'), validate(dispatchSupplyRequestSchema), supplyRequests.dispatch);
router.post('/supply-requests/:id/receive', authenticate, requirePermission('supply:request'), validate(idParamSchema, 'params'), validate(receiveSupplyRequestSchema), supplyRequests.receive);
router.post('/supply-requests/:id/confirm', authenticate, requirePermission('supply:review'), validate(idParamSchema, 'params'), supplyRequests.confirm);
router.post('/supply-requests/:id/close', authenticate, requirePermission('supply:review'), validate(idParamSchema, 'params'), supplyRequests.close);

// ── Inventory Distribution (admin) ──────────────────────────────
router.get('/distributions/templates', authenticate, requirePermission('distribution:manage'), distributions.templates);
router.post('/distributions/templates', authenticate, requirePermission('distribution:manage'), validate(createDistributionTemplateSchema), distributions.create);
router.patch('/distributions/templates/:id', authenticate, requirePermission('distribution:manage'), validate(distributionIdParamSchema, 'params'), validate(updateDistributionTemplateSchema), distributions.update);
router.delete('/distributions/templates/:id', authenticate, requirePermission('distribution:manage'), destructiveRateLimiter, validate(distributionIdParamSchema, 'params'), distributions.remove);
router.post('/distributions/apply', authenticate, requirePermission('distribution:manage'), validate(applyDistributionSchema), distributions.apply);
router.get('/distributions', authenticate, requirePermission('distribution:manage'), distributions.list);

export default router;
