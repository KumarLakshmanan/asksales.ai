/**
 * Browsers still report legacy IANA names (Chrome on Windows in India says
 * "Asia/Calcutta"). Intl accepts them, but the production PostgreSQL tz
 * database ships without the "backward" links, so `AT TIME ZONE 'Asia/Calcutta'`
 * fails. Every zone that reaches SQL or is stored goes through canonicalTimeZone.
 */
const LEGACY_TIME_ZONES: Readonly<Record<string, string>> = {
  "Asia/Calcutta": "Asia/Kolkata",
  "Asia/Saigon": "Asia/Ho_Chi_Minh",
  "Asia/Katmandu": "Asia/Kathmandu",
  "Asia/Rangoon": "Asia/Yangon",
  "Asia/Dacca": "Asia/Dhaka",
  "Asia/Thimbu": "Asia/Thimphu",
  "Asia/Ulan_Bator": "Asia/Ulaanbaatar",
  "Asia/Chongqing": "Asia/Shanghai",
  "Asia/Chungking": "Asia/Shanghai",
  "Asia/Harbin": "Asia/Shanghai",
  "Asia/Kashgar": "Asia/Urumqi",
  "Asia/Macao": "Asia/Macau",
  "Asia/Tel_Aviv": "Asia/Jerusalem",
  "Asia/Istanbul": "Europe/Istanbul",
  "Asia/Ujung_Pandang": "Asia/Makassar",
  "Asia/Ashkhabad": "Asia/Ashgabat",
  "Europe/Kiev": "Europe/Kyiv",
  "Europe/Uzhgorod": "Europe/Kyiv",
  "Europe/Zaporozhye": "Europe/Kyiv",
  "Europe/Nicosia": "Asia/Nicosia",
  "Europe/Belfast": "Europe/London",
  "America/Buenos_Aires": "America/Argentina/Buenos_Aires",
  "America/Catamarca": "America/Argentina/Catamarca",
  "America/Cordoba": "America/Argentina/Cordoba",
  "America/Jujuy": "America/Argentina/Jujuy",
  "America/Mendoza": "America/Argentina/Mendoza",
  "America/Godthab": "America/Nuuk",
  "America/Indianapolis": "America/Indiana/Indianapolis",
  "America/Fort_Wayne": "America/Indiana/Indianapolis",
  "America/Louisville": "America/Kentucky/Louisville",
  "America/Knox_IN": "America/Indiana/Knox",
  "America/Montreal": "America/Toronto",
  "America/Shiprock": "America/Denver",
  "America/Porto_Acre": "America/Rio_Branco",
  "America/Ensenada": "America/Tijuana",
  "Atlantic/Faeroe": "Atlantic/Faroe",
  "Atlantic/Jan_Mayen": "Europe/Oslo",
  "Africa/Asmera": "Africa/Asmara",
  "Africa/Timbuktu": "Africa/Bamako",
  "Pacific/Ponape": "Pacific/Pohnpei",
  "Pacific/Truk": "Pacific/Chuuk",
  "Pacific/Yap": "Pacific/Chuuk",
  "Pacific/Samoa": "Pacific/Pago_Pago",
  "Pacific/Enderbury": "Pacific/Kanton",
  "Pacific/Johnston": "Pacific/Honolulu",
  "Australia/ACT": "Australia/Sydney",
  "Australia/Canberra": "Australia/Sydney",
  "Australia/NSW": "Australia/Sydney",
  "Australia/North": "Australia/Darwin",
  "Australia/Queensland": "Australia/Brisbane",
  "Australia/South": "Australia/Adelaide",
  "Australia/Tasmania": "Australia/Hobart",
  "Australia/Victoria": "Australia/Melbourne",
  "Australia/West": "Australia/Perth",
  "Australia/Yancowinna": "Australia/Broken_Hill",
  "Australia/LHI": "Australia/Lord_Howe",
  "US/Eastern": "America/New_York",
  "US/Central": "America/Chicago",
  "US/Mountain": "America/Denver",
  "US/Pacific": "America/Los_Angeles",
  "US/Alaska": "America/Anchorage",
  "US/Hawaii": "Pacific/Honolulu",
  "US/Arizona": "America/Phoenix",
  "US/East-Indiana": "America/Indiana/Indianapolis",
  "US/Michigan": "America/Detroit",
  "US/Aleutian": "America/Adak",
  "US/Samoa": "Pacific/Pago_Pago",
  "Canada/Atlantic": "America/Halifax",
  "Canada/Central": "America/Winnipeg",
  "Canada/Eastern": "America/Toronto",
  "Canada/Mountain": "America/Edmonton",
  "Canada/Newfoundland": "America/St_Johns",
  "Canada/Pacific": "America/Vancouver",
  "Canada/Saskatchewan": "America/Regina",
  "Brazil/East": "America/Sao_Paulo",
  "Brazil/West": "America/Manaus",
  "Mexico/General": "America/Mexico_City",
  "Chile/Continental": "America/Santiago",
  "GB": "Europe/London",
  "GB-Eire": "Europe/London",
  "Eire": "Europe/Dublin",
  "Portugal": "Europe/Lisbon",
  "Poland": "Europe/Warsaw",
  "Turkey": "Europe/Istanbul",
  "Egypt": "Africa/Cairo",
  "Libya": "Africa/Tripoli",
  "Iran": "Asia/Tehran",
  "Israel": "Asia/Jerusalem",
  "Japan": "Asia/Tokyo",
  "ROK": "Asia/Seoul",
  "ROC": "Asia/Taipei",
  "PRC": "Asia/Shanghai",
  "Hongkong": "Asia/Hong_Kong",
  "Singapore": "Asia/Singapore",
  "NZ": "Pacific/Auckland",
  "NZ-CHAT": "Pacific/Chatham",
  "Jamaica": "America/Jamaica",
  "Cuba": "America/Havana",
  "Iceland": "Atlantic/Reykjavik",
  "Navajo": "America/Denver",
  "Kwajalein": "Pacific/Kwajalein",
  "UCT": "UTC",
  "Universal": "UTC",
  "Zulu": "UTC",
  "Etc/UCT": "UTC",
  "Etc/UTC": "UTC",
  "Etc/Universal": "UTC",
  "Etc/Zulu": "UTC",
};

/** The current IANA name for a zone; unknown names are returned unchanged. */
export function canonicalTimeZone(value: string): string;
export function canonicalTimeZone(value: string | null | undefined): string | null | undefined;
export function canonicalTimeZone(value: string | null | undefined): string | null | undefined {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  return LEGACY_TIME_ZONES[trimmed] ?? trimmed;
}

/** This device's zone under its current IANA name. */
export function deviceTimeZone(fallback = "UTC"): string {
  try {
    return canonicalTimeZone(Intl.DateTimeFormat().resolvedOptions().timeZone || fallback);
  } catch {
    return fallback;
  }
}
