const PATHS = {
  menu: 'M4 7h16M4 12h16M4 17h10',
  close: 'M6 6l12 12M18 6L6 18',
  bell: 'M6 9a6 6 0 0 1 12 0c0 6 2 7 2 7H4s2-1 2-7zM10 20a2 2 0 0 0 4 0',
  home: 'M4 11l8-7 8 7v9h-5v-6H9v6H4z',
  chart: 'M4 20V10h4v10zm6 0V4h4v16zm6 0v-7h4v7z',
  box: 'M3 7l9-4 9 4v10l-9 4-9-4zm9 4v9m0-9L3 7m9 4l9-4',
  tag: 'M3 12V4h8l10 10-8 8zM7.5 8.5h.01',
  users: 'M16 19v-1a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v1M10 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zm9 8v-1a4 4 0 0 0-3-3.9M16 4.2a3.5 3.5 0 0 1 0 6.6',
  syringe: 'M15 4l5 5M17 6l-9 9-3 1 1-3 9-9M12 9l3 3M5 19l-2 2',
  mail: 'M4 6h16v12H4zM4 7l8 6 8-6',
  spark: 'M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z',
  send: 'M5 12l15-8-5 17-3-7z',
  out: 'M10 5H5v14h5M15 8l4 4-4 4M19 12H9',
  receive: 'M12 4v12m0 0l-4-4m4 4l4-4M5 20h14',
  pay: 'M12 20V8m0 0l-4 4m4-4l4 4M5 4h14',
  alert: 'M12 4l9 16H3zM12 10v4m0 3h.01',
  calendar: 'M5 5h14v15H5zM5 10h14M9 3v4m6-4v4',
  wallet: 'M4 7h15v12H4zM4 7l12-3v3M15 13h2',
  check: 'M5 12.5l4.5 4.5L19 7.5',
  plus: 'M12 5v14M5 12h14',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  back: 'M15 5l-7 7 7 7',
  gear: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3h0a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8v0a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z',
  download: 'M12 4v11m0 0l-4-4m4 4l4-4M5 20h14',
  eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  eyeoff: 'M3 3l18 18M10.6 6.1A9.7 9.7 0 0 1 12 6c6 0 10 6 10 6a17 17 0 0 1-3.2 3.9M6.6 6.7A17 17 0 0 0 2 12s4 7 10 7c1.6 0 3-.4 4.3-1M9.9 9.9a3 3 0 0 0 4.2 4.2',
  copy: 'M9 9h10v11H9zM5 15H4V4h11v1',
  bank: 'M3 10l9-6 9 6M5 10v8m4-8v8m6-8v8m4-8v8M3 20h18',
  share: 'M12 3v12m0-12L8 7m4-4l4 4M5 13v7h14v-7',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v6h-4M14 18h2v2h-2z',
  chat: 'M4 5h16v11H9l-5 4zM8 10h8M8 13h5',
  pulse: 'M3 12h4l2-6 4 12 2-6h6',
} as const;

export type IconName = keyof typeof PATHS;

export const Icon = ({ name, size = 22 }: { name: IconName; size?: number }) => (
  <svg className="ico" width={size} height={size} viewBox="0 0 24 24" aria-hidden="true"><path d={PATHS[name]} /></svg>
);
