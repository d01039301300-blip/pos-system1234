-- SYSTEM POS / PostgreSQL schema completion
-- Phase 2, TASK 6-A: schema only. No data migration.

BEGIN;

-- Missing columns. IF NOT EXISTS keeps this migration safe against the
-- columns already present in 001_initial_postgres.sql.
ALTER TABLE branches
    ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE branches
    ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS bootstrap_password_initialized BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE users
    ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMP;
ALTER TABLE warehouses
    ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE warehouses
    ADD COLUMN IF NOT EXISTS code TEXT;
ALTER TABLE warehouses
    ADD COLUMN IF NOT EXISTS address TEXT;

CREATE TABLE IF NOT EXISTS ai_insights (
    id BIGSERIAL PRIMARY KEY,
    branch_id BIGINT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    insight_type TEXT NOT NULL,
    title TEXT,
    content JSONB NOT NULL DEFAULT '{}'::jsonb,
    severity TEXT NOT NULL DEFAULT 'info',
    status TEXT NOT NULL DEFAULT 'new',
    generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cash_audit_chain (
    id BIGSERIAL PRIMARY KEY,
    branch_id BIGINT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    transaction_id BIGINT REFERENCES cash_transactions(id) ON DELETE SET NULL,
    sequence_no BIGINT NOT NULL,
    previous_hash TEXT,
    entry_hash TEXT NOT NULL,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (branch_id, sequence_no),
    UNIQUE (branch_id, entry_hash)
);

CREATE TABLE IF NOT EXISTS customer_transactions (
    id BIGSERIAL PRIMARY KEY,
    branch_id BIGINT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    transaction_type TEXT NOT NULL,
    amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    reference_type TEXT,
    reference_id BIGINT,
    transaction_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS delivery_assignments (
    id BIGSERIAL PRIMARY KEY,
    branch_id BIGINT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    rider_id BIGINT NOT NULL REFERENCES delivery_riders(id) ON DELETE RESTRICT,
    sale_id BIGINT REFERENCES sales(id) ON DELETE SET NULL,
    service_order_id BIGINT REFERENCES service_orders(id) ON DELETE SET NULL,
    status TEXT NOT NULL DEFAULT 'assigned',
    assigned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    delivered_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS delivery_rider_transactions (
    id BIGSERIAL PRIMARY KEY,
    branch_id BIGINT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    rider_id BIGINT NOT NULL REFERENCES delivery_riders(id) ON DELETE RESTRICT,
    user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    transaction_type TEXT NOT NULL,
    amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    reference_type TEXT,
    reference_id BIGINT,
    transaction_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS loyalty_transactions (
    id BIGSERIAL PRIMARY KEY,
    branch_id BIGINT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
    sale_id BIGINT REFERENCES sales(id) ON DELETE SET NULL,
    transaction_type TEXT NOT NULL,
    points NUMERIC(14,3) NOT NULL DEFAULT 0,
    amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    reference_type TEXT,
    reference_id BIGINT,
    transaction_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS purchase_order_items (
    id BIGSERIAL PRIMARY KEY,
    branch_id BIGINT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    purchase_order_id BIGINT NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    quantity NUMERIC(14,3) NOT NULL,
    unit_price NUMERIC(14,2) NOT NULL DEFAULT 0,
    total NUMERIC(14,2) NOT NULL DEFAULT 0,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sale_returns (
    id BIGSERIAL PRIMARY KEY,
    branch_id BIGINT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    sale_id BIGINT REFERENCES sales(id) ON DELETE SET NULL,
    customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL,
    user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    return_no TEXT NOT NULL,
    return_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    reason TEXT,
    subtotal NUMERIC(14,2) NOT NULL DEFAULT 0,
    tax NUMERIC(14,2) NOT NULL DEFAULT 0,
    total NUMERIC(14,2) NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'completed',
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (branch_id, return_no)
);

CREATE TABLE IF NOT EXISTS sale_return_items (
    id BIGSERIAL PRIMARY KEY,
    branch_id BIGINT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    sale_return_id BIGINT NOT NULL REFERENCES sale_returns(id) ON DELETE CASCADE,
    sale_item_id BIGINT REFERENCES sale_items(id) ON DELETE SET NULL,
    product_id BIGINT NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
    quantity NUMERIC(14,3) NOT NULL,
    unit_price NUMERIC(14,2) NOT NULL DEFAULT 0,
    total NUMERIC(14,2) NOT NULL DEFAULT 0,
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS self_order_requests (
    id BIGSERIAL PRIMARY KEY,
    branch_id BIGINT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    customer_id BIGINT REFERENCES customers(id) ON DELETE SET NULL,
    sale_id BIGINT REFERENCES sales(id) ON DELETE SET NULL,
    request_no TEXT NOT NULL,
    channel TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    request_data JSONB NOT NULL DEFAULT '{}'::jsonb,
    requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    fulfilled_at TIMESTAMPTZ,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (branch_id, request_no)
);

CREATE TABLE IF NOT EXISTS supplier_transactions (
    id BIGSERIAL PRIMARY KEY,
    branch_id BIGINT NOT NULL REFERENCES branches(id) ON DELETE RESTRICT,
    supplier_id BIGINT NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
    user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
    transaction_type TEXT NOT NULL,
    amount NUMERIC(14,2) NOT NULL DEFAULT 0,
    reference_type TEXT,
    reference_id BIGINT,
    transaction_date TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Branch indexes and indexes for every additional foreign key.
CREATE INDEX IF NOT EXISTS idx_ai_insights_branch ON ai_insights(branch_id);
CREATE INDEX IF NOT EXISTS idx_cash_audit_chain_branch ON cash_audit_chain(branch_id);
CREATE INDEX IF NOT EXISTS idx_cash_audit_chain_transaction ON cash_audit_chain(transaction_id);
CREATE INDEX IF NOT EXISTS idx_customer_transactions_branch ON customer_transactions(branch_id);
CREATE INDEX IF NOT EXISTS idx_customer_transactions_customer ON customer_transactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_customer_transactions_user ON customer_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_delivery_assignments_branch ON delivery_assignments(branch_id);
CREATE INDEX IF NOT EXISTS idx_delivery_assignments_rider ON delivery_assignments(rider_id);
CREATE INDEX IF NOT EXISTS idx_delivery_assignments_sale ON delivery_assignments(sale_id);
CREATE INDEX IF NOT EXISTS idx_delivery_assignments_service_order ON delivery_assignments(service_order_id);
CREATE INDEX IF NOT EXISTS idx_delivery_rider_transactions_branch ON delivery_rider_transactions(branch_id);
CREATE INDEX IF NOT EXISTS idx_delivery_rider_transactions_rider ON delivery_rider_transactions(rider_id);
CREATE INDEX IF NOT EXISTS idx_delivery_rider_transactions_user ON delivery_rider_transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_branch ON loyalty_transactions(branch_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_customer ON loyalty_transactions(customer_id);
CREATE INDEX IF NOT EXISTS idx_loyalty_transactions_sale ON loyalty_transactions(sale_id);
CREATE INDEX IF NOT EXISTS idx_purchase_order_items_branch ON purchase_order_items(branch_id);
CREATE INDEX IF NOT EXISTS idx_purchase_order_items_order ON purchase_order_items(purchase_order_id);
CREATE INDEX IF NOT EXISTS idx_purchase_order_items_product ON purchase_order_items(product_id);
CREATE INDEX IF NOT EXISTS idx_sale_returns_branch ON sale_returns(branch_id);
CREATE INDEX IF NOT EXISTS idx_sale_returns_sale ON sale_returns(sale_id);
CREATE INDEX IF NOT EXISTS idx_sale_returns_customer ON sale_returns(customer_id);
CREATE INDEX IF NOT EXISTS idx_sale_returns_user ON sale_returns(user_id);
CREATE INDEX IF NOT EXISTS idx_sale_return_items_branch ON sale_return_items(branch_id);
CREATE INDEX IF NOT EXISTS idx_sale_return_items_return ON sale_return_items(sale_return_id);
CREATE INDEX IF NOT EXISTS idx_sale_return_items_sale_item ON sale_return_items(sale_item_id);
CREATE INDEX IF NOT EXISTS idx_sale_return_items_product ON sale_return_items(product_id);
CREATE INDEX IF NOT EXISTS idx_self_order_requests_branch ON self_order_requests(branch_id);
CREATE INDEX IF NOT EXISTS idx_self_order_requests_customer ON self_order_requests(customer_id);
CREATE INDEX IF NOT EXISTS idx_self_order_requests_sale ON self_order_requests(sale_id);
CREATE INDEX IF NOT EXISTS idx_supplier_transactions_branch ON supplier_transactions(branch_id);
CREATE INDEX IF NOT EXISTS idx_supplier_transactions_supplier ON supplier_transactions(supplier_id);
CREATE INDEX IF NOT EXISTS idx_supplier_transactions_user ON supplier_transactions(user_id);

COMMIT;
