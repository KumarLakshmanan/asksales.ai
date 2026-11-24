// GSM 03.38 default alphabet. Extension characters consume two septets.
const GSM_BASIC = new Set(Array.from("@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà"));
const GSM_EXTENSION = new Set(Array.from("\f^{}\\[~]|€"));

/** Estimate transport segments before recipient variables and links are expanded. */
export function calculateSmsMetrics(text: string) {
  const characters = Array.from(text).length;
  const gsm = Array.from(text).every(character => GSM_BASIC.has(character) || GSM_EXTENSION.has(character));
  const units = gsm ? Array.from(text).reduce((total, character) => total + (GSM_EXTENSION.has(character) ? 2 : 1), 0) : text.length;
  const singleLimit = gsm ? 160 : 70;
  const perSegment = units <= singleLimit ? singleLimit : gsm ? 153 : 67;
  return { encoding: gsm ? 'GSM-7' as const : 'UCS-2' as const, characters, units, perSegment, segments: units ? Math.ceil(units / perSegment) : 0 };
}
