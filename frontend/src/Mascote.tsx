import { useEffect, useRef, useState } from 'react';

// Mascote da Julia: robô branco com visor preto (baseado na referência em frontend/Referencias/IA), em SVG animado por CSS.
// Humores: idle (respira, pisca, olha em volta), wave (acena), talk (fala), think (pensando), happy, sad.
// Clicar nela faz uma reação (alegre). "head" e "half" recortam o mesmo desenho (rosto; rosto e tronco).
export type Mood = 'idle' | 'wave' | 'talk' | 'think' | 'happy' | 'sad';
const VIEW = { full: '0 0 200 230', half: '24 22 152 138', head: '34 30 132 100' } as const;

export default function Mascote({ mood = 'idle', variant = 'full', size = 160, greet = false, label = 'Julia, a assistente' }:
  { mood?: Mood; variant?: keyof typeof VIEW; size?: number; greet?: boolean; label?: string }) {
  const [flash, setFlash] = useState<Mood | null>(greet ? 'wave' : null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const react = (m: Mood, ms: number) => { clearTimeout(timer.current); setFlash(m); timer.current = setTimeout(() => setFlash(null), ms); };
  useEffect(() => { if (greet) react('wave', 2800); return () => clearTimeout(timer.current); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const shown = mood !== 'idle' ? mood : (flash ?? 'idle');
  const [, , w, h] = VIEW[variant].split(' ').map(Number) as [number, number, number, number];

  return (
    <svg className={`mascote m-${variant}`} data-mood={shown} viewBox={VIEW[variant]} width={size} height={Math.round(size * h! / w!)}
      role="img" aria-label={label} onClick={() => react('happy', 1800)}>
      <defs>
        <radialGradient id="mBody" cx="40%" cy="30%" r="80%"><stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#e3e9e4" /></radialGradient>
        <radialGradient id="mHead" cx="38%" cy="28%" r="85%"><stop offset="0" stopColor="#ffffff" /><stop offset="1" stopColor="#e6ebe7" /></radialGradient>
        <linearGradient id="mGreen" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#3f8f6e" /><stop offset="1" stopColor="#1d4d3b" /></linearGradient>
      </defs>
      <title>{label}</title>
      {variant === 'full' && <>
        <ellipse cx="100" cy="214" rx="76" ry="13" fill="#d9d4c4" opacity=".55" />
        <ellipse cx="100" cy="210" rx="72" ry="12" fill="#ffffff" stroke="#e2dfd2" />
      </>}

      <g className="m-all">
        {/* braço esquerdo */}
        <g className="arm arm-l">
          <path d="M68 128 C52 134 44 158 48 180 C50 190 62 190 65 181 C69 166 74 148 74 136 Z" fill="#fff" stroke="#dde3de" strokeWidth="1.5" />
          <ellipse cx="58" cy="160" rx="3.6" ry="14" fill="url(#mGreen)" transform="rotate(8 58 160)" />
        </g>
        {/* corpo */}
        <path className="m-torso" d="M100 106 C135 106 148 142 146 172 C144 198 125 208 100 208 C75 208 56 198 54 172 C52 142 65 106 100 106 Z" fill="url(#mBody)" stroke="#dde3de" strokeWidth="1.5" />
        <path d="M74 114 Q100 134 126 114 L128 132 Q126 148 120 134 Q100 142 80 134 Q74 148 72 132 Z" fill="url(#mGreen)" />
        <circle cx="86" cy="172" r="1.6" fill="#c3cbc6" />
        {/* braço direito (espelhado) */}
        <g className="arm arm-r">
          <g transform="translate(200 0) scale(-1 1)">
            <path d="M68 128 C52 134 44 158 48 180 C50 190 62 190 65 181 C69 166 74 148 74 136 Z" fill="#fff" stroke="#dde3de" strokeWidth="1.5" />
            <ellipse cx="58" cy="160" rx="3.6" ry="14" fill="url(#mGreen)" transform="rotate(8 58 160)" />
          </g>
        </g>

        {/* cabeça */}
        <g className="m-head">
          <ellipse cx="42" cy="84" rx="8" ry="16" fill="#cdd4cf" />
          <ellipse cx="158" cy="84" rx="8" ry="16" fill="#cdd4cf" />
          <ellipse cx="100" cy="82" rx="58" ry="48" fill="url(#mHead)" stroke="#dde3de" strokeWidth="1.5" />
          <path d="M78 41 Q100 34 122 41 L119 50 Q100 44 81 50 Z" fill="url(#mGreen)" />
          <ellipse cx="100" cy="86" rx="43" ry="33" fill="#0f1a15" />
          <ellipse cx="82" cy="70" rx="14" ry="5" fill="#fff" opacity=".07" transform="rotate(-18 82 70)" />

          <g className="eyes">
            <g className="eye eye-l"><ellipse cx="84" cy="80" rx="9" ry="10.5" fill="#fff" /></g>
            <g className="eye eye-r"><ellipse cx="116" cy="80" rx="9" ry="10.5" fill="#fff" /></g>
            <path className="eye-happy" d="M74 84 Q84 70 94 84 M106 84 Q116 70 126 84" fill="none" stroke="#fff" strokeWidth="4.5" strokeLinecap="round" />
            <path className="lid lid-sad" d="M70 78 L98 65 M130 78 L102 65" fill="none" stroke="#0f1a15" strokeWidth="9" strokeLinecap="round" />
          </g>
          <ellipse className="cheek" cx="68" cy="100" rx="7" ry="4" fill="#3f8f6e" />
          <ellipse className="cheek" cx="132" cy="100" rx="7" ry="4" fill="#3f8f6e" />
          <path className="mouth mouth-smile" d="M91 102 Q100 110 109 102" fill="none" stroke="#7fd1ae" strokeWidth="3" strokeLinecap="round" />
          <ellipse className="mouth mouth-talk" cx="100" cy="104" rx="6" ry="3.5" fill="#7fd1ae" />
          <path className="mouth mouth-flat" d="M93 104 L107 104" fill="none" stroke="#7fd1ae" strokeWidth="3" strokeLinecap="round" />
          <path className="mouth mouth-sad" d="M91 108 Q100 101 109 108" fill="none" stroke="#7fd1ae" strokeWidth="3" strokeLinecap="round" />
        </g>
        <g className="dots" fill="#3f8f6e"><circle cx="140" cy="36" r="3.5" /><circle cx="150" cy="27" r="4.5" /><circle cx="162" cy="17" r="5.5" /></g>
      </g>
    </svg>
  );
}
