function effectivePermissionsForUser(connection, user) {
  const rows = connection.prepare(`
    SELECT p.id,p.code,p.name_ar,p.category,rd.granted AS default_granted,up.granted AS override_granted
    FROM permissions p
    LEFT JOIN role_defaults rd ON rd.permission_id=p.id AND rd.role=?
    LEFT JOIN user_permissions up ON up.permission_id=p.id AND up.user_id=?
    ORDER BY p.category,p.code
  `).all(String(user?.role || ''), Number(user?.id));
  const roleDefined = rows.some(row => row.default_granted !== null && row.default_granted !== undefined);
  if (roleDefined) {
    const details = rows.map(row => ({
      code: row.code,
      name_ar: row.name_ar,
      category: row.category,
      granted: Number(row.override_granted ?? row.default_granted ?? 0) === 1,
      override_granted: row.override_granted === null || row.override_granted === undefined ? null : Number(row.override_granted)
    }));
    return { codes: details.filter(row => row.granted).map(row => row.code), details, source: 'role_defaults_plus_overrides' };
  }
  const legacyCodes = new Set(Array.isArray(user?.permissions) ? user.permissions.map(String) : []);
  for (const row of rows) {
    if (row.override_granted === null || row.override_granted === undefined) continue;
    if (Number(row.override_granted) === 1) legacyCodes.add(String(row.code));
    else legacyCodes.delete(String(row.code));
  }
  const details = rows.map(row => ({
    code: row.code,
    name_ar: row.name_ar,
    category: row.category,
    granted: legacyCodes.has(String(row.code)),
    override_granted: row.override_granted === null || row.override_granted === undefined ? null : Number(row.override_granted)
  }));
  for (const code of legacyCodes) if (!details.some(row => row.code === code)) details.push({ code, name_ar: code, category: 'legacy', granted: true, override_granted: null });
  return { codes: [...legacyCodes], details, source: 'legacy_user_permissions_plus_overrides' };
}

module.exports = { effectivePermissionsForUser };
