export function isAuthorizedAdminRecord(snapshot) {
  return Boolean(snapshot?.exists && snapshot.data()?.isAdmin === true)
}
