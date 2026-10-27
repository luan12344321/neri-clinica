import { useEffect, useState } from 'react';
import { useLoad } from './hooks';
import { Icon } from './Icon';
import { Avatar, ROLE_LABEL, type Role } from './ui';

export type Person = { id: string; name: string; role: Role; lastSeenAt: string | null; online: boolean };

export const usePresence = (enabled: boolean) => useLoad<Person[]>(enabled ? '/presence' : null, 30_000);

export function seenText(p: Person) {
  if (p.online) return 'Online agora';
  if (!p.lastSeenAt) return 'Ainda não entrou';
  const min = Math.max(1, Math.round((Date.now() - new Date(p.lastSeenAt).getTime()) / 60_000));
  if (min < 60) return `Visto há ${min} min`;
  const h = Math.round(min / 60);
  return h < 24 ? `Visto há ${h} h` : `Visto há ${Math.round(h / 24)} d`;
}

// Só o proprietário: avatares de quem está online ao lado do sino; ao tocar, abre o painel da equipe.
export function PresenceButton() {
  const { data } = usePresence(true);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    addEventListener('keydown', onKey);
    return () => removeEventListener('keydown', onKey);
  }, [open]);
  // O proprietário é único por clínica: "outras pessoas" são todos os demais perfis.
  const team = (data ?? []).filter((p) => p.role !== 'owner');
  const online = team.filter((p) => p.online);
  return (
    <>
      <button className="presence-btn" aria-label={online.length ? `${online.length} pessoa(s) online` : 'Equipe: ninguém online'} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        {online.length === 0 ? <Icon name="users" size={20} /> : (
          <span className="stack-av">
            {online.slice(0, 3).map((p) => <span key={p.id} className="stack-item"><Avatar name={p.name} size={28} /><i className="on-dot" /></span>)}
            {online.length > 3 && <span className="stack-more">+{online.length - 3}</span>}
          </span>
        )}
      </button>
      {open && (
        <>
          <div className="pop-scrim" onClick={() => setOpen(false)} />
          <section className="pop" role="dialog" aria-label="Equipe online">
            <h2>Equipe</h2>
            {team.length === 0 ? <p className="muted">Você ainda não cadastrou funcionários. Faça isso em Configurações.</p> : (
              <ul className="rows">{team.map((p) => (
                <li key={p.id}>
                  <div className="row-btn static">
                    <span className="av-wrap"><Avatar name={p.name} size={38} />{p.online && <i className="on-dot" />}</span>
                    <span className="grow"><b>{p.name}</b><span className="muted">{ROLE_LABEL[p.role]}</span></span>
                    <span className={`seen ${p.online ? 'on' : ''}`}>{seenText(p)}</span>
                  </div>
                </li>
              ))}</ul>
            )}
          </section>
        </>
      )}
    </>
  );
}
