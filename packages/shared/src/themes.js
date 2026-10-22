

export const THEMES = {
  'editorial-light': {
    id: 'editorial-light',
    name: 'Editorial Light',
    description: 'Paper white, ink typography, serif for reading, generous editorial spacing, restrained accents, hairline rules.',
    colors: {
      bgPrimary: '#FAF8F5',
      bgElevated: '#FFFFFF',
      bgSubtle: '#F0ECE3',
      textPrimary: '#181615',
      textSecondary: '#453F3C',
      textMuted: '#5C5551',
      accent: '#8B261D',
      accentText: '#FFFFFF',
      border: '#D8D2C7',
      focusRing: '#8B261D',
      danger: '#9E1C1C',
      success: '#1D5E3A',
      warning: '#7D4E00',
      highlightBg: '#F7E396',
      highlightText: '#181615',
    },
    typography: {
      fontUi: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontReading: '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
      fontMono: '"SF Mono", Menlo, Monaco, Consolas, monospace',
      scaleBasePx: 17,
      scaleRatio: 1.25,
      lineHeightBody: 1.72,
      lineHeightHeading: 1.22,
    },
    layout: {
      spacingUnitPx: 8,
      density: 'spacious',
      borderRadiusSm: '3px',
      borderRadiusMd: '6px',
      borderRadiusLg: '10px',
      borderStyle: 'solid',
      borderWidth: '1px',
      shadowSm: '0 1px 2px rgba(24, 22, 21, 0.06)',
      shadowMd: '0 4px 12px rgba(24, 22, 21, 0.08)',
      focusRingStyle: '2px solid #8B261D',
      motionDurationMs: 180,
      motionEasing: 'cubic-bezier(0.22, 1, 0.36, 1)',
    },
  },
  'midnight-amoled': {
    id: 'midnight-amoled',
    name: 'Midnight AMOLED',
    description: 'True #000000 base, distinguishable elevated surfaces, calibrated muted text, subtle borders. No neon or glow effects.',
    colors: {
      bgPrimary: '#000000',
      bgElevated: '#0E0E12',
      bgSubtle: '#17171D',
      textPrimary: '#F2F2F5',
      textSecondary: '#C2C2CC',
      textMuted: '#9A9AA6',
      accent: '#7AA2F7',
      accentText: '#000000',
      border: '#2A2A34',
      focusRing: '#8AB4F8',
      danger: '#F7768E',
      success: '#73DACA',
      warning: '#E0AF68',
      highlightBg: '#3B3212',
      highlightText: '#F2F2F5',
    },
    typography: {
      fontUi: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
      fontReading: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
      fontMono: '"SF Mono", Menlo, Consolas, monospace',
      scaleBasePx: 16,
      scaleRatio: 1.2,
      lineHeightBody: 1.65,
      lineHeightHeading: 1.25,
    },
    layout: {
      spacingUnitPx: 7,
      density: 'balanced',
      borderRadiusSm: '4px',
      borderRadiusMd: '8px',
      borderRadiusLg: '12px',
      borderStyle: 'solid',
      borderWidth: '1px',
      shadowSm: 'none',
      shadowMd: '0 2px 6px rgba(0, 0, 0, 0.85)',
      focusRingStyle: '2px solid #8AB4F8',
      motionDurationMs: 140,
      motionEasing: 'ease-out',
    },
  },
  'swiss-minimal': {
    id: 'swiss-minimal',
    name: 'Swiss Minimal',
    description: 'Grid-driven layout, grotesque sans-serif, dense information, strong alignment, square corners, visible rules.',
    colors: {
      bgPrimary: '#F4F4F4',
      bgElevated: '#FFFFFF',
      bgSubtle: '#E6E6E6',
      textPrimary: '#0A0A0A',
      textSecondary: '#2E2E2E',
      textMuted: '#4F4F4F',
      accent: '#D11A1A',
      accentText: '#FFFFFF',
      border: '#111111',
      focusRing: '#0A0A0A',
      danger: '#B80000',
      success: '#005A2B',
      warning: '#6B4700',
      highlightBg: '#FFE66D',
      highlightText: '#0A0A0A',
    },
    typography: {
      fontUi: '"Helvetica Neue", Helvetica, Arial, sans-serif',
      fontReading: '"Helvetica Neue", Helvetica, Arial, sans-serif',
      fontMono: 'Menlo, Monaco, "Courier New", monospace',
      scaleBasePx: 15,
      scaleRatio: 1.18,
      lineHeightBody: 1.5,
      lineHeightHeading: 1.15,
    },
    layout: {
      spacingUnitPx: 6,
      density: 'compact',
      borderRadiusSm: '0px',
      borderRadiusMd: '0px',
      borderRadiusLg: '0px',
      borderStyle: 'solid',
      borderWidth: '2px',
      shadowSm: 'none',
      shadowMd: '4px 4px 0px #111111',
      focusRingStyle: '3px solid #0A0A0A',
      motionDurationMs: 80,
      motionEasing: 'linear',
    },
  },
  'soft-sepia': {
    id: 'soft-sepia',
    name: 'Soft Sepia',
    description: 'Parchment tones, warm text, a book-like serif, gentle separators, earthy accents.',
    colors: {
      bgPrimary: '#F3EAD8',
      bgElevated: '#FAF3E6',
      bgSubtle: '#E8DCC4',
      textPrimary: '#2A1F14',
      textSecondary: '#4A3928',
      textMuted: '#5E4B36',
      accent: '#7A3E12',
      accentText: '#FFFFFF',
      border: '#CEBE9E',
      focusRing: '#7A3E12',
      danger: '#8C2318',
      success: '#26532B',
      warning: '#6E470B',
      highlightBg: '#EACF8B',
      highlightText: '#2A1F14',
    },
    typography: {
      fontUi: 'Georgia, "Times New Roman", serif',
      fontReading: 'Georgia, "Book Antiqua", Palatino, serif',
      fontMono: '"Courier New", Courier, monospace',
      scaleBasePx: 17,
      scaleRatio: 1.22,
      lineHeightBody: 1.78,
      lineHeightHeading: 1.26,
    },
    layout: {
      spacingUnitPx: 9,
      density: 'comfortable',
      borderRadiusSm: '4px',
      borderRadiusMd: '8px',
      borderRadiusLg: '14px',
      borderStyle: 'solid',
      borderWidth: '1px',
      shadowSm: '0 1px 3px rgba(42, 31, 20, 0.08)',
      shadowMd: '0 4px 14px rgba(42, 31, 20, 0.12)',
      focusRingStyle: '2px dashed #7A3E12',
      motionDurationMs: 200,
      motionEasing: 'ease-in-out',
    },
  },
};

