const LANGUAGE_META: Record<string, { aliases: string[] }> = {
  it: { aliases: ['意大利语', 'italian'] },
  es: { aliases: ['西班牙语', 'spanish'] },
  fr: { aliases: ['法语', 'french'] },
  ru: { aliases: ['俄语', 'russian'] },
  nl: { aliases: ['荷兰语', 'dutch'] },
  ja: { aliases: ['日语', 'japanese'] },
  ko: { aliases: ['韩语', 'korean'] },
  tr: { aliases: ['土耳其语', 'turkish'] },
};

const normalize = (value: string): string => value.trim().toLowerCase();

const ALIAS_TO_CODE = (() => {
  const map = new Map<string, string>();
  for (const [code, meta] of Object.entries(LANGUAGE_META)) {
    map.set(normalize(code), code);
    for (const alias of meta.aliases) {
      map.set(normalize(alias), code);
    }
  }
  return map;
})();

export function normalizeLanguageCode(value: string | null | undefined): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const mapped = ALIAS_TO_CODE.get(normalize(trimmed));
  if (mapped) {
    return mapped;
  }

  return normalize(trimmed);
}

export function buildLanguageFilterValues(value: string | null | undefined): string[] | null {
  const code = normalizeLanguageCode(value);
  if (!code) {
    return null;
  }

  const aliases = LANGUAGE_META[code]?.aliases || [];
  const set = new Set<string>([normalize(code)]);
  aliases.forEach((alias) => set.add(normalize(alias)));
  return Array.from(set);
}
