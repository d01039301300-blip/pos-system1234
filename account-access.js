(function exposeAccountAccess(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.SystemAccountAccess = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createAccountAccess() {
  const TABS = Object.freeze([
    ['pos', 'نقطة البيع'], ['wallets', 'المحافظ الإلكترونية'], ['installments', 'التقسيط وجدولة المستحقات'], ['promotions', 'العروض الترويجية'],
    ['offer-messages', 'رسائل العروض للعملاء'], ['dashboard', 'لوحة التحكم'], ['products', 'المنتجات والأسعار'],
    ['categories', 'الفئات والتصنيفات'], ['inventory', 'المخزون والتنبيهات'], ['purchases', 'المشتريات والموردين'],
    ['sales-history', 'سجل الفواتير والمبيعات'], ['delivery', 'مكتب الدليفري'], ['delivery-riders', 'طيارو التوصيل'],
    ['customers', 'العملاء والحسابات'], ['suppliers', 'الموردون'], ['treasury', 'الخزينة والمصروفات'],
    ['employees', 'حسابات الموظفين والرواتب'], ['barcodes', 'طباعة الباركود'], ['branch-warehouse', 'الفروع والمخازن'],
    ['reports', 'التقارير والأرباح'], ['users', 'المستخدمين والصلاحيات'], ['audit-logs', 'سجل مراقبة النشاط']
  ]);
  function isUnrestrictedAccount(user) {
    return Boolean(user && (user.is_owner === true || user.role === 'owner' || (user.username === 'admin' && user.role === 'admin')));
  }
  function canSeeScreen(user, tabId) {
    return isUnrestrictedAccount(user) || !Array.isArray(user?.allowed_tabs) || user.allowed_tabs.includes(tabId);
  }
  function isFocusedAccount(user) {
    return !isUnrestrictedAccount(user) && Array.isArray(user?.allowed_tabs);
  }
  return Object.freeze({ TABS, isUnrestrictedAccount, canSeeScreen, isFocusedAccount });
});
