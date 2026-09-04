// Source registry metadata only. Never retain X post text outside the mounted view.
let status = null;
export const meta = () => status;
export function recordStatus(payload) {
  status = payload ? { state: payload.status, lastSuccessAt: payload.lastSuccessAt || null,
    perCompany: payload.perCompany, intervalHours: payload.intervalHours } : null;
}
