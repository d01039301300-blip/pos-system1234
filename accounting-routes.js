'use strict';

const {
  ACCOUNT_CODES,
  createJournalEntry,
  postCashTransferToAccounting,
  amount,
  dateOnly
} = require('./accounting');

function connectionFor(db) {
  const connection = db?.storageAdapter?.connection;
  if (!connection) throw new Error('اتصال SQLite المحاسبي غير متاح.');
  return connection;
}

function validDate(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/u.test(text) ? text : '';
}

function queryRange(query = {}) {
  const from = validDate(query.from);
  const to = validDate(query.to);
  const conditions = ['e.is_posted=1'];
  const params = [];
  if (from) { conditions.push('e.entry_date >= ?'); params.push(from); }
  if (to) { conditions.push('e.entry_date <= ?'); params.push(to); }
  return { where: conditions.join(' AND '), params, from, to };
}

function runSqlTransaction(connection, operation) {
  connection.exec('BEGIN IMMEDIATE');
  try {
    const result = operation();
    connection.exec('COMMIT');
    return result;
  } catch (error) {
    try { connection.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

function signedBalance(accountType, debit, credit) {
  return ['asset', 'expense'].includes(accountType)
    ? amount(debit - credit)
    : amount(credit - debit);
}

function accountsTree(connection) {
  const rows = connection.prepare(`
    SELECT id, code, name_ar, name_en, type, parent_id, level, is_postable, is_active
    FROM accounts ORDER BY code
  `).all();
  const byParent = new Map();
  for (const row of rows) {
    const key = row.parent_id === null ? 'root' : String(row.parent_id);
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key).push(row);
  }
  const build = parentKey => (byParent.get(parentKey) || []).map(row => ({ ...row, children: build(String(row.id)) }));
  return { rows, tree: build('root') };
}

function journalRows(connection, query = {}) {
  const range = queryRange(query);
  const conditions = [range.where];
  const params = [...range.params];
  const accountCode = String(query.account_code || '').trim();
  const referenceType = String(query.reference_type || '').trim();
  const search = String(query.q || '').trim();
  if (accountCode) { conditions.push('a.code=?'); params.push(accountCode); }
  if (referenceType) { conditions.push('e.reference_type=?'); params.push(referenceType); }
  if (search) { conditions.push('(e.entry_number LIKE ? OR e.description LIKE ? OR e.reference_id LIKE ?)'); const like = `%${search}%`; params.push(like, like, like); }
  const rows = connection.prepare(`
    SELECT e.id, e.entry_number, e.entry_date, e.description, e.reference_type, e.reference_id,
           e.branch_id, e.created_by, e.is_posted, e.created_at,
           l.id AS line_id, l.debit, l.credit, l.description AS line_description,
           l.party_type, l.party_id, a.code AS account_code, a.name_ar AS account_name
    FROM journal_entries e
    JOIN journal_lines l ON l.entry_id=e.id
    JOIN accounts a ON a.id=l.account_id
    WHERE ${conditions.join(' AND ')}
    ORDER BY e.entry_date DESC, e.id DESC, l.id ASC
  `).all(...params);
  const entries = new Map();
  for (const row of rows) {
    let entry = entries.get(row.id);
    if (!entry) {
      entry = { id: row.id, entry_number: row.entry_number, entry_date: row.entry_date, description: row.description, reference_type: row.reference_type, reference_id: row.reference_id, branch_id: row.branch_id, created_by: row.created_by, is_posted: row.is_posted, created_at: row.created_at, lines: [], total_debit: 0, total_credit: 0 };
      entries.set(row.id, entry);
    }
    const line = { id: row.line_id, account_code: row.account_code, account_name: row.account_name, debit: amount(row.debit), credit: amount(row.credit), description: row.line_description, party_type: row.party_type, party_id: row.party_id };
    entry.lines.push(line);
    entry.total_debit = amount(entry.total_debit + line.debit);
    entry.total_credit = amount(entry.total_credit + line.credit);
  }
  const allEntries = [...entries.values()];
  const requestedLimit = Number.parseInt(query.limit, 10);
  const requestedOffset = Number.parseInt(query.offset, 10);
  if (Number.isInteger(requestedLimit) && requestedLimit > 0) {
    const limit = Math.min(requestedLimit, 200);
    const offset = Number.isInteger(requestedOffset) && requestedOffset >= 0 ? requestedOffset : 0;
    return { entries: allEntries.slice(offset, offset + limit), total: allEntries.length, offset, limit, has_more: offset + limit < allEntries.length };
  }
  return { entries: allEntries, total: allEntries.length };
}

function aggregateAccounts(connection, query = {}, asOfOnly = false) {
  const range = queryRange(asOfOnly ? { to: query.to } : query);
  const rows = connection.prepare(`
    SELECT a.id, a.code, a.name_ar, a.type,
           COALESCE(t.debit,0) AS debit, COALESCE(t.credit,0) AS credit
    FROM accounts a
    LEFT JOIN (
      SELECT l.account_id, SUM(l.debit) AS debit, SUM(l.credit) AS credit
      FROM journal_lines l
      JOIN journal_entries e ON e.id=l.entry_id
      WHERE ${range.where}
      GROUP BY l.account_id
    ) t ON t.account_id=a.id
    WHERE a.is_postable=1 AND (a.is_active=1 OR t.account_id IS NOT NULL)
    ORDER BY a.code
  `).all(...range.params).map(row => ({
    ...row,
    debit: amount(row.debit),
    credit: amount(row.credit),
    balance: signedBalance(row.type, Number(row.debit), Number(row.credit))
  }));
  return { rows, from: range.from, to: range.to };
}

function incomeStatement(connection, query = {}) {
  const range = queryRange(query);
  const rows = connection.prepare(`
    SELECT a.code, a.name_ar, a.type, COALESCE(SUM(l.debit),0) AS debit, COALESCE(SUM(l.credit),0) AS credit
    FROM accounts a
    JOIN journal_lines l ON l.account_id=a.id
    JOIN journal_entries e ON e.id=l.entry_id
    WHERE ${range.where} AND a.type IN ('revenue','expense')
    GROUP BY a.id, a.code, a.name_ar, a.type
    ORDER BY a.code
  `).all(...range.params).map(row => ({ ...row, debit: amount(row.debit), credit: amount(row.credit), balance: signedBalance(row.type, Number(row.debit), Number(row.credit)) }));
  const revenue = amount(rows.filter(row => row.type === 'revenue').reduce((sum, row) => sum + row.balance, 0));
  const expenses = amount(rows.filter(row => row.type === 'expense').reduce((sum, row) => sum + row.balance, 0));
  return { from: range.from, to: range.to, rows, revenue, expenses, net_income: amount(revenue - expenses) };
}

function balanceSheet(connection, query = {}) {
  const aggregated = aggregateAccounts(connection, { to: query.to }, true);
  const income = incomeStatement(connection, { from: '0000-01-01', to: validDate(query.to) || '9999-12-31' });
  const assets = amount(aggregated.rows.filter(row => row.type === 'asset').reduce((sum, row) => sum + row.balance, 0));
  const liabilities = amount(aggregated.rows.filter(row => row.type === 'liability').reduce((sum, row) => sum + row.balance, 0));
  const equityAccounts = aggregated.rows.filter(row => row.type === 'equity');
  const equityBase = amount(equityAccounts.reduce((sum, row) => sum + row.balance, 0));
  const currentProfit = amount(income.net_income);
  const equity = amount(equityBase + currentProfit);
  return { as_of: validDate(query.to) || null, rows: aggregated.rows, assets, liabilities, equity_base: equityBase, current_profit: currentProfit, equity, liabilities_plus_equity: amount(liabilities + equity), balanced: Math.abs(assets - liabilities - equity) <= 0.009 };
}

function registerAccountingRoutes({ app, db }) {
  app.get('/api/accounting/accounts', (_req, res) => {
    try { return res.json(accountsTree(connectionFor(db))); }
    catch (error) { return res.status(500).json({ error: error.message }); }
  });

  app.post('/api/accounting/accounts', (req, res) => {
    const code = String(req.body?.code || '').trim();
    const nameAr = String(req.body?.name_ar || '').trim();
    const nameEn = String(req.body?.name_en || '').trim();
    const type = String(req.body?.type || '').trim();
    const parentCode = String(req.body?.parent_code || '').trim();
    const isPostable = req.body?.is_postable === false || req.body?.is_postable === 0 ? 0 : 1;
    if (!/^\d{3,10}$/u.test(code) || !nameAr || !['asset','liability','equity','revenue','expense'].includes(type)) return res.status(400).json({ error: 'بيانات الحساب غير صحيحة.' });
    try {
      const connection = connectionFor(db);
      const result = runSqlTransaction(connection, () => {
        const parent = parentCode ? connection.prepare('SELECT id, level FROM accounts WHERE code=?').get(parentCode) : null;
        if (parentCode && !parent) throw new Error('الحساب الأب غير موجود.');
        const row = connection.prepare(`
          INSERT INTO accounts(code, name_ar, name_en, type, parent_id, level, is_postable, is_active)
          VALUES (?, ?, ?, ?, ?, ?, ?, 1)
        `).run(code, nameAr, nameEn, type, parent?.id || null, Number(parent?.level || 0) + 1, isPostable);
        return connection.prepare('SELECT * FROM accounts WHERE id=?').get(Number(row.lastInsertRowid));
      });
      return res.status(201).json(result);
    } catch (error) { return res.status(error.code === 'SQLITE_CONSTRAINT_UNIQUE' ? 409 : 400).json({ error: error.message }); }
  });

  app.put('/api/accounting/accounts/:id', (req, res) => {
    const id = Number(req.params.id);
    const nameAr = String(req.body?.name_ar || '').trim();
    const nameEn = String(req.body?.name_en || '').trim();
    const isActive = req.body?.is_active === false || req.body?.is_active === 0 ? 0 : 1;
    if (!Number.isInteger(id) || !nameAr) return res.status(400).json({ error: 'بيانات الحساب غير صحيحة.' });
    try {
      const connection = connectionFor(db);
      const result = connection.prepare('UPDATE accounts SET name_ar=?, name_en=?, is_active=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(nameAr, nameEn, isActive, id);
      if (!result.changes) return res.status(404).json({ error: 'الحساب غير موجود.' });
      return res.json(connection.prepare('SELECT * FROM accounts WHERE id=?').get(id));
    } catch (error) { return res.status(400).json({ error: error.message }); }
  });

  app.get('/api/accounting/journal', (req, res) => {
    try { return res.json(journalRows(connectionFor(db), req.query)); }
    catch (error) { return res.status(500).json({ error: error.message }); }
  });

  app.post('/api/accounting/journal', (req, res) => {
    const body = req.body || {};
    if (!Array.isArray(body.lines) || body.lines.length < 2) return res.status(400).json({ error: 'القيد اليدوي يحتاج سطرين على الأقل.' });
    const referenceId = String(body.reference_id || `MANUAL-${Date.now()}`).trim();
    try {
      const connection = connectionFor(db);
      const entry = runSqlTransaction(connection, () => createJournalEntry(connection, {
        entry_date: body.entry_date,
        description: body.description,
        reference_type: 'manual',
        reference_id: referenceId,
        branch_id: req.branchId,
        created_by: req.authUser?.id,
        lines: body.lines
      }));
      console.log(`[ACCOUNTING_API] manual journal=${entry.entry_number}`);
      return res.status(201).json(entry);
    } catch (error) { return res.status(error.code === 'ACCOUNTING_DUPLICATE_REFERENCE' ? 409 : 400).json({ error: error.message, code: error.code }); }
  });

  app.get('/api/accounting/ledger', (req, res) => {
    const code = String(req.query.account_code || '').trim();
    if (!code) return res.status(400).json({ error: 'اختر الحساب.' });
    try {
      const connection = connectionFor(db);
      const account = connection.prepare('SELECT id, code, name_ar, type FROM accounts WHERE code=?').get(code);
      if (!account) return res.status(404).json({ error: 'الحساب غير موجود.' });
      const range = queryRange(req.query);
      const opening = connection.prepare(`
        SELECT COALESCE(SUM(l.debit),0) AS debit, COALESCE(SUM(l.credit),0) AS credit
        FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
        WHERE e.is_posted=1 AND l.account_id=? AND (?='' OR e.entry_date < ?)
      `).get(account.id, range.from || '', range.from || '');
      const rows = connection.prepare(`
        SELECT e.entry_number, e.entry_date, e.description, e.reference_type, e.reference_id,
               l.debit, l.credit, l.description AS line_description, l.party_type, l.party_id
        FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
        WHERE ${range.where} AND l.account_id=?
        ORDER BY e.entry_date, e.id, l.id
      `).all(...range.params, account.id);
      let running = signedBalance(account.type, Number(opening.debit), Number(opening.credit));
      const ledgerRows = rows.map(row => {
        running = amount(running + signedBalance(account.type, Number(row.debit), Number(row.credit)));
        return { ...row, debit: amount(row.debit), credit: amount(row.credit), running_balance: running };
      });
      return res.json({ account, from: range.from, to: range.to, opening_balance: running - ledgerRows.reduce((sum, row) => sum + signedBalance(account.type, row.debit, row.credit), 0), closing_balance: running, rows: ledgerRows });
    } catch (error) { return res.status(500).json({ error: error.message }); }
  });

  app.get('/api/accounting/trial-balance', (req, res) => {
    try {
      const data = aggregateAccounts(connectionFor(db), req.query);
      const totalDebit = amount(data.rows.reduce((sum, row) => sum + row.debit, 0));
      const totalCredit = amount(data.rows.reduce((sum, row) => sum + row.credit, 0));
      return res.json({ ...data, total_debit: totalDebit, total_credit: totalCredit, balanced: Math.abs(totalDebit - totalCredit) <= 0.009 });
    } catch (error) { return res.status(500).json({ error: error.message }); }
  });

  app.get('/api/accounting/income-statement', (req, res) => {
    try { return res.json(incomeStatement(connectionFor(db), req.query)); }
    catch (error) { return res.status(500).json({ error: error.message }); }
  });

  app.get('/api/accounting/balance-sheet', (req, res) => {
    try { return res.json(balanceSheet(connectionFor(db), req.query)); }
    catch (error) { return res.status(500).json({ error: error.message }); }
  });

  app.get('/api/accounting/party-ledger', (req, res) => {
    const partyType = ['customer', 'supplier'].includes(String(req.query.party_type)) ? String(req.query.party_type) : '';
    const partyId = Number(req.query.party_id);
    if (!partyType || !Number.isInteger(partyId) || partyId <= 0) return res.status(400).json({ error: 'نوع ومعرّف الطرف مطلوبان.' });
    try {
      const connection = connectionFor(db);
      const range = queryRange(req.query);
      const rows = connection.prepare(`
        SELECT e.entry_number, e.entry_date, e.description, e.reference_type, e.reference_id,
               l.debit, l.credit, l.description AS line_description
        FROM journal_lines l JOIN journal_entries e ON e.id=l.entry_id
        WHERE ${range.where} AND l.party_type=? AND l.party_id=?
        ORDER BY e.entry_date, e.id, l.id
      `).all(...range.params, partyType, partyId).map(row => ({ ...row, debit: amount(row.debit), credit: amount(row.credit) }));
      const totalDebit = amount(rows.reduce((sum, row) => sum + row.debit, 0));
      const totalCredit = amount(rows.reduce((sum, row) => sum + row.credit, 0));
      return res.json({ party_type: partyType, party_id: partyId, from: range.from, to: range.to, rows, total_debit: totalDebit, total_credit: totalCredit, balance: amount(totalDebit - totalCredit) });
    } catch (error) { return res.status(500).json({ error: error.message }); }
  });

  app.get('/api/accounting/cash-banks', (_req, res) => {
    try {
      const connection = connectionFor(db);
      const rows = connection.prepare(`
        SELECT a.code, a.name_ar, a.type, COALESCE(SUM(l.debit),0) AS debit, COALESCE(SUM(l.credit),0) AS credit
        FROM accounts a LEFT JOIN journal_lines l ON l.account_id=a.id
        LEFT JOIN journal_entries e ON e.id=l.entry_id AND e.is_posted=1
        WHERE a.code IN (?,?) GROUP BY a.id ORDER BY a.code
      `).all(ACCOUNT_CODES.cash, ACCOUNT_CODES.bank).map(row => ({ ...row, debit: amount(row.debit), credit: amount(row.credit), balance: amount(Number(row.debit) - Number(row.credit)) }));
      return res.json({ rows, total: amount(rows.reduce((sum, row) => sum + row.balance, 0)) });
    } catch (error) { return res.status(500).json({ error: error.message }); }
  });

  app.post('/api/accounting/cash-transactions', (req, res) => {
    const type = String(req.body?.type || '').trim();
    const value = amount(req.body?.amount);
    const description = String(req.body?.description || '').trim();
    if (!['deposit', 'withdrawal', 'transfer'].includes(type) || value <= 0 || !description) return res.status(400).json({ error: 'أدخل نوع الحركة والبيان والمبلغ.' });
    const referenceId = `ACASH-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    try {
      const connection = connectionFor(db);
      const entry = runSqlTransaction(connection, () => {
        if (type === 'transfer') {
          return postCashTransferToAccounting({ reference_id: referenceId, amount: value, description, from_account_code: req.body?.from_account_code || ACCOUNT_CODES.cash, to_account_code: req.body?.to_account_code || ACCOUNT_CODES.bank, branch_id: req.branchId, created_by: req.authUser?.id, created_at: new Date().toISOString() }, connection);
        }
        const debitCode = type === 'deposit' ? (req.body?.to_account_code || ACCOUNT_CODES.cash) : (req.body?.expense_account_code || ACCOUNT_CODES.miscellaneousExpense);
        const creditCode = type === 'deposit' ? (req.body?.offset_account_code || ACCOUNT_CODES.capital) : (req.body?.from_account_code || ACCOUNT_CODES.cash);
        return createJournalEntry(connection, { entry_date: new Date().toISOString(), description, reference_type: 'cash', reference_id: referenceId, branch_id: req.branchId, created_by: req.authUser?.id, lines: [{ account_code: debitCode, debit: value, description }, { account_code: creditCode, credit: value, description }] });
      });
      return res.status(201).json(entry);
    } catch (error) { return res.status(400).json({ error: error.message, code: error.code }); }
  });

  app.get('/api/accounting/health', (_req, res) => {
    try {
      const connection = connectionFor(db);
      const version = Number(connection.prepare('PRAGMA user_version').get()?.user_version || 0);
      const accounts = Number(connection.prepare('SELECT COUNT(*) AS n FROM accounts').get().n || 0);
      const entries = Number(connection.prepare('SELECT COUNT(*) AS n FROM journal_entries WHERE is_posted=1').get().n || 0);
      return res.json({ ok: version >= 6 && accounts > 0, user_version: version, accounts, posted_entries: entries });
    } catch (error) { return res.status(500).json({ ok: false, error: error.message }); }
  });
}

module.exports = { registerAccountingRoutes, accountsTree, journalRows, aggregateAccounts, incomeStatement, balanceSheet, dateOnly };
