'use strict';
(function attachInvoiceShareUtils(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.InvoiceShareUtils = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createInvoiceShareUtils() {
  function normalizeDigits(value) {
    return String(value ?? '')
      .replace(/[٠-٩]/g, digit => String(digit.charCodeAt(0) - 0x0660))
      .replace(/[۰-۹]/g, digit => String(digit.charCodeAt(0) - 0x06f0));
  }

  function normalizeEgyptWhatsappPhone(value) {
    let digits = normalizeDigits(value).replace(/\D/g, '');
    if (digits.startsWith('00')) digits = digits.slice(2);
    if (digits.startsWith('0')) digits = `2${digits}`;
    return digits;
  }

  function normalizePublicBase(value) {
    try {
      const url = new URL(String(value || '').trim());
      if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || url.search || url.hash) return '';
      return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    } catch (_) { return ''; }
  }

  function buildPublicInvoiceUrl(publicUrl, token) {
    const base = normalizePublicBase(publicUrl);
    if (!base || !String(token || '').trim()) return '';
    return `${base}/share/invoice/${encodeURIComponent(String(token))}`;
  }

  function money(value) {
    const number = Number(value);
    return `${(Number.isFinite(number) ? number : 0).toFixed(2)} ج.م`;
  }

  function buildReceiptMessage(sale, { businessName = '', shareUrl = '' } = {}) {
    const rows = Array.isArray(sale?.items) ? sale.items : [];
    const remaining = sale?.remaining_amount === undefined || sale?.remaining_amount === null
      ? Math.max(0, Number(sale?.total || 0) - Number(sale?.paid_amount || 0))
      : sale.remaining_amount;
    const lines = [
      String(businessName || 'فاتورة بيع').trim(),
      `رقم الفاتورة: ${sale?.invoice_number || ''}`,
      `التاريخ: ${sale?.created_at || ''}`,
      'الأصناف:'
    ];
    rows.slice(0, 15).forEach(item => {
      const name = String(item?.product_name || item?.name || 'صنف').replace(/[\r\n]+/g, ' ').trim();
      lines.push(`• ${name} × ${normalizeDigits(item?.quantity ?? 0)} — سعر الوحدة ${money(item?.unit_price)} — الإجمالي ${money(item?.total)}`);
    });
    if (rows.length > 15) lines.push(`+ ${rows.length - 15} أصناف أخرى`);
    lines.push(
      `الخصم: ${money(sale?.discount)}`,
      `الإجمالي: ${money(sale?.total)}`,
      `المدفوع: ${money(sale?.paid_amount)}`,
      `المتبقي: ${money(remaining)}`
    );
    if (shareUrl) lines.push(`رابط الفاتورة: ${shareUrl}`);
    return lines.join('\n');
  }

  return { normalizeDigits, normalizeEgyptWhatsappPhone, normalizePublicBase, buildPublicInvoiceUrl, buildReceiptMessage };
});
