// Avatar redondo com a inicial (ou duas) do e-mail/nome — cor estável por texto,
// pra a mesma pessoa ter sempre a mesma cor em Users, Groups e nos membros.
const PALETTE = ['#2F9E9A', '#5B8DEF', '#9B6BDF', '#D9739C', '#E08A3C', '#4DAA6D', '#C2615A', '#7A8794'];

function hash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export function initialsOf(name: string): string {
  const base = (name.split('@')[0] || name).trim();
  const parts = base.split(/[\s._-]+/).filter(Boolean);
  const letters = parts.length > 1 ? parts[0][0] + parts[1][0] : base.slice(0, 1);
  return (letters || '?').toUpperCase();
}

export function Avatar({ name, size = 28 }: { name: string; size?: number }) {
  return (
    <span
      className="avatar"
      aria-hidden="true"
      style={{ width: size, height: size, fontSize: Math.round(size * 0.4), background: PALETTE[hash(name) % PALETTE.length] }}
    >
      {initialsOf(name)}
    </span>
  );
}

// Pilha de avatares sobrepostos (até `max`) + "+n".
export function AvatarStack({ names, max = 5 }: { names: string[]; max?: number }) {
  const shown = names.slice(0, max);
  const extra = names.length - shown.length;
  return (
    <span className="avatar-stack" title={names.join(', ')}>
      {shown.map(n => (
        <Avatar key={n} name={n} size={24} />
      ))}
      {extra > 0 && <span className="avatar avatar-more">+{extra}</span>}
    </span>
  );
}
