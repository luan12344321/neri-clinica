// Icons from @edusites/icons. Mostly the stroked "encarafit" set (ef-*); a few
// filled base icons where that set has no match.
const NAMES = {
  menu: 'ef-menu',
  close: 'ef-fechar',
  bell: 'ef-sino',
  home: 'ef-casa',
  chart: 'ef-grafico-barras',
  box: 'ef-cubo',
  tag: 'etiqueta-preco',
  users: 'ef-grupo',
  syringe: 'seringa',
  mail: 'ef-email',
  spark: 'ef-ia',
  send: 'ef-enviar',
  out: 'ef-sair',
  receive: 'ef-seta-baixo',
  pay: 'ef-seta-cima',
  alert: 'ef-alerta',
  calendar: 'ef-calendario',
  wallet: 'ef-carteira',
  check: 'ef-check',
  plus: 'ef-mais',
  search: 'ef-busca',
  back: 'ef-chevron-esquerda',
  arrow: 'ef-chevron-direita',
  gear: 'ef-ajustes',
  download: 'ef-baixar',
  eye: 'ef-olho',
  eyeoff: 'ef-olho-fechado',
  copy: 'ef-copiar',
  bank: 'ef-banco',
  share: 'ef-compartilhar',
  qr: 'ef-qr-code',
  chat: 'ef-chat',
  whatsapp: 'whatsapp',
  pulse: 'batimento-cardiaco',
  clock: 'ef-relogio',
  filter: 'ef-filtro',
  list: 'ef-vis-lista',
  grid: 'ef-vis-cards',
} as const;

export type IconName = keyof typeof NAMES;

// ponytail: the package's own svgIcone() resolves lazily (blank first paint), so we
// bundle the raw files we use synchronously. Relies on the package's src/icones layout.
const RAW = import.meta.glob<string>(
  // keep in sync with NAMES (glob must be a literal)
  '../node_modules/@edusites/icons/src/icones/{ef-menu,ef-fechar,ef-sino,ef-casa,ef-grafico-barras,ef-cubo,etiqueta-preco,ef-grupo,seringa,ef-email,ef-ia,ef-enviar,ef-sair,ef-seta-baixo,ef-seta-cima,ef-alerta,ef-calendario,ef-carteira,ef-check,ef-mais,ef-busca,ef-chevron-esquerda,ef-chevron-direita,ef-ajustes,ef-baixar,ef-olho,ef-olho-fechado,ef-copiar,ef-banco,ef-compartilhar,ef-qr-code,ef-chat,whatsapp,batimento-cardiaco,ef-relogio,ef-filtro,ef-vis-lista,ef-vis-cards}.js',
  { eager: true, import: 'default' },
);

type Parsed = { attrs: Record<string, string>; inner: string };
const parse = (svg: string): Parsed => {
  const end = svg.indexOf('>');
  const root = svg.slice(0, end);
  const attrs: Record<string, string> = {};
  for (const [, k, v] of root.matchAll(/([\w-]+)="([^"]*)"/g)) {
    if (k === 'xmlns') continue;
    attrs[k.replace(/-(\w)/g, (_, c: string) => c.toUpperCase())] = v;
  }
  if (!attrs.stroke) attrs.fill = 'currentColor'; // filled icons: color from CSS
  return { attrs, inner: svg.slice(end + 1, svg.lastIndexOf('</svg>')) };
};

const ICONS = Object.fromEntries(
  Object.entries(NAMES).map(([k, file]) => {
    const raw = Object.entries(RAW).find(([p]) => p.endsWith(`/${file}.js`))?.[1];
    if (!raw) throw new Error(`@edusites/icons: missing ${file}`);
    return [k, parse(raw)];
  }),
) as Record<IconName, Parsed>;

export const Icon = ({ name, size = 22 }: { name: IconName; size?: number }) => {
  const { attrs, inner } = ICONS[name];
  return <svg className="ico" {...attrs} width={size} height={size} aria-hidden="true" dangerouslySetInnerHTML={{ __html: inner }} />;
};
