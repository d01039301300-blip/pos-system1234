'use strict';

const {
  walletRow,
  listWallets,
  assertWalletScope,
  createWallet,
  updateWallet,
  softDeleteWallet,
  postWalletDeposit,
  postWalletWithdraw,
  postWalletTransfer,
  walletReport,
  listAlerts,
  resolveAlert,
  normalizePeriod,
  businessDate
} = require('./wallet-service');

function registerWalletRoutes({ app, db, isUnrestrictedAccount }) {
  const unrestricted = req => Boolean(isUnrestrictedAccount(req.authUser));
  const scope = req => ({ branchId: Number(req.branchId), unrestricted: unrestricted(req) });
  const sendError = (res, error) => res.status(Number(error.statusCode) || 500).json({ error: error.message, code: error.code || 'WALLET_ERROR' });
  const idempotency = req => String(req.body?.idempotency_key || req.get('Idempotency-Key') || '').trim().slice(0, 180);
  const reference = (req, key) => String(req.body?.reference_id || `WALLET-${key}`).trim().slice(0, 160);
  const validBranch = branchId => db.data.branches.some(branch => Number(branch.id) === Number(branchId) && branch.is_active !== false);

  app.get('/api/wallets', (req, res) => {
    try {
      const queryBranch = unrestricted(req) ? Number(req.query.branch_id) || null : null;
      res.json({ wallets: listWallets(db.storageAdapter.connection, { ...scope(req), branchFilter: queryBranch, activeOnly: req.query.include_inactive !== '1' }) });
    } catch (error) { sendError(res, error); }
  });

  app.post('/api/wallets', (req, res) => {
    if (!unrestricted(req)) return res.status(403).json({ error: 'إضافة المحافظ متاحة للمالك فقط.' });
    const branchId = Number(req.body?.branch_id);
    if (!validBranch(branchId)) return res.status(400).json({ error: 'الفرع المحدد غير موجود أو غير نشط.' });
    try {
      const wallet = db.withSqlTransaction(connection => createWallet(connection, { ...req.body, branch_id: branchId }));
      res.status(201).json({ wallet });
    } catch (error) { sendError(res, error); }
  });

  app.put('/api/wallets/:id', (req, res) => {
    if (!unrestricted(req)) return res.status(403).json({ error: 'تعديل المحافظ متاح للمالك فقط.' });
    try {
      const wallet = db.withSqlTransaction(connection => updateWallet(connection, Number(req.params.id), req.body || {}));
      res.json({ wallet });
    } catch (error) { sendError(res, error); }
  });

  app.delete('/api/wallets/:id', (req, res) => {
    if (!unrestricted(req)) return res.status(403).json({ error: 'حذف المحافظ متاح للمالك فقط.' });
    try {
      const wallet = db.withSqlTransaction(connection => softDeleteWallet(connection, Number(req.params.id)));
      res.json({ wallet, message: 'تم تعطيل المحفظة.' });
    } catch (error) { sendError(res, error); }
  });

  app.post('/api/wallets/:id/deposit', (req, res) => {
    const key = idempotency(req);
    if (!key) return res.status(400).json({ error: 'Idempotency-Key مطلوب لمنع تكرار الإيداع.' });
    try {
      const result = db.withSqlTransaction(connection => {
        const wallet = assertWalletScope(walletRow(connection, Number(req.params.id)), { ...scope(req), requireActive: true });
        const period = normalizePeriod(req.body?.period || 'daily', req.body?.from, req.body?.to);
        return postWalletDeposit(connection, { ...req.body, wallet_id: wallet.id, user_id: req.authUser.id, reference_id: reference(req, key), idempotency_key: key, period, source_account_code: req.body?.source_account_code || '1110' });
      });
      res.status(result.already_processed ? 200 : 201).json(result);
    } catch (error) { sendError(res, error); }
  });

  app.post('/api/wallets/:id/withdraw', (req, res) => {
    const key = idempotency(req);
    if (!key) return res.status(400).json({ error: 'Idempotency-Key مطلوب لمنع تكرار السحب.' });
    try {
      const result = db.withSqlTransaction(connection => {
        const wallet = assertWalletScope(walletRow(connection, Number(req.params.id)), { ...scope(req), requireActive: true });
        const period = normalizePeriod(req.body?.period || 'daily', req.body?.from, req.body?.to);
        return postWalletWithdraw(connection, { ...req.body, wallet_id: wallet.id, user_id: req.authUser.id, reference_id: reference(req, key), idempotency_key: key, period, destination_account_code: req.body?.destination_account_code || '1110' });
      });
      res.status(result.already_processed ? 200 : 201).json(result);
    } catch (error) { sendError(res, error); }
  });

  app.post('/api/wallets/:id/transfer', (req, res) => {
    const key = idempotency(req);
    if (!key) return res.status(400).json({ error: 'Idempotency-Key مطلوب لمنع تكرار التحويل.' });
    try {
      const result = db.withSqlTransaction(connection => {
        const fromWallet = assertWalletScope(walletRow(connection, Number(req.params.id)), { ...scope(req), requireActive: true });
        const toWallet = assertWalletScope(walletRow(connection, Number(req.body?.to_wallet_id)), { ...scope(req), requireActive: true });
        if (!unrestricted(req) && Number(toWallet.branch_id) !== Number(req.branchId)) {
          const error = new Error('لا يمكن لموظف الفرع التحويل إلى محفظة فرع آخر.'); error.statusCode = 403; throw error;
        }
        const period = normalizePeriod(req.body?.period || 'daily', req.body?.from, req.body?.to);
        return postWalletTransfer(connection, { ...req.body, from_wallet_id: fromWallet.id, to_wallet_id: toWallet.id, user_id: req.authUser.id, reference_id: reference(req, key), idempotency_key: key, period });
      });
      res.status(result.already_processed ? 200 : 201).json(result);
    } catch (error) { sendError(res, error); }
  });

  app.get('/api/wallets/reports', (req, res) => {
    try {
      const period = req.query.from || req.query.to
        ? normalizePeriod('custom', req.query.from || businessDate(), req.query.to || req.query.from || businessDate())
        : normalizePeriod('daily');
      const queryBranch = unrestricted(req) ? Number(req.query.branch_id) || null : null;
      res.json(walletReport(db.storageAdapter.connection, { ...scope(req), branchFilter: queryBranch, walletId: Number(req.query.wallet_id) || null, type: String(req.query.type || '').trim(), from: period.from, to: period.to }));
    } catch (error) { sendError(res, error); }
  });

  app.get('/api/wallets/alerts', (req, res) => {
    try {
      const queryBranch = unrestricted(req) ? Number(req.query.branch_id) || null : null;
      res.json({ alerts: listAlerts(db.storageAdapter.connection, { ...scope(req), branchFilter: queryBranch, unresolvedOnly: req.query.unresolved !== '0' }) });
    } catch (error) { sendError(res, error); }
  });

  app.get('/api/wallets/:id', (req, res) => {
    try {
      const wallet = assertWalletScope(walletRow(db.storageAdapter.connection, Number(req.params.id)), scope(req));
      res.json({ wallet });
    } catch (error) { sendError(res, error); }
  });

  app.post('/api/wallets/alerts/:id/resolve', (req, res) => {
    try {
      const alert = db.withSqlTransaction(connection => resolveAlert(connection, Number(req.params.id), scope(req)));
      res.json({ alert, message: 'تم تعليم التنبيه كمحلول.' });
    } catch (error) { sendError(res, error); }
  });
}

module.exports = { registerWalletRoutes };
