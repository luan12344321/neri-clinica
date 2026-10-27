import { q } from './db.js';

export const auditCtx = (req) => ({ clinicId: req.user.clinicId, userId: req.user.userId, ip: req.ip });

// Trilha de auditoria (LGPD). Quem chama deve dar `await` ANTES de devolver o dado sensível:
// se a gravação do log falhar, a requisição falha junto (fail-closed) e nada é revelado sem registro.
export const audit = ({ clinicId, userId, ip }, action, entity = null, entityId = null) =>
  q(`INSERT INTO audit_log (clinic_id, user_id, action, entity, entity_id, ip) VALUES ($1,$2,$3,$4,$5,$6)`,
    [clinicId, userId ?? null, action, entity, entityId, ip ?? null]);
