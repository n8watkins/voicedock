// VoiceDock's one icon set: Lucide-style 24px line icons (ISC license) plus
// the filled transport glyphs and the VoiceDock mark. The popup and settings
// page render them with <Icon> (src/ui.jsx); the on-page player bar builds the
// same shapes with iconElement() below. Keep it free of JSX and React.
//
// Each icon is a list of [tag, attributes]; `fill: true` icons are solid
// shapes, the rest are 2px strokes.

export const ICONS = {
  // Transport
  play: { fill: true, shapes: [['path', { d: 'M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5Z' }]] },
  pause: { fill: true, shapes: [['rect', { x: 6, y: 4, width: 4, height: 16, rx: 1 }], ['rect', { x: 14, y: 4, width: 4, height: 16, rx: 1 }]] },
  stop: { fill: true, shapes: [['rect', { x: 5, y: 5, width: 14, height: 14, rx: 2 }]] },
  'skip-back': { shapes: [['path', { d: 'M19 20 9 12l10-8v16Z' }], ['path', { d: 'M5 19V5' }]] },
  'skip-forward': { shapes: [['path', { d: 'm5 4 10 8-10 8V4Z' }], ['path', { d: 'M19 5v14' }]] },
  volume: { shapes: [['path', { d: 'M11 5 6 9H2v6h4l5 4V5Z' }], ['path', { d: 'M15.5 8.5a5 5 0 0 1 0 7' }], ['path', { d: 'M19 5a10 10 0 0 1 0 14' }]] },

  // Actions
  settings: { shapes: [['path', { d: 'M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4' }]] },
  refresh: { shapes: [['path', { d: 'M21 12a9 9 0 1 1-2.64-6.36L21 8' }], ['path', { d: 'M21 3v5h-5' }]] },
  search: { shapes: [['circle', { cx: 11, cy: 11, r: 7 }], ['path', { d: 'm20 20-3.5-3.5' }]] },
  star: { shapes: [['path', { d: 'm12 2.5 2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.4l-5.9 3.1 1.2-6.5-4.8-4.6 6.6-.9L12 2.5Z' }]] },
  check: { shapes: [['path', { d: 'M20 6 9 17l-5-5' }]] },
  copy: { shapes: [['rect', { x: 8, y: 8, width: 13, height: 13, rx: 2 }], ['path', { d: 'M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2' }]] },
  close: { shapes: [['path', { d: 'M18 6 6 18' }], ['path', { d: 'm6 6 12 12' }]] },
  plus: { shapes: [['path', { d: 'M5 12h14M12 5v14' }]] },
  pencil: { shapes: [['path', { d: 'M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z' }], ['path', { d: 'm15 5 4 4' }]] },
  trash: { shapes: [['path', { d: 'M3 6h18' }], ['path', { d: 'M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6' }], ['path', { d: 'M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2' }], ['path', { d: 'M10 11v6M14 11v6' }]] },
  folder: { shapes: [['path', { d: 'M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z' }]] },
  external: { shapes: [['path', { d: 'M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6' }]] },
  power: { shapes: [['path', { d: 'M12 2v10M18.4 6.6a9 9 0 1 1-12.8 0' }]] },

  // Navigation
  'chevron-down': { shapes: [['path', { d: 'm6 9 6 6 6-6' }]] },
  'chevron-up': { shapes: [['path', { d: 'm18 15-6-6-6 6' }]] },
  'chevron-left': { shapes: [['path', { d: 'm15 18-6-6 6-6' }]] },
  'chevron-right': { shapes: [['path', { d: 'm9 18 6-6-6-6' }]] },
  arrow: { shapes: [['path', { d: 'M5 12h14M13 6l6 6-6 6' }]] },

  // Status and notes
  loader: { shapes: [['path', { d: 'M21 12a9 9 0 1 1-6.2-8.56' }]] },
  warn: { shapes: [['path', { d: 'm21.7 18-8-14a2 2 0 0 0-3.4 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.7-3Z' }], ['path', { d: 'M12 9v4M12 17h.01' }]] },
  alert: { shapes: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M12 8v4M12 16h.01' }]] },
  info: { shapes: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M12 16v-4M12 8h.01' }]] },
  shield: { shapes: [['path', { d: 'M20 13c0 5-3.5 7.5-7.7 9a1 1 0 0 1-.6 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.2-2.7a1.2 1.2 0 0 1 1.6 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1Z' }]] },

  // Things
  wave: { shapes: [['path', { d: 'M2 10v3M6 6v11M10 3v18M14 8v7M18 5v13M22 10v3' }]] },
  users: { shapes: [['path', { d: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2' }], ['circle', { cx: 9, cy: 7, r: 4 }], ['path', { d: 'M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75' }]] },
  keyboard: { shapes: [['rect', { x: 2, y: 4, width: 20, height: 16, rx: 2 }], ['path', { d: 'M6 8h.01M10 8h.01M14 8h.01M18 8h.01M8 12h.01M12 12h.01M16 12h.01M7 16h10' }]] },
  globe: { shapes: [['circle', { cx: 12, cy: 12, r: 10 }], ['path', { d: 'M2 12h20M12 2a15 15 0 0 1 0 20M12 2a15 15 0 0 0 0 20' }]] },
  cpu: { shapes: [['rect', { x: 5, y: 5, width: 14, height: 14, rx: 2 }], ['rect', { x: 9, y: 9, width: 6, height: 6 }], ['path', { d: 'M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3' }]] },
  drive: { shapes: [['path', { d: 'M22 12H2M5.5 5.1 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.5-6.9A2 2 0 0 0 16.8 4H7.2a2 2 0 0 0-1.7 1.1ZM6 16h.01M10 16h.01' }]] },
  github: { fill: true, shapes: [['path', { d: 'M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0 1 12 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z' }]] },

  // The VoiceDock mark without its tile, for use on a coloured surface.
  mark: { fill: true, view: '0 0 64 64', shapes: [
    ['rect', { x: 14, y: 27, width: 5, height: 14, rx: 2.5 }],
    ['rect', { x: 22.5, y: 18, width: 5, height: 23, rx: 2.5 }],
    ['rect', { x: 31, y: 12, width: 5, height: 29, rx: 2.5 }],
    ['rect', { x: 39.5, y: 21, width: 5, height: 20, rx: 2.5 }],
    ['rect', { x: 48, y: 29, width: 5, height: 12, rx: 2.5, opacity: 0.85 }],
    ['rect', { x: 10, y: 46, width: 44, height: 6, rx: 3, opacity: 0.55 }],
  ] },
};

export const ICON_NAMES = Object.keys(ICONS);

const SVG_NS = 'http://www.w3.org/2000/svg';

// Builds an icon as a DOM <svg> (for the page script, which has no React).
export function iconElement(name, size = 16, doc = globalThis.document) {
  const spec = ICONS[name];
  if (!spec) throw new Error(`Unknown icon: ${name}`);
  const svg = doc.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', spec.view || '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');
  if (spec.fill) {
    svg.setAttribute('fill', 'currentColor');
  } else {
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
  }
  for (const [tag, attrs] of spec.shapes) {
    const el = doc.createElementNS(SVG_NS, tag);
    for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
    svg.appendChild(el);
  }
  return svg;
}