export function parseHexRgb(hex) {
  const clean = hex.trim().replace(/^#/, '');
  if (clean.length === 3) {
    return [
      Number.parseInt(clean[0] + clean[0], 16),
      Number.parseInt(clean[1] + clean[1], 16),
      Number.parseInt(clean[2] + clean[2], 16),
    ];
  }
  return [
    Number.parseInt(clean.slice(0, 2), 16),
    Number.parseInt(clean.slice(2, 4), 16),
    Number.parseInt(clean.slice(4, 6), 16),
  ];
}

export function relativeLuminance(hex) {
  const [r, g, b] = parseHexRgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(hex1, hex2) {
  const l1 = relativeLuminance(hex1);
  const l2 = relativeLuminance(hex2);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return Number(((lighter + 0.05) / (darker + 0.05)).toFixed(2));
}

export function verifyThemeContrast(theme) {
  const c = theme.colors;
  const ratios = {
    primaryOnBg: contrastRatio(c.textPrimary, c.bgPrimary),
    secondaryOnBg: contrastRatio(c.textSecondary, c.bgPrimary),
    mutedOnBg: contrastRatio(c.textMuted, c.bgPrimary),
    primaryOnElevated: contrastRatio(c.textPrimary, c.bgElevated),
    accentTextOnAccent: contrastRatio(c.accentText, c.accent),
    focusOnBg: contrastRatio(c.focusRing, c.bgPrimary),
    highlightTextOnHighlight: contrastRatio(c.highlightText, c.highlightBg),
  };

  const passesWcagAA =
    ratios.primaryOnBg >= 4.5 &&
    ratios.secondaryOnBg >= 4.5 &&
    ratios.mutedOnBg >= 4.5 &&
    ratios.primaryOnElevated >= 4.5 &&
    ratios.accentTextOnAccent >= 4.5 &&
    ratios.focusOnBg >= 3.0 &&
    ratios.highlightTextOnHighlight >= 4.5;

  return {
    themeId: theme.id,
    passesWcagAA,
    ratios,
  };
}
